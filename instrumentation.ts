export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const [
    { ensureSchema },
    { logError, logInfo, safeErrorCode },
    { reconcileTelegramWebhook },
    { reconcileWebexSubscriptions },
  ] = await Promise.all([
    import("./db"),
    import("./lib/logger"),
    import("./lib/telegram/client"),
    import("./lib/webex/subscriptions"),
  ]);

  try {
    await ensureSchema();
    logInfo("service.startup_ready", { outcome: "accepted" });
  } catch (error) {
    logError("service.startup_failed", {
      outcome: "failed",
      code: safeErrorCode(error),
    });
  }
  await Promise.all([
    reconcileTelegramWebhook(),
    reconcileWebexSubscriptions(),
  ]);
}
