import { BridgeError } from "./errors";

export type RuntimeEnv = {
  DATABASE_URL?: string;
  DATABASE_SSL?: string;
  DATABASE_POOL_SIZE?: string;
  ALLOW_IN_MEMORY_DB?: string;
  LOG_HASH_SECRET?: string;
  EXTERNAL_ID_SECRET?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_WEBHOOK_URL?: string;
  TELEGRAM_API_BASE_URL?: string;
  TELEGRAM_ALLOW_GROUPS?: string;
  TELEGRAM_WELCOME_MESSAGE?: string;
  TELEGRAM_UNSUPPORTED_MESSAGE?: string;
  TELEGRAM_OUTBOUND_ATTACHMENT_MESSAGE?: string;
  TELEGRAM_OUTBOUND_ATTACHMENTS_ENABLED?: string;
  TELEGRAM_MAX_ATTACHMENT_BYTES?: string;
  TELEGRAM_ATTACHMENT_DOWNLOAD_TIMEOUT_MS?: string;
  TELEGRAM_INBOUND_ATTACHMENTS_ENABLED?: string;
  TELEGRAM_INBOUND_MAX_ATTACHMENT_BYTES?: string;
  TEMP_ATTACHMENT_SIGNING_SECRET?: string;
  TEMP_ATTACHMENT_TTL_SECONDS?: string;
  TEMP_ATTACHMENT_DIRECTORY?: string;
  WEBEX_TASKS_URL?: string;
  WEBEX_SUBSCRIPTIONS_URL?: string;
  WEBEX_ORG_ID?: string;
  WEBEX_WEBHOOK_URL?: string;
  WEBEX_WEBHOOK_SECRET?: string;
  WEBEX_DESTINATION_ID?: string;
  WEBEX_CHANNEL_NAME?: string;
  WEBEX_OUTBOUND_ATTACHMENTS_ENCRYPTED?: string;
  WEBEX_DECRYPTION_TIMEOUT_MS?: string;
  WEBEX_ACCESS_TOKEN?: string;
  WEBEX_CLIENT_ID?: string;
  WEBEX_CLIENT_SECRET?: string;
  WEBEX_REFRESH_TOKEN?: string;
  WEBEX_OAUTH_URL?: string;
  AGENT_CONNECTED_MESSAGE?: string;
};

export function runtimeEnv() {
  return process.env as RuntimeEnv;
}

function required(value: string | undefined, code: string) {
  const normalized = value?.trim();
  if (!normalized) throw new BridgeError(code, 503);
  return normalized;
}

export function telegramConfig() {
  const env = runtimeEnv();
  const requestedMaxAttachmentBytes = Number(
    env.TELEGRAM_MAX_ATTACHMENT_BYTES ?? 50 * 1024 * 1024,
  );
  const requestedDownloadTimeout = Number(
    env.TELEGRAM_ATTACHMENT_DOWNLOAD_TIMEOUT_MS ?? 30_000,
  );
  const requestedInboundMaxAttachmentBytes = Number(
    env.TELEGRAM_INBOUND_MAX_ATTACHMENT_BYTES ?? 20 * 1024 * 1024,
  );
  return {
    botToken: required(env.TELEGRAM_BOT_TOKEN, "TELEGRAM_TOKEN_MISSING"),
    webhookSecret: required(
      env.TELEGRAM_WEBHOOK_SECRET,
      "TELEGRAM_WEBHOOK_SECRET_MISSING",
    ),
    webhookUrl: required(
      env.TELEGRAM_WEBHOOK_URL,
      "TELEGRAM_WEBHOOK_URL_MISSING",
    ),
    apiBaseUrl: (
      env.TELEGRAM_API_BASE_URL ?? "https://api.telegram.org"
    ).replace(/\/$/, ""),
    allowGroups: env.TELEGRAM_ALLOW_GROUPS === "true",
    welcomeMessage:
      env.TELEGRAM_WELCOME_MESSAGE?.trim() ||
      "Hello! Send a message and we will connect you with support.",
    unsupportedMessage:
      env.TELEGRAM_UNSUPPORTED_MESSAGE?.trim() ||
      "This message type or attachment size is not supported.",
    outboundAttachmentMessage:
      env.TELEGRAM_OUTBOUND_ATTACHMENT_MESSAGE?.trim() ||
      "Support sent an attachment that could not be delivered through this channel.",
    outboundAttachmentsEnabled:
      env.TELEGRAM_OUTBOUND_ATTACHMENTS_ENABLED !== "false",
    maxAttachmentBytes:
      Number.isSafeInteger(requestedMaxAttachmentBytes) &&
      requestedMaxAttachmentBytes > 0
        ? Math.min(requestedMaxAttachmentBytes, 50 * 1024 * 1024)
        : 50 * 1024 * 1024,
    attachmentDownloadTimeoutMs:
      Number.isSafeInteger(requestedDownloadTimeout) &&
      requestedDownloadTimeout >= 1_000
        ? Math.min(requestedDownloadTimeout, 120_000)
        : 30_000,
    inboundAttachmentsEnabled:
      env.TELEGRAM_INBOUND_ATTACHMENTS_ENABLED === "true",
    inboundMaxAttachmentBytes:
      Number.isSafeInteger(requestedInboundMaxAttachmentBytes) &&
      requestedInboundMaxAttachmentBytes > 0
        ? Math.min(requestedInboundMaxAttachmentBytes, 20 * 1024 * 1024)
        : 20 * 1024 * 1024,
  };
}

