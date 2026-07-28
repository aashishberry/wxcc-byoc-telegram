import { Pool, types } from "pg";
import { newDb } from "pg-mem";

import { runtimeEnv } from "../lib/config";
import { BridgeError } from "../lib/errors";

let initialized: Promise<void> | null = null;
let pool: Pool | null = null;
let database: Database | null = null;

types.setTypeParser(20, Number);

export type QueryResult = {
  results: Record<string, unknown>[];
  rowCount: number;
};

export class PreparedStatement {
  constructor(
    private readonly databasePool: Pool,
    private readonly sql: string,
    private readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]) {
    return new PreparedStatement(this.databasePool, this.sql, params);
  }

  queryText() {
    let index = 0;
    let text = this.sql.replace(/\?/g, () => `$${++index}`);
    if (/^\s*INSERT\s+OR\s+IGNORE\s+INTO/i.test(text)) {
      text = text.replace(/^\s*INSERT\s+OR\s+IGNORE\s+INTO/i, "INSERT INTO");
      text = `${text.trim().replace(/;$/, "")} ON CONFLICT DO NOTHING`;
    }
    return text;
  }

  queryParams() {
    return this.params;
  }

  async all(): Promise<QueryResult> {
    const result = await this.databasePool.query(this.queryText(), this.params);
    return { results: result.rows, rowCount: result.rowCount ?? 0 };
  }

  async first<T>(): Promise<T | null> {
    const result = await this.databasePool.query(this.queryText(), this.params);
    return (result.rows[0] as T | undefined) ?? null;
  }

  async run() {
    const result = await this.databasePool.query(this.queryText(), this.params);
    return { rowCount: result.rowCount ?? 0 };
  }
}

export class Database {
  constructor(private readonly databasePool: Pool) {}

  prepare(sql: string) {
    return new PreparedStatement(this.databasePool, sql);
  }

  async batch(statements: PreparedStatement[]) {
    const client = await this.databasePool.connect();
    try {
      await client.query("BEGIN");
      for (const statement of statements) {
        await client.query(statement.queryText(), statement.queryParams());
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export function getDb() {
  if (database) return database;

  const env = runtimeEnv();
  if (env.DATABASE_URL) {
    pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: Number(env.DATABASE_POOL_SIZE ?? 5),
      ssl: env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
    });
  } else if (
    process.env.NODE_ENV !== "production" ||
    env.ALLOW_IN_MEMORY_DB === "true"
  ) {
    const memory = newDb();
    const adapter = memory.adapters.createPg();
    pool = new adapter.Pool() as unknown as Pool;
  } else {
    throw new BridgeError("DATABASE_UNAVAILABLE", 503, true);
  }
  database = new Database(pool);
  return database;
}

export function ensureSchema() {
  if (initialized) return initialized;
  const db = getDb();
  initialized = db
    .batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS conversations (
        provider TEXT NOT NULL,
        external_chat_id TEXT NOT NULL,
        external_user_id TEXT NOT NULL,
        external_thread_id TEXT,
        task_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (provider, external_chat_id)
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS inbound_updates (
        provider TEXT NOT NULL,
        update_id TEXT NOT NULL,
        alias_id TEXT NOT NULL,
        state TEXT NOT NULL,
        task_id TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (provider, update_id)
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS outbound_deliveries (
        provider TEXT NOT NULL,
        delivery_key TEXT NOT NULL,
        task_id TEXT NOT NULL,
        state TEXT NOT NULL,
        provider_message_id TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (provider, delivery_key)
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS webex_events (
        event_key TEXT PRIMARY KEY,
        task_id TEXT,
        event_type TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )`),
      db.prepare(
        "CREATE INDEX IF NOT EXISTS conversations_task_idx ON conversations(task_id)",
      ),
      db.prepare(
        "CREATE INDEX IF NOT EXISTS conversations_updated_idx ON conversations(updated_at DESC)",
      ),
    ])
    .then(() => undefined);
  return initialized;
}
