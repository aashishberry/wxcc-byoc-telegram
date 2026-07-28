import assert from "node:assert/strict";
import test from "node:test";

import { safeReasonCode, safeRef, safeToken } from "../lib/logger";
import {
  telegramWebhookSecretIsValid,
  verifyTelegramWebhookSecret,
} from "../lib/telegram/client";

test("Telegram webhook secret uses exact constant-time comparison semantics", () => {
  assert.equal(
    verifyTelegramWebhookSecret("expected_123", "expected_123"),
    true,
  );
  assert.equal(verifyTelegramWebhookSecret("wrong", "expected_123"), false);
  assert.equal(verifyTelegramWebhookSecret(null, "expected_123"), false);
});

test("Telegram accepts only Bot API-compatible webhook secrets", () => {
  assert.equal(telegramWebhookSecretIsValid("Alpha-123_under"), true);
  assert.equal(telegramWebhookSecretIsValid("contains space"), false);
  assert.equal(telegramWebhookSecretIsValid(""), false);
});

test("safe references do not expose the source identifier", () => {
  process.env.LOG_HASH_SECRET = "test-only-log-secret";
  const raw = "telegram-user-123456";
  const reference = safeRef(raw);

  assert.equal(reference.length, 16);
  assert.equal(reference.includes(raw), false);
  assert.equal(reference, safeRef(raw));
});

test("unrecognized Webex reasons are never copied into logs", () => {
  assert.equal(String(safeReasonCode("customer@example.com")), "UNDISCLOSED");
  assert.equal(String(safeReasonCode("INVALID_CONTENT")), "INVALID_CONTENT");
});

test("safeToken strips unsafe characters from controlled metadata", () => {
  assert.equal(String(safeToken("task:ended")), "TASK:ENDED");
  assert.equal(String(safeToken("bad value\nnext")), "BAD_VALUE_NEXT");
});
