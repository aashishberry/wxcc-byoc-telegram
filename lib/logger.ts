import { createHmac, randomBytes } from "node:crypto";

import { runtimeEnv } from "./config";
import { bridgeErrorCode } from "./errors";

declare const safeRefBrand: unique symbol;
declare const safeTokenBrand: unique symbol;

export type SafeRef = string & { readonly [safeRefBrand]: true };
export type SafeToken = string & { readonly [safeTokenBrand]: true };

export type LogEvent =
  | "service.startup_ready"
  | "service.startup_failed"
  | "health.failed"
  | "telegram.webhook_received"
  | "telegram.webhook_rejected"
  | "telegram.webhook_duplicate"
  | "telegram.webhook_busy"
  | "telegram.message_ignored"
  | "telegram.message_forwarded"
  | "telegram.message_failed"
  | "telegram.delivery_sent"
  | "telegram.delivery_failed"
  | "telegram.webhook_sync"
  | "telegram.webhook_sync_failed"
  | "webex.webhook_received"
  | "webex.webhook_rejected"
  | "webex.webhook_duplicate"
  | "webex.webhook_accepted"
  | "webex.webhook_failed"
  | "webex.subscription_sync"
  | "webex.subscription_sync_failed";

export type SafeLogFields = {
  provider?: "telegram" | "webex";
  outcome?: "accepted" | "rejected" | "ignored" | "sent" | "failed";
  updateRef?: SafeRef;
  taskRef?: SafeRef;
  deliveryRef?: SafeRef;
  eventType?: SafeToken;
  code?: SafeToken;
  status?: SafeToken;
  httpStatus?: number;
  count?: number;
  configured?: boolean;
};

const processSalt = randomBytes(32);

export function safeRef(value: string | number | null | undefined): SafeRef {
  if (value == null || value === "") return "none" as SafeRef;
  const configuredSecret = runtimeEnv().LOG_HASH_SECRET?.trim();
  const key = configuredSecret ? Buffer.from(configuredSecret) : processSalt;
  return createHmac("sha256", key)
    .update(String(value))
    .digest("hex")
    .slice(0, 16) as SafeRef;
}

export function safeToken(
  value: string | null | undefined,
  fallback = "UNKNOWN",
): SafeToken {
  const normalized = value?.toUpperCase().replace(/[^A-Z0-9_.:-]/g, "_");
  return (normalized?.slice(0, 80) || fallback) as SafeToken;
}

export function safeErrorCode(error: unknown) {
  return safeToken(bridgeErrorCode(error));
}

const documentedReasonCodes = new Set([
  "CHANNEL_ASSET_UNDEFINED",
  "CONVERSATION_ALREADY_OPEN",
  "CONVERSATION_CREATION_FAILED",
  "ENTRY_POINT_NOT_FOUND",
  "FEATURE_FLAG_DISABLED",
  "INTERNAL_ERROR",
  "INVALID_CONTENT",
  "NOT_FOUND",
  "ORG_DIGITAL_CONTACT_LIMIT_EXCEEDED",
]);

export function safeReasonCode(value: string | null | undefined) {
  const normalized = value?.trim().toUpperCase();
  return safeToken(
    normalized && documentedReasonCodes.has(normalized)
      ? normalized
      : "UNDISCLOSED",
  );
}

function entry(event: LogEvent, fields: SafeLogFields) {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    event,
    ...fields,
  });
}

export function logInfo(event: LogEvent, fields: SafeLogFields = {}) {
  console.info(entry(event, fields));
}

export function logWarn(event: LogEvent, fields: SafeLogFields = {}) {
  console.warn(entry(event, fields));
}

export function logError(event: LogEvent, fields: SafeLogFields = {}) {
  console.error(entry(event, fields));
}
