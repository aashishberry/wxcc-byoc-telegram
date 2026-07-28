import assert from "node:assert/strict";
import test from "node:test";

import {
  attachmentField,
  downloadWebexAttachment,
  telegramAttachmentMethod,
} from "../lib/attachments";
import { BridgeError } from "../lib/errors";

process.env.TELEGRAM_BOT_TOKEN = "attachment-test-token";
process.env.TELEGRAM_WEBHOOK_SECRET = "attachment_test_secret";
process.env.TELEGRAM_WEBHOOK_URL =
  "https://bridge.example/api/webhooks/telegram";
process.env.TELEGRAM_MAX_ATTACHMENT_BYTES = "32";

test("attachment method follows MIME type and photo size", () => {
  assert.equal(telegramAttachmentMethod("image/png", 1024), "sendPhoto");
  assert.equal(
    telegramAttachmentMethod("image/png", 11 * 1024 * 1024),
    "sendDocument",
  );
  assert.equal(telegramAttachmentMethod("video/mp4", 1024), "sendVideo");
  assert.equal(telegramAttachmentMethod("audio/mpeg", 1024), "sendAudio");
  assert.equal(
    telegramAttachmentMethod("application/pdf", 1024),
    "sendDocument",
  );
  assert.equal(attachmentField("sendDocument"), "document");
});

test("Webex attachment download preserves safe metadata", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: {
        "content-length": "4",
        "content-type": "application/octet-stream",
      },
    });

  try {
    const attachment = await downloadWebexAttachment({
      url: "https://files.example/signed-download",
      fileName: "../report.pdf",
      mimeType: "application/pdf",
    });
    assert.equal(attachment.fileName, "report.pdf");
    assert.equal(attachment.mimeType, "application/pdf");
    assert.equal(attachment.size, 4);
    assert.deepEqual([...attachment.bytes], [1, 2, 3, 4]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("attachment download rejects unsafe URLs before making a request", async () => {
  await assert.rejects(
    downloadWebexAttachment({
      url: "http://127.0.0.1/private",
      fileName: "private.txt",
    }),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "ATTACHMENT_URL_UNSAFE",
  );
});

test("attachment stream is stopped at the configured limit", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(new Uint8Array(33), {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    });

  try {
    await assert.rejects(
      downloadWebexAttachment({
        url: "https://files.example/oversize",
        fileName: "oversize.bin",
      }),
      (error: unknown) =>
        error instanceof BridgeError && error.code === "ATTACHMENT_TOO_LARGE",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
