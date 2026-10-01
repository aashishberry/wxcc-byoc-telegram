import { readFile, stat } from "node:fs/promises";

import { BridgeError } from "@/lib/errors";
import { decodeTemporaryAttachmentToken } from "@/lib/temp-attachments";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function attachment(
  _request: Request,
  context: { params: Promise<{ token: string; name: string }> },
  includeBody: boolean,
) {
  try {
    const { token, name } = await context.params;
    const data = decodeTemporaryAttachmentToken(token);
    if (name !== data.name)
      throw new BridgeError("TEMP_ATTACHMENT_NAME_INVALID", 404);
    if ((await stat(data.path)).size !== data.size)
      throw new BridgeError("TEMP_ATTACHMENT_SIZE_MISMATCH", 404);
    const headers = {
      "Cache-Control": "private, no-store",
      "Content-Length": String(data.size),
      "Content-Type": data.mimeType,
      "Content-Disposition": `attachment; filename="${data.name}"`,
      "X-Content-Type-Options": "nosniff",
    };
    if (!includeBody) return new Response(null, { status: 200, headers });
    const bytes = await readFile(data.path);
    return new Response(bytes, { status: 200, headers });
  } catch (error) {
    const status = error instanceof BridgeError ? error.httpStatus : 404;
    return new Response(null, { status });
  }
}

export function GET(
  request: Request,
  context: { params: Promise<{ token: string; name: string }> },
) {
  return attachment(request, context, true);
}

export function HEAD(
  request: Request,
  context: { params: Promise<{ token: string; name: string }> },
) {
  return attachment(request, context, false);
}
