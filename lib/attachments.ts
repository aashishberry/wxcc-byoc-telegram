import { telegramConfig } from "./config";
import { BridgeError } from "./errors";
import type { WebexAttachment } from "./webex/types";

const mimeExtensions: Record<string, string> = {
  "application/pdf": "pdf",
  "application/zip": "zip",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "text/plain": "txt",
  "video/mp4": "mp4",
};

function attachmentUrl(attachment: WebexAttachment) {
  const raw = attachment.url ?? attachment.fileUrl;
  if (!raw) throw new BridgeError("ATTACHMENT_URL_MISSING", 422);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BridgeError("ATTACHMENT_URL_INVALID", 422);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !url.hostname
  )
    throw new BridgeError("ATTACHMENT_URL_UNSAFE", 422);
  return url;
}

function normalizedMimeType(value: string | null | undefined) {
  const mimeType = value?.split(";")[0]?.trim().toLowerCase();
  return mimeType &&
    /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mimeType)
    ? mimeType
    : "application/octet-stream";
}

function safeFilename(value: string | undefined, mimeType: string) {
  const basename = (value ?? "")
    .split(/[\\/]/)
    .pop()
    ?.replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"|?*]/g, "_")
    .trim()
    .slice(0, 180);
  if (basename) return basename;
  const extension = mimeExtensions[mimeType] ?? "bin";
  return `attachment.${extension}`;
}

export type DownloadedAttachment = {
  bytes: Uint8Array;
  fileName: string;
  mimeType: string;
  size: number;
};

export async function downloadWebexAttachment(
  attachment: WebexAttachment,
): Promise<DownloadedAttachment> {
  const config = telegramConfig();
  const url = attachmentUrl(attachment);
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(config.attachmentDownloadTimeoutMs),
    });
  } catch {
    throw new BridgeError("ATTACHMENT_DOWNLOAD_FAILED", 502, true);
  }
  if (!response.ok || !response.body)
    throw new BridgeError(`ATTACHMENT_HTTP_${response.status}`, 502, true);

  let finalUrl: URL;
  try {
    finalUrl = new URL(response.url || url);
  } catch {
    throw new BridgeError("ATTACHMENT_REDIRECT_INVALID", 502);
  }
  if (finalUrl.protocol !== "https:" || finalUrl.username || finalUrl.password)
    throw new BridgeError("ATTACHMENT_REDIRECT_UNSAFE", 502);

  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > config.maxAttachmentBytes
  )
    throw new BridgeError("ATTACHMENT_TOO_LARGE", 422);

  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > config.maxAttachmentBytes) {
        await reader.cancel();
        throw new BridgeError("ATTACHMENT_TOO_LARGE", 422);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError("ATTACHMENT_STREAM_FAILED", 502, true);
  }
  if (!size) throw new BridgeError("ATTACHMENT_EMPTY", 422);

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const mimeType = normalizedMimeType(
    attachment.mimeType ?? response.headers.get("content-type"),
  );
  return {
    bytes,
    size,
    mimeType,
    fileName: safeFilename(attachment.fileName, mimeType),
  };
}

export type TelegramAttachmentMethod =
  "sendAnimation" | "sendAudio" | "sendDocument" | "sendPhoto" | "sendVideo";

export function telegramAttachmentMethod(
  mimeType: string,
  size: number,
): TelegramAttachmentMethod {
  if (
    ["image/jpeg", "image/png", "image/webp"].includes(mimeType) &&
    size <= 10 * 1024 * 1024
  )
    return "sendPhoto";
  if (mimeType === "image/gif") return "sendAnimation";
  if (mimeType === "video/mp4") return "sendVideo";
  if (["audio/mpeg", "audio/mp4"].includes(mimeType)) return "sendAudio";
  return "sendDocument";
}

export function attachmentField(method: TelegramAttachmentMethod) {
  return {
    sendAnimation: "animation",
    sendAudio: "audio",
    sendDocument: "document",
    sendPhoto: "photo",
    sendVideo: "video",
  }[method];
}
