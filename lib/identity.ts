import { createHmac } from "node:crypto";

import { runtimeEnv } from "./config";
import { BridgeError } from "./errors";

export function webexOriginId(provider: string, externalUserId: string) {
  const secret = runtimeEnv().EXTERNAL_ID_SECRET?.trim();
  if (!secret) throw new BridgeError("EXTERNAL_ID_SECRET_MISSING", 503);
  const digest = createHmac("sha256", secret)
    .update(`${provider}:${externalUserId}`)
    .digest("hex");
  return `${provider}:${digest}`;
}
