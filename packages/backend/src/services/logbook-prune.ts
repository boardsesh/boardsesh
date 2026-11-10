import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { BackgroundJobTransaction } from '@boardsesh/db/queries';
import { LOGBOOK_CHANGE_WATERMARK_SINGLETON_ID, logbookChangeWatermark, logbookChanges } from '@boardsesh/db/schema';
import { positionIsBefore, type LogbookFeedPosition } from './logbook-feed';

/**
 * The logbook feed's retention job (docs/integration-platform.md, "Retention,
 * cursor validity and moving the database"): deletes `logbook_changes` rows
 * older than 90 days and advances the retention watermark over them.
 *
 * The one rule that keeps a reader from missing a change: **every row a batch
 * deletes sits at or below the watermark that the same transaction commits.**
 * The batch ends by raising the watermark to the last position it deleted, and
 * never lowers it. Readers take the watermark and the rows from one REPEATABLE
 * READ snapshot (`readLogbookFeedPage`), so a reader sees the rows and the old
 * watermark, or the new watermark without the rows, never the gap between. A
 * cursor below the watermark answers 410; a cursor at or above it reads rows
 * none of which were deleted.
 *
 * Two more rules:
 *
 * - **Only rows below the transaction horizon.** A batch deletes a row only when
 *   its transaction is older than every transaction still running. The feed
 *   never serves past the horizon, so a watermark above it would expire every
 *   cursor, including the one a reader was handed a moment ago.
 * - **Only rows older than 90 days**, by `created_at`, the writing transaction's
 *   start. The walk goes in insertion order (`seq`, the primary key) and stops at
 *   the first younger row. Insertion order and feed order (`txid`, `seq`) differ
 *   slightly, so a younger row can sit below the new watermark; it is kept, is
 *   unreachable (every cursor below the watermark answers 410), and goes once it
 *   is 90 days old without moving the watermark back.
 *
 * Why the primary key and not the BRIN index on `created_at`: rows are deleted
 * from the head of the table and inserted at the tail, so VACUUM hands the
 * emptied head pages to new inserts. A BRIN range only ever widens, so after one
 * 90-day cycle every range would match `created_at < cutoff` and the scan would
 * read the whole table. A walk up the primary key reads only the oldest rows.
 */

/** How long a change stays in the log. A cursor older than this may answer 410. */
export const LOGBOOK_CHANGE_RETENTION_DAYS = 90;
/** Rows one delete transaction removes. About 9 heap pages at 134 bytes a row. */
export const LOGBOOK_PRUNE_ROWS_PER_BATCH = 500;
/** Batches one run may delete before leaving the rest for the next run: 200,000 rows. */
export const LOGBOOK_PRUNE_MAX_BATCHES = 400;
/** Wall-clock time one run may spend before leaving the rest for the next run. */
export const LOGBOOK_PRUNE_BUDGET_MS = 240_000;

/**
 * The walk is a plain read outside every transaction that holds a lock, so it
 * may take longer than a delete. The first one of a run steps over every index
 * entry earlier runs deleted and autovacuum has not cleared yet: at about 32,000
 * rows a day (production, November 2026) and autovacuum's 20% threshold, up to
 * about 1,450 leaf pages, plus the previous run's ~530 heap pages the first
 * time. At 30 ms a cold page that is about 60 s, so the bound is 120 s. It holds
 * only ACCESS SHARE on the table.
 */
const WALK_STATEMENT_TIMEOUT = '120s';
const DELETE_STATEMENT_TIMEOUT = '5s';
/**
 * Both transactions, as the feed read does: a worker that freezes mid-batch
 * holds a transaction id, and every partner's feed horizon with it, for at most
 * this long.
 */
const IDLE_IN_TRANSACTION_TIMEOUT = '10s';
/**
 * Only the watermark row can make a delete wait: a candidate row someone else
 * holds (an account deletion) is skipped, not waited for.
 */
const DELETE_LOCK_TIMEOUT = '1s';

export type BatchRunner = <Result>(
  callback: (transaction: BackgroundJobTransaction) => Promise<Result>,
) => Promise<Result>;

/** Why a run stopped. Everything but `caught_up` leaves work for the next run. */
export type LogbookPruneStop =
  /** Nothing left that is old enough. */
  | 'caught_up'
  /** The next row in insertion order is younger than the retention period. */
  | 'young_row'
  /** The next row's transaction is not below the horizon yet. */
  | 'unsettled_row'
  | 'max_batches'
  | 'time_budget';

export interface LogbookPruneResult {
  rowsDeleted: number;
  batches: number;
  /** The watermark after the run. */
  prunedThrough: LogbookFeedPosition;
  stoppedBy: LogbookPruneStop;
}

export interface LogbookPruneOptions {
  signal?: AbortSignal;
  rowsPerBatch?: number;
  maxBatches?: number;
  budgetMs?: number;
  /** Milliseconds since the epoch, for the time budget. */
  clock?: () => number;
}

type WalkedRow = { seq: string; expired: boolean; settled: boolean };

/**
 * `created_at` is a `timestamp` written by `now()` in the writer's session time
 * zone, and `localtimestamp` is the same clock in this session's zone. Both use
 * the database default, so the two compare like for like.
 */
const expiredCondition = sql`${logbookChanges.createdAt} < localtimestamp - make_interval(days => ${LOGBOOK_CHANGE_RETENTION_DAYS}::int)`;
/** Every transaction below this snapshot's xmin has finished, so its rows can no longer change. */
const settledCondition = sql`${logbookChanges.txid} < pg_snapshot_xmin(pg_current_snapshot())`;

