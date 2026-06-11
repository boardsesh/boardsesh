import type { SQLiteDatabase } from 'expo-sqlite';

export const MUTATION_QUEUE_SCHEMA = `
CREATE TABLE IF NOT EXISTS pending_mutations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 10,
  last_error TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
);
`;

export async function ensureMutationQueueTable(db: SQLiteDatabase): Promise<void> {
  await db.execAsync(MUTATION_QUEUE_SCHEMA);
}
