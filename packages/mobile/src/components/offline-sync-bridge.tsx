import { useEffect, useMemo } from 'react';
import { useSQLiteContext } from 'expo-sqlite';
import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { notifyBootstrapMetadataChanged, notifyScopeDownloadComplete, setSyncProgress } from '../sync';
import {
  assertLocalUserDataOwner,
  beginGlobalPurge,
  stampLocalUserId,
  type GraphQLFetch,
} from '@boardsesh/offline-sync';
import { startSyncScheduler, drainMutationQueue, startBackgroundTracking } from '../offline/offline-sync-adapter';
import { recoverAndReportOutboxOnce } from '../offline/outbox-telemetry';
import { sweepDelistedDownloadTerminals } from '../offline/abandoned-download-terminals';
import { getSetting } from '../settings';
import { setupNotificationHandlers } from '../notifications';
import { getOfflineSyncHttpClient } from '../lib/graphql/client';
import { setOfflineEngineEnabled } from '../lib/offline-engine';
import { registerOfflineEngineState } from '../lib/analytics-offline-engine-state';
import { useAuth } from '../providers/auth-provider';
import { useSnapshotSource } from '../offline/use-snapshot-source';
import { useStoredUserId } from '../hooks/use-current-user-id';
import { clearUserData } from '../db/connection';
import { reportError } from '../lib/error-reporting';
import { useOfflineSchemaReady } from '../db/use-offline-schema-ready';

/**
 * Publishes the permanently enabled native offline engine to the module-level
 * store used by non-React read paths. Mounted first at the app root so the
 * effect flushes before any screen query effect.
 *
 * The super property now records `baked-on`; the Expo web fork records
 * `web-off`. `registerOfflineEngineState` remembers it across analytics resets.
 */
export function OfflineEngineFlagSync() {
  useEffect(() => {
    setOfflineEngineEnabled(true);
    registerOfflineEngineState('baked-on');
  }, []);

  return null;
}

/**
 * Headless bridge that turns the offline machinery on while the user is signed
 * in. It is mounted unconditionally at the root (next to PersistentQueueBar) —
 * NOT in an auth-gated subtree — so the sync effect gates on `isAuthenticated`
 * itself: a signed-out user must not fire doomed authed sync queries, and
 * sign-out must tear the scheduler down via the effect cleanup.
 *
 * Renders nothing. Every effect is wrapped so a failure here (a bad sync
 * trigger, a listener that can't attach) is logged in dev but never crashes the
 * host app — offline sync is best-effort and must not take the UI down with it.
 */
export function OfflineSyncBridge() {
  const db = useSQLiteContext();
  const queryClient = useQueryClient();
  const { isAuthenticated } = useAuth();
  const snapshotSource = useSnapshotSource();
  // `useSQLiteContext()` hands out a connection as soon as the launch gate opens,
  // which is after the FIRST init attempt whatever it did — so on a contended launch
  // this db has no tables yet. See src/db/schema-ready.ts.
  const schemaReady = useOfflineSchemaReady();

  // getOfflineSyncHttpClient() carries auth, endpoint, and a hard request
  // deadline; binding .request keeps the
  // GraphQLFetch shape the scheduler and drainer expect.
  const graphqlFetch = useMemo<GraphQLFetch>(
    () => (query, variables) => getOfflineSyncHttpClient().request(query, variables),
    [],
  );

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
          // setSigningOut, a board removal uses beginScopePurge): the scheduler
          // effect below may already have a pull cycle mid-table, and a page
          // that was on the wire when clearUserData ran would land AFTER the
          // wipe — resurrecting rows with a checkpoint past them, which the
          // strict `>` delta pull never revisits and `user_data_complete` would
          // then vouch for. Bumping the epoch makes syncTable's post-await
          // re-check discard that page; the next cycle restarts from the
          // now-empty checkpoints.
          // GLOBAL, unlike a board removal: clearUserData DELETEs every user
          // table plus deleteUserCheckpoints, so there is nothing scope-shaped to
          // narrow it to.
          beginGlobalPurge();
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

  // The download funnel's launch backstop (issue #4452). Every in-session
  // de-listing path reports its own terminal now — the My Boards toggle-off and
  // all three sign-outs — but a `scope-started:` marker whose scope is no longer
  // in `syncEnabledBoards` is still reachable three ways: a crash between the
  // de-list and the report, a device upgrading from a build that predates those
  // reports, and any future de-listing path nobody instruments. Sweeping at
  // launch makes the invariant structural rather than a list of remembered call
  // sites (the lesson #4391 wrote down).
  //
  // Declared AFTER the owner-stamp effect so a mismatch wipe runs first, and
  // gated on `isAuthenticated` so a signed-out cold start cannot re-report what
  // sign-out already reported and cleared. Self-limiting across re-runs: it
  // clears the markers it reports, so a second pass finds nothing.
  useEffect(() => {
    if (!isAuthenticated || !schemaReady) return;
    void sweepDelistedDownloadTerminals(db);
  }, [db, isAuthenticated, schemaReady]);

  // Unconditional (unlike the scheduler effect below): the offline-sync
  // engine's backgrounding guard must cover ad-hoc drainMutationQueue() calls
  // from mutation hooks too, not just the scheduler's own pull/drain loop —
  // see startBackgroundTracking's doc.
  useEffect(() => startBackgroundTracking(), []);

  // How much unsynced work this launch inherited — and, in the same pass, the
  // dead letters a lost local write lock manufactured put back in the queue
  // (#4331). recoverAndReportOutboxOnce self-guards against this effect re-running
  // on auth changes and swallows its own errors.
  // Gated on the schema like every other db effect: pending_mutations does not
  // exist yet on a contended launch, and a gauge that throws there would report
  // no backlog rather than the backlog it could not read.
  useEffect(() => {
    if (!isAuthenticated || !schemaReady) return;
    void recoverAndReportOutboxOnce(db);
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
          // prop-drilling. A missing build-time URL is the only reason the
          // snapshot source is absent.
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
  }, [db, queryClient, graphqlFetch, snapshotSource, isAuthenticated, schemaReady]);

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
