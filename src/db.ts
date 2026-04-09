import { createClient, type Client, type InValue } from '@libsql/client';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  TURSO_AUTH_TOKEN,
  TURSO_DATABASE_URL,
} from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
  Todo,
} from './types.js';

let db: Client;

async function createSchema(database: Client): Promise<void> {
  await database.execute(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    )
  `);
  await database.execute(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    )
  `);
  await database.execute(
    `CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp)`,
  );

  await database.execute(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    )
  `);
  await database.execute(
    `CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run)`,
  );
  await database.execute(
    `CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status)`,
  );

  await database.execute(`
    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    )
  `);
  await database.execute(
    `CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at)`,
  );

  await database.execute(`
    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  await database.execute(`
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    )
  `);
  await database.execute(`
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    )
  `);
  await database.execute(`
    CREATE TABLE IF NOT EXISTS memory_scopes_defs (
      name TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  await database.execute(`
    CREATE TABLE IF NOT EXISTS dashboard_tokens (
      token TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT DEFAULT '',
      allowed_groups TEXT DEFAULT '[]',
      can_send INTEGER DEFAULT 1,
      is_owner INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `);
  await database.execute(`
    CREATE TABLE IF NOT EXISTS drafts (
      chat_jid TEXT PRIMARY KEY,
      content TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    )
  `);
  await database.execute(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      user_agent TEXT DEFAULT '',
      created_at TEXT NOT NULL
    )
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    await database.execute(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    await database.execute(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    await database.execute({
      sql: `UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`,
      args: [`${ASSISTANT_NAME}:%`],
    });
  } catch {
    /* column already exists */
  }

  // Add is_main column if it doesn't exist (migration for existing DBs)
  try {
    await database.execute(
      `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    );
    // Backfill: existing rows with folder = 'main' are the main group
    await database.execute(
      `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`,
    );
  } catch {
    /* column already exists */
  }

  // Add is_transient column if it doesn't exist (migration for existing DBs)
  try {
    await database.execute(
      `ALTER TABLE registered_groups ADD COLUMN is_transient INTEGER DEFAULT 0`,
    );
  } catch {
    /* column already exists */
  }

  // Add memory_mode and memory_scopes columns
  try {
    await database.execute(
      `ALTER TABLE registered_groups ADD COLUMN memory_mode TEXT DEFAULT 'full'`,
    );
  } catch {
    /* column already exists */
  }
  try {
    await database.execute(
      `ALTER TABLE registered_groups ADD COLUMN memory_scopes TEXT DEFAULT '[]'`,
    );
  } catch {
    /* column already exists */
  }

  // Add memory_user_id column for per-user memory isolation
  try {
    await database.execute(
      `ALTER TABLE registered_groups ADD COLUMN memory_user_id TEXT DEFAULT 'venky'`,
    );
  } catch {
    /* column already exists */
  }

  // Add show_in_sidebar column
  try {
    await database.execute(
      `ALTER TABLE registered_groups ADD COLUMN show_in_sidebar INTEGER DEFAULT 1`,
    );
  } catch {
    /* column already exists */
  }

  // Add idle_timeout_minutes and allowed_skills columns
  try {
    await database.execute(
      `ALTER TABLE registered_groups ADD COLUMN idle_timeout_minutes INTEGER`,
    );
  } catch {
    /* column already exists */
  }
  try {
    await database.execute(
      `ALTER TABLE registered_groups ADD COLUMN allowed_skills TEXT DEFAULT '[]'`,
    );
  } catch {
    /* column already exists */
  }

  // Add mode column (tmux vs container — now always tmux)
  try {
    await database.execute(
      `ALTER TABLE registered_groups ADD COLUMN mode TEXT DEFAULT 'tmux'`,
    );
  } catch {
    /* column already exists */
  }

  // Add work_dir column for agent-in-project pattern
  try {
    await database.execute(
      `ALTER TABLE registered_groups ADD COLUMN work_dir TEXT`,
    );
  } catch {
    /* column already exists */
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    await database.execute(`ALTER TABLE chats ADD COLUMN channel TEXT`);
  } catch {
    /* column already exists */
  }
  try {
    await database.execute(
      `ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`,
    );
    // Backfill from JID patterns
    await database.execute(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    await database.execute(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    await database.execute(
      `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    await database.execute(
      `UPDATE chats SET channel = 'telegram', is_group = 1 WHERE jid LIKE 'tg:%'`,
    );
  } catch {
    /* column already exists */
  }

  // Add model column for per-group model selection
  try {
    await database.execute(
      `ALTER TABLE registered_groups ADD COLUMN model TEXT DEFAULT 'opus'`,
    );
  } catch {
    /* column already exists */
  }

  // Token usage tracking per group
  await database.execute(`
    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_folder TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      recorded_at TEXT NOT NULL
    )
  `);
  await database.execute(
    `CREATE INDEX IF NOT EXISTS idx_token_usage_folder ON token_usage(group_folder, recorded_at)`,
  );

  // Add session_mode to token_usage (stateful vs stateless analytics)
  try {
    await database.execute(
      `ALTER TABLE token_usage ADD COLUMN session_mode TEXT DEFAULT 'stateful'`,
    );
  } catch {
    /* column already exists */
  }

  // Add cost_usd to token_usage (actual cost from Claude result event)
  try {
    await database.execute(
      `ALTER TABLE token_usage ADD COLUMN cost_usd REAL DEFAULT 0`,
    );
  } catch {
    /* column already exists */
  }

  // Email routing rules
  await database.execute(`
    CREATE TABLE IF NOT EXISTS email_rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      from_pattern TEXT NOT NULL DEFAULT '',
      subject_pattern TEXT NOT NULL DEFAULT '',
      body_pattern TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL DEFAULT 'forward',
      target_group TEXT NOT NULL DEFAULT '',
      command_name TEXT NOT NULL DEFAULT '',
      extract_prompt TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  // Migrations: add columns to existing email_rules
  for (const col of ['command_name', 'email_type_pattern']) {
    try {
      await database.execute(
        `ALTER TABLE email_rules ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`,
      );
    } catch {
      /* column already exists */
    }
  }
  await database.execute(
    `CREATE INDEX IF NOT EXISTS idx_email_rules_priority ON email_rules(priority)`,
  );

  // Email processing log
  await database.execute(`
    CREATE TABLE IF NOT EXISTS email_log (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      thread_id TEXT,
      from_address TEXT NOT NULL,
      subject TEXT NOT NULL,
      rule_id TEXT,
      rule_name TEXT,
      action TEXT NOT NULL,
      target_group TEXT,
      summary TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      processed_at TEXT NOT NULL
    )
  `);
  await database.execute(
    `CREATE INDEX IF NOT EXISTS idx_email_log_processed ON email_log(processed_at)`,
  );

  // Migrate old email_log schema if needed
  const cols = await database.execute('PRAGMA table_info(email_log)');
  const colNames = new Set(cols.rows.map((r) => r.name as string));
  const migrations: Array<{ col: string; type: string; dflt: string }> = [
    { col: 'message_id', type: 'TEXT', dflt: "''" },
    { col: 'thread_id', type: 'TEXT', dflt: 'NULL' },
    { col: 'from_address', type: 'TEXT', dflt: "''" },
    { col: 'rule_id', type: 'TEXT', dflt: 'NULL' },
    { col: 'summary', type: 'TEXT', dflt: 'NULL' },
    { col: 'input_tokens', type: 'INTEGER', dflt: '0' },
    { col: 'output_tokens', type: 'INTEGER', dflt: '0' },
    { col: 'email_type', type: 'TEXT', dflt: 'NULL' },
    { col: 'structured_data', type: 'TEXT', dflt: 'NULL' },
  ];
  for (const m of migrations) {
    if (!colNames.has(m.col)) {
      await database.execute(
        `ALTER TABLE email_log ADD COLUMN ${m.col} ${m.type} DEFAULT ${m.dflt}`,
      );
    }
  }

  // Agent performance alerts
  await database.execute(`
    CREATE TABLE IF NOT EXISTS agent_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_folder TEXT NOT NULL,
      group_name TEXT NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      duration_ms INTEGER,
      num_turns INTEGER,
      cost_usd REAL,
      context_percent REAL,
      created_at TEXT NOT NULL,
      dismissed INTEGER NOT NULL DEFAULT 0
    )
  `);
  await database.execute(
    `CREATE INDEX IF NOT EXISTS idx_agent_alerts_created ON agent_alerts(created_at)`,
  );

  // Per-group MCP server allowlist and tool disabling
  for (const col of ['allowed_mcp_servers', 'disabled_tools']) {
    try {
      await database.execute(
        `ALTER TABLE registered_groups ADD COLUMN ${col} TEXT DEFAULT '[]'`,
      );
    } catch {
      /* column already exists */
    }
  }
}

export async function initDatabase(): Promise<void> {
  db = createClient({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN });
  await createSchema(db);

  // Migrate from JSON files if they exist
  await migrateJsonState();
}

export function getDbClient(): Client {
  return db;
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export async function _initTestDatabase(): Promise<void> {
  db = createClient({ url: ':memory:' });
  await createSchema(db);
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export async function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): Promise<void> {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    await db.execute({
      sql: `
        INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(jid) DO UPDATE SET
          name = excluded.name,
          last_message_time = MAX(last_message_time, excluded.last_message_time),
          channel = COALESCE(excluded.channel, channel),
          is_group = COALESCE(excluded.is_group, is_group)
      `,
      args: [chatJid, name, timestamp, ch, group],
    });
  } else {
    await db.execute({
      sql: `
        INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(jid) DO UPDATE SET
          last_message_time = MAX(last_message_time, excluded.last_message_time),
          channel = COALESCE(excluded.channel, channel),
          is_group = COALESCE(excluded.is_group, is_group)
      `,
      args: [chatJid, chatJid, timestamp, ch, group],
    });
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export async function updateChatName(
  chatJid: string,
  name: string,
): Promise<void> {
  await db.execute({
    sql: `
      INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET name = excluded.name
    `,
    args: [chatJid, name, new Date().toISOString()],
  });
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export async function getAllChats(): Promise<ChatInfo[]> {
  const result = await db.execute(`
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `);
  return result.rows as unknown as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export async function getLastGroupSync(): Promise<string | null> {
  const result = await db.execute({
    sql: `SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`,
    args: [],
  });
  const row = result.rows[0] as unknown as
    | { last_message_time: string }
    | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export async function setLastGroupSync(): Promise<void> {
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
    args: [now],
  });
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export async function storeMessage(msg: NewMessage): Promise<void> {
  await db.execute({
    sql: `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      msg.id,
      msg.chat_jid,
      msg.sender,
      msg.sender_name,
      msg.content,
      msg.timestamp,
      msg.is_from_me ? 1 : 0,
      msg.is_bot_message ? 1 : 0,
    ],
  });
}

/**
 * Store a message directly.
 */
export async function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): Promise<void> {
  await db.execute({
    sql: `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      msg.id,
      msg.chat_jid,
      msg.sender,
      msg.sender_name,
      msg.content,
      msg.timestamp,
      msg.is_from_me ? 1 : 0,
      msg.is_bot_message ? 1 : 0,
    ],
  });
}

export async function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): Promise<{ messages: NewMessage[]; newTimestamp: string }> {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE timestamp > ? AND chat_jid IN (${placeholders})
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  const result = await db.execute({
    sql,
    args: [lastTimestamp, ...jids, `${botPrefix}:%`, limit] as InValue[],
  });
  const rows = result.rows as unknown as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export async function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): Promise<NewMessage[]> {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  const result = await db.execute({
    sql,
    args: [chatJid, sinceTimestamp, `${botPrefix}:%`, limit],
  });
  return result.rows as unknown as NewMessage[];
}

/**
 * Get all messages (including bot responses) for dashboard display.
 */
export async function getAllMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  limit: number = 200,
): Promise<NewMessage[]> {
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  const result = await db.execute({
    sql,
    args: [chatJid, sinceTimestamp, limit],
  });
  return result.rows as unknown as NewMessage[];
}

export async function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): Promise<void> {
  await db.execute({
    sql: `
      INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      task.id,
      task.group_folder,
      task.chat_jid,
      task.prompt,
      task.schedule_type,
      task.schedule_value,
      task.context_mode || 'isolated',
      task.next_run ?? null,
      task.status,
      task.created_at,
    ],
  });
}

export async function getTaskById(
  id: string,
): Promise<ScheduledTask | undefined> {
  const result = await db.execute({
    sql: 'SELECT * FROM scheduled_tasks WHERE id = ?',
    args: [id],
  });
  return (result.rows[0] ?? undefined) as unknown as ScheduledTask | undefined;
}

export async function getTasksForGroup(
  groupFolder: string,
): Promise<ScheduledTask[]> {
  const result = await db.execute({
    sql: 'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    args: [groupFolder],
  });
  return result.rows as unknown as ScheduledTask[];
}

export async function getAllTasks(): Promise<ScheduledTask[]> {
  const result = await db.execute(
    'SELECT * FROM scheduled_tasks ORDER BY created_at DESC',
  );
  return result.rows as unknown as ScheduledTask[];
}

export async function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'
    >
  >,
): Promise<void> {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  await db.execute({
    sql: `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
    args: values as InValue[],
  });
}

export async function deleteTask(id: string): Promise<void> {
  // Delete child records first (FK constraint)
  await db.execute({
    sql: 'DELETE FROM task_run_logs WHERE task_id = ?',
    args: [id],
  });
  await db.execute({
    sql: 'DELETE FROM scheduled_tasks WHERE id = ?',
    args: [id],
  });
}

export async function getDueTasks(): Promise<ScheduledTask[]> {
  const now = new Date().toISOString();
  const result = await db.execute({
    sql: `
      SELECT * FROM scheduled_tasks
      WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
      ORDER BY next_run
    `,
    args: [now],
  });
  return result.rows as unknown as ScheduledTask[];
}

export async function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db.execute({
    sql: `
      UPDATE scheduled_tasks
      SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
      WHERE id = ?
    `,
    args: [nextRun, now, lastResult, nextRun, id],
  });
}

export async function logTaskRun(log: TaskRunLog): Promise<void> {
  await db.execute({
    sql: `
      INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    args: [
      log.task_id,
      log.run_at,
      log.duration_ms,
      log.status,
      log.result ?? null,
      log.error ?? null,
    ],
  });
}

export async function getTaskRunLogs(
  taskId: string,
  limit = 20,
): Promise<TaskRunLog[]> {
  const result = await db.execute({
    sql: 'SELECT * FROM task_run_logs WHERE task_id = ? ORDER BY run_at DESC LIMIT ?',
    args: [taskId, limit],
  });
  return result.rows as unknown as TaskRunLog[];
}

// --- Todos CRUD ---

export async function createTodo(todo: Todo): Promise<void> {
  await db.execute({
    sql: `INSERT INTO todos (id, user_id, title, data, status, priority, due_date, remind_at, recurrence, reminder_fired_at, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      todo.id,
      todo.user_id,
      todo.title,
      todo.data ?? null,
      todo.status,
      todo.priority,
      todo.due_date ?? null,
      todo.remind_at ?? null,
      todo.recurrence ?? null,
      todo.reminder_fired_at ?? null,
      todo.created_by,
      todo.created_at,
      todo.updated_at,
    ],
  });
}

export async function getTodoById(id: string): Promise<Todo | undefined> {
  const result = await db.execute({
    sql: 'SELECT * FROM todos WHERE id = ?',
    args: [id],
  });
  return (result.rows[0] ?? undefined) as unknown as Todo | undefined;
}

export async function getTodosByUser(
  userId: string,
  includeCompleted = false,
): Promise<Todo[]> {
  const sql = includeCompleted
    ? "SELECT * FROM todos WHERE user_id = ? ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at DESC"
    : "SELECT * FROM todos WHERE user_id = ? AND status != 'done' ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at DESC";
  const result = await db.execute({ sql, args: [userId] });
  return result.rows as unknown as Todo[];
}

export async function getAllTodos(): Promise<Todo[]> {
  const result = await db.execute(
    'SELECT * FROM todos ORDER BY created_at DESC',
  );
  return result.rows as unknown as Todo[];
}

export async function updateTodo(
  id: string,
  updates: Partial<
    Pick<
      Todo,
      | 'title'
      | 'data'
      | 'status'
      | 'priority'
      | 'due_date'
      | 'remind_at'
      | 'recurrence'
      | 'reminder_fired_at'
    >
  >,
): Promise<void> {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (updates.title !== undefined) {
    fields.push('title = ?');
    values.push(updates.title);
  }
  if (updates.data !== undefined) {
    fields.push('data = ?');
    values.push(updates.data);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.priority !== undefined) {
    fields.push('priority = ?');
    values.push(updates.priority);
  }
  if (updates.due_date !== undefined) {
    fields.push('due_date = ?');
    values.push(updates.due_date);
  }
  if (updates.remind_at !== undefined) {
    fields.push('remind_at = ?');
    values.push(updates.remind_at);
  }
  if (updates.recurrence !== undefined) {
    fields.push('recurrence = ?');
    values.push(updates.recurrence);
  }
  if (updates.reminder_fired_at !== undefined) {
    fields.push('reminder_fired_at = ?');
    values.push(updates.reminder_fired_at);
  }
  if (fields.length === 0) return;
  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);
  await db.execute({
    sql: `UPDATE todos SET ${fields.join(', ')} WHERE id = ?`,
    args: values as InValue[],
  });
}

