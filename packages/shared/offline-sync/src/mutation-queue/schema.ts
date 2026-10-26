import type { SqlExecutor } from '../database';

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

export async function ensureMutationQueueTable(db: SqlExecutor): Promise<void> {
  await db.execAsync(MUTATION_QUEUE_SCHEMA);
  await ensureMutationQueueDependencies(db);
}

/** Also used by the versioned migration, including databases created by older bundles. */
export async function ensureMutationQueueDependencies(db: SqlExecutor): Promise<void> {
  const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(pending_mutations)');
  const columnNames = new Set(columns.map((column) => column.name));
  for (const columnName of ['entity_key', 'depends_on_key']) {
    if (!columnNames.has(columnName)) {
      await db.execAsync(`ALTER TABLE pending_mutations ADD COLUMN ${columnName} TEXT;`);
    }
  }
  await db.execAsync('CREATE INDEX IF NOT EXISTS idx_pending_mutations_entity ON pending_mutations (entity_key, id);');
  await db.execAsync(
    'CREATE INDEX IF NOT EXISTS idx_pending_mutations_dependency ON pending_mutations (depends_on_key);',
  );
}
