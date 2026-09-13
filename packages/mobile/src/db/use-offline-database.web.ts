import { useSQLiteContext, type SQLiteDatabase } from 'expo-sqlite';

/**
 * Expo-web fork: there is no recovery to follow, so the provider's connection is
 * always the right one.
 *
 * The browser app has no offline SQLite — `expo-sqlite` is aliased to
 * `src/web-shims/sqlite.tsx` and nothing ever publishes a handle — so subscribing
 * to the native handle store would return null forever and the fallback would be
 * the only branch taken. Same reasoning as ./use-offline-schema-ready.web.ts.
 */
export function useOfflineDatabase(): SQLiteDatabase {
  return useSQLiteContext();
}
