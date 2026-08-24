// Retry ladder for a local SQLite write that lost the single-writer lock.
//
// Every offline write in the engine is one `withExclusiveTransactionAsync` task
// on its own connection. The transaction is atomic, so a `SQLITE_BUSY` anywhere
// inside it rolls back BOTH the data row and the outbox row it would have
// queued — the whole write vanishes. Today the caller sees the throw and, for a
// tick, drops the send. One extra attempt turns most of those into ordinary
// saves.
//
// SIZING, from measurement rather than assertion:
//   - Attempt 1 of a user-facing write takes 2.5s
//     (OFFLINE_DB_FOREGROUND_WRITE_TIMEOUT_MS). NOTE what a first-attempt failure
//     did and did not mean: until #4332 the busy handler was never reached on this
//     path at all, because the task opened a deferred transaction with a SELECT.
//     Every one of the 17 `Offline Local Write Attempt Failed` events over 30 days
//     ran the WHOLE two-attempt ladder — a 150ms sleep included — in 174-342ms,
//     which an honoured 5s timeout makes arithmetically impossible. With
//     `beginImmediateWrite` the wait is real for the first time, and 2.5s carries
//     a 7x margin over the longest window ever observed.
//   - Attempt 2 gets a shortened 1.5s timeout after a 150ms gap: a "did the lock
//     clear in the gap" probe rather than a second full wait.
//     CORRECTION (issue #4310). This bullet used to justify that with "measured
//     `Offline Board Download Completed.importMs` over 60 days is p50 806ms, p90
//     2.3s, max 3.2s — every observed import fits inside attempt 1's window".
//     Both halves are wrong. The window never existed: `importMs` was first
//     emitted on 2026-08-12 (#4337/#4345) and this file was written on
//     2026-08-14. And `importMs` is not a lock hold — it is stamped around
//     ATTACH + `PRAGMA quick_check` over a 271 MB artifact + two full `COUNT(*)`
//     scans + the scoped watermark reads + the write transaction, and only the
//     last of those holds anything. The live series reads p50 2,944ms / p90
//     21,988ms / max 253,939ms, but that is still the whole import, not the hold.
//     How long the import really held the lock has never been measured; the
//     batched importer emits `importLockMaxMs` for exactly that, and it is the
//     first number this ladder can honestly be sized against. What DID change
//     underneath it: before #4310 the import was one exclusive transaction that
//     no ladder could outlast; after it the longest holder is one batch.
//   - A caller may then run a smaller fallback write (mobile's outbox-only tick
//     degrade) on the remaining budget.
// Worst case 2500 + 150 + 1500 + 1000 + 150 + 1000 = 6.3s, under the hard
// OFFLINE_LOCAL_WRITE_BUDGET_MS wall-clock cap, so no composition of per-attempt
// timeouts can overrun it.
//
// The case this deliberately does NOT try to outlast: VACUUM holds an exclusive
// lock for the whole rebuild, order 5-20s on a 200-400MB database (see
// db/vacuum.ts), and it is reachable from the UI (remove a downloaded board).
// Waiting that out would freeze the log-ascent sheet for twenty seconds. That
// case exits as a localized error instead, and `onSettled`'s `elapsedMs` is what
// measures how long these locks really are — it is the number that refuted the
// "holders are minutes long" theory in #4332.

import { isDatabaseLockedError } from './lock-errors';

/**
 * Hard wall-clock cap on everything a single user-visible local write may spend
 * fighting for the lock, retries and any caller-run fallback included. Checked
 * against the clock before each retry, so the budget is a real ceiling rather
 * than the sum of some timeouts.
 */
export const OFFLINE_LOCAL_WRITE_BUDGET_MS = 9000;

/** What the ladder did, reported once per write whose first attempt threw. */
export type LocalWriteRetryOutcome = {
  /** How many attempts ran, 1-based. `1` means the error was not retryable. */
  attempts: number;
  /** The LAST error seen. On a recovered write this is attempt 1's error. */
  error: unknown;
  /** True when a later attempt succeeded and the caller lost nothing. */
  recovered: boolean;
  /** Wall-clock time from the first attempt to the settle, per the injected clock. */
  elapsedMs: number;
};

export type LocalWriteRetryOptions = {
  /** Total attempts including the first. Default 2. */
  maxAttempts?: number;
  /** Pause between attempts, giving the holder a chance to commit. Default 150ms. */
  retryDelayMs?: number;
  /** Wall-clock ceiling for the whole ladder. Default OFFLINE_LOCAL_WRITE_BUDGET_MS. */
  budgetMs?: number;
  /** Which errors are worth another attempt. Default: SQLite lock contention. */
  shouldRetry?: (error: unknown) => boolean;
  /** Clock seam, so tests need no fake timers. Default Date.now. */
  now?: () => number;
  /** Sleep seam, same reason. Default a real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Telemetry hook. Fires at most once, only when attempt 1 threw. */
  onSettled?: (outcome: LocalWriteRetryOutcome) => void;
};

const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 150;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a local SQLite write, retrying it while the failure looks like lock
 * contention and the budget still allows another try.
 *
 * Contract, relied on by callers:
 *  - Attempt 1 succeeding is silent: `onSettled` is NOT called. Its raw count is
 *    therefore the contention rate, not the write rate.
 *  - `write` receives the 1-based attempt number so the caller can shorten that
 *    attempt's `busy_timeout`.
 *  - A terminal failure rethrows the ORIGINAL error object BY IDENTITY, never a
 *    wrapper. Load-bearing: mobile hands that same object to Sentry under
 *    `kind: 'tick-local-write'`, and a wrapper would both fork that aggregate and
 *    add a `.cause` level for `isDatabaseLockedError`'s bounded walk to spend.
 *  - The budget gates RETRIES only. Attempt 1 always runs, even with
 *    `budgetMs: 0` — performing the write is the whole point.
 *  - `onSettled` runs inside try/catch: a throwing telemetry callback must never
 *    change the write's outcome (same discipline as the drainer's
 *    `onMutationStatusError`).
 *
 * The write MUST be safe to re-run. A `SQLITE_BUSY` can surface at COMMIT, so a
 * retried attempt may follow one that actually landed — every statement inside
 * must be idempotent (`INSERT OR IGNORE`, `DELETE`, an upsert).
 */
export async function runLocalWriteWithRetry<T>(
  write: (attempt: number) => Promise<T>,
  options: LocalWriteRetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    budgetMs = OFFLINE_LOCAL_WRITE_BUDGET_MS,
    shouldRetry = isDatabaseLockedError,
    now = Date.now,
    sleep = defaultSleep,
    onSettled,
  } = options;

  const startedAt = now();
  let attempt = 0;
  let lastError: unknown = null;

  const settle = (recovered: boolean) => {
    // Only when the ladder actually ran — a clean first attempt reports nothing.
    if (attempt <= 1 && recovered) return;
    if (!onSettled) return;
    try {
      onSettled({ attempts: attempt, error: lastError, recovered, elapsedMs: now() - startedAt });
    } catch {
      // A broken telemetry sink must not turn a saved write into a lost one.
    }
  };

  for (;;) {
    attempt += 1;
    try {
      const result = await write(attempt);
      settle(true);
      return result;
    } catch (error) {
      lastError = error;
      const hasAttemptsLeft = attempt < maxAttempts;
      const fitsInBudget = now() - startedAt + retryDelayMs < budgetMs;
      if (!hasAttemptsLeft || !fitsInBudget || !shouldRetry(error)) {
        settle(false);
        throw error;
      }
      await sleep(retryDelayMs);
    }
  }
}
