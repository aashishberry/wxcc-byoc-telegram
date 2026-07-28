import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test from "node:test";

import { conversationByChat } from "../lib/store";
import { processTelegramUpdate } from "../lib/telegram/handler";
import type { TelegramUpdate } from "../lib/telegram/types";
import { handleWebexWebhook } from "../lib/webex/handler";
import type { WebexEvent } from "../lib/webex/types";

process.env.ALLOW_IN_MEMORY_DB = "true";
process.env.LOG_HASH_SECRET = "integration-log-secret";
process.env.EXTERNAL_ID_SECRET = "integration-identity-secret";
process.env.TELEGRAM_BOT_TOKEN = "test-bot-token";
process.env.TELEGRAM_WEBHOOK_SECRET = "telegram_webhook_secret";
process.env.TELEGRAM_WEBHOOK_URL =
  "https://bridge.example/api/webhooks/telegram";
process.env.TELEGRAM_API_BASE_URL = "https://telegram.mock";
process.env.WEBEX_TASKS_URL = "https://webex.mock/v2/tasks";
process.env.WEBEX_DESTINATION_ID = "support@example.test";
process.env.WEBEX_CHANNEL_NAME = "telegram";
process.env.WEBEX_WEBHOOK_SECRET = "webex-webhook-secret";
process.env.WEBEX_ACCESS_TOKEN = "test-webex-token";
process.env.AGENT_CONNECTED_MESSAGE = "An agent is connected.";

function telegramUpdate(updateId: number, chatId: string, text: string) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      from: { id: chatId, is_bot: false },
      chat: { id: chatId, type: "private" },
      text,
    },
  } satisfies TelegramUpdate;
}

function signedWebexRequest(event: WebexEvent) {
  const rawBody = JSON.stringify(event);
  const signature = createHmac("sha256", process.env.WEBEX_WEBHOOK_SECRET!)
    .update(rawBody)
    .digest("hex");
  return {
    rawBody,
    request: new Request("https://bridge.example/api/webhooks/webex", {
      method: "POST",
      headers: {
        "x-webexcc-signature": signature,
        "x-webexcc-timestamp": String(event.comciscotimestamp),
        "x-webexcc-webhook-version":
          event.type === "task-message:appended"
            ? "task-message:1.0.0"
            : "task:1.0.0",
      },
    }),
  };
}

test("messages bridge both directions and ended tasks start a new conversation", async () => {
  const webexRequests: Array<Record<string, unknown>> = [];
  const telegramRequests: Array<Record<string, unknown>> = [];
  const taskIds = [randomUUID(), randomUUID()];
  let createCount = 0;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url === "https://webex.mock/v2/tasks") {
      webexRequests.push(body);
      return Response.json(
        { data: { id: taskIds[createCount++] } },
        { status: 201 },
      );
    }
    if (url.startsWith("https://telegram.mock/bottest-bot-token/")) {
      telegramRequests.push(body);
      return Response.json({
        ok: true,
        result: { message_id: telegramRequests.length },
      });
    }
    throw new Error(`Unexpected mocked request: ${new URL(url).pathname}`);
  };

  try {
    const chatId = "900000000001";
    await processTelegramUpdate(
      telegramUpdate(10_000_001, chatId, "Initial customer text"),
    );
    assert.equal(createCount, 1);
    assert.equal(
      (
        (webexRequests[0].channelParams as Record<string, unknown>)
          .message as Record<string, unknown>
      ).text,
      "Initial customer text",
    );

    const connected: WebexEvent = {
      id: randomUUID(),
      type: "task:connected",
      comciscotimestamp: Date.now(),
      data: {
        taskId: taskIds[0],
        channel: "telegram",
        channelType: "customMessaging",
      },
    };
    const connectedRequest = signedWebexRequest(connected);
    await handleWebexWebhook(
      connectedRequest.rawBody,
      connectedRequest.request,
    );
    assert.equal(telegramRequests[0].text, "An agent is connected.");

    const reply: WebexEvent = {
      id: randomUUID(),
      type: "task-message:appended",
      comciscotimestamp: Date.now(),
      data: {
        taskId: taskIds[0],
        channel: "telegram",
        channelType: "customMessaging",
        messageDirection: "OUTBOUND",
        senderType: "agent",
        channelParams: {
          message: {
            aliasId: randomUUID(),
            text: "<strong>Agent reply</strong>",
          },
        },
      },
    };
    const replyRequest = signedWebexRequest(reply);
    await handleWebexWebhook(replyRequest.rawBody, replyRequest.request);
    assert.equal(telegramRequests[1].text, "Agent reply");

    const ended: WebexEvent = {
      id: randomUUID(),
      type: "task:ended",
      comciscotimestamp: Date.now(),
      data: {
        taskId: taskIds[0],
        channel: "telegram",
        channelType: "customMessaging",
      },
    };
    const endedRequest = signedWebexRequest(ended);
    await handleWebexWebhook(endedRequest.rawBody, endedRequest.request);
    assert.equal(
      (await conversationByChat("telegram", chatId))?.status,
      "ended",
    );

    await processTelegramUpdate(
      telegramUpdate(10_000_002, chatId, "Start another conversation"),
    );
    assert.equal(createCount, 2);
    assert.equal(
      (await conversationByChat("telegram", chatId))?.task_id,
      taskIds[1],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
