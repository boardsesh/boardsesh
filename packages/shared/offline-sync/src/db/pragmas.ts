// Connection PRAGMAs for the offline SQLite database.
//
// The engine runs many connections against one `boardsesh.db`: the app's main
// connection (react-query reads, VACUUM, wal_checkpoint) plus a fresh native
// connection per `withExclusiveTransactionAsync` task (`useNewConnection: true`).
// That task connection opens a plain deferred `BEGIN` — expo-sqlite's "exclusive"
// means one JS task owns the connection, NOT SQLite's `BEGIN EXCLUSIVE` — so it
// takes no lock until its first real statement. Applying the timeout as the task's
// first statement SETS it early enough; it does not follow that SQLite will ever
// CONSULT it, which is what `beginImmediateWrite` below exists to fix. Two settings
// keep these from colliding:
//
// - `journal_mode = WAL` PERSISTS in the database file header, so it is set ONCE
//   on the main connection (configureMainConnection) and every later connection —
//   including the ephemeral transaction ones — inherits it. WAL lets readers run
//   against a snapshot instead of blocking on the single writer, which is what
//   killed the read-vs-write "database is locked" throws (Sentry BOARDSESH-A9/AC).
// - `busy_timeout` is PER CONNECTION and defaults to 0 — a contending statement
//   fails instantly instead of waiting for the lock to clear. So it must be applied
//   to EVERY connection, including each transaction task's own connection, or two
//   concurrent `BEGIN EXCLUSIVE` writers still race and the loser throws
//   immediately (BOARDSESH-AB/AX).

import type { SqlExecutor } from '../database';

/**
 * How long a contending statement waits for a held lock before giving up. Five
 * seconds comfortably covers the longest offline write (a snapshot import or a
 * teardown delete on a large layout) without hanging a foreground interaction if
 * something is genuinely wedged.
 *
 * This is the BACKGROUND default — engine writers (pull, teardown, sign-out purge)
 * have nobody waiting on a tap. A user-facing write takes the shorter
 * OFFLINE_DB_FOREGROUND_WRITE_TIMEOUT_MS instead.
 */
export const OFFLINE_DB_BUSY_TIMEOUT_MS = 5000;

/**
 * The `busy_timeout` for the FIRST attempt of a write a user is waiting on — a
 * tick from the log-ascent sheet, a favorite, a follow.
 *
 * Shorter than the background default on purpose. Until #4332 the timeout was
 * never consulted at all on this path (see `beginImmediateWrite`), so the real
 * contention windows were finally measurable only from the retry ladder's own
 * telemetry: `Offline Local Write Attempt Failed` over 30 days is 17 events with
 * `elapsedMs` between 174ms and 342ms for a two-attempt ladder — i.e. every
 * observed holder released inside ~340ms, and 14 of 16 recovered on attempt 2.
 * 2.5s is a 7x margin over the worst window ever seen, while halving how long a
 * genuinely wedged file (a VACUUM mid-rebuild) can freeze the sheet.
 */
export const OFFLINE_DB_FOREGROUND_WRITE_TIMEOUT_MS = 2500;

/**
 * The `busy_timeout` in force *only* while the one-shot WAL switch is attempted.
 *
 * Switching a rollback-journal file to WAL needs a lock no other connection holds,
 * and SQLite's behaviour under contention is asymmetric (measured against real
 * SQLite for #4104):
 *   - a contending WRITER makes the switch fail INSTANTLY — `busy_timeout` is never
 *     consulted, so a longer timeout buys exactly nothing;
 *   - a contending READER makes it wait out the whole `busy_timeout` and THEN fail.
 * Running the switch under the full 5s would therefore add a five-second stall to
 * app launch (`SQLiteProvider` renders nothing until `onInit` resolves) and still
 * fail. A quarter second absorbs a brief blip without a visibly slow launch.
 */
export const OFFLINE_DB_WAL_SWITCH_TIMEOUT_MS = 250;

