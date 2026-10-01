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
import {
  deliverTelegramAttachments,
  deliverTelegramText,
} from "../telegram/delivery";
import { extractWebexMessage, webexPayloadHints } from "./message";
import { verifyWebexWebhook } from "./signature";
import { webexWebhookSourceKind } from "./subscriptions";
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

function normalizedEventValue(value: string | undefined) {
  return value?.trim().toUpperCase();
}

function outboundMessage(event: WebexEvent) {
  const direction = normalizedEventValue(event.data?.messageDirection);
  const senderType = normalizedEventValue(event.data?.senderType);
  return (
    direction === "OUTBOUND" ||
    senderType === "AGENT" ||
    senderType === "SYSTEM"
  );
}

function messageClassification(event: WebexEvent) {
  if (event.type !== "task-message:appended") return;
  if (outboundMessage(event)) return "OUTBOUND_ASSET";
  if (normalizedEventValue(event.data?.messageDirection) === "INBOUND")
    return "INBOUND_SUBSCRIPTION_ACK";
  return "UNCLASSIFIED_MESSAGE";
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
  const webhookVersion = safeToken(
    request.headers.get("x-webexcc-webhook-version"),
  );
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
    let messageStatus = messageClassification(event);
    const extractedMessage =
      event.type === "task-message:appended"
        ? extractWebexMessage(event)
        : undefined;
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
      outboundMessage(event) &&
      taskId
    ) {
      const conversation = await conversationByTask(taskId);
      if (!conversation)
        throw new BridgeError("WEBEX_CONVERSATION_NOT_READY", 503, true);
      const message = extractedMessage?.message;
      const attachments = message?.attachments ?? [];
      const text = message?.text?.trim() ?? "";
      const attachmentConfig = telegramConfig();
      if (attachments.length && attachmentConfig.outboundAttachmentsEnabled) {
        try {
          await deliverTelegramAttachments({
            taskId,
            deliveryKey: `webex:${message?.aliasId ?? event.id}`,
            text,
            attachments,
          });
        } catch (error) {
          await deliverTelegramText({
            taskId,
            deliveryKey: `webex:${message?.aliasId ?? event.id}:attachment-fallback`,
            text: attachmentConfig.outboundAttachmentMessage,
          });
          throw error;
        }
      } else if (attachments.length) {
        if (text) {
          await deliverTelegramText({
            taskId,
            deliveryKey: `webex:${message?.aliasId ?? event.id}:text`,
            text,
          });
        }
        logInfo("telegram.attachment_ignored", {
          provider: "telegram",
          outcome: "ignored",
          taskRef: safeRef(taskId),
          updateRef: eventRef,
          code: safeToken("ATTACHMENTS_DISABLED"),
          count: attachments.length,
        });
        await deliverTelegramText({
          taskId,
          deliveryKey: `webex:${message?.aliasId ?? event.id}:attachment-fallback`,
          text: attachmentConfig.outboundAttachmentMessage,
        });
      } else if (text) {
        await deliverTelegramText({
          taskId,
          deliveryKey: `webex:${message?.aliasId ?? event.id}:text`,
          text,
        });
      } else {
        messageStatus = "OUTBOUND_ASSET_EMPTY";
      }
      if (messageStatus !== "OUTBOUND_ASSET_EMPTY")
        messageStatus = "OUTBOUND_ASSET_DELIVERED";
    }

    await finishWebexEvent(eventKey, "completed");
    logInfo("webex.webhook_accepted", {
      provider: "webex",
      outcome: "accepted",
      updateRef: eventRef,
      taskRef,
      eventType,
      messageDirection:
        event.type === "task-message:appended"
          ? safeToken(event.data?.messageDirection)
          : undefined,
      senderType:
        event.type === "task-message:appended"
          ? safeToken(event.data?.senderType)
          : undefined,
      webhookSource:
        event.type === "task-message:appended"
          ? safeToken(webexWebhookSourceKind(event.source))
          : undefined,
      webhookVersion:
        event.type === "task-message:appended" ? webhookVersion : undefined,
      payloadShape: extractedMessage
        ? safeToken(extractedMessage.shape)
        : undefined,
      payloadHints:
        event.type === "task-message:appended"
          ? safeToken(webexPayloadHints(event))
          : undefined,
      hasText: extractedMessage
        ? Boolean(extractedMessage.message?.text?.trim())
        : undefined,
      attachmentCount: extractedMessage
        ? (extractedMessage.message?.attachments?.length ?? 0)
        : undefined,
      status: status
        ? safeToken(status)
        : messageStatus
          ? safeToken(messageStatus)
          : undefined,
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
