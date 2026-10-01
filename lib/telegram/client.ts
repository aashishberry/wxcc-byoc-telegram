import { timingSafeEqual } from "node:crypto";

import { runtimeEnv, telegramConfig } from "../config";
import { BridgeError } from "../errors";
import { logError, logInfo, safeErrorCode, safeToken } from "../logger";
import { splitTelegramText } from "../text";
import {
  attachmentField,
  type DownloadedAttachment,
  type TelegramAttachmentMethod,
} from "../attachments";
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

async function telegramMultipartRequest<T>(method: string, payload: FormData) {
  let response: Response;
  try {
    response = await fetch(telegramMethodUrl(method), {
      method: "POST",
      body: payload,
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

export async function downloadTelegramFile(
  fileId: string,
  maxBytes: number,
) {
  const file = await telegramRequest<{
    file_path?: string;
    file_size?: number;
  }>("getFile", { file_id: fileId });
  if (!file.file_path)
    throw new BridgeError("TELEGRAM_FILE_PATH_MISSING", 502, true);
  if (file.file_size && file.file_size > maxBytes)
    throw new BridgeError("TELEGRAM_ATTACHMENT_TOO_LARGE", 422);

  const config = telegramConfig();
  const url = `${config.apiBaseUrl}/file/bot${config.botToken}/${file.file_path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(config.attachmentDownloadTimeoutMs),
    });
  } catch {
    throw new BridgeError("TELEGRAM_FILE_DOWNLOAD_FAILED", 502, true);
  }
  if (!response.ok || !response.body)
    throw new BridgeError(`TELEGRAM_FILE_HTTP_${response.status}`, 502, true);

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes)
    throw new BridgeError("TELEGRAM_ATTACHMENT_TOO_LARGE", 422);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new BridgeError("TELEGRAM_ATTACHMENT_TOO_LARGE", 422);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError("TELEGRAM_FILE_STREAM_FAILED", 502, true);
  }
  if (!size) throw new BridgeError("TELEGRAM_ATTACHMENT_EMPTY", 422);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function sendTelegramAttachment(input: {
  chatId: string;
  attachment: DownloadedAttachment;
  method: TelegramAttachmentMethod;
  caption?: string;
  messageThreadId?: number;
}) {
  const form = new FormData();
  form.set("chat_id", input.chatId);
  if (input.messageThreadId)
    form.set("message_thread_id", String(input.messageThreadId));
  if (input.caption) form.set("caption", input.caption);
  const fileBytes = Uint8Array.from(input.attachment.bytes).buffer;
  form.set(
    attachmentField(input.method),
    new Blob([fileBytes], { type: input.attachment.mimeType }),
    input.attachment.fileName,
  );
  const result = await telegramMultipartRequest<{ message_id: number }>(
    input.method,
    form,
  );
  return String(result.message_id);
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
