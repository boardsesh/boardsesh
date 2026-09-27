import { sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { rowsOf } from '../util/rows';
import { recomputeClimbStatsBulk, type ClimbStatsKey } from './recompute';

type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/**
 * How a logbook applier refreshes `board_climb_stats` for the keys it wrote.
 * The default is {@link recomputeClimbStatsBulk} on the applier's own
 * transaction. A caller that must keep each write transaction short passes a
 * collector instead ({@link DeferredClimbStatsRecompute.collect}) and runs the
 * recompute afterwards in its own batches.
 */
export type ClimbStatsRecompute = (transaction: DrizzleDb, keys: ClimbStatsKey[]) => Promise<void>;

/** Keys per recompute batch: one seed INSERT and one aggregate UPDATE (recompute.ts's chunk). */
export const CLIMB_STATS_RECOMPUTE_BATCH_KEYS = 500;

/** A pending key this old was left behind by a worker that stopped before its flush. */
export const PENDING_RECOMPUTE_ORPHAN_AGE_MS = 2 * 60 * 1000;

/** Runs one write batch in one transaction, behind whatever fences its owner applies. */
type RecomputeBatchRunner = <Result>(callback: (transaction: DrizzleDb) => Promise<Result>) => Promise<Result>;

function keyOf(key: ClimbStatsKey): string {
  return `${key.boardType} ${key.climbUuid} ${key.angle}`;
}

function compareKeys(left: ClimbStatsKey, right: ClimbStatsKey): number {
  if (left.boardType !== right.boardType) return left.boardType < right.boardType ? -1 : 1;
  if (left.climbUuid !== right.climbUuid) return left.climbUuid < right.climbUuid ? -1 : 1;
  return left.angle - right.angle;
}

/** Distinct keys in one fixed order, so every writer locks pending rows in the same order. */
function sortedDistinct(keys: readonly ClimbStatsKey[]): ClimbStatsKey[] {
  return [...new Map(keys.map((key) => [keyOf(key), key])).values()].sort(compareKeys);
}

function keysPayload(keys: readonly ClimbStatsKey[]): string {
  return JSON.stringify(
    keys.map((key) => ({ board_type: key.boardType, climb_uuid: key.climbUuid, angle: key.angle })),
  );
}

/**
 * Record that `keys` owe a recompute, inside the transaction that wrote their
 * ticks. The upsert (rather than DO NOTHING) takes the row lock, so a flush
 * recomputing the same key either waits for this transaction and then sees its
 * ticks, or deletes the row first and this transaction re-inserts it. Either
 * way the key is recomputed after this write.
 *
 * The update keeps the row's oldest `requested_at`. That timestamp is the
 * orphan clock {@link drainPendingClimbStatsRecomputes} reads, so resetting it
 * on every write would let a key that keeps being re-marked stay younger than
 * the drain's cutoff forever.
 */
export async function markClimbStatsRecomputePending(
  transaction: DrizzleDb,
  keys: readonly ClimbStatsKey[],
): Promise<void> {
  const distinct = sortedDistinct(keys);
  for (let start = 0; start < distinct.length; start += CLIMB_STATS_RECOMPUTE_BATCH_KEYS) {
    const payload = keysPayload(distinct.slice(start, start + CLIMB_STATS_RECOMPUTE_BATCH_KEYS));
    await transaction.execute(sql`
      INSERT INTO climb_stats_recompute_pending AS pending (board_type, climb_uuid, angle)
      SELECT k.board_type, k.climb_uuid, k.angle
        FROM jsonb_to_recordset(${payload}::jsonb) AS k(board_type text, climb_uuid text, angle integer)
      ON CONFLICT (board_type, climb_uuid, angle)
        DO UPDATE SET requested_at = LEAST(pending.requested_at, excluded.requested_at)
    `);
  }
}

/**
 * A pending row as a batch observed it while holding its lock. `requested_at`
 * travels as a UTC ISO-8601 string with microseconds
 * (`2026-09-27T12:00:00.123456Z`, via `to_char(... AT TIME ZONE 'UTC', ...)`):
 * the same text under any session TimeZone, and exact when it goes back into
 * `timestamptz` for the conditional DELETE.
 */
type ObservedMarker = { board_type: string; climb_uuid: string; angle: number; requested_at: string };

function toKey(marker: ObservedMarker): ClimbStatsKey {
  return { boardType: marker.board_type, climbUuid: marker.climb_uuid, angle: marker.angle };
}

/**
 * Delete the pending rows this batch recomputed: only a row whose
 * `requested_at` is no newer than the value the batch observed under its lock.
 * The batch holds every one of these row locks until it commits, so nothing can
 * re-mark them in between; the comparison states that contract in the
 * statement itself rather than leaving it to the lock alone.
 */
async function clearObservedPending(transaction: DrizzleDb, markers: readonly ObservedMarker[]): Promise<void> {
  await transaction.execute(sql`
    DELETE FROM climb_stats_recompute_pending pending
     USING jsonb_to_recordset(${JSON.stringify(markers)}::jsonb)
             AS k(board_type text, climb_uuid text, angle integer, requested_at timestamptz)
     WHERE pending.board_type = k.board_type AND pending.climb_uuid = k.climb_uuid AND pending.angle = k.angle
       AND pending.requested_at <= k.requested_at
  `);
}

/**
 * Recompute one batch of keys and clear their pending rows, in one
 * transaction.
 *
 * Every key gets a locked pending row BEFORE the recompute reads any tick: an
 * upsert inserts a marker for a key that has none (the stale-scan self-heal's
 * keys usually have none) and takes the row lock on one that does, keeping its
 * oldest `requested_at`. The order that makes this safe under READ COMMITTED:
 *
 * 1. this batch holds the marker lock (or the uncommitted insert) for each key;
 * 2. a sync page writing a tick for one of these keys marks it in its own
 *    transaction, so its upsert waits on (1) until this batch commits, and its
 *    tick change is either committed before the recompute's statements read the
 *    ticks (so they see it) or not yet visible (so its marker lands after this
 *    batch's DELETE and survives for the next flush or drain);
 * 3. the DELETE removes only the rows this batch observed, at no newer
 *    `requested_at` than it saw.
 *
 * Without the marker lock, a key with no pending row locked nothing: a page
 * could commit a tick change and a new marker between the recompute's read and
 * the DELETE, the DELETE's fresh snapshot removed that marker, and a deleted or
 * downgraded final send was then invisible to the tick scan for good.
 */
async function recomputeAndClear(transaction: DrizzleDb, keys: readonly ClimbStatsKey[]): Promise<void> {
  const markers = rowsOf<ObservedMarker>(
    await transaction.execute(sql`
      INSERT INTO climb_stats_recompute_pending AS pending (board_type, climb_uuid, angle)
      SELECT k.board_type, k.climb_uuid, k.angle
        FROM jsonb_to_recordset(${keysPayload(keys)}::jsonb) AS k(board_type text, climb_uuid text, angle integer)
      ON CONFLICT (board_type, climb_uuid, angle)
        DO UPDATE SET requested_at = LEAST(pending.requested_at, excluded.requested_at)
      RETURNING pending.board_type, pending.climb_uuid, pending.angle, to_char(pending.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS requested_at
    `),
  );
  await recomputeClimbStatsBulk(transaction, [...keys]);
  await clearObservedPending(transaction, markers);
}

/**
 * Recompute `keys` in batches of at most `batchKeys`, each in its own
 * `runBatch` transaction that also clears the keys' pending rows. A background
 * job passes its fenced runner, so every batch commits under the attempt fence
 * and none of them holds the run-row lock (which blocks the job's heartbeat)
 * for longer than one bounded recompute.
 */
export async function recomputeClimbStatsInBatches(
  runBatch: RecomputeBatchRunner,
  keys: readonly ClimbStatsKey[],
  batchKeys: number = CLIMB_STATS_RECOMPUTE_BATCH_KEYS,
  onBatchCommitted?: (batch: readonly ClimbStatsKey[]) => void,
): Promise<number> {
  if (!Number.isInteger(batchKeys) || batchKeys <= 0) throw new Error('Invalid recompute batch size');
  const distinct = sortedDistinct(keys);
  for (let start = 0; start < distinct.length; start += batchKeys) {
    const batch = distinct.slice(start, start + batchKeys);
    await runBatch((transaction) => recomputeAndClear(transaction, batch));
    onBatchCommitted?.(batch);
  }
  return distinct.length;
}

/**
 * Drain the pending keys a stopped worker left behind: rows older than
 * `olderThanMs`, oldest first, `batchKeys` per transaction, at most
 * `maxBatches` transactions. Returns how many keys it recomputed.
 *
 * Each batch picks its keys by age (past any rows a live flush held on an
 * earlier pick), then locks them in the canonical
 * `(board_type, climb_uuid, angle)` order every other writer of these rows
 * uses (the page's mark, {@link recomputeAndClear}), with `SKIP LOCKED` so it
 * never waits on a live flush. Then the same recompute and conditional DELETE
 * as {@link recomputeAndClear}: a page re-marking one of these keys waits on
 * the lock and its marker lands after this batch commits.
 */
export async function drainPendingClimbStatsRecomputes(
  runBatch: RecomputeBatchRunner,
  options: { olderThanMs?: number; batchKeys?: number; maxBatches?: number } = {},
): Promise<number> {
  const olderThanSeconds = (options.olderThanMs ?? PENDING_RECOMPUTE_ORPHAN_AGE_MS) / 1000;
  const batchKeys = options.batchKeys ?? CLIMB_STATS_RECOMPUTE_BATCH_KEYS;
  const maxBatches = options.maxBatches ?? 20;
  let drained = 0;
  // Rows a live flush held on an earlier pick: skipped over, not re-picked, so
  // one locked batch at the head of the queue cannot stall the drain.
  let skippedOver = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const { picked, recomputed } = await runBatch(async (transaction) => {
      // 1. The oldest keys, unlocked: age decides WHICH rows, never the lock order.
      const oldest = rowsOf<{ board_type: string; climb_uuid: string; angle: number }>(
        await transaction.execute(sql`
          SELECT board_type, climb_uuid, angle
            FROM climb_stats_recompute_pending
           WHERE requested_at < now() - make_interval(secs => ${olderThanSeconds}::double precision)
           ORDER BY requested_at, board_type, climb_uuid, angle
           LIMIT ${batchKeys}
          OFFSET ${skippedOver}
        `),
      );
      if (oldest.length === 0) return { picked: 0, recomputed: 0 };
      // 2. Lock them in key order, skipping any a live flush holds. A row that
      //    went away since step 1 is simply not returned.
      const markers = rowsOf<ObservedMarker>(
        await transaction.execute(sql`
          SELECT pending.board_type, pending.climb_uuid, pending.angle,
                 to_char(pending.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS requested_at
            FROM climb_stats_recompute_pending pending
            JOIN jsonb_to_recordset(${JSON.stringify(oldest)}::jsonb) AS k(board_type text, climb_uuid text, angle integer)
              ON pending.board_type = k.board_type AND pending.climb_uuid = k.climb_uuid AND pending.angle = k.angle
           ORDER BY pending.board_type, pending.climb_uuid, pending.angle
             FOR UPDATE OF pending SKIP LOCKED
        `),
      );
      if (markers.length > 0) {
        await recomputeClimbStatsBulk(transaction, markers.map(toKey));
        await clearObservedPending(transaction, markers);
      }
      return { picked: oldest.length, recomputed: markers.length };
    });
    drained += recomputed;
    // A short pick means the backlog is exhausted. Otherwise the recomputed
    // rows are gone and the locked ones stay at the front: step past those.
    if (picked < batchKeys) break;
    skippedOver += picked - recomputed;
  }
  return drained;
}