export async function deleteTodo(id: string): Promise<void> {
  await db.execute({ sql: 'DELETE FROM todos WHERE id = ?', args: [id] });
}

export async function getDueTodoReminders(): Promise<Todo[]> {
  const now = new Date().toISOString();
  const result = await db.execute({
    sql: `SELECT * FROM todos WHERE remind_at IS NOT NULL AND remind_at <= ? AND status != 'done' AND (reminder_fired_at IS NULL OR reminder_fired_at < remind_at)`,
    args: [now],
  });
  return result.rows as unknown as Todo[];
}

// --- Router state accessors ---

export async function getRouterState(key: string): Promise<string | undefined> {
  const result = await db.execute({
    sql: 'SELECT value FROM router_state WHERE key = ?',
    args: [key],
  });
  const row = result.rows[0] as unknown as { value: string } | undefined;
  return row?.value;
}

export async function setRouterState(
  key: string,
  value: string,
): Promise<void> {
  await db.execute({
    sql: 'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
    args: [key, value],
  });
}

// --- Session accessors ---

export async function getSession(
  groupFolder: string,
): Promise<string | undefined> {
  const result = await db.execute({
    sql: 'SELECT session_id FROM sessions WHERE group_folder = ?',
    args: [groupFolder],
  });
  const row = result.rows[0] as unknown as { session_id: string } | undefined;
  return row?.session_id;
}

