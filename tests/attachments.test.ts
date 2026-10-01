import assert from "node:assert/strict";
import { unlink } from "node:fs/promises";
import test from "node:test";

import {
  attachmentField,
  downloadWebexAttachment,
  telegramAttachmentMethod,
} from "../lib/attachments";
import {
  decodeTemporaryAttachmentToken,
  storeTemporaryAttachment,
} from "../lib/temp-attachments";
import { telegramInboundAttachment } from "../lib/telegram/attachments";
import { createWebexTask } from "../lib/webex/client";
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

test("Telegram inbound media keeps safe file metadata", () => {
  const attachment = telegramInboundAttachment({
    message_id: 1,
    date: 1,
    chat: { id: 1, type: "private" },
    document: {
      file_id: "telegram-file",
      file_name: "../../invoice?.pdf",
      mime_type: "application/pdf",
      file_size: 1024,
    },
  });
  assert.deepEqual(attachment, {
    fileId: "telegram-file",
    fileName: "invoice_.pdf",
    mimeType: "application/pdf",
    fileSize: 1024,
  });
});

test("temporary attachment URLs are signed and preserve exact size", async () => {
  process.env.TELEGRAM_WEBHOOK_URL =
    "https://bridge.example/api/webhooks/telegram";
  process.env.TEMP_ATTACHMENT_SIGNING_SECRET = "test-signing-secret";
  process.env.TEMP_ATTACHMENT_DIRECTORY = `/tmp/relay-attachment-test-${process.pid}`;
  const stored = await storeTemporaryAttachment({
    bytes: new TextEncoder().encode("file-content"),
    fileName: "invoice.pdf",
    mimeType: "application/pdf",
  });
  const url = new URL(stored.fileUrl);
  const token = url.pathname.split("/")[3];
  const decoded = decodeTemporaryAttachmentToken(token);
  try {
    assert.equal(decoded.size, 12);
    assert.equal(decoded.mimeType, "application/pdf");
    assert.match(decoded.name, /^attachment-[a-f0-9-]{36}\.pdf$/);
    assert.throws(
      () => decodeTemporaryAttachmentToken(`${token}x`),
      /TEMP_ATTACHMENT_TOKEN_INVALID/,
    );
  } finally {
    await unlink(decoded.path);
  }
});

test("Webex create task uses text-with-attachments payload", async () => {
  process.env.WEBEX_ACCESS_TOKEN = "test-token";
  process.env.WEBEX_TASKS_URL = "https://webex.example/v2/tasks";
  process.env.WEBEX_DESTINATION_ID = "support@example.com";
  process.env.WEBEX_CHANNEL_NAME = "telegram";
  process.env.WEBEX_WEBHOOK_SECRET = "test-webhook-secret";
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ data: { id: "task-1" } }, { status: 201 });
  };
  try {
    await createWebexTask({
      originId: "opaque-origin",
      aliasId: crypto.randomUUID(),
      text: "",
      timestamp: Date.now(),
      attachments: [
        {
          fileName: "invoice.pdf",
          mimeType: "application/pdf",
          fileUrl: "https://bridge.example/api/attachments/signed/file.pdf",
        },
      ],
    });
    const channelParams = requestBody?.channelParams as {
      type?: string;
      message?: { attachments?: unknown[] };
    };
    assert.equal(channelParams.type, "text-with-attachments");
    assert.equal(channelParams.message?.attachments?.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
