import type { WebexAttachment, WebexEvent, WebexMessage } from "./types";

export type WebexMessageShape =
  | "CHANNEL_PARAMS_MESSAGE"
  | "CHANNEL_PARAMS_MESSAGE_JSON"
  | "CHANNEL_PARAMS_JSON_MESSAGE"
  | "CHANNEL_PARAMS_JSON_MESSAGE_JSON"
  | "CHANNEL_PARAMS_DIRECT"
  | "DATA_MESSAGE"
  | "DATA_MESSAGE_JSON"
  | "DATA_DIRECT"
  | "DATA_PAYLOAD_WRAPPER"
  | "DATA_CONTENT_WRAPPER"
  | "DATA_BODY_WRAPPER"
  | "DATA_EVENT_DATA_WRAPPER"
  | "DATA_MESSAGE_DATA_WRAPPER"
  | "NESTED_MESSAGE_RECORD"
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
      typeof value.timestamp === "string" || typeof value.timestamp === "number"
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

function messageFromContainer(value: unknown): WebexMessage | undefined {
  const container = parsedRecord(value);
  if (!container) return messageFromValue(value);

  const channelParams = parsedRecord(container.channelParams);
  if (channelParams) {
    const nested = messageFromValue(channelParams.message);
    if (hasMessageContent(nested)) return nested;
    const direct = messageFromRecord(channelParams);
    if (hasMessageContent(direct)) return direct;
  }

  const nested = messageFromValue(container.message);
  if (hasMessageContent(nested)) return nested;

  const direct = messageFromRecord(container);
  if (hasMessageContent(direct)) return direct;
}

function nestedMessageRecord(
  value: unknown,
  depth = 0,
  state: { visited: number } = { visited: 0 },
): WebexMessage | undefined {
  if (depth > 5 || state.visited >= 64) return;
  const container = parsedRecord(value);
  if (!container) return;
  state.visited += 1;

  const self = messageFromRecord(container);
  if (
    (self.aliasId || self.timestamp) &&
    (self.text?.trim() || self.attachments?.length)
  )
    return self;

  for (const [key, child] of Object.entries(container)) {
    if (key === "message") {
      const message = messageFromContainer(child);
      if (hasMessageContent(message)) return message;
    }
    const nested = nestedMessageRecord(child, depth + 1, state);
    if (nested) return nested;
  }
}

export function extractWebexMessage(event: WebexEvent): ExtractedWebexMessage {
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

  const wrappers = [
    ["DATA_PAYLOAD_WRAPPER", data.payload],
    ["DATA_CONTENT_WRAPPER", data.content],
    ["DATA_BODY_WRAPPER", data.body],
    ["DATA_EVENT_DATA_WRAPPER", data.eventData],
    ["DATA_MESSAGE_DATA_WRAPPER", data.messageData],
  ] as const;
  for (const [shape, value] of wrappers) {
    const wrappedMessage = messageFromContainer(value);
    if (hasMessageContent(wrappedMessage))
      return { shape, message: wrappedMessage };
  }

  const nestedMessage = nestedMessageRecord(data);
  if (hasMessageContent(nestedMessage))
    return { shape: "NESTED_MESSAGE_RECORD", message: nestedMessage };

  return { shape: "NONE" };
}