export async function setSession(
  groupFolder: string,
  sessionId: string,
): Promise<void> {
  await db.execute({
    sql: 'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
    args: [groupFolder, sessionId],
  });
}

export async function getAllSessions(): Promise<Record<string, string>> {
  const result = await db.execute(
    'SELECT group_folder, session_id FROM sessions',
  );
  const rows = result.rows as unknown as Array<{
    group_folder: string;
    session_id: string;
  }>;
  const out: Record<string, string> = {};
  for (const row of rows) {
    out[row.group_folder] = row.session_id;
  }
  return out;
}

// --- Registered group accessors ---

export async function getRegisteredGroup(
  jid: string,
): Promise<(RegisteredGroup & { jid: string }) | undefined> {
  const result = await db.execute({
    sql: 'SELECT * FROM registered_groups WHERE jid = ?',
    args: [jid],
  });
  const row = result.rows[0] as unknown as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        requires_trigger: number | null;
        is_main: number | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
  };
}

export async function setRegisteredGroup(
  jid: string,
  group: RegisteredGroup,
): Promise<void> {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  await db.execute({
    sql: `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main, is_transient, memory_mode, memory_scopes, memory_user_id, show_in_sidebar, idle_timeout_minutes, allowed_skills, mode, work_dir, model, allowed_mcp_servers, disabled_tools)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      jid,
      group.name,
      group.folder,
      group.trigger,
      group.added_at,
      null, // container_config column kept for DB compat
      group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
      group.isMain ? 1 : 0,
      group.isTransient ? 1 : 0,
      group.memoryMode || 'full',
      JSON.stringify(group.memoryScopes || []),
      group.memoryUserId || 'venky',
      group.showInSidebar === false ? 0 : 1,
      group.idleTimeoutMinutes ?? null,
      JSON.stringify(group.allowedSkills || []),
      group.mode || 'tmux',
      group.workDir ?? null,
      group.model || 'opus',
      JSON.stringify(group.allowedMcpServers || []),
      JSON.stringify(group.disabledTools || []),
    ],
  });
}

export async function getAllRegisteredGroups(): Promise<
  Record<string, RegisteredGroup>
> {
  const result = await db.execute('SELECT * FROM registered_groups');
  const rows = result.rows as unknown as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    requires_trigger: number | null;
    is_main: number | null;
    is_transient: number | null;
    memory_mode: string | null;
    memory_scopes: string | null;
    memory_user_id: string | null;
    show_in_sidebar: number | null;
    idle_timeout_minutes: number | null;
    allowed_skills: string | null;
    mode: string | null;
    work_dir: string | null;
    model: string | null;
    allowed_mcp_servers: string | null;
    disabled_tools: string | null;
  }>;
  const out: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    out[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      isMain: row.is_main === 1 ? true : undefined,
      isTransient: row.is_transient === 1 ? true : undefined,
      memoryMode: (row.memory_mode as 'full' | 'local' | 'none') || 'full',
      memoryScopes: row.memory_scopes ? JSON.parse(row.memory_scopes) : [],
      memoryUserId: row.memory_user_id || 'venky',
      showInSidebar: row.show_in_sidebar === 0 ? false : true,
      idleTimeoutMinutes: row.idle_timeout_minutes ?? undefined,
      allowedSkills: row.allowed_skills ? JSON.parse(row.allowed_skills) : [],
      mode: row.mode || 'tmux',
      workDir: row.work_dir || undefined,
      model: (row.model as 'opus' | 'sonnet') || 'opus',
      allowedMcpServers: row.allowed_mcp_servers ? JSON.parse(row.allowed_mcp_servers) : [],
      disabledTools: row.disabled_tools ? JSON.parse(row.disabled_tools) : [],
    };
  }
  return out;
}

// --- Memory scope definitions ---

export interface MemoryScopeDef {
  name: string;
  description: string;
  created_at: string;
}

export async function getAllScopeDefs(): Promise<MemoryScopeDef[]> {
  const result = await db.execute(
    'SELECT * FROM memory_scopes_defs ORDER BY name',
  );
  return result.rows as unknown as MemoryScopeDef[];
}

export async function createScopeDef(
  name: string,
  description: string,
): Promise<void> {
  await db.execute({
    sql: `INSERT OR REPLACE INTO memory_scopes_defs (name, description, created_at) VALUES (?, ?, ?)`,
    args: [name, description, new Date().toISOString()],
  });
}

export async function deleteScopeDef(name: string): Promise<void> {
  await db.execute({
    sql: 'DELETE FROM memory_scopes_defs WHERE name = ?',
    args: [name],
  });
}

// --- JSON migration ---

async function migrateJsonState(): Promise<void> {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      await setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      await setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      await setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        await setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}

// --- Push subscriptions ---

export interface PushSubscription {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string;
  created_at: string;
}

/** No-op: push_subscriptions table is now created in createSchema */
export async function initPushSubscriptionsTable(): Promise<void> {
  // Table is created in createSchema during initDatabase
}

export async function savePushSubscription(
  sub: PushSubscription,
): Promise<void> {
  await db.execute({
    sql: `INSERT OR REPLACE INTO push_subscriptions (id, endpoint, p256dh, auth, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      sub.id,
      sub.endpoint,
      sub.p256dh,
      sub.auth,
      sub.user_agent,
      sub.created_at,
    ],
  });
}

