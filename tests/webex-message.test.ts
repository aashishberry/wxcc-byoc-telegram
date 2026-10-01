import assert from "node:assert/strict";
import test from "node:test";

import { extractWebexMessage } from "../lib/webex/message";
import type { WebexEvent } from "../lib/webex/types";

function event(data: WebexEvent["data"]): WebexEvent {
  return { type: "task-message:appended", data };
}

test("extracts the documented channelParams.message payload", () => {
  const extracted = extractWebexMessage(
    event({
      channelParams: {
        message: {
          aliasId: "message-1",
          text: "Agent reply",
          attachments: [{ fileName: "details.pdf" }],
        },
      },
    }),
  );

  assert.equal(extracted.shape, "CHANNEL_PARAMS_MESSAGE");
  assert.equal(extracted.message?.text, "Agent reply");
  assert.equal(extracted.message?.attachments?.length, 1);
});

test("extracts serialized channelParams and serialized nested messages", () => {
  const serializedParams = extractWebexMessage(
    event({
      channelParams: JSON.stringify({
        message: { aliasId: "message-2", text: "Flow reply" },
      }),
    }),
  );
  assert.equal(serializedParams.shape, "CHANNEL_PARAMS_JSON_MESSAGE");
  assert.equal(serializedParams.message?.text, "Flow reply");

  const serializedMessage = extractWebexMessage(
    event({
      channelParams: {
        message: JSON.stringify({
          aliasId: "message-3",
          text: "Agent reply",
        }),
      },
    }),
  );
  assert.equal(serializedMessage.shape, "CHANNEL_PARAMS_MESSAGE_JSON");
  assert.equal(serializedMessage.message?.text, "Agent reply");
});

test("extracts flattened compatibility payloads", () => {
  const channelParamsDirect = extractWebexMessage(
    event({
      channelParams: { aliasId: "message-4", text: "Direct params" },
    }),
  );
  assert.equal(channelParamsDirect.shape, "CHANNEL_PARAMS_DIRECT");
  assert.equal(channelParamsDirect.message?.text, "Direct params");

  const dataMessage = extractWebexMessage(
    event({ message: { aliasId: "message-5", text: "Data message" } }),
  );
  assert.equal(dataMessage.shape, "DATA_MESSAGE");
  assert.equal(dataMessage.message?.text, "Data message");

  const dataDirect = extractWebexMessage(
    event({ aliasId: "message-6", text: "Direct data" }),
  );
  assert.equal(dataDirect.shape, "DATA_DIRECT");
  assert.equal(dataDirect.message?.text, "Direct data");
});

test("extracts only explicitly allowlisted wrapper payloads", () => {
  const payload = extractWebexMessage(
    event({
      payload: {
        channelParams: {
          message: { aliasId: "message-7", text: "Wrapped reply" },
        },
      },
    }),
  );
  assert.equal(payload.shape, "DATA_PAYLOAD_WRAPPER");
  assert.equal(payload.message?.text, "Wrapped reply");

  const content = extractWebexMessage(event({ content: "Content reply" }));
  assert.equal(content.shape, "DATA_CONTENT_WRAPPER");
  assert.equal(content.message?.text, "Content reply");
});

test("finds a bounded nested message record without accepting arbitrary text", () => {
  const nested = extractWebexMessage(
    event({
      payload: undefined,
      content: undefined,
      body: undefined,
      eventData: undefined,
      messageData: undefined,
      unknownEnvelope: {
        notification: {
          message: { aliasId: "message-8", text: "Nested reply" },
        },
      },
    } as WebexEvent["data"] & Record<string, unknown>),
  );
  assert.equal(nested.shape, "NESTED_MESSAGE_RECORD");
  assert.equal(nested.message?.text, "Nested reply");
});

test("does not search arbitrary nested fields for message content", () => {
  const extracted = extractWebexMessage(
    event({
      channelParams: JSON.stringify({ unrelated: { text: "private" } }),
    }),
  );

  assert.equal(extracted.shape, "NONE");
  assert.equal(extracted.message, undefined);
});
