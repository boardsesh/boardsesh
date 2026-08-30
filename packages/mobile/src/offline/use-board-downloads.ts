import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useSQLiteContext } from 'expo-sqlite';
import { useQueryClient } from '@tanstack/react-query';
import type { UserBoard } from '@boardsesh/shared-schema';
import { restoreBootstrapRetryBudget, type GraphQLFetch } from '@boardsesh/offline-sync';
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
import { getOfflineSyncHttpClient } from '../lib/graphql/client';
import { notifyBootstrapMetadataChanged, notifyScopeDownloadComplete, setSyncProgress } from '../sync';
import { triggerSync, drainMutationQueue, hasUsableInternetConnection } from './offline-sync-adapter';
import { useSnapshotSource } from './use-snapshot-source';
import { useOfflineSchemaReady } from '../db/use-offline-schema-ready';
import { LOCAL_ACCESS_MODE } from '@boardsesh/party-profile';
import { useAuth } from '../providers/auth-provider';

const rejectCatalogGraphql: GraphQLFetch = async () => {
  throw new Error('Catalog-only download attempted an authenticated GraphQL request');
};

const rejectCatalogDrain = async (): Promise<void> => {
  throw new Error('Catalog-only download attempted to drain personal mutations');
};

/** Which surface flipped the switch, for the Toggled event (issue #4316). */
export type ToggleSource = 'manage' | 'storage' | 'more' | 'adopt' | 'onboarding';