export async function deletePushSubscription(endpoint: string): Promise<void> {
  await db.execute({
    sql: 'DELETE FROM push_subscriptions WHERE endpoint = ?',
    args: [endpoint],
  });
}

export async function getAllPushSubscriptions(): Promise<PushSubscription[]> {
  try {
    const result = await db.execute('SELECT * FROM push_subscriptions');
    return result.rows as unknown as PushSubscription[];
  } catch {
    return [];
  }
}

// --- Dashboard token accessors (used by auth.ts) ---

export interface DashboardTokenRow {
  token: string;
  name: string;
  role: string;
  allowed_groups: string;
  can_send: number;
  is_owner: number;
  created_at: string;
  reminder_group_jid: string | null;
}

export async function getDashboardToken(
  token: string,
): Promise<DashboardTokenRow | undefined> {
  const result = await db.execute({
    sql: 'SELECT * FROM dashboard_tokens WHERE token = ?',
    args: [token],
  });
  return (result.rows[0] ?? undefined) as unknown as
    | DashboardTokenRow
    | undefined;
}

export async function insertDashboardToken(
  row: DashboardTokenRow,
): Promise<void> {
  await db.execute({
    sql: 'INSERT INTO dashboard_tokens (token, name, role, allowed_groups, can_send, is_owner, created_at, reminder_group_jid) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    args: [
      row.token,
      row.name,
      row.role,
      row.allowed_groups,
      row.can_send,
      row.is_owner,
      row.created_at,
      row.reminder_group_jid ?? null,
    ],
  });
}

