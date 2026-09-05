import { useCallback, useEffect, type ReactNode } from 'react';
import { SQLiteProvider, type SQLiteDatabase } from 'expo-sqlite';
import { LOCAL_ACCESS_MODE } from '@boardsesh/party-profile';
import { DATABASE_NAME, LOCAL_PROFILE_DATABASE_NAME, initializeDatabase, setDatabaseHandle } from '../db';
import { useAuth } from './auth-provider';

function handleDatabaseError(error: Error): void {
  if (__DEV__) {
    console.warn('[SQLite] database initialization failed; running without local storage:', error);
  }
}

export function DatabaseProvider({ children }: { children: ReactNode }) {
  const { accessMode } = useAuth();
  const databaseName = accessMode === LOCAL_ACCESS_MODE ? LOCAL_PROFILE_DATABASE_NAME : DATABASE_NAME;
  const initializeSelectedDatabase = useCallback(
    (database: SQLiteDatabase) => initializeDatabase(database, databaseName),
    [databaseName],
  );

  useEffect(
    () => () => {
      // SQLiteProvider closes the old handle when the access mode changes. Do
      // not leave non-React readers pointing at that closed account/local file
      // while the replacement runs migrations.
      setDatabaseHandle(null);
    },
    [databaseName],
  );

  return (
    <SQLiteProvider
      key={databaseName}
      databaseName={databaseName}
      onInit={initializeSelectedDatabase}
      onError={handleDatabaseError}
    >
      {children}
    </SQLiteProvider>
  );
}
