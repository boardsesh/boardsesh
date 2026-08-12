// The one reactive read of "which board scopes have actually landed on this
// device". Three screens (My Boards, the boards picker, More) each had their own
// inline copy of this query; they now share this hook so the query key, the
// SQLite read and — crucially — the freshness contract live in one place.
//
// Freshness is NOT owned here. `offline-sync-adapter.ts` invalidates
// `['downloadedScopeKeys']` from the engine's per-scope completion callback, so
// a badge or an empty state flips on the screen the user is already looking at
// without any consumer subscribing to `useSyncStatus()` (which republishes on
// every progress frame and would churn the virtualised screens).

import { useQuery } from '@tanstack/react-query';
import { useSQLiteContext } from 'expo-sqlite';
import { getDownloadedScopeKeys } from '@boardsesh/offline-sync';
import { useOfflineSchemaReady } from '../db/use-offline-schema-ready';

export const DOWNLOADED_SCOPE_KEYS_QUERY_KEY = ['downloadedScopeKeys'] as const;

/**
 * Scope keys (`boardType:layoutId:sizeId`) whose board data has a completed
 * download checkpoint.
 *
 * Deliberately ungated by the offline-downloads flag: it reads rows already on
 * disk, and a device that still holds downloads after a kill-switch rollback
 * must not be stranded.
 */
export function useDownloadedScopeKeys() {
  const db = useSQLiteContext();
  // Schema readiness is a KEY member, not an `enabled` gate. On a contended launch
  // this connection has no tables yet, and the read lands in `isError` — the empty
  // state, which is already the right answer. Gating instead would spin forever
  // whenever init genuinely fails; keying makes a late readiness flip refetch.
  // The invalidations above target the prefix, so they still reach every variant.
  const schemaReady = useOfflineSchemaReady();
  return useQuery({
    queryKey: [...DOWNLOADED_SCOPE_KEYS_QUERY_KEY, schemaReady],
    queryFn: () => getDownloadedScopeKeys(db),
  });
}