export async function getAllDashboardTokens(): Promise<DashboardTokenRow[]> {
  const result = await db.execute('SELECT * FROM dashboard_tokens');
  return result.rows as unknown as DashboardTokenRow[];
}

export async function updateDashboardToken(
  token: string,
  updates: { reminder_group_jid?: string | null },
): Promise<void> {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (updates.reminder_group_jid !== undefined) {
    fields.push('reminder_group_jid = ?');
    values.push(updates.reminder_group_jid);
  }
  if (fields.length === 0) return;
  values.push(token);
  await db.execute({
    sql: `UPDATE dashboard_tokens SET ${fields.join(', ')} WHERE token = ?`,
    args: values as InValue[],
  });
}

export async function deleteDashboardToken(token: string): Promise<void> {
  await db.execute({
    sql: 'DELETE FROM dashboard_tokens WHERE token = ? AND is_owner = 0',
    args: [token],
  });
}

export async function getDraft(chatJid: string): Promise<string> {
  const result = await db.execute({
    sql: 'SELECT content FROM drafts WHERE chat_jid = ?',
    args: [chatJid],
  });
  return (result.rows[0]?.content as string) || '';
}

export async function setDraft(
  chatJid: string,
  content: string,
): Promise<void> {
  if (content.trim()) {
    await db.execute({
      sql: 'INSERT OR REPLACE INTO drafts (chat_jid, content, updated_at) VALUES (?, ?, ?)',
      args: [chatJid, content, new Date().toISOString()],
    });
  } else {
    await db.execute({
      sql: 'DELETE FROM drafts WHERE chat_jid = ?',
      args: [chatJid],
    });
  }
}

