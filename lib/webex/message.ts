import type {
  WebexAttachment,
  WebexEvent,
  WebexMessage,
} from "./types";

export type WebexMessageShape =
  | "CHANNEL_PARAMS_MESSAGE"
  | "CHANNEL_PARAMS_MESSAGE_JSON"
  | "CHANNEL_PARAMS_JSON_MESSAGE"
  | "CHANNEL_PARAMS_JSON_MESSAGE_JSON"
  | "CHANNEL_PARAMS_DIRECT"
  | "DATA_MESSAGE"
  | "DATA_MESSAGE_JSON"
  | "DATA_DIRECT"
  | "NONE";

export type ExtractedWebexMessage = {
  shape: WebexMessageShape;
  message?: WebexMessage;
};

const maxNestedJsonLength = 2 * 1024 * 1024;

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  return value as Record<string, unknown>;
}

function parsedRecord(value: unknown): Record<string, unknown> | undefined {
  const direct = record(value);
  if (direct) return direct;
  if (
    typeof value !== "string" ||
    !value.trim().startsWith("{") ||
    value.length > maxNestedJsonLength
  )
    return;
  try {
    return record(JSON.parse(value));
  } catch {
    return;
  }
}

function attachments(value: unknown): WebexAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is WebexAttachment => Boolean(record(item)));
}

function messageFromRecord(value: Record<string, unknown>): WebexMessage {
  return {
    aliasId: typeof value.aliasId === "string" ? value.aliasId : undefined,
    text: typeof value.text === "string" ? value.text : undefined,
    attachments: attachments(value.attachments),
    timestamp:
      typeof value.timestamp === "string" ||
      typeof value.timestamp === "number"
        ? value.timestamp
        : undefined,
  };
}

function messageFromValue(value: unknown): WebexMessage | undefined {
  const parsed = parsedRecord(value);
  if (parsed) return messageFromRecord(parsed);
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("{") || trimmed.startsWith("[")) return;
  return { text: value };
}

function hasMessageContent(message: WebexMessage | undefined) {
  return Boolean(
    message?.text?.trim() ||
      message?.attachments?.length ||
      message?.aliasId ||
      message?.timestamp,
  );
}

export function extractWebexMessage(
  event: WebexEvent,
): ExtractedWebexMessage {
  const data = record(event.data);
  if (!data) return { shape: "NONE" };

  const rawChannelParams = data.channelParams;
  const channelParams = parsedRecord(rawChannelParams);
  if (channelParams) {
    const rawMessage = channelParams.message;
    const message = messageFromValue(rawMessage);
    if (hasMessageContent(message)) {
      const paramsWereJson = typeof rawChannelParams === "string";
      const messageWasJson =
        typeof rawMessage === "string" && rawMessage.trim().startsWith("{");
      return {
        shape: paramsWereJson
          ? messageWasJson
            ? "CHANNEL_PARAMS_JSON_MESSAGE_JSON"
            : "CHANNEL_PARAMS_JSON_MESSAGE"
          : messageWasJson
            ? "CHANNEL_PARAMS_MESSAGE_JSON"
            : "CHANNEL_PARAMS_MESSAGE",
        message,
      };
    }

    const directMessage = messageFromRecord(channelParams);
    if (hasMessageContent(directMessage))
      return { shape: "CHANNEL_PARAMS_DIRECT", message: directMessage };
  }

  const rawDataMessage = data.message;
  const dataMessage = messageFromValue(rawDataMessage);
  if (hasMessageContent(dataMessage))
    return {
      shape:
        typeof rawDataMessage === "string" &&
        rawDataMessage.trim().startsWith("{")
          ? "DATA_MESSAGE_JSON"
          : "DATA_MESSAGE",
      message: dataMessage,
    };

  const directMessage = messageFromRecord(data);
  if (hasMessageContent(directMessage))
    return { shape: "DATA_DIRECT", message: directMessage };

  return { shape: "NONE" };
}