const ARM_REACHABILITY_RETRY_DELAYS_MS = [750, 3_000] as const;

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
  // The db from `useSQLiteContext()` is handed out as soon as the launch gate opens,
  // which is after the FIRST init attempt whatever it did — so on a contended launch
  // it has no tables yet and a snapshot import would land in a half-set-up file.
  const schemaReady = useOfflineSchemaReady();
  const { accessMode } = useAuth();
  // Local mode never drains or reaches authenticated GraphQL, even when the
  // installation still has a valid account token for switching back later.
  const catalogOnly = accessMode === LOCAL_ACCESS_MODE;

  const graphqlFetch = useMemo<GraphQLFetch>(
    () =>
      catalogOnly ? rejectCatalogGraphql : (query, variables) => getOfflineSyncHttpClient().request(query, variables),
    [catalogOnly],
  );
  const drainQueue = useCallback(
    () => (catalogOnly ? rejectCatalogDrain() : drainMutationQueue(db, queryClient, graphqlFetch)),
    [catalogOnly, db, queryClient, graphqlFetch],
  );

  const startDownloadCycle = useCallback(() => {
    // Reads `syncEnabledBoards` at call time, never a captured list — so a deferred
    // kick downloads what is enabled NOW, not what was enabled when the user tapped.
    // Someone who turns a board on and off again while the schema is unready gets
    // one cycle that finds nothing to do rather than a download they cancelled.
    triggerSync(db, queryClient, graphqlFetch, () => getSetting('syncEnabledBoards'), drainQueue, {
      onProgress: setSyncProgress,
      onBootstrapMetadataChanged: notifyBootstrapMetadataChanged,
      onScopeDownloadComplete: notifyScopeDownloadComplete,
      snapshotSource,
      catalogOnly,
    });
  }, [catalogOnly, db, queryClient, graphqlFetch, drainQueue, snapshotSource]);

  // A tap that arrives before the schema is stamped is HELD, not dropped: the
  // settings writes below are pure preference state and land immediately, and this
  // flag replays the download kick once readiness flips. Dropping it would leave a
  // "Download" tap doing visibly nothing, which is what discovery nudges send people
  // straight into.
  const downloadKickPendingRef = useRef(false);
  const schemaReadyRef = useRef(schemaReady);
  schemaReadyRef.current = schemaReady;
  const mountedRef = useRef(true);
  const reachabilityProbeGenerationRef = useRef(0);
  const reachabilityRetryTimeoutsRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      reachabilityProbeGenerationRef.current += 1;
      for (const timeout of reachabilityRetryTimeoutsRef.current) clearTimeout(timeout);
      reachabilityRetryTimeoutsRef.current.clear();
    };
  }, []);

  const startDownloadCycleIfReachable = useCallback(() => {
    const generation = reachabilityProbeGenerationRef.current + 1;
    reachabilityProbeGenerationRef.current = generation;

    function runProbe(attemptIndex: number): void {
      const scheduleNext = (): void => {
        if (!mountedRef.current || reachabilityProbeGenerationRef.current !== generation) return;
        const delay = ARM_REACHABILITY_RETRY_DELAYS_MS[attemptIndex];
        if (delay === undefined) return;
        const timeout = setTimeout(() => {
          reachabilityRetryTimeoutsRef.current.delete(timeout);
          runProbe(attemptIndex + 1);
        }, delay);
        reachabilityRetryTimeoutsRef.current.add(timeout);
      };

      void hasUsableInternetConnection(catalogOnly ? 'catalog' : 'backend')
        .then((isReachable) => {
          if (!mountedRef.current || reachabilityProbeGenerationRef.current !== generation) return;
          if (!isReachable) {
            scheduleNext();
            return;
          }
          // Invalidate any delayed callback before kicking. The cycle reads the
          // current enabled-board setting, so one kick covers every arm that
          // arrived while the reachability probe was pending.
          reachabilityProbeGenerationRef.current += 1;
          if (!schemaReadyRef.current) {
            downloadKickPendingRef.current = true;
            return;
          }
          startDownloadCycle();
        })
        .catch(scheduleNext);
    }

    runProbe(0);
  }, [catalogOnly, startDownloadCycle]);

  // The enable half both entry points share: flip the per-scope setting, persist
  // the attribution, emit Toggled, and snapshot the board identities while we
  // hold them. This is the single funnel for every offline enable (the My Boards
  // toggle, adopt-found-board, the "download all" settings toggle, the discovery
  // nudges), so the offline picker gets its rows without any caller having to
  // remember to persist them. A scope key alone can't name a board — see
  // settings/offline-boards.ts.
  const markBoardsEnabled = useCallback(
    (list: UserBoard[], options?: { trigger?: OfflineDownloadTrigger; source?: ToggleSource }) => {
      const trigger = options?.trigger ?? 'unknown';
      const source = options?.source ?? 'manage';
      // Two boards can share one offline scope — the key is board type + layout +
      // size, so a climber who follows two gyms with the same wall gets one entry
      // in `syncEnabledBoards` and ONE download for both. The enable work is
      // per-scope for that reason: emitting a Toggled per board would count two
      // enables against the single Started the downloader emits, and the
      // download-all path is exactly where the duplicates arrive (its "missing"
      // filter runs against the pre-batch enabled set, so siblings all pass).
      // Every board card is still remembered below — that list is per-board.
      const seenScopeKeys = new Set<string>();
      for (const board of list) {
        const scopeKey = offlineBoardKeyForBoard(board);
        if (seenScopeKeys.has(scopeKey)) continue;
        seenScopeKeys.add(scopeKey);
        setOfflineBoardEnabled(offlineBoardScopeForBoard(board), true);
        // Persisted, then consumed when the download actually starts — which can
        // be a later app launch entirely if the board was enabled with no signal,
        // which is exactly what the arm path below leaves behind.
        if (!catalogOnly) {
          rememberDownloadTrigger(scopeKey, trigger);
          track(SHARED_EVENTS.OfflineBoardToggled, {
            scopeKey,
            enabled: true,
            source,
            offlineEngineEnabled: isOfflineEngineEnabled(),
          });
        }
      }
      if (!catalogOnly) rememberOfflineBoards(list);
    },
    [catalogOnly],
  );

  const enableBoardsOffline = useCallback(
    (boards: UserBoard | UserBoard[], options?: { trigger?: OfflineDownloadTrigger; source?: ToggleSource }) => {
      const list = Array.isArray(boards) ? boards : [boards];
      if (list.length === 0) return;
      markBoardsEnabled(list, options);
      if (!schemaReady) {
        downloadKickPendingRef.current = true;
        return;
      }
      startDownloadCycle();
    },
    [markBoardsEnabled, schemaReady, startDownloadCycle],
  );

  useEffect(() => {
    if (!schemaReady || !downloadKickPendingRef.current) return;
    downloadKickPendingRef.current = false;
    startDownloadCycle();
  }, [schemaReady, startDownloadCycle]);

  /**
   * Put a board that settled onto the slow crawl back on the fast download
   * (issue #4313). Restores both retry budgets, clears the cooldown and the
   * slow-path caption, then kicks a cycle so the artifact starts coming down
   * now rather than at the next foreground. The caller owns the confirm dialog,
   * because this is the one path where the ~100 MB spend is consented.
   */
  const retryFastDownload = useCallback(
    async (board: UserBoard) => {
      await restoreBootstrapRetryBudget(db, offlineBoardKeyForBoard(board));
      notifyBootstrapMetadataChanged({ scopeKey: offlineBoardKeyForBoard(board) });
      startDownloadCycle();
    },
    [db, startDownloadCycle],
  );

  /**
   * Mark boards for offline and kick only when NetInfo currently sees a usable
   * upstream connection.
   *
   * Every surface that can fire while the device has no usable connection — the
   * offline board picker, the offline climbs empty state — reaches this instead
   * of `enableBoardsOffline`. It probes NetInfo before triggering so a known
   * captive portal/dead upstream does not start doomed work.
   *
   * The current-state probe closes a narrow lost-wake race: reconnect can land
   * immediately before the setting write, when the scheduler sees no enabled
   * board yet and there may be no second edge. A rejected or stale-negative read
   * is retried twice; after that the durable setting remains armed and the
   * scheduler's next reachability event reads it. Captive portals still do not
   * start a cycle.
   */
  const armBoardsOffline = useCallback(
    (boards: UserBoard | UserBoard[], options?: { trigger?: OfflineDownloadTrigger; source?: ToggleSource }) => {
      const list = Array.isArray(boards) ? boards : [boards];
      if (list.length === 0) return;
      markBoardsEnabled(list, options);
      startDownloadCycleIfReachable();
    },
    [markBoardsEnabled, startDownloadCycleIfReachable],
  );

  return { enableBoardsOffline, armBoardsOffline, retryFastDownload, syncNow: startDownloadCycle };
}
