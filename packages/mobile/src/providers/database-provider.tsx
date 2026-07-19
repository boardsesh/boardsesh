import type { ReactNode } from 'react';
import { SQLiteProvider } from 'expo-sqlite';
import { DATABASE_NAME, initializeDatabase } from '../db';

function handleDatabaseError(error: Error): void {
  if (__DEV__) {
    console.warn('[SQLite] database initialization failed; running without local storage:', error);
  }
}

export function DatabaseProvider({ children }: { children: ReactNode }) {
  return (
    <SQLiteProvider databaseName={DATABASE_NAME} onInit={initializeDatabase} onError={handleDatabaseError}>
      {children}
    </SQLiteProvider>
  );
}
