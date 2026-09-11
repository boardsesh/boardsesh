// One process-lifetime reference to the app database, so `SQLiteProvider`'s effect
// teardown can never be the last one out.
//
// WHY (#5300). expo-sqlite runs every `*Async` entry point on a CONCURRENT dispatch
// queue (`moduleQueue`, iOS `SQLiteModule.swift`), so a close and a query are on the
// wire at the same instant whenever the provider tears down while work is in flight.
// `closeDatabase` frees the connection with `exsqlite3_close` and — because
// `finalizeUnusedStatementsBeforeClosing` defaults to true (`SQLiteOptions.swift`) —
// first walks `exsqlite3_next_stmt` and finalizes EVERY statement on it without
// clearing the per-statement `isFinalized` flag JS checks. Whatever was mid-flight is
// then touching memory that is already gone: `sqlite3_column_type` on a freed Vdbe
// (EXC_BAD_ACCESS), a `prepare_v2` against a freed `sqlite3*`, or the `finalizeAsync`
// that expo-sqlite's own `finally` runs next double-freeing an already-finalized
// statement ("pointer being freed was not allocated"). SQLite is built serialized and
// its connection mutex is healthy in every one of those crash reports — a mutex
// cannot protect memory that has already been freed.
//
// WHY THE #5292 FIX IS NOT ENOUGH. #5336 retracts the published handle before the
// close lands, so no reader can PICK UP a connection the provider already closed.
// That is the branch where the check wins. This is the branch where the free wins: a
// reader that took the handle a moment earlier is already inside an `await` chain,
// holds its own reference to the `SQLiteDatabase`, and keeps issuing queries. No
// amount of JS-side handle bookkeeping reaches it, because the object it is holding
// never went through `getDatabaseHandle()` again.
//
// THE LEVER. expo-sqlite's native connection cache is refcounted, identically on both
// platforms (iOS `SQLiteModule.swift`, Android `SQLiteModule.kt`): opening the same
// path with the same options returns the CACHED `NativeDatabase` and `addRef()`s it,
// and `closeAsync` reaches `exsqlite3_close` only when `removeCachedDatabase` sees the
// refcount fall to zero. Holding one extra handle and never closing it pins the count
// at >= 1, so every `SQLiteProvider` teardown still runs and still decrements but can
// no longer free anything under an in-flight query. The connection stays valid
// (`isClosed` is only set inside the branch that actually closes), so the provider's
// next mount gets the same live connection back instead of reopening the file.
//
// WHAT IT COSTS. Nothing that would otherwise have been reclaimed: the app has exactly
// one database and needs it for the whole process, and the SQLite module's own
// `OnDestroy` closes every cached connection when the module goes away. In dev the
// provider's teardown also unregisters the database from the devtools plugin even
// though our handle survives; the next mount re-registers it.
//
// It also costs nothing at the WAL switch, which is the obvious place to worry.
// `configureMainConnection` flips `journal_mode` on the first launch after install,
// and SQLite refuses that flip while ANOTHER connection holds the file. This is a
// refcount bump on the same `NativeDatabase` — the same `sqlite3*` — not a second
// connection, so there is nothing new to contend with.

import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import { reportError } from '../lib/error-reporting';
import { DATABASE_NAME } from './database-name';
import { pinDatabase } from './connection-pin';

/**
 * The single retain, kept as its promise so concurrent callers share one open and a
 * remount after the first launch adds no further references.
 */
let retention: Promise<SQLiteDatabase | null> | null = null;

/**
 * Takes the process-lifetime reference described above, once. Safe to call on every
 * `onInit`, including the ones a remount produces.
 *
 * Never rejects. A failed open leaves the provider's teardown able to free the
 * connection again, which is the crash — so the promise is dropped on failure and the
 * next `onInit` retries rather than caching the failure for the session.
 *
 * The returned connection is deliberately not published anywhere. It exists to hold a
 * reference, not to be queried: readers keep using the connection `SQLiteProvider`
 * hands them, which — once this has landed — is the same native connection.
 */
export function retainDatabaseConnection(): Promise<SQLiteDatabase | null> {
  retention ??= openDatabaseAsync(DATABASE_NAME).then(
    (connection) => {
      // Redundant while the `retention` promise holds it, and kept anyway so that
      // "every wrapper for this file goes through `pinDatabase`" is one enforceable
      // rule rather than four separate arguments. Note that
      // `resetConnectionRetentionForTests` nulling `retention` is exactly the shape
      // of code that would otherwise create a collectable wrapper (#5410).
      pinDatabase(connection);
      return connection;
    },
    (error: unknown) => {
      retention = null;
      reportError(error, { tags: { source: 'offline-sync', kind: 'sqlite-retain' } });
      return null;
    },
  );
  return retention;
}

/**
 * Test-only. Drops the retain so a suite can drive the first-launch path more than
 * once. Deliberately NOT re-exported from ./testing — that barrel is imported by
 * node-env suites, and this module's `expo-sqlite` import reaches react-native's Flow
 * source, which Rolldown cannot parse during collection. Callers mock `expo-sqlite`
 * and import this directly.
 */
export function resetConnectionRetentionForTests(): void {
  retention = null;
}
