// Connection PRAGMAs for the offline SQLite database.
//
// The engine runs many connections against one `boardsesh.db`: the app's main
// connection (react-query reads, VACUUM, wal_checkpoint) plus a fresh native
// connection per `withExclusiveTransactionAsync` task (`useNewConnection: true`).
// That task connection opens a plain deferred `BEGIN` — expo-sqlite's "exclusive"
// means one JS task owns the connection, NOT SQLite's `BEGIN EXCLUSIVE` — so it
// takes no lock until its first real statement, which is why applying the timeout
// as the task's first statement is early enough. Two settings keep these from
// colliding:
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
 */
export const OFFLINE_DB_BUSY_TIMEOUT_MS = 5000;

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
 * Set `busy_timeout` on a connection. Call as the first statement of every
 * `withExclusiveTransactionAsync` task — the task runs on its own native
 * connection, which starts at `busy_timeout = 0`.
 */
export async function applyBusyTimeout(db: SqlExecutor): Promise<void> {
  await db.execAsync(`PRAGMA busy_timeout = ${OFFLINE_DB_BUSY_TIMEOUT_MS}`);
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
