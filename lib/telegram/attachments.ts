import path from "node:path";

import type {
  TelegramFileReference,
  TelegramMessage,
} from "./types";

export type TelegramInboundAttachment = {
  fileId: string;
  fileName: string;
  mimeType: string;
  fileSize?: number;
};

function safeFilename(value: string | undefined, fallback: string) {
  const filename = path
    .basename(value?.trim() || fallback)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"|?*]/g, "_")
    .slice(0, 180);
  return filename || fallback;
}

function fromFile(
  file: TelegramFileReference | undefined,
  fallbackName: string,
  fallbackMimeType: string,
): TelegramInboundAttachment | undefined {
  if (!file?.file_id) return;
  return {
    fileId: file.file_id,
    fileName: safeFilename(file.file_name, fallbackName),
    mimeType: file.mime_type?.trim().toLowerCase() || fallbackMimeType,
    fileSize: file.file_size,
  };
}

export function telegramInboundAttachment(
  message: TelegramMessage,
): TelegramInboundAttachment | undefined {
  if (message.document)
    return fromFile(
      message.document,
      "document.bin",
      "application/octet-stream",
    );
  if (message.audio)
    return fromFile(message.audio, "audio.mp3", "audio/mpeg");
  if (message.video)
    return fromFile(message.video, "video.mp4", "video/mp4");
  if (message.voice)
    return fromFile(message.voice, "voice.ogg", "audio/ogg");
  if (message.video_note)
    return fromFile(message.video_note, "video-note.mp4", "video/mp4");
  if (message.animation)
    return fromFile(message.animation, "animation.gif", "image/gif");
  if (message.photo?.length) {
    const photo = [...message.photo].sort(
      (left, right) =>
        (right.file_size ?? right.width ?? 0) -
        (left.file_size ?? left.width ?? 0),
    )[0];
    return fromFile(photo, "photo.jpg", "image/jpeg");
  }
}

export function hasUnsupportedTelegramContent(message: TelegramMessage) {
  return Boolean(message.sticker || message.location || message.contact);
}
