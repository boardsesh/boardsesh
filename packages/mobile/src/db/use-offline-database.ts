import { useSyncExternalStore } from 'react';
import { useSQLiteContext, type SQLiteDatabase } from 'expo-sqlite';
import { getDatabaseHandle, subscribeDatabaseHandle } from './connection';
import { refuseDatabase } from './refused-database';
import { getSchemaDowngrade, subscribeSchemaDowngrade } from './schema-downgrade';

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
 *
 * The one case where the answer is "neither": the file was migrated by a newer
 * bundle than this one (./schema-downgrade). The provider's connection is live
 * and its tables exist, so the fallback above would let this bundle read and
 * write a schema it does not know. It gets a connection that refuses every call
 * instead — see ./refused-database.
 */
export function useOfflineDatabase(): SQLiteDatabase {
  const provided = useSQLiteContext();
  const published = useSyncExternalStore(subscribeDatabaseHandle, getDatabaseHandle, () => null);
  const downgrade = useSyncExternalStore(subscribeSchemaDowngrade, getSchemaDowngrade, () => null);
  if (downgrade !== null) return refuseDatabase(provided, downgrade);
  return published ?? provided;
}
