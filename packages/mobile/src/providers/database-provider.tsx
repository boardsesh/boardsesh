import { useEffect, type ReactNode } from 'react';
import { SQLiteProvider, useSQLiteContext, type SQLiteDatabase } from 'expo-sqlite';
import { DATABASE_NAME, initializeDatabase, releaseDatabaseHandle } from '../db';
import { retainDatabaseConnection } from '../db/connection-retention';

function handleDatabaseError(error: Error): void {
  if (__DEV__) {
    console.warn('[SQLite] database initialization failed; running without local storage:', error);
  }
}

/**
 * Renders nothing; exists to hang the handle retraction off `SQLiteProvider`'s own
 * lifecycle.
 *
 * The provider's effect teardown closes the connection (expo-sqlite
 * `build/hooks.js`), and it does so asynchronously — `await db.closeAsync()`, started
 * from the cleanup. Every cleanup in the torn-down subtree runs in that same
 * synchronous commit, so retracting from here lands before the close itself does,
 * whichever order React visits them in. Without it the window between the close and
 * the replacement connection's migrations belongs to whoever reads
 * `getDatabaseHandle()` — the sync scheduler and mutation drainer, neither of which is
 * inside React and neither of which can see the provider remount (#5292).
 *
 * Mounted as a sibling of `children` rather than wrapping them: it must not add a
 * component boundary to the tree every screen renders under.
 */
function DatabaseHandleLifecycle() {
  const database = useSQLiteContext();
  useEffect(() => () => releaseDatabaseHandle(database), [database]);
  return null;
}

/**
 * The provider's `onInit`: run the usual setup sequence and, alongside it, take the
 * process-lifetime reference on the connection.
 *
 * Ordering matters. `SQLiteProvider` opens the connection, awaits `onInit`, and only
 * then stores it in the ref its teardown closes — so `onInit` is the earliest point at
 * which the connection exists in expo-sqlite's native cache, and it is strictly before
 * any teardown that could free it. Taking the reference here means the provider's
 * close is never the last one out (#5300): it decrements, the connection survives, and
 * whatever query was mid-flight on another module-queue thread keeps reading live
 * memory instead of a freed `sqlite3*`.
 *
 * Both are STARTED synchronously and awaited together, which is load-bearing at both
 * ends:
 *
 * - `initializeDatabase` first and un-awaited, so its synchronous retraction of a
 *   stale handle still lands the instant `onInit` runs for a new connection (#5336).
 *   Putting an await in front of it would push that retraction a microtask later.
 * - `onInit` does not resolve until the reference exists. `openDatabaseAsync` awaits
 *   `ensureDatabasePathExistsAsync` before it reaches the constructor that bumps the
 *   refcount, so a fire-and-forget retain leaves a window where the provider has
 *   already published — and can therefore already tear down and close the only
 *   reference — while the retain is still in flight. Resolving late costs nothing
 *   next to the migrations running alongside it, and on every later mount the retain
 *   is an already-settled promise.
 *
 * Neither promise rejects (`initializeDatabase` swallows setup failures so the app is
 * never stuck rendering null; `retainDatabaseConnection` reports and resolves null),
 * so neither does this.
 *
 * Declared at module scope rather than as a `useCallback`, because `onInit` sits in
 * `SQLiteProviderNonSuspense`'s effect deps AND in its `memo` comparator — a fresh
 * identity per render would close and reopen the database on every parent re-render,
 * which is the exact churn this file exists to survive.
 */
function initializeAndRetainDatabase(db: SQLiteDatabase): Promise<void> {
  const initialization = initializeDatabase(db);
  return Promise.all([initialization, retainDatabaseConnection()]).then(() => undefined);
}

export function DatabaseProvider({ children }: { children: ReactNode }) {
  return (
    <SQLiteProvider databaseName={DATABASE_NAME} onInit={initializeAndRetainDatabase} onError={handleDatabaseError}>
      <DatabaseHandleLifecycle />
      {children}
    </SQLiteProvider>
  );
}
