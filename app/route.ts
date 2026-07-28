export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({
    service: "relay-webex-telegram-middleware",
    status: "running",
    health: "/api/health",
    webhooks: {
      telegram: "/api/webhooks/telegram",
      webex: "/api/webhooks/webex",
    },
  });
}
