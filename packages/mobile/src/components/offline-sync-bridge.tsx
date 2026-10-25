import { useEffect, useMemo, useRef } from 'react';
import { useOfflineDatabase } from '../db/use-offline-database';
import { useQueryClient } from '@tanstack/react-query';
import { notifyBootstrapMetadataChanged, notifyScopeDownloadComplete, setSyncProgress } from '../sync';
import { assertLocalUserDataOwner, stampLocalUserId, type GraphQLFetch } from '@boardsesh/offline-sync';
import { startSyncScheduler, drainMutationQueue, startBackgroundTracking } from '../offline/offline-sync-adapter';
import { recoverAndReportOutboxOnce } from '../offline/outbox-telemetry';
import { sweepDelistedDownloadTerminals } from '../offline/abandoned-download-terminals';
import { wipePreviousAccountLocalData } from '../offline/account-boundary';
import { getSetting } from '../settings';
import { useNotificationUpdates } from '../notifications/use-notification-updates';
import { getOfflineSyncHttpClient } from '../lib/graphql/client';
import { setOfflineEngineEnabled } from '../lib/offline-engine';
import { registerOfflineEngineState } from '../lib/analytics-offline-engine-state';
import { useAuth } from '../providers/auth-provider';
import { useSnapshotSource } from '../offline/use-snapshot-source';
import { useStoredUserId } from '../hooks/use-current-user-id';
import { reportError } from '../lib/error-reporting';
import { useOfflineSchemaReady } from '../db/use-offline-schema-ready';
import { loadFollowedAuthors, useFollowedAuthors } from '../lib/graphql/hooks/use-followed-authors';
import { invalidateFollowingCatalogueQueries, isCatalogueQuery } from '../lib/graphql/author-query-invalidation';
import { useLaunchWritesReady } from '../providers/launch-ready-context';

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
  // Keep the query observed for reconnect/pull invalidations. The owner effect
  // below explicitly repeats any pre-schema warm-up so it also reaches SQLite.
  useFollowedAuthors();
  // Not `useSQLiteContext()` directly: a dead-handle recovery opens a REPLACEMENT
  // connection without the provider ever re-rendering, so the context value would
  // still be the wrapper around the dead native instance (#5410).
  const db = useOfflineDatabase();
  const queryClient = useQueryClient();
  const { isAuthenticated, isLoading } = useAuth();
  const snapshotSource = useSnapshotSource();
  // `useSQLiteContext()` hands out a connection as soon as the launch gate opens,
  // which is after the FIRST init attempt whatever it did — so on a contended launch
  // this db has no tables yet. See src/db/schema-ready.ts.
  const schemaReady = useOfflineSchemaReady();
  // Every effect below that WRITES waits for the launch to settle (#6689). Until
  // the launch update gate resolves, and while a reload it asked for may still
  // land, this runtime can be replaced. On Android a reload does not close the old
  // runtime's SQLite connections: a write transaction open at that moment keeps
  // the write lock until the process dies, and every tick and sync write after it
  // fails for the whole session. Ordinary local reads do not wait; the first
  // screen renders from them.
  const launchWritesReady = useLaunchWritesReady();

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
  // claim the device for this account. The wipe resets the previous account's
  // downloaded-board list, board names and sync status too, as sign-out does
  // (#6563). Until the stamp matches, every user-scoped local read declines and
  // falls through to the network.
  //
  // Waits for a stamped schema like every other db effect here: the stamp is a
  // write, and on a contended launch there is no sync_meta table to write it
  // into. Nothing reads local user data before the stamp lands either — those
  // reads go through getDatabaseHandle(), which stays null until the same
  // moment. It also waits for `launchWritesReady`: a missing stamp during the launch
  // gate only sends user-scoped reads to the network, and the catalogue recovery
  // below re-runs them once the stamp lands.
  const { userId: localUserId } = useStoredUserId(isAuthenticated);
  useNotificationUpdates(isAuthenticated && !isLoading, localUserId);
  const previousDatabase = useRef(db);
  const catalogueRecoveryPending = useRef(!schemaReady);
  useEffect(() => {
    // Ordinary offline reads can cache an empty fallback before initialization,
    // or personal results before the owner stamp. Remember recovery across auth
    // delays and canceled preparations, without refreshing normal ready launches.
    if (!schemaReady || previousDatabase.current !== db) catalogueRecoveryPending.current = true;
    previousDatabase.current = db;
    if (!isAuthenticated || !localUserId || !schemaReady || !launchWritesReady) return;
    let cancelled = false;
    void (async () => {
      try {
        const ownership = await assertLocalUserDataOwner(db, localUserId);
        if (cancelled) return;
        if (ownership !== 'ok') catalogueRecoveryPending.current = true;
        if (ownership === 'mismatch') {
          reportError(new Error('Local offline user data belonged to a different account'), {
            tags: { source: 'offline-sync', op: 'owner-stamp-mismatch' },
          });
          // The scheduler effect below may already have a pull cycle mid-table;
          // the wipe bumps the global purge epoch first, so the next cycle
          // restarts from the now-empty checkpoints.
          await wipePreviousAccountLocalData(db);
          if (cancelled) return;
        }
        if (ownership !== 'ok') await stampLocalUserId(db, localUserId);
        if (cancelled) return;
        if (catalogueRecoveryPending.current) {
          // Cancel even an initial fetch with no cached data: invalidation alone
          // would reuse its promise and accept results captured before stamping.
          await queryClient.cancelQueries({ predicate: isCatalogueQuery });
          if (cancelled) return;
          void queryClient.invalidateQueries({ predicate: isCatalogueQuery });
          catalogueRecoveryPending.current = false;
        }
        // A screen may already have fetched authors before SQLite was ready.
        // Load again after the owner stamp, even when that query is still fresh,
        // so an empty follow list also gets its complete offline snapshot.
        await queryClient.cancelQueries({ queryKey: ['followedAuthors', localUserId], exact: true });
        if (cancelled) return;
        const authors = await loadFollowedAuthors(localUserId);
        if (!cancelled) {
          queryClient.setQueryData(['followedAuthors', localUserId], authors);
          // Equal cached authors can still predate SQLite readiness. Retry the
          // local Following reads now that their snapshot is usable. Ordinary
          // readiness recovery was handled separately before the author load.
          invalidateFollowingCatalogueQueries(queryClient);
        }
      } catch (error) {
        if (__DEV__) {
          console.warn('[OfflineSyncBridge] failed to prepare local user data:', error);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [db, isAuthenticated, localUserId, schemaReady, launchWritesReady, queryClient]);

  // The download funnel's launch backstop (issue #4452). Every in-session
  // de-listing path reports its own terminal now — the My Boards toggle-off and
  // all three sign-outs — but a `scope-started:` marker whose scope is no longer
  // in `syncEnabledBoards` is still reachable three ways: a crash between the
  // de-list and the report, a device upgrading from a build that predates those
  // reports, and any future de-listing path nobody instruments. Sweeping at
  // launch makes the invariant structural rather than a list of remembered call
  // sites (the lesson #4391 wrote down).
  //
  // Runs alongside the owner-stamp effect, not after it: that effect is async.
  // A mismatch wipe clears the previous account's markers before it empties
  // `syncEnabledBoards`, and the sweep reads the list before the markers, so it
  // cannot report them on this account (#6563). Gated on `isAuthenticated` so a
  // signed-out cold start cannot re-report what sign-out already reported and
  // cleared. Self-limiting across re-runs: it clears the markers it reports, so
  // a second pass finds nothing.
  useEffect(() => {
    if (!isAuthenticated || !schemaReady || !launchWritesReady) return;
    void sweepDelistedDownloadTerminals(db);
  }, [db, isAuthenticated, schemaReady, launchWritesReady]);

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
    if (!isAuthenticated || !schemaReady || !launchWritesReady) return;
    void recoverAndReportOutboxOnce(db);
  }, [db, isAuthenticated, schemaReady, launchWritesReady]);

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
    // And for the launch to settle: see `launchWritesReady` above.
    if (!launchWritesReady) return undefined;
    try {
      const getEnabledBoards = () => getSetting('syncEnabledBoards');
      const drainQueue = () => drainMutationQueue(db, queryClient, graphqlFetch);
      const options = {
        onProgress: setSyncProgress,
        onBootstrapMetadataChanged: notifyBootstrapMetadataChanged,
        onScopeDownloadComplete: notifyScopeDownloadComplete,
        snapshotSource,
      };
      return startSyncScheduler(db, queryClient, graphqlFetch, getEnabledBoards, drainQueue, options);
    } catch (error) {
      if (__DEV__) {
        console.warn('[OfflineSyncBridge] failed to start sync scheduler:', error);
      }
      return undefined;
    }
  }, [db, queryClient, graphqlFetch, snapshotSource, isAuthenticated, schemaReady, launchWritesReady]);

  return null;
}