// ── Token Usage Tracking ──

export async function recordTokenUsage(
  groupFolder: string,
  usage: {
    input_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    output_tokens: number;
  },
  sessionMode: 'stateful' | 'stateless' = 'stateful',
  costUsd: number = 0,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO token_usage (group_folder, input_tokens, cache_creation_tokens, cache_read_tokens, output_tokens, session_mode, cost_usd, recorded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      groupFolder,
      usage.input_tokens,
      usage.cache_creation_input_tokens,
      usage.cache_read_input_tokens,
      usage.output_tokens,
      sessionMode,
      costUsd,
      new Date().toISOString(),
    ],
  });
}

export interface TokenUsageSummary {
  group_folder: string;
  total_input: number;
  total_cache_creation: number;
  total_cache_read: number;
  total_output: number;
  total_tokens: number;
  total_cost_usd: number;
  turn_count: number;
  stateful_tokens: number;
  stateless_tokens: number;
  stateful_turns: number;
  stateless_turns: number;
}

export async function getTokenUsageSummary(
  groupFolder?: string,
  sinceDays?: number,
  since?: string,
  until?: string,
): Promise<TokenUsageSummary[]> {
  let sql = `SELECT group_folder,
    SUM(input_tokens) as total_input,
    SUM(cache_creation_tokens) as total_cache_creation,
    SUM(cache_read_tokens) as total_cache_read,
    SUM(output_tokens) as total_output,
    SUM(input_tokens + cache_creation_tokens + cache_read_tokens + output_tokens) as total_tokens,
    SUM(CASE WHEN COALESCE(cost_usd, 0) > 0 THEN cost_usd
      ELSE (input_tokens * 3.0 + cache_creation_tokens * 3.75 + cache_read_tokens * 0.30 + output_tokens * 15.0) / 1000000.0
    END) as total_cost_usd,
    COUNT(*) as turn_count,
    SUM(CASE WHEN session_mode = 'stateful' OR session_mode IS NULL THEN input_tokens + cache_creation_tokens + cache_read_tokens + output_tokens ELSE 0 END) as stateful_tokens,
    SUM(CASE WHEN session_mode = 'stateless' THEN input_tokens + cache_creation_tokens + cache_read_tokens + output_tokens ELSE 0 END) as stateless_tokens,
    SUM(CASE WHEN session_mode = 'stateful' OR session_mode IS NULL THEN 1 ELSE 0 END) as stateful_turns,
    SUM(CASE WHEN session_mode = 'stateless' THEN 1 ELSE 0 END) as stateless_turns
    FROM token_usage WHERE 1=1`;
  const args: InValue[] = [];

  if (groupFolder) {
    sql += ' AND group_folder = ?';
    args.push(groupFolder);
  }
  if (since) {
    sql += ' AND recorded_at >= ?';
    args.push(since);
  }
  if (until) {
    sql += ' AND recorded_at < ?';
    args.push(until);
  }
  if (sinceDays && !since) {
    const sinceDate = new Date(Date.now() - sinceDays * 86400000).toISOString();
    sql += ' AND recorded_at >= ?';
    args.push(sinceDate);
  }

  sql += ' GROUP BY group_folder ORDER BY total_cost_usd DESC';

  const result = await db.execute({ sql, args });
  return result.rows.map((r) => ({
    group_folder: r.group_folder as string,
    total_input: Number(r.total_input) || 0,
    total_cache_creation: Number(r.total_cache_creation) || 0,
    total_cache_read: Number(r.total_cache_read) || 0,
    total_output: Number(r.total_output) || 0,
    total_tokens: Number(r.total_tokens) || 0,
    total_cost_usd: Number(r.total_cost_usd) || 0,
    turn_count: Number(r.turn_count) || 0,
    stateful_tokens: Number(r.stateful_tokens) || 0,
    stateless_tokens: Number(r.stateless_tokens) || 0,
    stateful_turns: Number(r.stateful_turns) || 0,
    stateless_turns: Number(r.stateless_turns) || 0,
  }));
}

