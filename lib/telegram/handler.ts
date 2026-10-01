import { telegramConfig } from "../config";
import { BridgeError } from "../errors";
import { webexOriginId } from "../identity";
import { withKeyLock } from "../locks";
import {
  logError,
  logInfo,
  logWarn,
  safeErrorCode,
  safeRef,
  safeToken,
} from "../logger";
import {
  activeConversation,
  claimInboundUpdate,
  conversationByChat,
  finishInboundUpdate,
  latestWebexLifecycleEvent,
  saveConversation,
  touchConversation,
  updateConversationStatus,
} from "../store";
import { storeTemporaryAttachment } from "../temp-attachments";
import { appendWebexMessage, createWebexTask } from "../webex/client";
import {
  hasUnsupportedTelegramContent,
  telegramInboundAttachment,
} from "./attachments";
import { downloadTelegramFile, sendTelegramText } from "./client";
import type { TelegramUpdate } from "./types";

const provider = "telegram";

function command(text: string) {
  const match = text.match(/^\/(start|help)(?:@[A-Za-z0-9_]+)?(?:\s|$)/i);
  return match?.[1]?.toLowerCase();
}

export async function processTelegramUpdate(update: TelegramUpdate) {
  const updateId = String(update.update_id);
  const updateRef = safeRef(updateId);
  const message = update.message;
  const sender = message?.from;
  if (!Number.isSafeInteger(update.update_id) || !message?.chat || !sender) {
    logInfo("telegram.message_ignored", {
      provider,
      outcome: "ignored",
      updateRef,
      code: safeToken("UNSUPPORTED_UPDATE"),
    });
    return { outcome: "ignored" as const };
  }

  const chatId = String(message.chat.id);
  const userId = String(sender.id);
  return withKeyLock(`${provider}:${chatId}`, async () => {
    const claim = await claimInboundUpdate(provider, updateId, Date.now());
    if (claim.outcome === "duplicate") {
      logInfo("telegram.webhook_duplicate", {
        provider,
        outcome: "accepted",
        updateRef,
        taskRef: safeRef(claim.taskId),
      });
      return { outcome: "duplicate" as const };
    }
    if (claim.outcome === "busy") {
      logWarn("telegram.webhook_busy", {
        provider,
        outcome: "failed",
        updateRef,
      });
      throw new BridgeError("TELEGRAM_UPDATE_BUSY", 503, true);
    }

    try {
      const config = telegramConfig();
      if (sender.is_bot) {
        await finishInboundUpdate(provider, updateId, "completed");
        logInfo("telegram.message_ignored", {
          provider,
          outcome: "ignored",
          updateRef,
          code: safeToken("BOT_MESSAGE"),
        });
        return { outcome: "ignored" as const };
      }
      if (message.chat.type !== "private" && !config.allowGroups) {
        await finishInboundUpdate(provider, updateId, "completed");
        logInfo("telegram.message_ignored", {
          provider,
          outcome: "ignored",
          updateRef,
          code: safeToken("GROUPS_DISABLED"),
        });
        return { outcome: "ignored" as const };
      }
      const media = telegramInboundAttachment(message);
      if (
        hasUnsupportedTelegramContent(message) ||
        (media && !config.inboundAttachmentsEnabled)
      ) {
        await sendTelegramText({
          chatId,
          text: config.unsupportedMessage,
          messageThreadId: message.message_thread_id,
        });
        await finishInboundUpdate(provider, updateId, "completed");
        logInfo("telegram.message_ignored", {
          provider,
          outcome: "ignored",
          updateRef,
          code: safeToken("UNSUPPORTED_CONTENT"),
        });
        return { outcome: "ignored" as const };
      }

      const text = (message.text ?? message.caption)?.trim() ?? "";
      if (!text && !media) {
        await finishInboundUpdate(provider, updateId, "completed");
        logInfo("telegram.message_ignored", {
          provider,
          outcome: "ignored",
          updateRef,
          code: safeToken("EMPTY_TEXT"),
        });
        return { outcome: "ignored" as const };
      }
      if (!media && command(text)) {
        await sendTelegramText({
          chatId,
          text: config.welcomeMessage,
          messageThreadId: message.message_thread_id,
        });
        await finishInboundUpdate(provider, updateId, "completed");
        logInfo("telegram.message_ignored", {
          provider,
          outcome: "ignored",
          updateRef,
          code: safeToken("LOCAL_COMMAND"),
        });
        return { outcome: "local-command" as const };
      }

      const timestamp = Number.isFinite(message.date)
        ? message.date * 1000
        : Date.now();
      let attachments:
        | Array<{ fileName: string; mimeType: string; fileUrl: string }>
        | undefined;
      if (media) {
        try {
          if (
            media.fileSize &&
            media.fileSize > config.inboundMaxAttachmentBytes
          )
            throw new BridgeError("TELEGRAM_ATTACHMENT_TOO_LARGE", 422);
          const bytes = await downloadTelegramFile(
            media.fileId,
            config.inboundMaxAttachmentBytes,
          );
          attachments = [
            await storeTemporaryAttachment({
              bytes,
              fileName: media.fileName,
              mimeType: media.mimeType,
            }),
          ];
        } catch (error) {
          if (!(error instanceof BridgeError) || error.httpStatus !== 422)
            throw error;
          await sendTelegramText({
            chatId,
            text: config.unsupportedMessage,
            messageThreadId: message.message_thread_id,
          });
          await finishInboundUpdate(provider, updateId, "completed");
          logInfo("telegram.message_ignored", {
            provider,
            outcome: "ignored",
            updateRef,
            code: safeErrorCode(error),
          });
          return { outcome: "ignored" as const };
        }
      }
      const existing = await conversationByChat(provider, chatId);
      let taskId: string;
      let operation: "created" | "appended";
      if (existing && activeConversation(existing.status)) {
        taskId = existing.task_id;
        await appendWebexMessage({
          taskId,
          aliasId: claim.aliasId,
          text,
          timestamp,
          attachments,
        });
        await touchConversation(taskId, timestamp);
        operation = "appended";
      } else {
        taskId = await createWebexTask({
          originId: webexOriginId(provider, userId),
          aliasId: claim.aliasId,
          text,
          timestamp,
          attachments,
        });
        await saveConversation({
          provider,
          externalChatId: chatId,
          externalUserId: userId,
          externalThreadId: message.message_thread_id
            ? String(message.message_thread_id)
            : undefined,
          taskId,
          status: "accepted",
          now: timestamp,
        });
        // Webex can publish task:new/task:failed before the Create Task HTTP
        // response reaches us. Reconcile an already-recorded lifecycle event
        // so a fast failure never leaves this chat permanently active.
        const lifecycle = await latestWebexLifecycleEvent(taskId);
        const reconciledStatus =
          lifecycle?.event_type === "task:new"
            ? "created"
            : lifecycle?.event_type === "task:parked"
              ? "queued"
              : lifecycle?.event_type === "task:connected"
                ? "connected"
                : lifecycle?.event_type === "task:ended"
                  ? "ended"
                  : lifecycle?.event_type === "task:failed"
                    ? "failed"
                    : undefined;
        if (reconciledStatus)
          await updateConversationStatus(taskId, reconciledStatus, Date.now());
        operation = "created";
      }
      await finishInboundUpdate(provider, updateId, "completed", taskId);
      logInfo("telegram.message_forwarded", {
        provider,
        outcome: "accepted",
        updateRef,
        taskRef: safeRef(taskId),
        status: safeToken(operation),
      });
      return { outcome: operation, taskId };
    } catch (error) {
      await finishInboundUpdate(provider, updateId, "failed");
      logError("telegram.message_failed", {
        provider,
        outcome: "failed",
        updateRef,
        code: safeErrorCode(error),
      });
      throw error;
    }
  });
}