export function temporaryAttachmentConfig() {
  const env = runtimeEnv();
  const webhookUrl = required(
    env.TELEGRAM_WEBHOOK_URL,
    "TELEGRAM_WEBHOOK_URL_MISSING",
  );
  const signingSecret = required(
    env.TEMP_ATTACHMENT_SIGNING_SECRET,
    "TEMP_ATTACHMENT_SIGNING_SECRET_MISSING",
  );
  const ttl = Number(env.TEMP_ATTACHMENT_TTL_SECONDS ?? 900);
  let publicOrigin: string;
  try {
    const url = new URL(webhookUrl);
    if (url.protocol !== "https:")
      throw new BridgeError("TEMP_ATTACHMENT_URL_NOT_HTTPS", 503);
    publicOrigin = url.origin;
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError("TEMP_ATTACHMENT_URL_INVALID", 503);
  }
  return {
    publicOrigin,
    signingSecret,
    ttlSeconds:
      Number.isSafeInteger(ttl) && ttl >= 60 ? Math.min(ttl, 3600) : 900,
    directory:
      env.TEMP_ATTACHMENT_DIRECTORY?.trim() ||
      "/tmp/relay-telegram-attachments",
  };
}

export function webexAttachmentsEncrypted() {
  return runtimeEnv().WEBEX_OUTBOUND_ATTACHMENTS_ENCRYPTED === "true";
}

export function webexDecryptionTimeoutMs() {
  const value = Number(runtimeEnv().WEBEX_DECRYPTION_TIMEOUT_MS ?? 60_000);
  return Number.isSafeInteger(value) && value >= 5_000
    ? Math.min(value, 120_000)
    : 60_000;
}

export function webexConfig() {
  const env = runtimeEnv();
  return {
    tasksUrl: required(env.WEBEX_TASKS_URL, "WEBEX_TASKS_URL_MISSING").replace(
      /\/$/,
      "",
    ),
    destinationId: required(
      env.WEBEX_DESTINATION_ID,
      "WEBEX_DESTINATION_MISSING",
    ),
    channelName: required(env.WEBEX_CHANNEL_NAME, "WEBEX_CHANNEL_NAME_MISSING"),
    webhookSecret: required(
      env.WEBEX_WEBHOOK_SECRET,
      "WEBEX_WEBHOOK_SECRET_MISSING",
    ),
  };
}

export function hasWebexAuthentication() {
  const env = runtimeEnv();
  return Boolean(
    env.WEBEX_ACCESS_TOKEN?.trim() ||
    (env.WEBEX_CLIENT_ID?.trim() &&
      env.WEBEX_CLIENT_SECRET?.trim() &&
      env.WEBEX_REFRESH_TOKEN?.trim()),
  );
}

export function configurationReadiness() {
  const env = runtimeEnv();
  return {
    database: Boolean(
      env.DATABASE_URL ||
      process.env.NODE_ENV !== "production" ||
      env.ALLOW_IN_MEMORY_DB === "true",
    ),
    logHashing: Boolean(env.LOG_HASH_SECRET?.trim()),
    externalIdentity: Boolean(env.EXTERNAL_ID_SECRET?.trim()),
    telegram: Boolean(
      env.TELEGRAM_BOT_TOKEN?.trim() &&
      env.TELEGRAM_WEBHOOK_SECRET?.trim() &&
      env.TELEGRAM_WEBHOOK_URL?.trim(),
    ),
    webexTasks: Boolean(
      env.WEBEX_TASKS_URL?.trim() &&
      env.WEBEX_DESTINATION_ID?.trim() &&
      env.WEBEX_CHANNEL_NAME?.trim() &&
      hasWebexAuthentication(),
    ),
    webexWebhook: Boolean(env.WEBEX_WEBHOOK_SECRET?.trim()),
    webexSubscriptions: Boolean(
      env.WEBEX_SUBSCRIPTIONS_URL?.trim() &&
      env.WEBEX_ORG_ID?.trim() &&
      env.WEBEX_WEBHOOK_URL?.trim() &&
      env.WEBEX_WEBHOOK_SECRET?.trim() &&
      hasWebexAuthentication(),
    ),
  };
}
