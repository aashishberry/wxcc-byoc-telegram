import { runtimeEnv, telegramConfig } from "../config";
import { BridgeError } from "../errors";
import {
  logError,
  logInfo,
  logWarn,
  safeErrorCode,
  safeReasonCode,
  safeRef,
  safeToken,
} from "../logger";
import {
  claimWebexEvent,
  conversationByTask,
  finishWebexEvent,
  updateConversationStatus,
} from "../store";
import { deliverTelegramText } from "../telegram/delivery";
import { verifyWebexWebhook } from "./signature";
import type { WebexEvent } from "./types";

const taskStatuses: Record<string, string> = {
  "task:new": "created",
  "task:parked": "queued",
  "task:connected": "connected",
  "task:ended": "ended",
  "task:failed": "failed",
};

function normalizeTimestamp(value: unknown, fallback = Date.now()) {
  let timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return fallback;
  if (timestamp < 100_000_000_000) timestamp *= 1000;
  if (timestamp > 100_000_000_000_000) timestamp /= 1000;
  return Math.round(timestamp);
}

function taskIdFor(event: WebexEvent) {
  return (
    event.data?.taskId ??
    (event.type?.startsWith("task:") ? event.id : undefined)
  );
}

function eventBelongsToTelegramChannel(event: WebexEvent) {
  const configured = runtimeEnv().WEBEX_CHANNEL_NAME?.trim();
  return (
    !event.data?.channel || !configured || event.data.channel === configured
  );
}

export async function handleWebexWebhook(rawBody: string, request: Request) {
  let event: WebexEvent;
  try {
    event = JSON.parse(rawBody) as WebexEvent;
  } catch {
    logWarn("webex.webhook_rejected", {
      provider: "webex",
      outcome: "rejected",
      code: safeToken("INVALID_JSON"),
    });
    throw new BridgeError("WEBEX_INVALID_JSON", 400);
  }

  const taskId = taskIdFor(event);
  const eventRef = safeRef(event.id);
  const taskRef = safeRef(taskId);
  const eventType = safeToken(event.type);
  logInfo("webex.webhook_received", {
    provider: "webex",
    outcome: "accepted",
    updateRef: eventRef,
    taskRef,
    eventType,
  });

  const verification = verifyWebexWebhook(
    rawBody,
    request,
    event.comciscotimestamp,
  );
  if (!verification.valid) {
    logWarn("webex.webhook_rejected", {
      provider: "webex",
      outcome: "rejected",
      updateRef: eventRef,
      taskRef,
      eventType,
      code: safeToken("VERIFICATION_FAILED"),
    });
    throw new BridgeError("WEBEX_VERIFICATION_FAILED", 401);
  }
  if (!event.id || !event.type)
    throw new BridgeError("WEBEX_EVENT_FIELDS_MISSING", 400);

  if (!eventBelongsToTelegramChannel(event)) {
    logInfo("webex.webhook_accepted", {
      provider: "webex",
      outcome: "ignored",
      updateRef: eventRef,
      taskRef,
      eventType,
      code: safeToken("OTHER_CHANNEL"),
    });
    return { outcome: "ignored" as const };
  }

  const now = normalizeTimestamp(
    event.comciscotimestamp,
    normalizeTimestamp(event.data?.createdTime),
  );
  const eventKey = [event.id, event.type, taskId ?? "", now].join(":");
  const claim = await claimWebexEvent({
    eventKey,
    taskId,
    eventType: event.type,
    now,
  });
  if (claim === "duplicate") {
    logInfo("webex.webhook_duplicate", {
      provider: "webex",
      outcome: "accepted",
      updateRef: eventRef,
      taskRef,
      eventType,
    });
    return { outcome: "duplicate" as const };
  }
  if (claim === "busy") throw new BridgeError("WEBEX_EVENT_BUSY", 503, true);

  try {
    const status = taskStatuses[event.type];
    if (taskId && status) await updateConversationStatus(taskId, status, now);

    if (event.type === "task:connected" && taskId) {
      const conversation = await conversationByTask(taskId);
      if (!conversation)
        throw new BridgeError("WEBEX_CONVERSATION_NOT_READY", 503, true);
      const text =
        runtimeEnv().AGENT_CONNECTED_MESSAGE?.trim() ||
        "You're now connected to a support agent. They'll be with you shortly.";
      await deliverTelegramText({
        taskId,
        deliveryKey: `connected:${taskId}`,
        text,
      });
    } else if (
      event.type === "task-message:appended" &&
      event.data?.messageDirection === "OUTBOUND" &&
      taskId
    ) {
      const conversation = await conversationByTask(taskId);
      if (!conversation)
        throw new BridgeError("WEBEX_CONVERSATION_NOT_READY", 503, true);
      const message = event.data.channelParams?.message;
      const hasAttachments = Boolean(message?.attachments?.length);
      const text =
        message?.text?.trim() ||
        (hasAttachments ? telegramConfig().outboundAttachmentMessage : "");
      if (text) {
        await deliverTelegramText({
          taskId,
          deliveryKey: `webex:${message?.aliasId ?? event.id}`,
          text,
        });
      }
    }

    await finishWebexEvent(eventKey, "completed");
    logInfo("webex.webhook_accepted", {
      provider: "webex",
      outcome: "accepted",
      updateRef: eventRef,
      taskRef,
      eventType,
      status: status ? safeToken(status) : undefined,
      code:
        event.type === "task:failed"
          ? safeReasonCode(event.data?.reason)
          : undefined,
    });
    return { outcome: "accepted" as const, taskId, eventType: event.type };
  } catch (error) {
    await finishWebexEvent(eventKey, "failed");
    logError("webex.webhook_failed", {
      provider: "webex",
      outcome: "failed",
      updateRef: eventRef,
      taskRef,
      eventType,
      code: safeErrorCode(error),
    });
    throw error;
  }
}
