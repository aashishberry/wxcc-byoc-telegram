import { telegramConfig } from "../../../../lib/config";
import { BridgeError } from "../../../../lib/errors";
import {
  logInfo,
  logWarn,
  safeErrorCode,
  safeRef,
  safeToken,
} from "../../../../lib/logger";
import { verifyTelegramWebhookSecret } from "../../../../lib/telegram/client";
import { processTelegramUpdate } from "../../../../lib/telegram/handler";
import type { TelegramUpdate } from "../../../../lib/telegram/types";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const config = telegramConfig();
    const suppliedSecret = request.headers.get(
      "x-telegram-bot-api-secret-token",
    );
    if (!verifyTelegramWebhookSecret(suppliedSecret, config.webhookSecret)) {
      logWarn("telegram.webhook_rejected", {
        provider: "telegram",
        outcome: "rejected",
        code: safeToken("VERIFICATION_FAILED"),
      });
      return Response.json({ ok: false }, { status: 401 });
    }

    let update: TelegramUpdate;
    try {
      update = (await request.json()) as TelegramUpdate;
    } catch {
      logWarn("telegram.webhook_rejected", {
        provider: "telegram",
        outcome: "rejected",
        code: safeToken("INVALID_JSON"),
      });
      return Response.json({ ok: false }, { status: 400 });
    }
    logInfo("telegram.webhook_received", {
      provider: "telegram",
      outcome: "accepted",
      updateRef: safeRef(update.update_id),
    });
    await processTelegramUpdate(update);
    return Response.json({ ok: true });
  } catch (error) {
    const status = error instanceof BridgeError ? error.httpStatus : 500;
    logWarn("telegram.webhook_rejected", {
      provider: "telegram",
      outcome: "failed",
      code: safeErrorCode(error),
      httpStatus: status,
    });
    return Response.json({ ok: false, retryable: status >= 500 }, { status });
  }
}
