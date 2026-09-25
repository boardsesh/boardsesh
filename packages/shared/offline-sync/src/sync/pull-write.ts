// The write primitives every background writer in the sync engine shares: the
// bound-parameter ceiling, the multi-row INSERT builder sized against it, and the
// retried IMMEDIATE transaction a write nobody is waiting on runs in.
//
// Extracted from pull-client.ts so the holds index builder (holds-index/) can
// write through exactly the same lock discipline as a pull page without an
// import cycle back through the pull client.

import type { OfflineDatabase, SqlExecutor } from '../database';
import { beginImmediateWrite, OFFLINE_DB_BUSY_TIMEOUT_MS } from '../db/pragmas';
import {
  runLocalWriteWithRetry,
  OFFLINE_BACKGROUND_WRITE_BUDGET_MS,
  OFFLINE_BACKGROUND_WRITE_MAX_ATTEMPTS,
  OFFLINE_BACKGROUND_WRITE_RETRY_DELAY_MS,
} from '../db/write-retry';
import { TABLE_CONFIGS } from './table-config';

// SQLite's default compile-time limit on bound parameters per statement
// (SQLITE_MAX_VARIABLE_NUMBER's pre-3.32 default, still the safe floor across
// the SQLite builds we run on — bundled iOS/Android sqlite3, node:sqlite).
// Batching must never bind more than this per INSERT.
export const SQLITE_MAX_BIND_VARIABLES = 999;

/**
 * How many rows fit in one multi-row `INSERT OR REPLACE ... VALUES (...),(...)`
 * statement without exceeding SQLite's bound-parameter ceiling. Always at
 * least 1 (a table wider than the ceiling still gets one row per statement —
 * it just can't batch).
 */
export function multiRowChunkSize(columnCount: number): number {
  return Math.max(1, Math.floor(SQLITE_MAX_BIND_VARIABLES / columnCount));
}

export function buildMultiRowInsertSql(
  tableName: string,
  columns: readonly string[],
  rowCount: number,
  preserveNewerRows = false,
): string {
  const columnList = columns.join(', ');
  const rowPlaceholder = `(${columns.map(() => '?').join(', ')})`;
  const valuesClause = Array.from({ length: rowCount }, () => rowPlaceholder).join(', ');
  if (!preserveNewerRows) return `INSERT OR REPLACE INTO ${tableName} (${columnList}) VALUES ${valuesClause}`;
  const { primaryKeyColumns, cursorColumn } = TABLE_CONFIGS[tableName];
  const assignments = columns
    .filter((column) => !primaryKeyColumns.includes(column))
    .map((column) => `${column} = excluded.${column}`)
    .join(', ');
  // Sync/export timestamps are UTC ISO text, but PostgreSQL omits trailing
  // fractional zeroes. Pad the fraction so TEXT ordering preserves microseconds.
  const timestampKey = (column: string) =>
    `(substr(${column}, 1, 19) || '.' || CASE WHEN substr(${column}, 20, 1) = '.'
      THEN substr(substr(${column}, 21, length(${column}) - 21) || '000000', 1, 6)
      ELSE '000000' END)`;
  return `INSERT INTO ${tableName} (${columnList}) VALUES ${valuesClause}
    ON CONFLICT (${primaryKeyColumns.join(', ')}) DO UPDATE SET ${assignments}
    WHERE ${tableName}.${cursorColumn} IS NULL
       OR (${timestampKey(`excluded.${cursorColumn}`)}, excluded.sync_seq)
          >= (${timestampKey(`${tableName}.${cursorColumn}`)}, ${tableName}.sync_seq)`;
}

/**
 * Run one of the pull's write transactions, retrying a lost SQLite write lock
 * instead of letting it abort the whole cycle (issue #5302).
 *
 * WHAT USED TO HAPPEN. Each of these transactions opened expo's deferred `BEGIN`,
 * set `busy_timeout`, and wrote. A `SQLITE_BUSY` anywhere inside threw out of
 * `upsertDocuments` → `syncTable` → `pullSync`, so ONE contended page ended the
 * cycle: every table after it in BOARD_DATA_TABLES was skipped, no checkpoint
 * advanced, and no `scope-complete:` marker was written. The scheduler's next wake
 * is 30s later and met the same contention, which is what "Waiting to download"
 * looks like from the outside. 1,431 events across 365 users in 30 days landed on
 * `phase:board_data` alone (Sentry BOARDSESH-CW / BOARDSESH-CF).
 *
 * TWO THINGS ARE WRONG WITH THE OLD SHAPE, and this fixes both:
 *
 *  1. `applyBusyTimeout` alone is not enough for a task that READS before it
 *     writes. `markSchemaRefreshComplete` in `'refresh'` mode opens with a
 *     `getCheckpoint` SELECT, so the deferred `BEGIN` becomes a READ transaction
 *     and the write that follows has to UPGRADE — the case #4332 measured against
 *     real SQLite, where the busy handler is never consulted and the write fails in
 *     about a millisecond against a 5,000ms setting. `beginImmediateWrite` takes
 *     the write lock up front so the wait is real for every one of these
 *     transactions, whichever statement they happen to start with.
 *  2. Even a write-first transaction can genuinely lose a 5s race — the code below
 *     notes that `removeBoardScopeData` holds an exclusive transaction for seconds,
 *     and a snapshot import batch is the other documented long holder. The engine
 *     has had a bounded ladder for exactly this since #4332; every user-facing
 *     write goes through it and the pull did not. Now it does, at background
 *     sizing (see OFFLINE_BACKGROUND_WRITE_* — nobody is waiting on a tap here).
 *
 * SAFE TO RE-RUN, which the ladder requires: expo rolls the whole transaction back
 * on a throw, and every statement in these three tasks is idempotent anyway —
 * `INSERT OR REPLACE` / `ON CONFLICT DO UPDATE` upserts, `DELETE`s, and checkpoint
 * writes that either replace a row or only move a cursor forward. The one throw
 * that must NOT be retried, `DeletionPageAbortedError`, is not a lock error, and
 * the ladder's default `shouldRetry` is `isDatabaseLockedError`, so it rethrows
 * immediately.
 *
 * A recovered lock reports NOTHING: `runLocalWriteWithRetry` is silent unless
 * attempt 1 threw, and no `onSettled` is passed, so the only lock that still
 * reaches telemetry is one the ladder could not win — which surfaces exactly where
 * it did before, as a failed cycle.
 */
export async function runPullWrite(
  db: OfflineDatabase,
  task: (transaction: SqlExecutor) => Promise<void>,
): Promise<void> {
  await runLocalWriteWithRetry(
    () =>
      db.withExclusiveTransactionAsync(async (transaction) => {
        await beginImmediateWrite(transaction, OFFLINE_DB_BUSY_TIMEOUT_MS);
        await task(transaction);
      }),
    {
      maxAttempts: OFFLINE_BACKGROUND_WRITE_MAX_ATTEMPTS,
      retryDelayMs: OFFLINE_BACKGROUND_WRITE_RETRY_DELAY_MS,
      budgetMs: OFFLINE_BACKGROUND_WRITE_BUDGET_MS,
    },
  );
}
