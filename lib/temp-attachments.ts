import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, open, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

import { temporaryAttachmentConfig } from "./config";
import { BridgeError } from "./errors";

const idPattern = /^[a-f0-9-]{36}$/;
const extensionPattern = /^[a-z0-9]{1,10}$/;

type TemporaryAttachmentToken = {
  id: string;
  exp: number;
  size: number;
  mimeType: string;
  name: string;
};

function signature(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeMimeType(value: string | undefined) {
  const mimeType = value?.split(";")[0]?.trim().toLowerCase();
  return mimeType &&
    /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mimeType)
    ? mimeType
    : "application/octet-stream";
}

function extension(fileName: string | undefined) {
  const value = path.extname(fileName ?? "").slice(1).toLowerCase();
  return extensionPattern.test(value) ? value : "bin";
}

function encodeToken(data: TemporaryAttachmentToken, secret: string) {
  const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
  return `${payload}.${signature(payload, secret)}`;
}

export function decodeTemporaryAttachmentToken(token: string) {
  const config = temporaryAttachmentConfig();
  const [payload, suppliedSignature, ...rest] = token.split(".");
  if (!payload || !suppliedSignature || rest.length)
    throw new BridgeError("TEMP_ATTACHMENT_TOKEN_INVALID", 404);
  const expectedSignature = signature(payload, config.signingSecret);
  const left = Buffer.from(suppliedSignature);
  const right = Buffer.from(expectedSignature);
  if (left.length !== right.length || !timingSafeEqual(left, right))
    throw new BridgeError("TEMP_ATTACHMENT_TOKEN_INVALID", 404);
  let data: TemporaryAttachmentToken;
  try {
    data = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as TemporaryAttachmentToken;
  } catch {
    throw new BridgeError("TEMP_ATTACHMENT_TOKEN_INVALID", 404);
  }
  if (
    !idPattern.test(data.id) ||
    !Number.isSafeInteger(data.exp) ||
    data.exp <= Date.now() ||
    !Number.isSafeInteger(data.size) ||
    data.size <= 0 ||
    typeof data.mimeType !== "string" ||
    typeof data.name !== "string"
  )
    throw new BridgeError("TEMP_ATTACHMENT_TOKEN_EXPIRED", 404);
  return {
    ...data,
    path: path.join(config.directory, data.id),
  };
}

async function cleanupExpiredFiles(directory: string, ttlSeconds: number) {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return;
  }
  const cutoff = Date.now() - ttlSeconds * 1000;
  await Promise.all(
    entries
      .filter((entry) => idPattern.test(entry))
      .map(async (entry) => {
        const filePath = path.join(directory, entry);
        try {
          if ((await stat(filePath)).mtimeMs < cutoff) await unlink(filePath);
        } catch {
          // Best-effort expiry cleanup; a concurrent read or deletion is safe.
        }
      }),
  );
}

export async function storeTemporaryAttachment(input: {
  bytes: Uint8Array;
  fileName?: string;
  mimeType?: string;
}) {
  const config = temporaryAttachmentConfig();
  const id = randomUUID();
  const ext = extension(input.fileName);
  const publicName = `attachment-${id}.${ext}`;
  const filePath = path.join(config.directory, id);
  await mkdir(config.directory, { recursive: true, mode: 0o700 });
  const file = await open(filePath, "wx", 0o600);
  try {
    await file.writeFile(input.bytes);
  } finally {
    await file.close();
  }
  void cleanupExpiredFiles(config.directory, config.ttlSeconds);

  const data: TemporaryAttachmentToken = {
    id,
    exp: Date.now() + config.ttlSeconds * 1000,
    size: input.bytes.byteLength,
    mimeType: safeMimeType(input.mimeType),
    name: publicName,
  };
  const token = encodeToken(data, config.signingSecret);
  return {
    fileUrl: `${config.publicOrigin}/api/attachments/${token}/${publicName}`,
    fileName: input.fileName?.trim() || publicName,
    mimeType: data.mimeType,
  };
}
