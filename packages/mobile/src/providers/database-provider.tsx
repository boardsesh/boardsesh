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
 * It does NOT beat the close. `SQLiteProvider`'s cleanup calls `teardown(db)`
 * synchronously and `await db?.closeAsync()` is its first statement (expo-sqlite
 * `build/hooks.js`), so the close is ENTERED from the parent's cleanup — and React
 * runs the parent's cleanup before this child's. By the time the retraction runs, the
 * connection is already closing. Queries that were already in flight are narrowed by
 * nothing here: what keeps them off freed memory is the process-lifetime reference
 * `initializeAndRetainDatabase` takes below (#5300), not this ordering.
 *
 * What it buys is the window AFTER the unmount commit: every reader that starts from
 * then on gets null and falls back to the network instead of a closed connection that
 * throws `Access to closed resource` (~249 users/30d, #5292). That is the sync
 * scheduler on its interval and the mutation drainer on its listener — neither is
 * inside React, so neither can see the provider go away. `initializeDatabase` covers
 * the remount case as soon as the replacement connection's `onInit` runs; this covers
 * the gap until then, and the plain unmount where no replacement is coming at all.
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
