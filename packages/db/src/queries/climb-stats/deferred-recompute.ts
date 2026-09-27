import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
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

/** Runs one write batch in one transaction, behind whatever fences its owner applies. */
type RecomputeBatchRunner = <Result>(callback: (transaction: DrizzleDb) => Promise<Result>) => Promise<Result>;

function keyOf(key: ClimbStatsKey): string {
  return `${key.boardType} ${key.climbUuid} ${key.angle}`;
}

/**
 * Recompute `keys` in batches of at most `batchKeys`, each in its own
 * `runBatch` transaction. A background job passes its fenced runner, so every
 * batch commits under the attempt fence and none of them holds the run-row lock
 * (which blocks the job's heartbeat) for longer than one bounded recompute.
 */
export async function recomputeClimbStatsInBatches(
  runBatch: RecomputeBatchRunner,
  keys: readonly ClimbStatsKey[],
  batchKeys: number = CLIMB_STATS_RECOMPUTE_BATCH_KEYS,
): Promise<number> {
  if (!Number.isInteger(batchKeys) || batchKeys <= 0) throw new Error('Invalid recompute batch size');
  const distinct = [...new Map(keys.map((key) => [keyOf(key), key])).values()];
  for (let start = 0; start < distinct.length; start += batchKeys) {
    const batch = distinct.slice(start, start + batchKeys);
    await runBatch((transaction) => recomputeClimbStatsBulk(transaction, batch));
  }
  return distinct.length;
}

/**
 * Moves the stats recompute out of a logbook write transaction.
 *
 * The appliers call `collect` where they used to call the recompute; the keys
 * are staged per write transaction and only kept once that transaction has
 * committed (`commit`), so a rolled-back page never recomputes keys it did not
 * write. `flush` then recomputes everything committed so far in bounded
 * batches. Keys lost to a crash between the page commit and the flush are
 * picked up by the hourly self-heal (`selfHealStaleClimbStats`): their ticks'
 * `updated_at` is newer than the stats row.
 */
export class DeferredClimbStatsRecompute {
  private staged: ClimbStatsKey[] = [];
  private committed = new Map<string, ClimbStatsKey>();

  /** Stands in for the recompute inside a write transaction. */
  readonly collect: ClimbStatsRecompute = async (_transaction, keys) => {
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

  /** Recompute every committed key in bounded batches, then forget them. */
  async flush(runBatch: RecomputeBatchRunner, batchKeys?: number): Promise<number> {
    const keys = [...this.committed.values()];
    this.committed = new Map();
    return recomputeClimbStatsInBatches(runBatch, keys, batchKeys);
  }
}
