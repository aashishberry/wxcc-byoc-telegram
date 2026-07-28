import { runtimeEnv, webexConfig } from "../config";
import { BridgeError } from "../errors";

let tokenCache: { value: string; expiresAt: number } | null = null;

async function webexAccessToken() {
  const env = runtimeEnv();
  if (env.WEBEX_ACCESS_TOKEN?.trim()) return env.WEBEX_ACCESS_TOKEN.trim();
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000)
    return tokenCache.value;
  if (
    !env.WEBEX_CLIENT_ID?.trim() ||
    !env.WEBEX_CLIENT_SECRET?.trim() ||
    !env.WEBEX_REFRESH_TOKEN?.trim()
  )
    throw new BridgeError("WEBEX_CREDENTIALS_MISSING", 503);

  let response: Response;
  try {
    response = await fetch(
      env.WEBEX_OAUTH_URL?.trim() || "https://webexapis.com/v1/access_token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: env.WEBEX_CLIENT_ID,
          client_secret: env.WEBEX_CLIENT_SECRET,
          refresh_token: env.WEBEX_REFRESH_TOKEN,
        }),
      },
    );
  } catch {
    throw new BridgeError("WEBEX_TOKEN_NETWORK", 502, true);
  }
  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!response.ok || !body.access_token)
    throw new BridgeError(`WEBEX_TOKEN_HTTP_${response.status}`, 502, true);
  tokenCache = {
    value: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
  return tokenCache.value;
}

export async function webexJsonRequest<T>(url: string, init: RequestInit = {}) {
  const token = await webexAccessToken();
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new BridgeError("WEBEX_NETWORK", 502, true);
  }
  const body = (await response.json().catch(() => ({}))) as T;
  if (!response.ok)
    throw new BridgeError(
      `WEBEX_HTTP_${response.status}`,
      502,
      response.status >= 500 || response.status === 429,
    );
  return body;
}

export async function createWebexTask(input: {
  originId: string;
  aliasId: string;
  text: string;
  timestamp: number;
}) {
  const config = webexConfig();
  const body = await webexJsonRequest<{ data?: { id?: string } }>(
    config.tasksUrl,
    {
      method: "POST",
      body: JSON.stringify({
        origin: {
          id: input.originId,
          name: "Telegram customer",
        },
        destination: {
          id: config.destinationId,
          type: "businessAddress",
        },
        channelType: "customMessaging",
        channel: config.channelName,
        channelParams: {
          type: "text",
          message: {
            aliasId: input.aliasId,
            text: input.text,
            timestamp: input.timestamp,
          },
        },
      }),
    },
  );
  const taskId = body.data?.id;
  if (!taskId) throw new BridgeError("WEBEX_TASK_ID_MISSING", 502, true);
  return taskId;
}

export async function appendWebexMessage(input: {
  taskId: string;
  aliasId: string;
  text: string;
  timestamp: number;
}) {
  const config = webexConfig();
  await webexJsonRequest(
    `${config.tasksUrl}/${encodeURIComponent(input.taskId)}/messages`,
    {
      method: "POST",
      body: JSON.stringify({
        mediaType: "customMessaging",
        channelParams: {
          type: "text",
          message: {
            aliasId: input.aliasId,
            text: input.text,
            timestamp: input.timestamp,
          },
        },
      }),
    },
  );
}