/**
 * The `busy_timeout` for a RETRY of a local write whose first attempt already
 * waited out its whole window. Shorter on purpose: this attempt asks "did the
 * lock clear in the retry gap?" and gets out of the log-ascent sheet's way if it
 * did not.
 *
 * WHAT THIS IS NOT SIZED FROM ANY MORE (issue #4310). This docblock used to cite
 * "`Offline Board Download Completed.importMs`, p50 806ms / max 3.2s over 60
 * days" as proof that every import fits inside attempt 1. That window never
 * existed: `importMs` was first emitted by #4337/#4345 on 2026-08-12 and this
 * constant was written on 2026-08-14, so at most two days of the series were
 * ever readable. The live fleet reads p50 2,944ms / p90 21,988ms / max 253,939ms
 * — and even that is the wrong quantity, because `importMs` is stamped around
 * ATTACH + `PRAGMA quick_check` over a 271 MB file + two full `COUNT(*)` scans +
 * the scoped watermark reads + the write transaction, and every one of those but
 * the last runs in AUTOCOMMIT holding no lock at all.
 *
 * How long the import actually HELD the write lock has never been measured. The
 * batched importer added for #4310 emits `importLockMaxMs` — the longest single
 * exclusive hold — which is the first number this ladder can honestly be sized
 * against. Until that series has fleet coverage, treat the ladder as sized for a
 * holder of one import batch (SNAPSHOT_IMPORT_BATCH_ROWS rows), not for a whole
 * import.
 */
export const OFFLINE_DB_RETRY_BUSY_TIMEOUT_MS = 1500;

/**
 * The `busy_timeout` for the last-chance fallback write, run after the main
 * write has already lost the lock twice (mobile's outbox-only tick degrade).
 * One second: the user is blocked on it, it is the smallest write on the path,
 * and the whole ladder still has to land inside OFFLINE_LOCAL_WRITE_BUDGET_MS.
 */
export const OFFLINE_DB_FALLBACK_BUSY_TIMEOUT_MS = 1000;

/**
 * Set `busy_timeout` on a connection. Call as the first statement of every
 * `withExclusiveTransactionAsync` task — the task runs on its own native
 * connection, which starts at `busy_timeout = 0`.
 *
 * `timeoutMs` exists for the retry ladder, which shortens the wait on later
 * attempts (see the constants above). Everything else takes the default.
 *
 * Setting the timeout is NOT sufficient on its own for a task that reads before
 * it writes — use `beginImmediateWrite` for those. See its docblock.
 */
export async function applyBusyTimeout(db: SqlExecutor, timeoutMs = OFFLINE_DB_BUSY_TIMEOUT_MS): Promise<void> {
  await db.execAsync(`PRAGMA busy_timeout = ${timeoutMs}`);
}

/**
 * Loosen durability for the life of ONE bulk-import connection: `synchronous =
 * NORMAL` instead of the default FULL.
 *
 * Why the batched snapshot import needs it (issue #4310). Splitting a ~710k-row
 * Kilter import into ~142 short exclusive transactions replaces one fsync with
 * ~142 of them under FULL, which would make the import slower than the single
 * mega-transaction it replaces. NORMAL is what keeps the batching a win rather
 * than a regression, so the two ship together.
 *
 * Why it is safe here, in the order the questions get asked:
 *  - PER CONNECTION, not persisted, and that connection is short-lived. Unlike
 *    `journal_mode`, which lives in the database file header (see the module
 *    header above), `synchronous` is a connection setting — and the only caller
 *    applies it inside `withExclusiveTransactionAsync`, which expo-sqlite runs
 *    on a connection it opens (`useNewConnection: true`) and tears down when the
 *    task returns. So there is no pooled slot to leave loosened: every other
 *    connection, the app's main one included, stays at FULL, and the loosened
 *    one stops existing when the import ends.
 *  - IN WAL, NORMAL CANNOT CORRUPT. It only stops fsyncing the WAL on each
 *    commit, so a power loss or OS crash can lose transactions committed in the
 *    last moments before it. The WAL is replayed to its last VALID frame, so a
 *    later commit can never survive an earlier one being lost — which is exactly
 *    what makes "rows in earlier transactions, checkpoints stamped in the last
 *    one" safe: losing the tail can never leave a checkpoint without its rows.
 *  - LOSING THE TAIL COSTS NOTHING. The artifact is retained on disk with its
 *    `.complete` sidecar and every statement is `INSERT OR REPLACE`, so a
 *    re-import is idempotent and re-does only what was lost.
 *
 * Must run in AUTOCOMMIT: SQLite rejects the pragma inside a transaction with
 * "Safety level may not be changed inside a transaction" rather than silently
 * ignoring it, so a misplaced call fails loudly instead of quietly leaving FULL.
 */
export async function applyBulkImportPragmas(db: SqlExecutor): Promise<void> {
  await db.execAsync('PRAGMA synchronous = NORMAL');
}

