import { useSyncExternalStore } from 'react';
import { getSchemaDowngrade, subscribeSchemaDowngrade, type SchemaDowngrade } from './schema-downgrade';

/**
 * The downgrade this launch found, or null — see ./schema-downgrade.
 *
 * For a surface that has to say WHY its offline data is missing. Everything else
 * needs no gate of its own: the handle is never published, schema readiness stays
 * false, and `useOfflineDatabase()` already hands out a connection that refuses.
 *
 * No `.web` fork: nothing sets the store in the browser, so it reads null there.
 */
export function useOfflineSchemaDowngrade(): SchemaDowngrade | null {
  return useSyncExternalStore(subscribeSchemaDowngrade, getSchemaDowngrade, () => null);
}
