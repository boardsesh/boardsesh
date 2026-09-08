import { useEffect, type ReactNode } from 'react';
import { SQLiteProvider, useSQLiteContext } from 'expo-sqlite';
import { DATABASE_NAME, initializeDatabase, releaseDatabaseHandle } from '../db';

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

export function DatabaseProvider({ children }: { children: ReactNode }) {
  return (
    <SQLiteProvider databaseName={DATABASE_NAME} onInit={initializeDatabase} onError={handleDatabaseError}>
      <DatabaseHandleLifecycle />
      {children}
    </SQLiteProvider>
  );
}
