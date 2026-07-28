import { timingSafeEqual } from "node:crypto";

import { runtimeEnv, telegramConfig } from "../config";
import { BridgeError } from "../errors";
import { logError, logInfo, safeErrorCode, safeToken } from "../logger";
import { splitTelegramText } from "../text";
import type { TelegramApiResponse } from "./types";

function telegramMethodUrl(method: string) {
  const config = telegramConfig();
  return `${config.apiBaseUrl}/bot${config.botToken}/${method}`;
}

async function telegramRequest<T>(
  method: string,
  payload: Record<string, unknown>,
) {
  let response: Response;
  try {
    response = await fetch(telegramMethodUrl(method), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new BridgeError("TELEGRAM_NETWORK", 502, true);
  }

  const body = (await response
    .json()
    .catch(() => ({ ok: false }))) as TelegramApiResponse<T>;
  if (!response.ok || !body.ok || body.result === undefined) {
    throw new BridgeError(
      `TELEGRAM_API_${body.error_code ?? response.status}`,
      502,
      response.status >= 500 || response.status === 429,
    );
  }
  return body.result;
}

export function verifyTelegramWebhookSecret(
  supplied: string | null,
  expected: string,
) {
  if (!supplied) return false;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function telegramWebhookSecretIsValid(value: string) {
  return /^[A-Za-z0-9_-]{1,256}$/.test(value);
}

export async function sendTelegramTextChunk(input: {
  chatId: string;
  text: string;
  messageThreadId?: number;
}) {
  const result = await telegramRequest<{ message_id: number }>("sendMessage", {
    chat_id: input.chatId,
    text: input.text,
    ...(input.messageThreadId
      ? { message_thread_id: input.messageThreadId }
      : {}),
  });
  return String(result.message_id);
}

export async function sendTelegramText(input: {
  chatId: string;
  text: string;
  messageThreadId?: number;
}) {
  const messageIds: string[] = [];
  for (const chunk of splitTelegramText(input.text)) {
    messageIds.push(
      await sendTelegramTextChunk({
        chatId: input.chatId,
        text: chunk,
        messageThreadId: input.messageThreadId,
      }),
    );
  }
  return messageIds;
}

export async function reconcileTelegramWebhook() {
  const env = runtimeEnv();
  const hasAnyConfiguration = Boolean(
    env.TELEGRAM_BOT_TOKEN ||
    env.TELEGRAM_WEBHOOK_SECRET ||
    env.TELEGRAM_WEBHOOK_URL,
  );
  if (!hasAnyConfiguration) return;

  try {
    const config = telegramConfig();
    if (!telegramWebhookSecretIsValid(config.webhookSecret))
      throw new BridgeError("TELEGRAM_WEBHOOK_SECRET_INVALID", 503);
    const url = new URL(config.webhookUrl);
    if (url.protocol !== "https:")
      throw new BridgeError("TELEGRAM_WEBHOOK_URL_NOT_HTTPS", 503);

    await telegramRequest<boolean>("setWebhook", {
      url: config.webhookUrl,
      secret_token: config.webhookSecret,
      allowed_updates: ["message"],
      drop_pending_updates: false,
    });
    logInfo("telegram.webhook_sync", {
      provider: "telegram",
      outcome: "accepted",
      configured: true,
    });
  } catch (error) {
    logError("telegram.webhook_sync_failed", {
      provider: "telegram",
      outcome: "failed",
      code: safeErrorCode(error),
    });
  }
}

export function telegramErrorToken(error: unknown) {
  return safeToken(
    error instanceof BridgeError ? error.code : "TELEGRAM_UNEXPECTED",
  );
}
