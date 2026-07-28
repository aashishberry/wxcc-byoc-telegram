import { ensureSchema, getDb } from "../db";

export type Conversation = {
  provider: string;
  external_chat_id: string;
  external_user_id: string;
  external_thread_id?: string;
  task_id: string;
  status: string;
  created_at: number;
  updated_at: number;
};

type WorkState = {
  state: string;
  alias_id: string;
  task_id?: string;
  updated_at: number;
};

export type ClaimResult =
  | { outcome: "claimed"; aliasId: string; taskId?: string }
  | { outcome: "duplicate"; aliasId: string; taskId?: string }
  | { outcome: "busy"; aliasId: string; taskId?: string };

const staleAfterMs = 2 * 60 * 1000;

export async function claimInboundUpdate(
  provider: string,
  updateId: string,
  now: number,
): Promise<ClaimResult> {
  await ensureSchema();
  const db = getDb();
  const aliasId = crypto.randomUUID();
  const inserted = await db
    .prepare(
      `INSERT OR IGNORE INTO inbound_updates
       (provider, update_id, alias_id, state, created_at, updated_at)
       VALUES (?, ?, ?, 'processing', ?, ?)`,
    )
    .bind(provider, updateId, aliasId, now, now)
    .run();
  if (inserted.rowCount) return { outcome: "claimed", aliasId };

  const existing = await db
    .prepare(
      "SELECT state, alias_id, task_id, updated_at FROM inbound_updates WHERE provider = ? AND update_id = ?",
    )
    .bind(provider, updateId)
    .first<WorkState>();
  if (!existing) return { outcome: "busy", aliasId };
  const result = {
    aliasId: existing.alias_id,
    taskId: existing.task_id,
  };
  if (existing.state === "completed")
    return { outcome: "duplicate", ...result };
  if (
    existing.state === "processing" &&
    Number(existing.updated_at) > now - staleAfterMs
  )
    return { outcome: "busy", ...result };

  await db
    .prepare(
      "UPDATE inbound_updates SET state = 'processing', updated_at = ? WHERE provider = ? AND update_id = ?",
    )
    .bind(now, provider, updateId)
    .run();
  return { outcome: "claimed", ...result };
}

export async function finishInboundUpdate(
  provider: string,
  updateId: string,
  state: "completed" | "failed",
  taskId?: string,
) {
  await ensureSchema();
  await getDb()
    .prepare(
      "UPDATE inbound_updates SET state = ?, task_id = COALESCE(?, task_id), updated_at = ? WHERE provider = ? AND update_id = ?",
    )
    .bind(state, taskId ?? null, Date.now(), provider, updateId)
    .run();
}

export async function conversationByChat(
  provider: string,
  externalChatId: string,
) {
  await ensureSchema();
  return getDb()
    .prepare(
      "SELECT * FROM conversations WHERE provider = ? AND external_chat_id = ?",
    )
    .bind(provider, externalChatId)
    .first<Conversation>();
}

export async function conversationByTask(taskId: string) {
  await ensureSchema();
  return getDb()
    .prepare("SELECT * FROM conversations WHERE task_id = ?")
    .bind(taskId)
    .first<Conversation>();
}

export async function saveConversation(input: {
  provider: string;
  externalChatId: string;
  externalUserId: string;
  externalThreadId?: string;
  taskId: string;
  status: string;
  now: number;
}) {
  await ensureSchema();
  await getDb()
    .prepare(
      `INSERT INTO conversations
       (provider, external_chat_id, external_user_id, external_thread_id, task_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (provider, external_chat_id) DO UPDATE SET
         external_user_id = EXCLUDED.external_user_id,
         external_thread_id = EXCLUDED.external_thread_id,
         task_id = EXCLUDED.task_id,
         status = EXCLUDED.status,
         created_at = EXCLUDED.created_at,
         updated_at = EXCLUDED.updated_at`,
    )
    .bind(
      input.provider,
      input.externalChatId,
      input.externalUserId,
      input.externalThreadId ?? null,
      input.taskId,
      input.status,
      input.now,
      input.now,
    )
    .run();
}

