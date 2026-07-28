import assert from "node:assert/strict";
import test from "node:test";

import {
  activeConversation,
  claimInboundUpdate,
  claimWebexEvent,
  conversationByChat,
  finishInboundUpdate,
  finishWebexEvent,
  latestWebexLifecycleEvent,
  saveConversation,
  updateConversationStatus,
} from "../lib/store";

process.env.ALLOW_IN_MEMORY_DB = "true";

test("Telegram update claims are idempotent and retain one alias", async () => {
  const updateId = crypto.randomUUID();
  const first = await claimInboundUpdate("telegram", updateId, Date.now());
  assert.equal(first.outcome, "claimed");

  await finishInboundUpdate(
    "telegram",
    updateId,
    "completed",
    "task-idempotency",
  );
  const duplicate = await claimInboundUpdate("telegram", updateId, Date.now());

  assert.equal(duplicate.outcome, "duplicate");
  assert.equal(duplicate.aliasId, first.aliasId);
  assert.equal(duplicate.taskId, "task-idempotency");
});

test("terminal conversation status cannot be reopened by late events", async () => {
  const chatId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  await saveConversation({
    provider: "telegram",
    externalChatId: chatId,
    externalUserId: crypto.randomUUID(),
    taskId,
    status: "accepted",
    now: Date.now(),
  });

  await updateConversationStatus(taskId, "ended", Date.now());
  await updateConversationStatus(taskId, "connected", Date.now() + 1);
  const conversation = await conversationByChat("telegram", chatId);

  assert.equal(conversation?.status, "ended");
  assert.equal(activeConversation(conversation?.status ?? ""), false);
});

test("early Webex lifecycle events remain available for create reconciliation", async () => {
  const taskId = crypto.randomUUID();
  const eventKey = crypto.randomUUID();
  const now = Date.now();
  assert.equal(
    await claimWebexEvent({
      eventKey,
      taskId,
      eventType: "task:failed",
      now,
    }),
    "claimed",
  );
  await finishWebexEvent(eventKey, "completed");

  assert.deepEqual(await latestWebexLifecycleEvent(taskId), {
    event_type: "task:failed",
  });
});
