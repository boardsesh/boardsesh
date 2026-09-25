import { useSyncExternalStore } from 'react';
import { useSQLiteContext, type SQLiteDatabase } from 'expo-sqlite';
import { getDatabaseHandle, subscribeDatabaseHandle } from './connection';

/**
 * The database a `useSQLiteContext()` consumer should actually use.
 *
 * WHY NOT JUST `useSQLiteContext()` (#5410). When a dead-handle recovery opens a
 * replacement connection, the provider's context value does not change — the
 * provider never tore down, and its connection is a wrapper around the native
 * instance that just died. A consumer holding the context value would keep writing
 * through the dead one, so a successful recovery would fix the readers that go
 * through `getDatabaseHandle()` and leave the sync scheduler and the mutation
 * drainer broken.
 *
 * So: prefer the published handle, fall back to the provider's. The fallback is
 * what covers the ordinary case — the published handle is deliberately null until
 * migrations have run, and a read-only consumer still wants a connection then (see
 * the contract in ./schema-ready). Consumers that WRITE must still gate on
 * `useOfflineSchemaReady()`; this hook decides WHICH connection, not WHETHER.
 */
export function useOfflineDatabase(): SQLiteDatabase {
  const provided = useSQLiteContext();
  const published = useSyncExternalStore(subscribeDatabaseHandle, getDatabaseHandle, () => null);
  return published ?? provided;
}