export async function updateConversationStatus(
  taskId: string,
  status: string,
  now: number,
) {
  await ensureSchema();
  await getDb()
    .prepare(
      `UPDATE conversations SET
       status = CASE WHEN status IN ('ended', 'failed') THEN status ELSE ? END,
       updated_at = CASE WHEN status IN ('ended', 'failed') THEN updated_at ELSE ? END
       WHERE task_id = ?`,
    )
    .bind(status, now, taskId)
    .run();
}

export async function touchConversation(taskId: string, now: number) {
  await ensureSchema();
  await getDb()
    .prepare("UPDATE conversations SET updated_at = ? WHERE task_id = ?")
    .bind(now, taskId)
    .run();
}

export async function claimOutboundDelivery(
  provider: string,
  deliveryKey: string,
  taskId: string,
  now: number,
) {
  await ensureSchema();
  const db = getDb();
  const inserted = await db
    .prepare(
      `INSERT OR IGNORE INTO outbound_deliveries
       (provider, delivery_key, task_id, state, created_at, updated_at)
       VALUES (?, ?, ?, 'processing', ?, ?)`,
    )
    .bind(provider, deliveryKey, taskId, now, now)
    .run();
  if (inserted.rowCount) return "claimed" as const;
  const existing = await db
    .prepare(
      "SELECT state, updated_at FROM outbound_deliveries WHERE provider = ? AND delivery_key = ?",
    )
    .bind(provider, deliveryKey)
    .first<{ state: string; updated_at: number }>();
  if (existing?.state === "completed") return "duplicate" as const;
  if (
    existing?.state === "processing" &&
    Number(existing.updated_at) > now - staleAfterMs
  )
    return "busy" as const;
  await db
    .prepare(
      "UPDATE outbound_deliveries SET state = 'processing', updated_at = ? WHERE provider = ? AND delivery_key = ?",
    )
    .bind(now, provider, deliveryKey)
    .run();
  return "claimed" as const;
}

export async function finishOutboundDelivery(
  provider: string,
  deliveryKey: string,
  state: "completed" | "failed",
  providerMessageId?: string,
) {
  await ensureSchema();
  await getDb()
    .prepare(
      "UPDATE outbound_deliveries SET state = ?, provider_message_id = COALESCE(?, provider_message_id), updated_at = ? WHERE provider = ? AND delivery_key = ?",
    )
    .bind(state, providerMessageId ?? null, Date.now(), provider, deliveryKey)
    .run();
}

export async function claimWebexEvent(input: {
  eventKey: string;
  taskId?: string;
  eventType: string;
  now: number;
}) {
  await ensureSchema();
  const db = getDb();
  const inserted = await db
    .prepare(
      `INSERT OR IGNORE INTO webex_events
       (event_key, task_id, event_type, state, created_at, updated_at)
       VALUES (?, ?, ?, 'processing', ?, ?)`,
    )
    .bind(
      input.eventKey,
      input.taskId ?? null,
      input.eventType,
      input.now,
      input.now,
    )
    .run();
  if (inserted.rowCount) return "claimed" as const;
  const existing = await db
    .prepare("SELECT state, updated_at FROM webex_events WHERE event_key = ?")
    .bind(input.eventKey)
    .first<{ state: string; updated_at: number }>();
  if (existing?.state === "completed") return "duplicate" as const;
  if (
    existing?.state === "processing" &&
    Number(existing.updated_at) > input.now - staleAfterMs
  )
    return "busy" as const;
  await db
    .prepare(
      "UPDATE webex_events SET state = 'processing', updated_at = ? WHERE event_key = ?",
    )
    .bind(input.now, input.eventKey)
    .run();
  return "claimed" as const;
}

export async function finishWebexEvent(
  eventKey: string,
  state: "completed" | "failed",
) {
  await ensureSchema();
  await getDb()
    .prepare(
      "UPDATE webex_events SET state = ?, updated_at = ? WHERE event_key = ?",
    )
    .bind(state, Date.now(), eventKey)
    .run();
}

export async function latestWebexLifecycleEvent(taskId: string) {
  await ensureSchema();
  return getDb()
    .prepare(
      `SELECT event_type FROM webex_events
       WHERE task_id = ? AND event_type IN
       ('task:new', 'task:parked', 'task:connected', 'task:ended', 'task:failed')
       ORDER BY created_at DESC, updated_at DESC
       LIMIT 1`,
    )
    .bind(taskId)
    .first<{ event_type: string }>();
}

export function activeConversation(status: string) {
  return !["ended", "failed"].includes(status);
}
