import { runtimeEnv } from "../config";
import { BridgeError } from "../errors";
import { logError, logInfo, safeErrorCode, safeToken } from "../logger";
import { webexJsonRequest } from "./client";

type WebexSubscription = {
  id?: string;
  subscriptionId?: string;
  name?: string;
  eventTypes?: string[];
  destinationUrl?: string;
  resourceVersion?: string;
  status?: string;
  active?: boolean;
};

type DesiredSubscription = {
  name: string;
  description: string;
  eventTypes: string[];
  resourceVersion: string;
};

const managedSubscriptionIds = new Set<string>();

function subscriptionId(subscription: WebexSubscription | undefined) {
  return subscription?.id ?? subscription?.subscriptionId;
}

function rememberManagedSubscription(
  subscription: WebexSubscription | undefined,
) {
  const id = subscriptionId(subscription);
  if (id) managedSubscriptionIds.add(id);
}

function subscriptionFromResponse(body: unknown) {
  if (!body || typeof body !== "object") return;
  const record = body as Record<string, unknown>;
  if (record.data && typeof record.data === "object")
    return record.data as WebexSubscription;
  return record as WebexSubscription;
}

export function webexWebhookSourceKind(source: string | undefined) {
  const id = source?.split("/").filter(Boolean).at(-1);
  if (!id) return "UNKNOWN";
  return managedSubscriptionIds.has(id)
    ? "MANAGED_SUBSCRIPTION"
    : "ASSET_OR_UNMANAGED";
}

const desiredSubscriptions: DesiredSubscription[] = [
  {
    name: "telegram-bridge-task-lifecycle",
    description: "Task lifecycle events for the Telegram messaging bridge",
    eventTypes: [
      "task:new",
      "task:connect",
      "task:connected",
      "task:parked",
      "task:ended",
      "task:failed",
    ],
    resourceVersion: "task:1.0.0",
  },
  {
    name: "telegram-bridge-task-messages",
    description: "Inbound task-message events for the Telegram bridge",
    eventTypes: ["task-message:appended", "task-message:append-failed"],
    resourceVersion: "task-message:1.0.0",
  },
];

function config() {
  const env = runtimeEnv();
  const subscriptionsUrl = env.WEBEX_SUBSCRIPTIONS_URL?.trim();
  const orgId = env.WEBEX_ORG_ID?.trim();
  const destinationUrl = env.WEBEX_WEBHOOK_URL?.trim();
  const secret = env.WEBEX_WEBHOOK_SECRET?.trim();
  if (!subscriptionsUrl || !orgId || !destinationUrl || !secret)
    throw new BridgeError("WEBEX_SUBSCRIPTION_CONFIG_MISSING", 503);
  const destination = new URL(destinationUrl);
  if (destination.protocol !== "https:" || destination.search)
    throw new BridgeError("WEBEX_SUBSCRIPTION_URL_INVALID", 503);
  return { subscriptionsUrl, orgId, destinationUrl, secret };
}

function subscriptionArray(body: unknown): WebexSubscription[] {
  if (Array.isArray(body)) return body as WebexSubscription[];
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  if (Array.isArray(record.data)) return record.data as WebexSubscription[];
  if (record.data && typeof record.data === "object") {
    const data = record.data as Record<string, unknown>;
    if (Array.isArray(data.items)) return data.items as WebexSubscription[];
    if (Array.isArray(data.subscriptions))
      return data.subscriptions as WebexSubscription[];
  }
  if (Array.isArray(record.items)) return record.items as WebexSubscription[];
  if (Array.isArray(record.subscriptions))
    return record.subscriptions as WebexSubscription[];
  return [];
}

function sameEvents(left: string[] = [], right: string[] = []) {
  return [...left].sort().join("\n") === [...right].sort().join("\n");
}

function isActive(
  subscription: WebexSubscription,
  desired: DesiredSubscription,
  destinationUrl: string,
) {
  return (
    subscription.destinationUrl === destinationUrl &&
    subscription.resourceVersion === desired.resourceVersion &&
    sameEvents(subscription.eventTypes, desired.eventTypes) &&
    subscription.active !== false &&
    !["disabled", "inactive"].includes(subscription.status?.toLowerCase() ?? "")
  );
}

export async function reconcileWebexSubscriptions() {
  const env = runtimeEnv();
  const hasAnyConfiguration = Boolean(
    env.WEBEX_SUBSCRIPTIONS_URL || env.WEBEX_ORG_ID || env.WEBEX_WEBHOOK_URL,
  );
  if (!hasAnyConfiguration) return;

  try {
    const settings = config();
    const listUrl = new URL(settings.subscriptionsUrl);
    listUrl.searchParams.set("orgId", settings.orgId);
    const existing = subscriptionArray(
      await webexJsonRequest(listUrl.toString()),
    );
    let created = 0;
    let drifted = 0;
    for (const desired of desiredSubscriptions) {
      const matches = existing.filter((item) => item.name === desired.name);
      matches.forEach(rememberManagedSubscription);
      if (
        matches.some((item) => isActive(item, desired, settings.destinationUrl))
      )
        continue;
      if (matches.length) {
        drifted += 1;
        continue;
      }
      const createdSubscription = subscriptionFromResponse(
        await webexJsonRequest(settings.subscriptionsUrl, {
          method: "POST",
          body: JSON.stringify({
            ...desired,
            destinationUrl: settings.destinationUrl,
            secret: settings.secret,
            orgId: settings.orgId,
          }),
        }),
      );
      rememberManagedSubscription(createdSubscription);
      created += 1;
    }
    logInfo("webex.subscription_sync", {
      provider: "webex",
      outcome: "accepted",
      count: created,
      status: safeToken(drifted ? "DRIFT_REVIEW_REQUIRED" : "READY"),
      configured: true,
    });
  } catch (error) {
    logError("webex.subscription_sync_failed", {
      provider: "webex",
      outcome: "failed",
      code: safeErrorCode(error),
    });
  }
}
