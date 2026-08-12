import { useCallback, useMemo } from 'react';
import { useSQLiteContext } from 'expo-sqlite';
import { useQueryClient } from '@tanstack/react-query';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { GraphQLFetch } from '@boardsesh/offline-sync';
import {
  getSetting,
  setOfflineBoardEnabled,
  offlineBoardKeyForBoard,
  offlineBoardScopeForBoard,
  rememberDownloadTrigger,
  rememberOfflineBoards,
  type OfflineDownloadTrigger,
} from '../settings';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../lib/analytics';
import { isOfflineEngineEnabled } from '../lib/offline-engine';
import { getHttpClient } from '../lib/graphql/client';
import { notifyBootstrapMetadataChanged, notifyScopeDownloadComplete, setSyncProgress } from '../sync';
import { triggerSync, drainMutationQueue } from './offline-sync-adapter';
import { useSnapshotSource } from './use-snapshot-source';

/** Which surface flipped the switch, for the Toggled event (issue #4316). */
export type ToggleSource = 'manage' | 'storage' | 'more' | 'adopt';

/**
 * Enable one or more boards for offline and kick a single sync so their catalogs
 * download now. This centralises the plumbing that lived inline in the My Boards
 * screen (`handleToggleOffline`) so the discovery/adopt flow and the "download all"
 * settings toggle can trigger downloads without re-deriving the db / snapshot /
 * drain wiring. `triggerSync → runSync` is single-flight, so enabling several
 * boards in quick succession collapses into one cycle that reads the latest
 * `syncEnabledBoards` setting — hence the batch variant is just "enable all, kick
 * once".
 *
 * Callers must be inside the root SQLite + snapshot providers (every screen is).
 * This only owns the *enable + download* side; the reactive read of the setting
 * (`useOfflineBoardEnabled`, `getDownloadedScopeKeys`) stays with the UI.
 */
export function useBoardDownloads() {
  const db = useSQLiteContext();
  const queryClient = useQueryClient();
  const snapshotSource = useSnapshotSource();

  const graphqlFetch = useMemo<GraphQLFetch>(() => (query, variables) => getHttpClient().request(query, variables), []);
  const drainQueue = useCallback(
    () => drainMutationQueue(db, queryClient, graphqlFetch),
    [db, queryClient, graphqlFetch],
  );

  const enableBoardsOffline = useCallback(
    (boards: UserBoard | UserBoard[], options?: { trigger?: OfflineDownloadTrigger; source?: ToggleSource }) => {
      const list = Array.isArray(boards) ? boards : [boards];
      if (list.length === 0) return;
      const trigger = options?.trigger ?? 'unknown';
      const source = options?.source ?? 'manage';
      for (const board of list) {
        const scopeKey = offlineBoardKeyForBoard(board);
        setOfflineBoardEnabled(offlineBoardScopeForBoard(board), true);
        // Persisted, then consumed when the download actually starts — which can
        // be a later app launch entirely if the board was enabled with no signal.
        rememberDownloadTrigger(scopeKey, trigger);
        track(SHARED_EVENTS.OfflineBoardToggled, {
          scopeKey,
          enabled: true,
          source,
          offlineEngineEnabled: isOfflineEngineEnabled(),
        });
      }
      // Snapshot the board identities while we hold them. This is the single funnel
      // for every offline enable (the My Boards toggle, adopt-found-board, the
      // "download all" settings toggle), so the offline picker gets its rows without
      // any caller having to remember to persist them. A scope key alone can't name
      // a board — see settings/offline-boards.ts.
      rememberOfflineBoards(list);
      triggerSync(db, queryClient, graphqlFetch, () => getSetting('syncEnabledBoards'), drainQueue, {
        onProgress: setSyncProgress,
        onBootstrapMetadataChanged: notifyBootstrapMetadataChanged,
        onScopeDownloadComplete: notifyScopeDownloadComplete,
        snapshotSource,
      });
    },
    [db, queryClient, graphqlFetch, drainQueue, snapshotSource],
  );

  return { enableBoardsOffline };
}