// --- Email Rules ---

import type { EmailRule } from './types.js';

export async function createEmailRule(
  rule: Omit<EmailRule, 'id' | 'created_at' | 'updated_at'>,
): Promise<EmailRule> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO email_rules (id, name, priority, from_pattern, subject_pattern, body_pattern, email_type_pattern, action, target_group, extract_prompt, enabled, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      rule.name,
      rule.priority,
      rule.from_pattern,
      rule.subject_pattern,
      rule.body_pattern,
      rule.email_type_pattern || '',
      rule.action,
      rule.target_group,
      rule.extract_prompt || '',
      rule.enabled ? 1 : 0,
      now,
      now,
    ],
  });
  return { ...rule, id, created_at: now, updated_at: now };
}

export async function getEmailRules(): Promise<EmailRule[]> {
  const result = await db.execute(
    'SELECT * FROM email_rules ORDER BY priority ASC, created_at ASC',
  );
  return result.rows.map(rowToEmailRule);
}

export async function getEnabledEmailRules(): Promise<EmailRule[]> {
  const result = await db.execute(
    'SELECT * FROM email_rules WHERE enabled = 1 ORDER BY priority ASC',
  );
  return result.rows.map(rowToEmailRule);
}

export async function updateEmailRule(
  id: string,
  updates: Partial<Omit<EmailRule, 'id' | 'created_at' | 'updated_at'>>,
): Promise<void> {
  const fields: string[] = [];
  const args: InValue[] = [];
  for (const [key, value] of Object.entries(updates)) {
    const col = key === 'enabled' ? 'enabled' : key;
    fields.push(`${col} = ?`);
    args.push(key === 'enabled' ? (value ? 1 : 0) : (value as InValue));
  }
  fields.push('updated_at = ?');
  args.push(new Date().toISOString());
  args.push(id);
  await db.execute({
    sql: `UPDATE email_rules SET ${fields.join(', ')} WHERE id = ?`,
    args,
  });
}

export async function deleteEmailRule(id: string): Promise<void> {
  await db.execute({ sql: 'DELETE FROM email_rules WHERE id = ?', args: [id] });
}

