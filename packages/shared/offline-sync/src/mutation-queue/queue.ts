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
 * for a double-tapped favorite (`existingStatus: 'pending'`) but was SILENT
 * DATA LOSS once the existing row was a dead letter: every later add for that
 * climb/angle was swallowed at enqueue time, so no drain ran and no dead-letter
 * event could ever fire for it (#4331).
 *
 * Callers with a deterministic key opt into `reviveDeadLetter` to take the
 * escape hatch instead — see `EnqueueOptions`.
 */
export type EnqueueResult = {
  inserted: boolean;
  /**
   * A dead-lettered row already owned this key and was reset to `pending` with
   * the payload of THIS write. Mutually exclusive with `inserted`.
   */
  revived: boolean;
  /** Status of the row that won the UNIQUE key, when nothing was inserted. */
  existingStatus: string | null;
};

export type EnqueueOptions = {
  /**
   * When a DEAD-LETTERED row already owns this idempotency key, reset it to
   * `pending` and overwrite it with this write instead of dropping the write.
   *
   * Off by default, because it is only correct for a DETERMINISTIC key, where
   * the colliding row represents the same user intent for the same target. A
   * per-write uuid (ticks) can never collide, so it never needs this.
   *
   * Opt in from EVERY deterministic-key call site. `setter_follows`,
   * `playlist_follows` and `user_playlist_pins` have drainer handlers but no
   * enqueue call site yet — whoever adds one MUST pass this, or that key
   * inherits the favorites/follows blind spot the moment it dead-letters.
   */
  reviveDeadLetter?: boolean;
};

export async function enqueue(
  db: SqlExecutor,
  tableName: string,
  operation: 'create' | 'update' | 'delete',
  payload: Record<string, unknown>,
  idempotencyKey: string,
  options: EnqueueOptions = {},
): Promise<EnqueueResult> {
  const serializedPayload = JSON.stringify(payload);
  const result = await db.runAsync(
    `INSERT OR IGNORE INTO pending_mutations (table_name, operation, payload, idempotency_key)
     VALUES (?, ?, ?, ?)`,
    [tableName, operation, serializedPayload, idempotencyKey],
  );
  // Anything other than an explicit `changes: 0` counts as inserted. A driver
  // (or test double) that doesn't report `changes` degrades to losing the
  // suppression signal rather than inventing a data-loss report for every write.
  if (result?.changes !== 0) return { inserted: true, revived: false, existingStatus: null };

  // Only the suppressed path pays for the extra lookup: a single indexed hit on
  // the UNIQUE column, inside the transaction the caller already opened.
  const existing = await db.getFirstAsync<{ status: string }>(
    'SELECT status FROM pending_mutations WHERE idempotency_key = ?',
    [idempotencyKey],
  );
  const existingStatus = existing?.status ?? null;

  if (!options.reviveDeadLetter || existingStatus !== 'dead_letter') {
    return { inserted: false, revived: false, existingStatus };
  }

  // Overwrite table/operation/payload as well as the status: the revived row
  // must replay the CURRENT intent, not the one that died (an add key revived
  // by a later add carries the later add's payload). `created_at` is bumped so
  // peekPending's FIFO stays honest and queue-age telemetry stops reporting the
  // weeks the row spent dead. Guarded on `status = 'dead_letter'` so it can
  // never touch a row a concurrent drain has in flight.
  const revive = await db.runAsync(
    `UPDATE pending_mutations
     SET table_name = ?, operation = ?, payload = ?, status = 'pending',
         retry_count = 0, last_error = NULL, created_at = datetime('now')
     WHERE idempotency_key = ? AND status = 'dead_letter'`,
    [tableName, operation, serializedPayload, idempotencyKey],
  );
  // Same defensive read as the INSERT above: a driver that reports no `changes`
  // count degrades to "revived", matching the row state we just wrote.
  return { inserted: false, revived: revive?.changes !== 0, existingStatus };
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

/**
 * `limit` is for callers that act on the rows rather than display them (the
 * launch recovery sweep), so their ceiling is enforced by the query instead of
 * only by the loop that walks the result. Unbounded by default: the Sync-issues
 * screen shows the user everything they have.
 */
export async function getDeadLetters(db: SqlExecutor, limit?: number): Promise<PendingMutation[]> {
  if (limit === undefined) {
    return db.getAllAsync<PendingMutation>(
      `SELECT * FROM pending_mutations WHERE status = 'dead_letter' ORDER BY created_at ASC`,
    );
  }
  return db.getAllAsync<PendingMutation>(
    `SELECT * FROM pending_mutations WHERE status = 'dead_letter' ORDER BY created_at ASC LIMIT ?`,
    [limit],
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
