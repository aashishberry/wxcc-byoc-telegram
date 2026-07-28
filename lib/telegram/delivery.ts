import { BridgeError } from "../errors";
import {
  downloadWebexAttachment,
  telegramAttachmentMethod,
} from "../attachments";
import { logError, logInfo, safeErrorCode, safeRef } from "../logger";
import {
  claimOutboundDelivery,
  conversationByTask,
  finishOutboundDelivery,
} from "../store";
import { splitTelegramText, toPlainText } from "../text";
import type { WebexAttachment } from "../webex/types";
import { sendTelegramAttachment, sendTelegramTextChunk } from "./client";

const provider = "telegram";

export async function deliverTelegramText(input: {
  taskId: string;
  deliveryKey: string;
  text: string;
}) {
  const conversation = await conversationByTask(input.taskId);
  if (!conversation)
    throw new BridgeError("TELEGRAM_CONVERSATION_NOT_FOUND", 503, true);

  const text = toPlainText(input.text);
  if (!text) return { outcome: "ignored" as const, count: 0 };

  const chunks = splitTelegramText(text);
  let delivered = 0;
  for (const [index, chunk] of chunks.entries()) {
    const chunkKey = `${input.deliveryKey}:${index}`;
    const claim = await claimOutboundDelivery(
      provider,
      chunkKey,
      input.taskId,
      Date.now(),
    );
    if (claim === "duplicate") {
      delivered += 1;
      continue;
    }
    if (claim === "busy")
      throw new BridgeError("TELEGRAM_DELIVERY_BUSY", 503, true);

    try {
      const providerMessageId = await sendTelegramTextChunk({
        chatId: conversation.external_chat_id,
        text: chunk,
        messageThreadId: conversation.external_thread_id
          ? Number(conversation.external_thread_id)
          : undefined,
      });
      await finishOutboundDelivery(
        provider,
        chunkKey,
        "completed",
        providerMessageId,
      );
      delivered += 1;
      logInfo("telegram.delivery_sent", {
        provider,
        outcome: "sent",
        taskRef: safeRef(input.taskId),
        deliveryRef: safeRef(chunkKey),
        count: 1,
      });
    } catch (error) {
      await finishOutboundDelivery(provider, chunkKey, "failed");
      logError("telegram.delivery_failed", {
        provider,
        outcome: "failed",
        taskRef: safeRef(input.taskId),
        deliveryRef: safeRef(chunkKey),
        code: safeErrorCode(error),
      });
      throw error;
    }
  }
  return { outcome: "sent" as const, count: delivered };
}

export async function deliverTelegramAttachments(input: {
  taskId: string;
  deliveryKey: string;
  text?: string;
  attachments: WebexAttachment[];
}) {
  const conversation = await conversationByTask(input.taskId);
  if (!conversation)
    throw new BridgeError("TELEGRAM_CONVERSATION_NOT_FOUND", 503, true);

  const text = toPlainText(input.text);
  const textFitsCaption = Array.from(text).length <= 1024;
  if (text && !textFitsCaption) {
    await deliverTelegramText({
      taskId: input.taskId,
      deliveryKey: `${input.deliveryKey}:text`,
      text,
    });
  }

  let delivered = 0;
  for (const [index, attachment] of input.attachments.entries()) {
    const attachmentKey = `${input.deliveryKey}:attachment:${index}`;
    const claim = await claimOutboundDelivery(
      provider,
      attachmentKey,
      input.taskId,
      Date.now(),
    );
    if (claim === "duplicate") {
      delivered += 1;
      continue;
    }
    if (claim === "busy")
      throw new BridgeError("TELEGRAM_DELIVERY_BUSY", 503, true);

    try {
      const downloaded = await downloadWebexAttachment(attachment);
      const providerMessageId = await sendTelegramAttachment({
        chatId: conversation.external_chat_id,
        attachment: downloaded,
        method: telegramAttachmentMethod(downloaded.mimeType, downloaded.size),
        caption: index === 0 && textFitsCaption ? text : undefined,
        messageThreadId: conversation.external_thread_id
          ? Number(conversation.external_thread_id)
          : undefined,
      });
      await finishOutboundDelivery(
        provider,
        attachmentKey,
        "completed",
        providerMessageId,
      );
      delivered += 1;
      logInfo("telegram.attachment_sent", {
        provider,
        outcome: "sent",
        taskRef: safeRef(input.taskId),
        deliveryRef: safeRef(attachmentKey),
        count: 1,
      });
    } catch (error) {
      await finishOutboundDelivery(provider, attachmentKey, "failed");
      logError("telegram.attachment_failed", {
        provider,
        outcome: "failed",
        taskRef: safeRef(input.taskId),
        deliveryRef: safeRef(attachmentKey),
        code: safeErrorCode(error),
      });
      throw error;
    }
  }
  return { outcome: "sent" as const, count: delivered };
}
