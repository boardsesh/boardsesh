import type { SQLiteDatabase } from 'expo-sqlite';

export type PendingMutation = {
  id: number;
  table_name: string;
  operation: string;
  payload: string;
  idempotency_key: string;
  created_at: string;
  retry_count: number;
  max_retries: number;
  last_error: string | null;
  status: string;
};

export async function enqueue(
  db: SQLiteDatabase,
  tableName: string,
  operation: 'create' | 'update' | 'delete',
  payload: Record<string, unknown>,
  idempotencyKey: string,
): Promise<void> {
  await db.runAsync(
    `INSERT OR IGNORE INTO pending_mutations (table_name, operation, payload, idempotency_key)
     VALUES (?, ?, ?, ?)`,
    [tableName, operation, JSON.stringify(payload), idempotencyKey],
  );
}

export async function peekPending(db: SQLiteDatabase, limit: number = 10): Promise<PendingMutation[]> {
  return db.getAllAsync<PendingMutation>(
    `SELECT * FROM pending_mutations WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?`,
    [limit],
  );
}

export async function markCompleted(db: SQLiteDatabase, id: number): Promise<void> {
  await db.runAsync('DELETE FROM pending_mutations WHERE id = ?', [id]);
}

export async function incrementRetry(db: SQLiteDatabase, id: number, error: string): Promise<void> {
  await db.runAsync('UPDATE pending_mutations SET retry_count = retry_count + 1, last_error = ? WHERE id = ?', [
    error,
    id,
  ]);
}

export async function markDeadLetter(db: SQLiteDatabase, id: number, error: string): Promise<void> {
  await db.runAsync(`UPDATE pending_mutations SET status = 'dead_letter', last_error = ? WHERE id = ?`, [error, id]);
}

export async function getPendingCount(db: SQLiteDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) as count FROM pending_mutations WHERE status = 'pending'`,
  );
  return row?.count ?? 0;
}

export async function getDeadLetterCount(db: SQLiteDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) as count FROM pending_mutations WHERE status = 'dead_letter'`,
  );
  return row?.count ?? 0;
}

export async function getDeadLetters(db: SQLiteDatabase): Promise<PendingMutation[]> {
  return db.getAllAsync<PendingMutation>(
    `SELECT * FROM pending_mutations WHERE status = 'dead_letter' ORDER BY created_at ASC`,
  );
}

export async function retryDeadLetter(db: SQLiteDatabase, id: number): Promise<void> {
  await db.runAsync(
    `UPDATE pending_mutations SET status = 'pending', retry_count = 0, last_error = NULL WHERE id = ?`,
    [id],
  );
}

export async function discardDeadLetter(db: SQLiteDatabase, id: number): Promise<void> {
  await db.runAsync('DELETE FROM pending_mutations WHERE id = ? AND status = ?', [id, 'dead_letter']);
}

export async function clearAll(db: SQLiteDatabase): Promise<void> {
  await db.runAsync('DELETE FROM pending_mutations');
}
