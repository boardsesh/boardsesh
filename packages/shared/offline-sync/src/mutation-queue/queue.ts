import type { SqlExecutor } from '../database';
import type { OfflineBoardScope } from '../offline-board-key';

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
  entity_key?: string | null;
  depends_on_key?: string | null;
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
  /** All authored writes for one climb share this key. */
  entityKey?: string;
  /** Replay only after this earlier operation has been acknowledged and removed. */
  dependsOnKey?: string;
};

export async function enqueue(
  db: SqlExecutor,
  tableName: string,
  operation: 'create' | 'update' | 'delete',
  payload: Record<string, unknown>,
  idempotencyKey: string,
  options: EnqueueOptions = {},
): Promise<EnqueueResult> {
  if (options.dependsOnKey === idempotencyKey) throw new Error('A queued write cannot depend on itself');
  const serializedPayload = JSON.stringify(payload);
  // Reference writes must wait for an offline climb too: CLIMB_NOT_FOUND is
  // otherwise treated as a deleted climb and silently acknowledged by the drain.
  // Resolve inside the INSERT/UPDATE so even callers without an enclosing
  // transaction cannot miss a climb write committed before this reference.
  const referenceEntityKey =
    operation === 'create' &&
    (tableName === 'user_favorites' || tableName === 'playlist_climbs') &&
    typeof payload.climbUuid === 'string'
      ? climbMutationEntityKey('spray', payload.climbUuid)
      : null;
  const dependencySql = referenceEntityKey
    ? `COALESCE(?, (SELECT idempotency_key FROM pending_mutations
         WHERE table_name = 'board_climbs' AND entity_key = ? ORDER BY id DESC LIMIT 1))`
    : '?';
  const dependencyParams = referenceEntityKey
    ? [options.dependsOnKey ?? null, referenceEntityKey]
    : [options.dependsOnKey ?? null];
  const result = await db.runAsync(
    `INSERT OR IGNORE INTO pending_mutations (table_name, operation, payload, idempotency_key, entity_key, depends_on_key)
     VALUES (?, ?, ?, ?, ?, ${dependencySql})`,
    [tableName, operation, serializedPayload, idempotencyKey, options.entityKey ?? null, ...dependencyParams],
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
     SET table_name = ?, operation = ?, payload = ?, entity_key = ?, depends_on_key = ${dependencySql}, status = 'pending',
         retry_count = 0, last_error = NULL, created_at = datetime('now')
     WHERE idempotency_key = ? AND status = 'dead_letter'`,
    [tableName, operation, serializedPayload, options.entityKey ?? null, ...dependencyParams, idempotencyKey],
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
    `SELECT pending.* FROM pending_mutations pending
     WHERE pending.status = 'pending' AND NOT EXISTS (
       SELECT 1 FROM pending_mutations dependency WHERE dependency.idempotency_key = pending.depends_on_key
     ) ORDER BY pending.created_at ASC, pending.id ASC LIMIT ?`,
    [limit],
  );
}

export function climbMutationEntityKey(boardType: string, climbUuid: string): string {
  return `climb:${boardType}:${climbUuid}`;
}

/** Call inside the local-write transaction so a new edit/tick cannot overtake a save. */
export async function getLatestClimbMutationKey(
  db: SqlExecutor,
  boardType: string,
  climbUuid: string,
  excludedMutationKey?: string,
): Promise<string | null> {
  const mutation = await db.getFirstAsync<{ idempotency_key: string }>(
    `SELECT idempotency_key FROM pending_mutations
     WHERE table_name = 'board_climbs' AND entity_key = ? AND (? IS NULL OR idempotency_key <> ?)
     ORDER BY id DESC LIMIT 1`,
    [climbMutationEntityKey(boardType, climbUuid), excludedMutationKey ?? null, excludedMutationKey ?? null],
  );
  return mutation?.idempotency_key ?? null;
}

/** User-requested cache removal must never remove the only editable copy of a queued climb. */
export async function hasPendingClimbWritesForScope(db: SqlExecutor, scope: OfflineBoardScope): Promise<boolean> {
  if (scope.boardType !== 'spray') return false;
  const mutation = await db.getFirstAsync<{ found: number }>(
    `SELECT 1 AS found FROM board_climbs climb JOIN pending_mutations mutation
       ON mutation.entity_key = 'climb:' || climb.board_type || ':' || climb.uuid
     WHERE climb.board_type = ? AND climb.layout_id = ? AND mutation.table_name = 'board_climbs'
       AND mutation.status IN ('pending', 'dead_letter') LIMIT 1`,
    [scope.boardType, scope.layoutId],
  );
  return mutation != null;
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

/**
 * Whether this device still has a tick on `climbUuid` waiting in the outbox
 * (#5960). The setter's "Delete climb" refuses while one does: the server only
 * counts ticks it has, so a delete sent now would win, and the queued send would
 * then dead-letter as CLIMB_NOT_FOUND. A row being drained stays `pending` until
 * it is marked completed, so an in-flight send counts too. Dead letters do not.
 */
export async function hasPendingTickForClimb(
  db: SqlExecutor,
  climbUuid: string,
  options: { includeDeadLetters?: boolean } = {},
): Promise<boolean> {
  const row = await db.getFirstAsync<{ found: number }>(
    `SELECT 1 AS found FROM pending_mutations
     WHERE table_name = 'boardsesh_ticks' AND operation = 'create'
       AND ${options.includeDeadLetters ? "status IN ('pending', 'dead_letter')" : "status = 'pending'"}
       AND json_extract(payload, '$.climbUuid') = ?
     LIMIT 1`,
    [climbUuid],
  );
  return row != null;
}

/**
 * Whether this device still has a tick logged in `sessionId` waiting in the
 * outbox (#6903). Ending a session asks before END_SESSION: the server builds
 * the summary, and the Strava export, from the ticks it already has, so a send
 * still queued here would be missing from both. Same row rules as
 * `hasPendingTickForClimb`: an in-flight send counts, a dead letter does not.
 */
export async function hasPendingTicksForSession(db: SqlExecutor, sessionId: string): Promise<boolean> {
  const row = await db.getFirstAsync<{ found: number }>(
    `SELECT 1 AS found FROM pending_mutations
     WHERE table_name = 'boardsesh_ticks' AND operation = 'create' AND status = 'pending'
       AND json_extract(payload, '$.sessionId') = ?
     LIMIT 1`,
    [sessionId],
  );
  return row != null;
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
  // One SQL statement checks and deletes, so a concurrently queued tick cannot
  // slip between a preflight read and the removal of the climb it depends on.
  const discarded = await db.runAsync(
    `DELETE FROM pending_mutations WHERE id = ? AND status = ?
     AND NOT EXISTS (SELECT 1 FROM pending_mutations dependent
       WHERE dependent.depends_on_key = pending_mutations.idempotency_key)`,
    [id, 'dead_letter'],
  );
  if (discarded?.changes === 0) {
    const dependency = await db.getFirstAsync<{ found: number }>(
      `SELECT 1 AS found FROM pending_mutations parent
       JOIN pending_mutations dependent ON dependent.depends_on_key = parent.idempotency_key
       WHERE parent.id = ? AND parent.status = 'dead_letter' LIMIT 1`,
      [id],
    );
    if (dependency) throw new Error('Retry or repair this climb before discarding the writes that depend on it');
  }
}

export async function clearAll(db: SqlExecutor): Promise<void> {
  await db.runAsync('DELETE FROM pending_mutations');
}
