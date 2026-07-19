import type { ReactNode } from 'react';
import type { SQLiteDatabase } from 'expo-sqlite';

const unavailableDatabase = {
  getFirstAsync: () => Promise.resolve(null),
  getAllAsync: () => Promise.resolve([]),
  runAsync: () => Promise.resolve({ lastInsertRowId: 0, changes: 0 }),
  execAsync: () => Promise.resolve(),
  withExclusiveTransactionAsync: (task: (database: SQLiteDatabase) => Promise<void>) =>
    task(unavailableDatabase as unknown as SQLiteDatabase),
  withTransactionAsync: (task: () => Promise<void>) => task(),
} as unknown as SQLiteDatabase;

// Offline SQLite is deferred for Expo web. Callers see an empty database so
// management screens remain safe while the offline feature flag is forced off.
export function useSQLiteContext(): SQLiteDatabase {
  return unavailableDatabase;
}

export function SQLiteProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
