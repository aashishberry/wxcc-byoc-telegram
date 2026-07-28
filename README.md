# Telegram ↔ Webex Contact Center middleware

Headless middleware that bridges Telegram Bot conversations to Webex Contact
Center (WxCC) Custom Messaging. It has no operator UI and exposes no task or
message browsing APIs.

The current implementation supports bidirectional text:

- A customer's first Telegram message creates a WxCC Custom Messaging task.
- Later customer messages append to the same active task.
- Flow and agent outbound messages are sent back to the original Telegram chat.
- `task:connected` sends one configurable interim message to the customer.
- `task:ended` and `task:failed` close the local mapping; the next Telegram
  message creates a new task.
- Telegram and WxCC webhook retries are idempotent.

Channel icon assets are available in two transparent SVG variants:

- [`assets/icons/telegram-channel-color.svg`](./assets/icons/telegram-channel-color.svg)
- [`assets/icons/telegram-channel-outline.svg`](./assets/icons/telegram-channel-outline.svg)

Attachments are deliberately not forwarded in this first version. Telegram
media receives a configurable text response. Outbound WxCC attachments produce
a configurable fallback message. Supporting files safely requires temporary
object storage, policy enforcement, malware handling, and optionally Webex's
decryption SDK; it should be implemented as a separate phase.

## Architecture

```text
Telegram customer
      │ Telegram webhook
      ▼
POST /api/webhooks/telegram
      │ Create Task / Task Messages API
      ▼
Webex Contact Center
      │
      ├─ subscription lifecycle webhooks ─┐
      └─ asset outbound-message webhook ──┤
                                         ▼
                              POST /api/webhooks/webex
                                         │ Telegram sendMessage
                                         ▼
                                  Telegram customer
```

PostgreSQL retains only the correlation and idempotency data needed by the
bridge. Message bodies and raw webhook payloads are never persisted.

## Prerequisites

- Node.js 22+
- A PostgreSQL database for deployed use
- A Telegram bot token from BotFather
- A WxCC Custom Messaging channel, asset, business address, entry point, and
  flow
- A Webex Service App authorized for the organization
- Public HTTPS URLs for both webhook endpoints

The Webex token requires:

- `cjp:task_write` for Create Task and Task Messages
- `cjp:task_read` if your organization requires task read access
- `cjp:config_read` and `cjp:config_write` for automatic subscription
  reconciliation

The same Webex token is used for task and subscription APIs.

## Local setup

```bash
npm install
cp .env.example .env.local
```

For an entirely local process, set:

```dotenv
ALLOW_IN_MEMORY_DB=true
```

Then fill in the remaining values and run:

```bash
npm run dev
```

The service listens on `http://localhost:3000` by default. Check:

```bash
curl http://localhost:3000/api/health
```

The default Telegram Bot API and Webex cannot post webhooks directly to
localhost. For live local testing, expose the server through an HTTPS tunnel
such as Cloudflare Tunnel or ngrok, then use the tunnel URLs for
`TELEGRAM_WEBHOOK_URL`, `WEBEX_WEBHOOK_URL`, and the Custom Messaging asset
webhook URL. Restart after changing the URLs so startup reconciliation runs.

The in-memory database is only for local experiments. It is cleared at restart
and is unsafe with multiple service instances.

## Configuration

Copy [`.env.example`](./.env.example) and set these required values:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection URL; injected automatically by the Render Blueprint |
| `LOG_HASH_SECRET` | HMAC secret used to make stable, irreversible log references |
| `EXTERNAL_ID_SECRET` | HMAC secret used to turn Telegram user IDs into opaque WxCC origins |
| `TELEGRAM_BOT_TOKEN` | BotFather token; never put it in source control |
| `TELEGRAM_WEBHOOK_SECRET` | Random Telegram webhook verification value |
| `TELEGRAM_WEBHOOK_URL` | Public `/api/webhooks/telegram` HTTPS URL |
| `WEBEX_TASKS_URL` | Region-specific WxCC `/v2/tasks` URL |
| `WEBEX_SUBSCRIPTIONS_URL` | Region-specific WxCC `/v2/subscriptions` URL |
| `WEBEX_ORG_ID` | Authorized WxCC organization ID |
| `WEBEX_WEBHOOK_URL` | Public `/api/webhooks/webex` HTTPS URL |
| `WEBEX_WEBHOOK_SECRET` | Secret configured both on the asset and managed subscriptions |
| `WEBEX_DESTINATION_ID` | Business address configured on the Custom Messaging asset |
| `WEBEX_CHANNEL_NAME` | Exact configured Custom Messaging channel name |
| `WEBEX_ACCESS_TOKEN` | Static token, or use the three refresh credential variables |

