import { ensureSchema } from "../../../db";
import { configurationReadiness } from "../../../lib/config";
import { logError, safeErrorCode } from "../../../lib/logger";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await ensureSchema();
    const configuration = configurationReadiness();
    const ready = Object.values(configuration).every(Boolean);
    return Response.json({
      status: ready ? "ok" : "degraded",
      service: "relay-webex-telegram-middleware",
      configuration,
    });
  } catch (error) {
    logError("health.failed", {
      outcome: "failed",
      code: safeErrorCode(error),
    });
    return Response.json(
      {
        status: "error",
        service: "relay-webex-telegram-middleware",
      },
      { status: 503 },
    );
  }
}
