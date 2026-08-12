import type { SqlExecutor } from '../database';

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

/**
 * What an enqueue actually did. `idempotency_key` is UNIQUE and the INSERT is
 * `OR IGNORE`, so a duplicate key is dropped silently — which is correct dedup
 * for a double-tapped favorite (`existingStatus: 'pending'`) but SILENT DATA
 * LOSS once the existing row is a dead letter: every later add for that
 * climb/angle is swallowed at enqueue time, so no drain runs and no
 * dead-letter event can ever fire for it. Callers that use a deterministic key
 * (favorites, follows) inspect this to report the second case.
 */
export type EnqueueResult = {
  inserted: boolean;
  /** Status of the row that won the UNIQUE key, when nothing was inserted. */
  existingStatus: string | null;
};

export async function enqueue(
  db: SqlExecutor,
  tableName: string,
  operation: 'create' | 'update' | 'delete',
  payload: Record<string, unknown>,
  idempotencyKey: string,
): Promise<EnqueueResult> {
  const result = await db.runAsync(
    `INSERT OR IGNORE INTO pending_mutations (table_name, operation, payload, idempotency_key)
     VALUES (?, ?, ?, ?)`,
    [tableName, operation, JSON.stringify(payload), idempotencyKey],
  );
  // Anything other than an explicit `changes: 0` counts as inserted. A driver
  // (or test double) that doesn't report `changes` degrades to losing the
  // suppression signal rather than inventing a data-loss report for every write.
  if (result?.changes !== 0) return { inserted: true, existingStatus: null };

  // Only the suppressed path pays for the extra lookup: a single indexed hit on
  // the UNIQUE column, inside the transaction the caller already opened.
  const existing = await db.getFirstAsync<{ status: string }>(
    'SELECT status FROM pending_mutations WHERE idempotency_key = ?',
    [idempotencyKey],
  );
  return { inserted: false, existingStatus: existing?.status ?? null };
}

export async function peekPending(db: SqlExecutor, limit: number = 10): Promise<PendingMutation[]> {
  // created_at is 1-second resolution (datetime('now')), so two writes in the
  // same second tie on created_at. The `id` (AUTOINCREMENT) tiebreak gives true
  // FIFO for same-second writes — the order a user actually performed them.
  return db.getAllAsync<PendingMutation>(
    `SELECT * FROM pending_mutations WHERE status = 'pending' ORDER BY created_at ASC, id ASC LIMIT ?`,
    [limit],
  );
}

export async function markCompleted(db: SqlExecutor, id: number): Promise<void> {
  await db.runAsync('DELETE FROM pending_mutations WHERE id = ?', [id]);
}

/**
 * The post-UPDATE state of a failed push attempt. The bumped `retryCount` rides
 * along because the drainer's dead-letter telemetry needs "how many attempts
 * did this write burn before we gave up", and re-reading it after the UPDATE
 * would be a second statement racing the same row.
 */
export type RecordFailureResult = {
  status: 'pending' | 'dead_letter';
  retryCount: number;
};

/**
 * Atomically records a failed push attempt: bumps retry_count, stores the error,
 * and flips status to dead_letter in the SAME statement once the bumped count
 * reaches max_retries. Folding the bump and the dead-letter transition into one
 * UPDATE means a crash between them can't leave a mutation with retry_count
 * exhausted but status still 'pending' (which the old two-write
 * incrementRetry + markDeadLetter pair could).
 */
export async function recordFailure(db: SqlExecutor, id: number, error: string): Promise<RecordFailureResult> {
  const row = await db.getFirstAsync<{ status: string; retry_count: number }>(
    `UPDATE pending_mutations
     SET retry_count = retry_count + 1,
         last_error = ?,
         status = CASE WHEN retry_count + 1 >= max_retries THEN 'dead_letter' ELSE status END
     WHERE id = ?
     RETURNING status, retry_count`,
    [error, id],
  );
  // A missing row means another lifecycle action already completed/discarded
  // it. There is no durable dead letter to announce, so preserve the existing
  // conservative contract and report it as pending.
  return {
    status: row?.status === 'dead_letter' ? 'dead_letter' : 'pending',
    retryCount: row?.retry_count ?? 0,
  };
}

/**
 * Force-dead-letters a mutation regardless of retry_count — used for
 * non-retryable failures (validation/4xx) where retrying is pointless.
 */
export async function markDeadLetter(db: SqlExecutor, id: number, error: string): Promise<void> {
  await db.runAsync(`UPDATE pending_mutations SET status = 'dead_letter', last_error = ? WHERE id = ?`, [error, id]);
}

export async function getPendingCount(db: SqlExecutor): Promise<number> {
  const row = await db.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) as count FROM pending_mutations WHERE status = 'pending'`,
  );
  return row?.count ?? 0;
}

export async function getDeadLetterCount(db: SqlExecutor): Promise<number> {
  const row = await db.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) as count FROM pending_mutations WHERE status = 'dead_letter'`,
  );
  return row?.count ?? 0;
}

/**
 * A whole-outbox gauge: how much unsynced work is sitting here, and how old the
 * oldest of each kind is.
 *
 * Per-mutation telemetry only counts from the moment it ships, and sign-out
 * DELETEs the entire outbox (mobile's USER_DATA_TABLES_TO_CLEAR includes
 * pending_mutations), so a backlog that accumulated before either event is
 * otherwise invisible forever. One grouped SELECT rather than four COUNT
 * queries because the mobile callers read this on the launch path and inside
 * sign-out.
 */
export type OutboxSummary = {
  pendingCount: number;
  deadLetterCount: number;
  /** Raw SQLite `created_at`; parse with parseQueueTimestamp. */
  oldestPendingAt: string | null;
  oldestDeadLetterAt: string | null;
};

export async function getOutboxSummary(db: SqlExecutor): Promise<OutboxSummary> {
  const rows = await db.getAllAsync<{ status: string; count: number; oldest_created_at: string | null }>(
    `SELECT status, COUNT(*) as count, MIN(created_at) as oldest_created_at
     FROM pending_mutations
     GROUP BY status`,
  );
  const summary: OutboxSummary = {
    pendingCount: 0,
    deadLetterCount: 0,
    oldestPendingAt: null,
    oldestDeadLetterAt: null,
  };
  for (const row of rows) {
    if (row.status === 'pending') {
      summary.pendingCount = row.count;
      summary.oldestPendingAt = row.oldest_created_at;
    } else if (row.status === 'dead_letter') {
      summary.deadLetterCount = row.count;
      summary.oldestDeadLetterAt = row.oldest_created_at;
    }
  }
  return summary;
}

export async function getDeadLetters(db: SqlExecutor): Promise<PendingMutation[]> {
  return db.getAllAsync<PendingMutation>(
    `SELECT * FROM pending_mutations WHERE status = 'dead_letter' ORDER BY created_at ASC`,
  );
}

export async function retryDeadLetter(db: SqlExecutor, id: number): Promise<void> {
  await db.runAsync(
    `UPDATE pending_mutations SET status = 'pending', retry_count = 0, last_error = NULL WHERE id = ?`,
    [id],
  );
}

export async function discardDeadLetter(db: SqlExecutor, id: number): Promise<void> {
  await db.runAsync('DELETE FROM pending_mutations WHERE id = ? AND status = ?', [id, 'dead_letter']);
}

export async function clearAll(db: SqlExecutor): Promise<void> {
  await db.runAsync('DELETE FROM pending_mutations');
}