function rowToEmailRule(row: Record<string, unknown>): EmailRule {
  return {
    id: row.id as string,
    name: row.name as string,
    priority: Number(row.priority) || 0,
    from_pattern: (row.from_pattern as string) || '',
    subject_pattern: (row.subject_pattern as string) || '',
    body_pattern: (row.body_pattern as string) || '',
    email_type_pattern: (row.email_type_pattern as string) || '',
    action: (row.action as EmailRule['action']) || 'forward',
    target_group: (row.target_group as string) || '',
    command_name: (row.command_name as string) || '',
    extract_prompt: (row.extract_prompt as string) || '',
    enabled: row.enabled === 1 || row.enabled === true,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

// --- Email Log ---

export interface EmailLogEntry {
  id: string;
  message_id: string;
  thread_id: string;
  from_address: string;
  subject: string;
  rule_id: string | null;
  rule_name: string | null;
  action: string;
  target_group: string | null;
  summary: string | null;
  input_tokens: number;
  output_tokens: number;
  processed_at: string;
  email_type: string | null;
  structured_data: string | null; // JSON string of typed extraction data
}

export async function logEmail(
  entry: Omit<EmailLogEntry, 'id'>,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO email_log (sender, message_id, thread_id, from_address, subject, rule_id, rule_name, action, target_group, summary, input_tokens, output_tokens, processed_at, email_type, structured_data)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      entry.from_address || 'unknown',
      entry.message_id,
      entry.thread_id || '',
      entry.from_address,
      entry.subject,
      entry.rule_id || null,
      entry.rule_name || null,
      entry.action,
      entry.target_group || null,
      entry.summary || null,
      entry.input_tokens,
      entry.output_tokens,
      entry.processed_at,
      entry.email_type || null,
      entry.structured_data || null,
    ],
  });
}

export async function getEmailLog(
  limit = 50,
  offset = 0,
): Promise<EmailLogEntry[]> {
  const result = await db.execute({
    sql: 'SELECT * FROM email_log ORDER BY processed_at DESC LIMIT ? OFFSET ?',
    args: [limit, offset],
  });
  return result.rows.map((r) => ({
    id: r.id as string,
    message_id: r.message_id as string,
    thread_id: (r.thread_id as string) || '',
    from_address: r.from_address as string,
    subject: r.subject as string,
    rule_id: (r.rule_id as string) || null,
    rule_name: (r.rule_name as string) || null,
    action: r.action as string,
    target_group: (r.target_group as string) || null,
    summary: (r.summary as string) || null,
    input_tokens: Number(r.input_tokens) || 0,
    output_tokens: Number(r.output_tokens) || 0,
    processed_at: r.processed_at as string,
    email_type: (r.email_type as string) || null,
    structured_data: (r.structured_data as string) || null,
  }));
}

// --- Agent Alerts ---

export interface AgentAlert {
  id: number;
  group_folder: string;
  group_name: string;
  type: string;
  message: string;
  duration_ms: number | null;
  num_turns: number | null;
  cost_usd: number | null;
  context_percent: number | null;
  created_at: string;
  dismissed: boolean;
}

export async function insertAlert(
  alert: Omit<AgentAlert, 'id' | 'dismissed'>,
): Promise<number> {
  const result = await db.execute({
    sql: `INSERT INTO agent_alerts (group_folder, group_name, type, message, duration_ms, num_turns, cost_usd, context_percent, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      alert.group_folder,
      alert.group_name,
      alert.type,
      alert.message,
      alert.duration_ms ?? null,
      alert.num_turns ?? null,
      alert.cost_usd ?? null,
      alert.context_percent ?? null,
      alert.created_at,
    ],
  });
  return Number(result.lastInsertRowid);
}

export async function getAlerts(limit = 100): Promise<AgentAlert[]> {
  const result = await db.execute({
    sql: 'SELECT * FROM agent_alerts WHERE dismissed = 0 ORDER BY created_at DESC LIMIT ?',
    args: [limit],
  });
  return result.rows.map((r) => ({
    id: Number(r.id),
    group_folder: r.group_folder as string,
    group_name: r.group_name as string,
    type: r.type as string,
    message: r.message as string,
    duration_ms: r.duration_ms != null ? Number(r.duration_ms) : null,
    num_turns: r.num_turns != null ? Number(r.num_turns) : null,
    cost_usd: r.cost_usd != null ? Number(r.cost_usd) : null,
    context_percent:
      r.context_percent != null ? Number(r.context_percent) : null,
    created_at: r.created_at as string,
    dismissed: Boolean(r.dismissed),
  }));
}

export async function dismissAlert(id: number): Promise<void> {
  await db.execute({
    sql: 'UPDATE agent_alerts SET dismissed = 1 WHERE id = ?',
    args: [id],
  });
}

export async function dismissAllAlerts(): Promise<void> {
  await db.execute('UPDATE agent_alerts SET dismissed = 1 WHERE dismissed = 0');
}
