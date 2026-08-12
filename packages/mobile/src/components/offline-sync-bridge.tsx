import { useEffect, useMemo, useRef } from 'react';
import { useSQLiteContext } from 'expo-sqlite';
import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { notifyBootstrapMetadataChanged, notifyScopeDownloadComplete, setSyncProgress } from '../sync';
import {
  assertLocalUserDataOwner,
  beginLocalPurge,
  getPendingCount,
  stampLocalUserId,
  type GraphQLFetch,
} from '@boardsesh/offline-sync';
import { startSyncScheduler, drainMutationQueue, startBackgroundTracking } from '../offline/offline-sync-adapter';
import { reportOutboxBacklogOnce } from '../offline/outbox-telemetry';
import { getSetting } from '../settings';
import { setupNotificationHandlers } from '../notifications';
import { getHttpClient } from '../lib/graphql/client';
import { setOfflineEngineEnabled } from '../lib/offline-engine';
import { registerOfflineEngineState } from '../lib/analytics-offline-engine-state';
import { useAuth } from '../providers/auth-provider';
import { useFeatureFlag, useOfflineDownloadsEnabled } from '../providers/feature-flags-provider';
import { useSnapshotSource } from '../offline/use-snapshot-source';
import { useStoredUserId } from '../hooks/use-current-user-id';
import { clearUserData } from '../db/connection';
import { reportError } from '../lib/error-reporting';
import { useOfflineSchemaReady } from '../db/use-offline-schema-ready';

/**
 * How long the flag gets to resolve before a launch counts as "flags never
 * landed". Everyone starts unresolved for the first few hundred milliseconds,
 * so registering `default-on` immediately would tag ~100% of sessions with it
 * and measure nothing.
 */
export const FLAG_SETTLE_MS = 10_000;

/**
 * Publishes the offline-engine flag decision to the module-level store that
 * non-React code (the GraphQL read interceptor) checks. Mounted as the first
 * child inside FeatureFlagsProvider so its effect flushes before any screen's
 * query effect fires — a flag-on user's first local-first read never races the
 * store. First render always sees flags as `{}` (PostHog state lands via the
 * provider's own effect), which since #4312 resolves to engine-ON; the store's
 * literal `false` default therefore holds only until this effect runs, which is
 * before anything can read it.
 *
 * It also stamps HOW the engine got its state onto every subsequent event, via
 * the `offline_engine_state` super property. #4208 turned off
 * `$feature_flag_called`, which is the signal #4312 was diagnosed from, so
 * without this we would have no way to tell whether the bake worked. A super
 * property costs no event volume — it rides along on events we already send,
 * including the download funnel. `registerOfflineEngineState` remembers what it
 * registered so `analytics.reset()` can put it back: a sign-out wipes every
 * super property, and this effect will not run again for the rest of the launch.
 */
export function OfflineEngineFlagSync() {
  const offlineEnabled = useOfflineDownloadsEnabled();
  const rawFlag = useFeatureFlag('offline-board-downloads');

  useEffect(() => {
    setOfflineEngineEnabled(offlineEnabled);
  }, [offlineEnabled]);

  // Keyed on the RAW flag, not the resolved boolean: `flag-on` and `default-on`
  // both resolve to `true`, so an effect keyed on the boolean could not tell
  // them apart. A resolved value registers straight away; an unresolved one
  // waits out FLAG_SETTLE_MS and only then counts as "flags never landed" —
  // the cleanup cancels the timer if the flag resolves first, so a normal
  // launch never registers `default-on`.
  useEffect(() => {
    if (rawFlag !== undefined) {
      registerOfflineEngineState(rawFlag ? 'flag-on' : 'flag-off');
      return undefined;
    }
    const settleTimer = setTimeout(() => {
      registerOfflineEngineState('default-on');
    }, FLAG_SETTLE_MS);
    return () => clearTimeout(settleTimer);
  }, [rawFlag]);

  return null;
}