/**
 * Moves the stats recompute out of a logbook write transaction, durably.
 *
 * The appliers call `collect` where they used to call the recompute. It writes
 * the keys to `climb_stats_recompute_pending` in that same transaction and
 * stages them in memory; `commit` keeps them once the transaction committed, so
 * a rolled-back page never recomputes keys it did not write. `flush` then
 * recomputes everything committed so far in bounded batches, each deleting the
 * pending rows it recomputed. A worker that stops between a page and its flush
 * leaves the rows for {@link drainPendingClimbStatsRecomputes}.
 */
export class DeferredClimbStatsRecompute {
  private staged: ClimbStatsKey[] = [];
  private committed = new Map<string, ClimbStatsKey>();

  /** Stands in for the recompute inside a write transaction. */
  readonly collect: ClimbStatsRecompute = async (transaction, keys) => {
    if (keys.length === 0) return;
    await markClimbStatsRecomputePending(transaction, keys);
    this.staged.push(...keys);
  };

  /** Start a write transaction: drop whatever an earlier, rolled-back attempt staged. */
  begin(): void {
    this.staged = [];
  }

  /** The write transaction committed: its keys are now owed a recompute. */
  commit(): void {
    for (const key of this.staged) this.committed.set(keyOf(key), key);
    this.staged = [];
  }

  get pendingKeys(): number {
    return this.committed.size;
  }

  /**
   * Recompute every committed key in bounded batches. Each key is forgotten
   * only once the batch that recomputed it committed, so a flush that throws
   * part-way keeps the rest for a retry (and their pending rows for the drain).
   */
  async flush(runBatch: RecomputeBatchRunner, batchKeys?: number): Promise<number> {
    return recomputeClimbStatsInBatches(runBatch, [...this.committed.values()], batchKeys, (batch) => {
      for (const key of batch) this.committed.delete(keyOf(key));
    });
  }
}
