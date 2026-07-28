import { createHmac, timingSafeEqual } from "node:crypto";

import { runtimeEnv } from "../config";
import { BridgeError } from "../errors";

export function verifyWebexWebhook(
  rawBody: string,
  request: Request,
  bodyTimestamp?: number | string,
) {
  const secret = runtimeEnv().WEBEX_WEBHOOK_SECRET?.trim();
  if (!secret) throw new BridgeError("WEBEX_WEBHOOK_SECRET_MISSING", 503);

  const supplied = request.headers.get("x-webexcc-signature") ?? "";
  const computed = createHmac("sha256", secret).update(rawBody).digest("hex");
  const left = Buffer.from(supplied);
  const right = Buffer.from(computed);
  const signatureMatches =
    left.length === right.length && timingSafeEqual(left, right);

  const version = request.headers.get("x-webexcc-webhook-version");
  const headerTimestamp = Number(request.headers.get("x-webexcc-timestamp"));
  const timestampMatches =
    !version ||
    (Number.isFinite(headerTimestamp) &&
      Number(bodyTimestamp) === headerTimestamp);
  const fresh =
    !version ||
    (Number.isFinite(headerTimestamp) &&
      Math.abs(Date.now() - headerTimestamp) <= 5 * 60 * 1000);

  return {
    valid: signatureMatches && timestampMatches && fresh,
    signatureMatches,
    timestampMatches,
    fresh,
  };
}