Use either `WEBEX_ACCESS_TOKEN` or all of:

- `WEBEX_CLIENT_ID`
- `WEBEX_CLIENT_SECRET`
- `WEBEX_REFRESH_TOKEN`

Generate secrets locally without printing them into application logs:

```bash
openssl rand -hex 32
```

Use different random values for `LOG_HASH_SECRET`,
`EXTERNAL_ID_SECRET`, `TELEGRAM_WEBHOOK_SECRET`, and
`WEBEX_WEBHOOK_SECRET`.

## Webex configuration

1. Create a Custom Messaging channel and note its exact channel name.
2. Create an asset with its business address.
3. Set the asset webhook URL to
   `https://YOUR_HOST/api/webhooks/webex`.
4. Configure the asset webhook secret to match `WEBEX_WEBHOOK_SECRET`.
5. Map the asset to an active Custom Messaging entry point and flow.
6. Ensure the queue, team, agent multimedia profile, and flow routing are
   valid.
7. Authorize the Service App and set its token or refresh credentials.
8. Set the region-specific Tasks and Subscriptions base URLs.

At startup the bridge creates three missing subscriptions:

- Task lifecycle: `task:new`, `task:connect`, `task:connected`, `task:ended`,
  `task:failed`
- Inbound task messages: `task-message:appended`,
  `task-message:append-failed`
- Queue state: `task:parked`

Existing subscriptions with the bridge's names are not overwritten. Drift is
reported as `DRIFT_REVIEW_REQUIRED`, avoiding an unexpected mutation of an
administrator-managed subscription.

## Telegram configuration

1. Use BotFather to create a bot and obtain its token.
2. Set the token as `TELEGRAM_BOT_TOKEN`.
3. Generate an allowed webhook secret (letters, digits, `_`, and `-`).
4. Set the public webhook URL and secret.
5. Deploy or restart the service.

Startup calls Telegram `setWebhook` with:

- the configured HTTPS URL
- the configured secret token
- `allowed_updates: ["message"]`

Private chats are enabled by default. Set `TELEGRAM_ALLOW_GROUPS=true` only
after deciding how group participants should map to WxCC conversations.

## Render deployment

[`render.yaml`](./render.yaml) defines one Node web service and one PostgreSQL
database. Put this directory in its own Git repository, push it to your Git
provider, and create a Render Blueprint from that repository.

After Render creates the resources:

1. Add all secret and organization-specific variables in the Render service
   environment.
2. Use the Render service hostname to set both webhook URL variables.
3. Use the same WxCC webhook URL and secret on the Custom Messaging asset.
4. Redeploy or restart once the variables are complete.
5. Confirm `/api/health` reports `"status": "ok"`.

Do not commit `.env.local`. Render reads its runtime environment settings; it
does not read your local `.env.local`.

## Safe logging

Logs are structured JSON and restricted to:

- controlled event names and state
- HTTP status codes and counts
- HMAC-hashed task, update, and delivery references
- allow-listed WxCC failure reason codes

The code does not log message content, webhook payloads, Telegram chat/user
IDs, names, usernames, Webex origin/destination values, tokens, secrets, remote
API response descriptions, or attachment URLs. ESLint rejects `console` usage
outside the logger module.

PostgreSQL necessarily stores Telegram chat/user IDs to route replies. Protect
the database with provider access controls and encryption at rest. Message text
is not stored.

## Commands

```bash
npm run dev      # local development
npm test         # unit and mocked end-to-end tests
npm run lint     # logging and code checks
npm run build    # production build
npm run check    # lint, tests, and build
npm start        # production server
```

## Health and operational behavior

- `GET /api/health` returns database and configuration readiness booleans only.
- Webhooks are HMAC/secret verified before processing.
- Delivery/update/event keys prevent duplicate customer or agent messages.
- Out-of-order terminal events cannot reopen a closed task.
- A fast `task:failed` that beats the Create Task HTTP response is reconciled
  after the task mapping is saved.
- Startup creates missing Telegram webhook and WxCC subscription configuration,
  but logs failures safely and keeps the health endpoint available.

For production scale beyond one web process, replace the in-process per-chat
mutex with a distributed lock or queue. Webhook handlers currently perform
downstream delivery before returning; a durable job queue is the next
reliability improvement if sustained volume or the webhook response-time limit
becomes a concern.
