// The write primitives every background writer in the sync engine shares: the
// bound-parameter ceiling, the multi-row INSERT builder sized against it, and the
// retried IMMEDIATE transaction a write nobody is waiting on runs in.
//
// Extracted from pull-client.ts so the holds index builder (holds-index/) can
// write through exactly the same lock discipline as a pull page without an
// import cycle back through the pull client.

import type { OfflineDatabase, SqlExecutor } from '../database';
import {
  beginImmediateWrite,
  OFFLINE_DB_BUSY_TIMEOUT_MS,
  OFFLINE_DB_FOREGROUND_WRITE_TIMEOUT_MS,
  OFFLINE_DB_RETRY_BUSY_TIMEOUT_MS,
} from '../db/pragmas';
import { isDatabaseLockedError } from '../db/lock-errors';
import {
  runLocalWriteWithRetry,
  OFFLINE_BACKGROUND_WRITE_BUDGET_MS,
  OFFLINE_BACKGROUND_WRITE_MAX_ATTEMPTS,
  OFFLINE_BACKGROUND_WRITE_RETRY_DELAY_MS,
  OFFLINE_LOCAL_WRITE_BUDGET_MS,
  type LocalWriteRetryOptions,
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
 * TELEMETRY (issue #5851). Every call names its `site`. A write whose FIRST
 * attempt lost the lock reports once through the injected settle reporter
 * (`setPullWriteSettledReporter`), whatever its later attempts did — committed,
 * refused by its guard (`refusedWhen`), aborted by its own sentinel, or out of
 * attempts — so "how often does an engine write meet a held lock, for how long,
 * and to what" is a number rather than an inference. A write the ladder could not
 * win still surfaces where it did before, as a failed cycle, and now carries its
 * site on the error (`getSqliteWriteSite`), so the report names the statement
 * that lost.
 *
 * NEVER CALL THIS FROM INSIDE A TRANSACTION. It opens its own connection; from
 * inside another write transaction that connection waits on the caller's own
 * lock for the whole ladder and then fails. Pass the transaction executor to the
 * helper instead.
 */
export async function runPullWrite<T = void>(
  db: OfflineDatabase,
  task: (transaction: SqlExecutor) => Promise<T>,
  options: PullWriteOptions & {
    /** True for a result that means "the task's guard refused, nothing was written". */
    refusedWhen?: (result: T) => boolean;
  },
): Promise<T> {
  const sizing = options.sizing ?? 'background';
  const ladder = PULL_WRITE_LADDERS[sizing];
  let result: T | undefined;
  // Decided by attempt 1, not by the last error: a write that lost attempt 1 to a
  // teardown and then hit its own guard or abort sentinel is exactly the case the
  // report exists for, and its last error is that sentinel, not a lock.
  let firstAttemptLostLock = false;
  try {
    await runLocalWriteWithRetry(
      async (attempt) => {
        try {
          await db.withExclusiveTransactionAsync(async (transaction) => {
            await beginImmediateWrite(transaction, ladder.busyTimeoutMs(attempt));
            result = await task(transaction);
          });
        } catch (error) {
          if (attempt === 1) firstAttemptLostLock = isDatabaseLockedError(error);
          throw error;
        }
      },
      {
        maxAttempts: ladder.maxAttempts,
        retryDelayMs: ladder.retryDelayMs,
        budgetMs: ladder.budgetMs,
        onSettled: ({ attempts, error, recovered, elapsedMs }) => {
          // A non-lock throw on attempt 1 is a task's own control flow (an abort
          // sentinel, a guard), not contention, and is not worth an event.
          if (!firstAttemptLostLock) return;
          const outcome: PullWriteOutcome = recovered
            ? options.refusedWhen?.(result as T)
              ? 'refused'
              : 'committed'
            : isDatabaseLockedError(error)
              ? 'exhausted'
              : 'aborted';
          pullWriteSettledReporter?.({ site: options.site, sizing, attempts, outcome, elapsedMs });
        },
      },
    );
  } catch (error) {
    if (isDatabaseLockedError(error)) tagSqliteWriteSite(error, options.site);
    throw error;
  }
  return result as T;
}

/**
 * `runPullWrite` for a write that must not land once a teardown has: `canWrite`
 * runs INSIDE the writer lock, after `BEGIN IMMEDIATE`, on every attempt. That is
 * the placement the page writes and the holds index already use, and the one a
 * marker write needs most. A teardown holds the lock for seconds, so a write
 * that waited behind it (or lost attempt 1 to it and retried) would otherwise put
 * back the marker the teardown just deleted — a `scope-complete:` outliving its
 * rows, or `user_data_complete` vouching for a wiped logbook.
 *
 * Any read the write depends on belongs in `task` too, so it reads under the same
 * lock it writes under. A read on the main connection can be a snapshot older
 * than the last commit, and a value derived from it would be a lost update.
 *
 * Resolves `true` when the task ran and committed, `false` when `canWrite`
 * refused it (nothing was written). The caller maps `false` onto its own
 * teardown exit.
 */
export async function runGuardedPullWrite(
  db: OfflineDatabase,
  options: PullWriteOptions & { canWrite: () => boolean },
  task: (transaction: SqlExecutor) => Promise<void>,
): Promise<boolean> {
  return runPullWrite(
    db,
    async (transaction) => {
      if (!options.canWrite()) return false;
      await task(transaction);
      return true;
    },
    { site: options.site, sizing: options.sizing, refusedWhen: (wrote) => !wrote },
  );
}

/**
 * `background` — the pull and every engine write nobody waits on: three attempts,
 * the full 5 s wait each, inside a 20 s budget (OFFLINE_BACKGROUND_WRITE_*).
 * `foreground` — a write the climber just tapped for (the Download confirm): the
 * log-ascent sheet's two-attempt ladder, 2.5 s then 1.5 s, so a held lock cannot
 * hold the screen for the background ladder's 15 s.
 */
export type PullWriteSizing = 'background' | 'foreground';

export type PullWriteOptions = {
  /**
   * Low-cardinality label for telemetry: what the write is, never which scope.
   * `deletions-coverage`, `scope-complete`, `bootstrap-retry-state`, ….
   */
  site: string;
  /** Default `background`. */
  sizing?: PullWriteSizing;
};

type PullWriteLadder = Required<Pick<LocalWriteRetryOptions, 'maxAttempts' | 'retryDelayMs' | 'budgetMs'>> & {
  busyTimeoutMs: (attempt: number) => number;
};

const PULL_WRITE_LADDERS: Record<PullWriteSizing, PullWriteLadder> = {
  background: {
    maxAttempts: OFFLINE_BACKGROUND_WRITE_MAX_ATTEMPTS,
    retryDelayMs: OFFLINE_BACKGROUND_WRITE_RETRY_DELAY_MS,
    budgetMs: OFFLINE_BACKGROUND_WRITE_BUDGET_MS,
    busyTimeoutMs: () => OFFLINE_DB_BUSY_TIMEOUT_MS,
  },
  foreground: {
    maxAttempts: 2,
    retryDelayMs: 150,
    budgetMs: OFFLINE_LOCAL_WRITE_BUDGET_MS,
    busyTimeoutMs: (attempt) =>
      attempt === 1 ? OFFLINE_DB_FOREGROUND_WRITE_TIMEOUT_MS : OFFLINE_DB_RETRY_BUSY_TIMEOUT_MS,
  },
};

/**
 * What a write whose first attempt lost the lock ended as.
 * - `committed`: a later attempt wrote and committed.
 * - `refused`: a later attempt took the lock and its guard refused (a teardown
 *   landed while it waited); nothing was written, by design.
 * - `aborted`: a later attempt's own abort sentinel threw (a page, holds-index
 *   chunk or mirror that found its scope torn down).
 * - `exhausted`: every attempt lost the lock; the caller sees the lock error.
 */
export type PullWriteOutcome = 'committed' | 'refused' | 'aborted' | 'exhausted';

/** One engine write whose first attempt lost the SQLite write lock. */
export type PullWriteSettledReport = {
  site: string;
  sizing: PullWriteSizing;
  /** Attempts run, 1-based. */
  attempts: number;
  outcome: PullWriteOutcome;
  /** First attempt to settle, wall clock. */
  elapsedMs: number;
};

let pullWriteSettledReporter: ((report: PullWriteSettledReport) => void) | null = null;

/**
 * Register the platform's sink for `PullWriteSettledReport`s. One sink per
 * process; returns the unregister. The engine stays analytics-free — mobile maps
 * the report onto its own event.
 */
export function setPullWriteSettledReporter(reporter: (report: PullWriteSettledReport) => void): () => void {
  pullWriteSettledReporter = reporter;
  return () => {
    if (pullWriteSettledReporter === reporter) pullWriteSettledReporter = null;
  };
}

const SQLITE_WRITE_SITE = 'sqliteWriteSite';

function tagSqliteWriteSite(error: unknown, site: string): void {
  if (typeof error !== 'object' || error === null) return;
  try {
    if (!Object.isExtensible(error) || SQLITE_WRITE_SITE in error) return;
    // Non-enumerable: the error keeps its identity and its serialised shape, and
    // reporters read the site through `getSqliteWriteSite`.
    Object.defineProperty(error, SQLITE_WRITE_SITE, { value: site, enumerable: false, configurable: true });
  } catch {
    // A diagnostic label must never replace the error it describes.
  }
}

/** The `site` of the background write a lock error escaped from, if any. */
export function getSqliteWriteSite(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const site = (error as { [SQLITE_WRITE_SITE]?: unknown })[SQLITE_WRITE_SITE];
  return typeof site === 'string' ? site : null;
}