async function readWatermark(transaction: BackgroundJobTransaction): Promise<LogbookFeedPosition> {
  const [state] = await transaction
    .select({
      txid: sql<string>`${logbookChangeWatermark.prunedThroughTxid}::text`,
      seq: sql<string>`${logbookChangeWatermark.prunedThroughSeq}::text`,
    })
    .from(logbookChangeWatermark)
    .where(eq(logbookChangeWatermark.id, LOGBOOK_CHANGE_WATERMARK_SINGLETON_ID));
  if (!state) throw new Error('logbook_change_watermark has no row: the logbook trigger migration has not run');
  return state;
}

/** The next rows in insertion order, and whether each may go. A read; it locks nothing. */
async function walk(read: BatchRunner, afterSeq: bigint, limit: number): Promise<WalkedRow[]> {
  return read(async (transaction) => {
    await transaction.execute(
      sql`SELECT set_config('statement_timeout', ${WALK_STATEMENT_TIMEOUT}, true), set_config('idle_in_transaction_session_timeout', ${IDLE_IN_TRANSACTION_TIMEOUT}, true)`,
    );
    return transaction
      .select({
        seq: sql<string>`${logbookChanges.seq}::text`,
        expired: sql<boolean>`${expiredCondition}`,
        settled: sql<boolean>`${settledCondition}`,
      })
      .from(logbookChanges)
      .where(gt(logbookChanges.seq, afterSeq))
      .orderBy(asc(logbookChanges.seq))
      .limit(limit);
  });
}

/**
 * Deletes the given rows that are still old enough and settled, skipping any row
 * another transaction holds, and raises the watermark over what it deleted, all
 * in one transaction. Returns the number deleted.
 */
async function deleteBatch(transaction: BackgroundJobTransaction, seqs: bigint[]): Promise<number> {
  await transaction.execute(
    sql`SELECT set_config('statement_timeout', ${DELETE_STATEMENT_TIMEOUT}, true), set_config('lock_timeout', ${DELETE_LOCK_TIMEOUT}, true), set_config('idle_in_transaction_session_timeout', ${IDLE_IN_TRANSACTION_TIMEOUT}, true)`,
  );
  // Both conditions again, in this transaction: the walk was another snapshot.
  const claimable = transaction
    .select({ seq: logbookChanges.seq })
    .from(logbookChanges)
    .where(and(inArray(logbookChanges.seq, seqs), expiredCondition, settledCondition))
    .for('update', { skipLocked: true });
  const deleted = await transaction
    .delete(logbookChanges)
    .where(inArray(logbookChanges.seq, claimable))
    .returning({
      txid: sql<string>`${logbookChanges.txid}::text`,
      seq: sql<string>`${logbookChanges.seq}::text`,
    });
  if (deleted.length === 0) return 0;

  const last = deleted.reduce((highest, row) => (positionIsBefore(highest, row) ? row : highest));
  // Never backwards: a batch that deleted only rows already below the watermark
  // leaves it where it is.
  await transaction
    .update(logbookChangeWatermark)
    .set({ prunedThroughTxid: last.txid, prunedThroughSeq: BigInt(last.seq), updatedAt: sql`now()` })
    .where(
      and(
        eq(logbookChangeWatermark.id, LOGBOOK_CHANGE_WATERMARK_SINGLETON_ID),
        sql`(${logbookChangeWatermark.prunedThroughTxid}, ${logbookChangeWatermark.prunedThroughSeq}) < (${last.txid}::xid8, ${last.seq}::bigint)`,
      ),
    );
  return deleted.length;
}

/**
 * One run: walk up the primary key from the oldest row, delete each batch of
 * rows that are old enough in its own short transaction, and stop at the first
 * row that is not, or at the run's batch or time budget.
 *
 * `read` runs the walk (no row locks, a 120 s statement timeout); `runBatch` runs each
 * delete (5 s per statement, 1 s per lock wait). In the worker, `runBatch` is
 * the attempt fence and `read` is the unfenced connection.
 */
export async function pruneLogbookChanges(
  { read, runBatch }: { read: BatchRunner; runBatch: BatchRunner },
  {
    signal,
    rowsPerBatch = LOGBOOK_PRUNE_ROWS_PER_BATCH,
    maxBatches = LOGBOOK_PRUNE_MAX_BATCHES,
    budgetMs = LOGBOOK_PRUNE_BUDGET_MS,
    clock = Date.now,
  }: LogbookPruneOptions = {},
): Promise<LogbookPruneResult> {
  const startedAt = clock();
  let afterSeq = 0n;
  let rowsDeleted = 0;
  let batches = 0;
  let stoppedBy: LogbookPruneStop | undefined;

  while (!stoppedBy) {
    if (batches >= maxBatches) {
      stoppedBy = 'max_batches';
      break;
    }
    if (clock() - startedAt >= budgetMs) {
      stoppedBy = 'time_budget';
      break;
    }
    signal?.throwIfAborted();

    const walked = await walk(read, afterSeq, rowsPerBatch);
    const firstKept = walked.findIndex((row) => !row.expired || !row.settled);
    const deletable = firstKept === -1 ? walked : walked.slice(0, firstKept);
    if (firstKept !== -1) stoppedBy = walked[firstKept].expired ? 'unsettled_row' : 'young_row';
    else if (walked.length < rowsPerBatch) stoppedBy = 'caught_up';

    if (deletable.length > 0) {
      const seqs = deletable.map((row) => BigInt(row.seq));
      rowsDeleted += await runBatch((transaction) => deleteBatch(transaction, seqs));
      batches += 1;
      afterSeq = seqs[seqs.length - 1];
    }
  }

  const prunedThrough = await read(readWatermark);
  return { rowsDeleted, batches, prunedThrough, stoppedBy };
}
