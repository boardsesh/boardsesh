// Connection PRAGMAs for the offline SQLite database.
//
// The engine runs many connections against one `boardsesh.db`: the app's main
// connection (react-query reads, VACUUM, wal_checkpoint) plus a fresh native
// connection per `withExclusiveTransactionAsync` task (`useNewConnection: true`),
// which opens `BEGIN EXCLUSIVE`. Two settings keep those from colliding:
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
 * WAL should always succeed on the local app-sandbox filesystem; a device that
 * refuses it (returns something other than `wal`) still works, just without the
 * reader/writer concurrency win, so this reads the result back and warns in dev
 * rather than throwing.
 */
export async function configureMainConnection(db: SqlExecutor): Promise<void> {
  const result = await db.getFirstAsync<{ journal_mode: string }>('PRAGMA journal_mode = WAL');
  // NODE_ENV is the platform-free stand-in for RN's __DEV__ — this package carries
  // no react-native globals, and Metro inlines it the same way.
  if (process.env.NODE_ENV !== 'production' && result?.journal_mode?.toLowerCase() !== 'wal') {
    console.warn(`[SQLite] journal_mode is "${result?.journal_mode}", expected "wal" — reads may contend with writes`);
  }
  await applyBusyTimeout(db);
}