/**
 * Open a `withExclusiveTransactionAsync` task as a WRITE transaction, with
 * `busy_timeout` armed. Call it as the task's first statement instead of
 * `applyBusyTimeout` whenever the task writes — always, if the task reads first.
 *
 * `timeoutMs` is REQUIRED rather than defaulted: this helper serves both a
 * foreground write somebody is watching (OFFLINE_DB_FOREGROUND_WRITE_TIMEOUT_MS)
 * and a background one nobody is (OFFLINE_DB_BUSY_TIMEOUT_MS), and there is no
 * default that is right for both. Whichever it defaulted to, half the future call
 * sites would silently get the wrong wait.
 *
 * Why this exists (#4332). expo's wrapper opens a plain deferred `BEGIN`, and a
 * deferred transaction picks its lock from whatever statement runs first. When
 * that is a SELECT — every tick and favorite write starts with a `sync_meta` read
 * for the owner stamp — SQLite opens a READ transaction, and the later INSERT has
 * to upgrade it. SQLite does not run the busy handler on that upgrade (btree.c's
 * retry loop is gated on there being no transaction yet), and under WAL a snapshot
 * conflict (SQLITE_BUSY_SNAPSHOT, 517, which prints as plain code 5) is not
 * retryable at any timeout. So `busy_timeout` was set and then never consulted:
 * measured against real SQLite with a second connection holding the write lock,
 * `BEGIN; PRAGMA busy_timeout=5000; SELECT; INSERT` threw in 1ms, while the
 * sequence below waited the full 5,049ms and then succeeded once the holder let go.
 *
 * The shape mirrors what the snapshot importer already does: close the wrapper's
 * empty deferred transaction, then re-open it IMMEDIATE so the write lock is taken
 * (and the busy handler engaged) up front, on a fresh snapshot.
 *
 * The catch is MANDATORY, not defensive dressing. expo runs an unconditional
 * `ROLLBACK` on its error path, and a `ROLLBACK` with no open transaction throws —
 * that error would REPLACE the lock error, breaking `isDatabaseLockedError`
 * classification, defeating the retry ladder, and forking the Sentry aggregate the
 * retry helper goes out of its way to keep intact. Restoring a deferred `BEGIN`
 * first gives the wrapper something to roll back so the original error survives.
 */
export async function beginImmediateWrite(db: SqlExecutor, timeoutMs: number): Promise<void> {
  // Connection-local, takes no lock, cannot fail — safe inside the empty transaction.
  await applyBusyTimeout(db, timeoutMs);

  try {
    // The wrapper's `BEGIN` has taken no locks yet, so this commits nothing.
    await db.execAsync('COMMIT');
    await db.execAsync('BEGIN IMMEDIATE');
  } catch (error) {
    // Leave a transaction open for expo's unconditional ROLLBACK, whichever of the
    // two statements failed. If COMMIT was the one that threw we are still inside
    // the wrapper's transaction and this BEGIN fails harmlessly.
    await db.execAsync('BEGIN').catch(() => {});
    throw error;
  }
}

/**
 * Configure the app's main connection: switch the database file to WAL journaling
 * (persists, so every later connection inherits it) and set this connection's
 * `busy_timeout`. Must run in autocommit — `journal_mode` cannot change inside a
 * transaction — so call it before any table creation or migration.
 *
 * Never throws. The WAL switch is an OPTIMISATION, not a prerequisite: a database
 * still in rollback-journal mode works correctly, it just serialises readers against
 * the writer. Letting a contended switch abort startup is what took the whole of
 * `initializeDatabase` down with it and left offline storage disabled for the entire
 * session (#4104), so a refused switch is logged in dev and stepped over.
 *
 * Note the switch is genuinely one-shot in practice: on a file ALREADY in WAL the
 * pragma is a free no-op that takes no lock and cannot fail, even with another
 * connection mid-write. Only the first launch after install/upgrade can contend.
 */
export async function configureMainConnection(db: SqlExecutor): Promise<void> {
  // busy_timeout FIRST — every statement below wants it, and the pragma itself is a
  // connection-local setting that takes no lock and cannot fail. The short window is
  // deliberate: see OFFLINE_DB_WAL_SWITCH_TIMEOUT_MS for why a longer one is worse.
  await db.execAsync(`PRAGMA busy_timeout = ${OFFLINE_DB_WAL_SWITCH_TIMEOUT_MS}`);

  try {
    const result = await db.getFirstAsync<{ journal_mode: string }>('PRAGMA journal_mode = WAL');
    // NODE_ENV is the platform-free stand-in for RN's __DEV__ — this package carries
    // no react-native globals, and Metro inlines it the same way.
    if (process.env.NODE_ENV !== 'production' && result?.journal_mode?.toLowerCase() !== 'wal') {
      console.warn(
        `[SQLite] journal_mode is "${result?.journal_mode}", expected "wal" — reads may contend with writes`,
      );
    }
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(
        '[SQLite] could not switch to WAL (another connection holds the file); continuing without it:',
        error,
      );
    }
  }

  await applyBusyTimeout(db);
}
