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
      INSERT INTO climb_stats_recompute_pending (board_type, climb_uuid, angle)
      SELECT k.board_type, k.climb_uuid, k.angle
        FROM jsonb_to_recordset(${payload}::jsonb) AS k(board_type text, climb_uuid text, angle integer)
      ON CONFLICT (board_type, climb_uuid, angle)
        DO UPDATE SET requested_at = LEAST(climb_stats_recompute_pending.requested_at, excluded.requested_at)
    `);
  }
}

async function clearPending(transaction: DrizzleDb, keys: readonly ClimbStatsKey[]): Promise<void> {
  await transaction.execute(sql`
    DELETE FROM climb_stats_recompute_pending pending
     USING jsonb_to_recordset(${keysPayload(keys)}::jsonb) AS k(board_type text, climb_uuid text, angle integer)
     WHERE pending.board_type = k.board_type AND pending.climb_uuid = k.climb_uuid AND pending.angle = k.angle
  `);
}

/**
 * Recompute one batch of keys and clear their pending rows, in one
 * transaction. The pending rows are locked first, in key order, so a
 * concurrent page re-marking one of these keys either committed before the
 * recompute's snapshot or re-inserts its row after this DELETE.
 */
async function recomputeAndClear(transaction: DrizzleDb, keys: readonly ClimbStatsKey[]): Promise<void> {
  await transaction.execute(sql`
    SELECT 1
      FROM climb_stats_recompute_pending pending
      JOIN jsonb_to_recordset(${keysPayload(keys)}::jsonb) AS k(board_type text, climb_uuid text, angle integer)
        ON pending.board_type = k.board_type AND pending.climb_uuid = k.climb_uuid AND pending.angle = k.angle
     ORDER BY pending.board_type, pending.climb_uuid, pending.angle
       FOR UPDATE OF pending
  `);
  await recomputeClimbStatsBulk(transaction, [...keys]);
  await clearPending(transaction, keys);
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
 * `maxBatches` transactions. `SKIP LOCKED`, so it never waits on a live flush
 * holding the same rows. Returns how many keys it recomputed.
 */
export async function drainPendingClimbStatsRecomputes(
  runBatch: RecomputeBatchRunner,
  options: { olderThanMs?: number; batchKeys?: number; maxBatches?: number } = {},
): Promise<number> {
  const olderThanSeconds = (options.olderThanMs ?? PENDING_RECOMPUTE_ORPHAN_AGE_MS) / 1000;
  const batchKeys = options.batchKeys ?? CLIMB_STATS_RECOMPUTE_BATCH_KEYS;
  const maxBatches = options.maxBatches ?? 20;
  let drained = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const recomputed = await runBatch(async (transaction) => {
      const keys = rowsOf<{ board_type: string; climb_uuid: string; angle: number }>(
        await transaction.execute(sql`
          SELECT board_type, climb_uuid, angle
            FROM climb_stats_recompute_pending
           WHERE requested_at < now() - make_interval(secs => ${olderThanSeconds}::double precision)
           ORDER BY requested_at
           LIMIT ${batchKeys}
             FOR UPDATE SKIP LOCKED
        `),
      ).map((row) => ({ boardType: row.board_type, climbUuid: row.climb_uuid, angle: row.angle }));
      if (keys.length === 0) return 0;
      await recomputeClimbStatsBulk(transaction, keys);
      await clearPending(transaction, keys);
      return keys.length;
    });
    drained += recomputed;
    if (recomputed < batchKeys) break;
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
