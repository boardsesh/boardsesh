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
 * The provider's `onInit`: take the process-lifetime reference on the connection
 * first, then run the usual setup sequence.
 *
 * Ordering matters. `SQLiteProvider` opens the connection, awaits `onInit`, and only
 * then stores it in the ref its teardown closes — so `onInit` is the earliest point at
 * which the connection exists in expo-sqlite's native cache, and it is strictly before
 * any teardown that could free it. Taking the reference here means the provider's
 * close is never the last one out (#5300): it decrements, the connection survives, and
 * whatever query was mid-flight on another module-queue thread keeps reading live
 * memory instead of a freed `sqlite3*`.
 *
 * Started, never awaited: the provider renders nothing until `onInit` resolves, so
 * launch must not wait on a second open, and nothing in the setup sequence depends on
 * it. `retainDatabaseConnection` never rejects.
 *
 * Declared at module scope rather than as a `useCallback`, because `onInit` sits in
 * `SQLiteProviderNonSuspense`'s effect deps AND in its `memo` comparator — a fresh
 * identity per render would close and reopen the database on every parent re-render,
 * which is the exact churn this file exists to survive.
 */
function initializeAndRetainDatabase(db: SQLiteDatabase): Promise<void> {
  void retainDatabaseConnection();
  return initializeDatabase(db);
}

export function DatabaseProvider({ children }: { children: ReactNode }) {
  return (
    <SQLiteProvider databaseName={DATABASE_NAME} onInit={initializeAndRetainDatabase} onError={handleDatabaseError}>
      <DatabaseHandleLifecycle />
      {children}
    </SQLiteProvider>
  );
}