/**
 * Headless bridge that turns the offline machinery on while the user is signed
 * in. It is mounted unconditionally at the root (next to PersistentQueueBar) —
 * NOT in an auth-gated subtree — so the sync effect gates on `isAuthenticated`
 * itself: a signed-out user must not fire doomed authed sync queries, and
 * sign-out must tear the scheduler down via the effect cleanup.
 *
 * The sync scheduler additionally runs only when the `offline-board-downloads`
 * flag is on. Flag-off users get one leftover-queue check instead: writes
 * queued while the flag was on (or before a rollback) must still flush — the
 * flag gates NEW offline work, never the draining of existing work.
 *
 * Renders nothing. Every effect is wrapped so a failure here (a bad sync
 * trigger, a listener that can't attach) is logged in dev but never crashes the
 * host app — offline sync is best-effort and must not take the UI down with it.
 */
export function OfflineSyncBridge() {
  const db = useSQLiteContext();
  const queryClient = useQueryClient();
  const { isAuthenticated } = useAuth();
  const offlineEnabled = useOfflineDownloadsEnabled();
  const snapshotSource = useSnapshotSource();
  // `useSQLiteContext()` hands out a connection as soon as the launch gate opens,
  // which is after the FIRST init attempt whatever it did — so on a contended launch
  // this db has no tables yet. See src/db/schema-ready.ts.
  const schemaReady = useOfflineSchemaReady();

  // getHttpClient() already carries auth + endpoint; binding .request keeps the
  // GraphQLFetch shape the scheduler and drainer expect.
  const graphqlFetch = useMemo<GraphQLFetch>(() => (query, variables) => getHttpClient().request(query, variables), []);

  // Who the local user-data rows belong to. Written here rather than inside
  // pullSync because this is the layer that knows the signed-in climber, and
  // the stamp has to exist before the FIRST local read, not after the first
  // successful pull.
  //
  // A stamp naming somebody else means the sign-out wipe did not finish — a
  // locked database (#4314), a crash mid-sign-out, or the logged-out cold-start
  // path that skips cleanup entirely. Re-run the wipe, report it, and only then
  // claim the device for this account. Until the stamp matches, every
  // user-scoped local read declines and falls through to the network.
  //
  // Waits for a stamped schema like every other db effect here: the stamp is a
  // write, and on a contended launch there is no sync_meta table to write it
  // into. Nothing reads local user data before the stamp lands either — those
  // reads go through getDatabaseHandle(), which stays null until the same
  // moment.
  const { userId: localUserId } = useStoredUserId(isAuthenticated);
  useEffect(() => {
    if (!isAuthenticated || !localUserId || !schemaReady) return;
    let cancelled = false;
    void (async () => {
      try {
        const ownership = await assertLocalUserDataOwner(db, localUserId);
        if (cancelled) return;
        if (ownership === 'mismatch') {
          reportError(new Error('Local offline user data belonged to a different account'), {
            tags: { source: 'offline-sync', op: 'owner-stamp-mismatch' },
          });
          // Same hazard every other wipe path guards against (sign-out uses
          // setSigningOut, board removal uses beginLocalPurge): the scheduler
          // effect below may already have a pull cycle mid-table, and a page
          // that was on the wire when clearUserData ran would land AFTER the
          // wipe — resurrecting rows with a checkpoint past them, which the
          // strict `>` delta pull never revisits and `user_data_complete` would
          // then vouch for. Bumping the epoch makes syncTable's post-await
          // re-check discard that page; the next cycle restarts from the
          // now-empty checkpoints.
          beginLocalPurge();
          await clearUserData(db);
          if (cancelled) return;
        }
        if (ownership !== 'ok') await stampLocalUserId(db, localUserId);
      } catch (error) {
        if (__DEV__) {
          console.warn('[OfflineSyncBridge] failed to stamp the local user-data owner:', error);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [db, isAuthenticated, localUserId, schemaReady]);

  // Unconditional (unlike the scheduler effect below): the offline-sync
  // engine's backgrounding guard must cover ad-hoc drainMutationQueue() calls
  // from mutation hooks too, not just the scheduler's own pull/drain loop —
  // see startBackgroundTracking's doc.
  useEffect(() => startBackgroundTracking(), []);

  // On the flag flipping OFF mid-session, caches populated from local SQLite
  // must refetch from the network. `undefined` initial value skips the mount
  // pass so a plain flag-off launch doesn't invalidate anything.
  const previousOfflineEnabledRef = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    const wasEnabled = previousOfflineEnabledRef.current;
    previousOfflineEnabledRef.current = offlineEnabled;
    if (wasEnabled === true && !offlineEnabled) {
      void queryClient.invalidateQueries({ queryKey: ['searchClimbs'] });
      void queryClient.invalidateQueries({ queryKey: ['infiniteSearchClimbs'] });
      void queryClient.invalidateQueries({ queryKey: ['searchClimbsCount'] });
      void queryClient.invalidateQueries({ queryKey: ['climb'] });
    }
  }, [offlineEnabled, queryClient]);

  // How much unsynced work this launch inherited. Deliberately OUTSIDE the
  // offlineEnabled branch below: a kill-switched user's queued writes (and dead
  // letters) are exactly as stranded as a flag-on user's, and the bridge
  // already drains their leftovers. reportOutboxBacklogOnce self-guards against
  // this effect re-running on an auth or flag flip, and swallows its own errors.
  // Gated on the schema like every other db effect: pending_mutations does not
  // exist yet on a contended launch, and a gauge that throws there would report
  // no backlog rather than the backlog it could not read.
  useEffect(() => {
    if (!isAuthenticated || !schemaReady) return;
    void reportOutboxBacklogOnce(db);
  }, [db, isAuthenticated, schemaReady]);

  // Push-then-pull sync loop (foreground + reconnect triggers). Returns its own
  // teardown, so React calls it on unmount / dependency change — including the
  // isAuthenticated flip on sign-out, which stops the scheduler.
  useEffect(() => {
    if (!isAuthenticated) return undefined;
    // Both branches below WRITE to the database — the scheduler pulls catalog rows
    // and the leftover drain flushes queued mutations — so both wait for a stamped
    // schema. Readiness usually lands before the first commit; when a contended
    // launch makes it late, this effect re-runs on the flip and starts then.
    if (!schemaReady) return undefined;
    if (offlineEnabled) {
      try {
        const stop = startSyncScheduler(
          db,
          queryClient,
          graphqlFetch,
          () => getSetting('syncEnabledBoards'),
          () => drainMutationQueue(db, queryClient, graphqlFetch),
          {
            // Publish pull progress to the module-level store so the Settings
            // screen can render "last synced" + live progress without
            // prop-drilling. snapshotSource is gated by useSnapshotSource.
            onProgress: setSyncProgress,
            onBootstrapMetadataChanged: notifyBootstrapMetadataChanged,
            onScopeDownloadComplete: notifyScopeDownloadComplete,
            snapshotSource,
          },
        );
        return stop;
      } catch (error) {
        if (__DEV__) {
          console.warn('[OfflineSyncBridge] failed to start sync scheduler:', error);
        }
        return undefined;
      }
    }

    // Flag off: no scheduler, no listeners, no pull. One-shot leftover drain so
    // a user who queued writes while the flag was on is never stranded. The
    // drainer itself no-ops while offline; in that case the leftovers wait for
    // the sign-out drain or the next launch.
    let cancelled = false;
    void (async () => {
      try {
        const pending = await getPendingCount(db);
        if (!cancelled && pending > 0) {
          await drainMutationQueue(db, queryClient, graphqlFetch);
        }
      } catch (error) {
        if (__DEV__) {
          console.warn('[OfflineSyncBridge] leftover drain failed:', error);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [db, queryClient, graphqlFetch, offlineEnabled, snapshotSource, isAuthenticated, schemaReady]);

  // Deep-link routing for tapped push notifications. Deliberately independent
  // of the offline flag — notifications ship inert for everyone today.
  useEffect(() => {
    try {
      const cleanup = setupNotificationHandlers(router);
      return cleanup;
    } catch (error) {
      if (__DEV__) {
        console.warn('[OfflineSyncBridge] failed to set up notification handlers:', error);
      }
      return undefined;
    }
  }, []);

  return null;
}
