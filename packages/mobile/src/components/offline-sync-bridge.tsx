import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { openDatabaseAsync, useSQLiteContext } from 'expo-sqlite';
import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { notifyBootstrapMetadataChanged, notifyScopeDownloadComplete, setSyncProgress } from '../sync';
import {
  assertLocalUserDataOwner,
  beginGlobalPurge,
  getLocalUserId,
  isScopeDownloadComplete,
  offlineBoardKeyForBoard,
  stampLocalUserId,
  type GraphQLFetch,
} from '@boardsesh/offline-sync';
import { LOCAL_ACCESS_MODE } from '@boardsesh/party-profile';
import { startSyncScheduler, drainMutationQueue, startBackgroundTracking } from '../offline/offline-sync-adapter';
import { reportOutboxBacklogOnce } from '../offline/outbox-telemetry';
import { sweepDelistedDownloadTerminals } from '../offline/abandoned-download-terminals';
import { getSetting } from '../settings';
import { setupNotificationHandlers } from '../notifications';
import { getOfflineSyncHttpClient } from '../lib/graphql/client';
import { setOfflineEngineEnabled } from '../lib/offline-engine';
import { registerOfflineEngineState } from '../lib/analytics-offline-engine-state';
import { useAuth } from '../providers/auth-provider';
import { useSnapshotSource } from '../offline/use-snapshot-source';
import { useStoredUserId } from '../hooks/use-current-user-id';
import { clearUserData, LOCAL_PROFILE_DATABASE_NAME } from '../db/connection';
import { reportError } from '../lib/error-reporting';
import { useOfflineSchemaReady } from '../db/use-offline-schema-ready';
import { usePartyProfile } from '../providers/party-profile-provider';
import { getNetworkPolicy, subscribeNetworkPolicy } from '../lib/network-policy';
import { getLocalBoard } from '../lib/boards/local-board-store';
import { readPendingLocalProfileImportPrompt, writePendingLocalProfileImportPrompt } from '../lib/access-mode-store';
import { getLocalProfileImportCounts, importLocalProfileIntoAccount } from '../lib/local-profile-account-import';
import { useConfirm } from '../providers/dialog-provider';
import { useTranslation } from 'react-i18next';

const rejectCatalogGraphql: GraphQLFetch = async () => {
  throw new Error('Catalog-only sync attempted an authenticated GraphQL request');
};

const rejectCatalogDrain = async (): Promise<void> => {
  throw new Error('Catalog-only sync attempted to drain personal mutations');
};

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
 * in account mode, or in catalog-only mode for a local profile. It is mounted
 * unconditionally at the root, so every personal effect gates on the account
 * capability instead of assuming that any auth token permits cloud sync.
 *
 * Renders nothing. Every effect is wrapped so a failure here (a bad sync
 * trigger, a listener that can't attach) is logged in dev but never crashes the
 * host app — offline sync is best-effort and must not take the UI down with it.
 */
export function OfflineSyncBridge() {
  const db = useSQLiteContext();
  const queryClient = useQueryClient();
  const { accessMode, accessCapabilities, setLocalCatalogReady, setLocalOwnerReady } = useAuth();
  const accountModeActive = accessCapabilities.useAccountFeatures;
  const localModeActive = accessMode === LOCAL_ACCESS_MODE;
  const { profile: partyProfile } = usePartyProfile();
  const snapshotSource = useSnapshotSource();
  const networkPolicy = useSyncExternalStore(subscribeNetworkPolicy, getNetworkPolicy, () => 'online');
  const confirm = useConfirm();
  const { t: tProfile } = useTranslation('profile');
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
  const { userId: localUserId } = useStoredUserId(accountModeActive);
  useEffect(() => {
    if (!accountModeActive || !localUserId || !schemaReady) return;
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
        if (cancelled || !readPendingLocalProfileImportPrompt()) return;

        const localProfileDatabase = await openDatabaseAsync(LOCAL_PROFILE_DATABASE_NAME, {
          useNewConnection: true,
        });
        try {
          const counts = await getLocalProfileImportCounts(localProfileDatabase);
          const hasPersonalRows = counts.ticks + counts.favorites + counts.playlists + counts.playlistClimbs > 0;
          if (!hasPersonalRows) {
            writePendingLocalProfileImportPrompt(false);
            return;
          }
          const approved = await confirm({
            title: tProfile('mobile.local.importTitle'),
            message: tProfile('mobile.local.importMessage', {
              tickCount: counts.ticks,
              favoriteCount: counts.favorites,
              playlistCount: counts.playlists,
            }),
            confirmLabel: tProfile('mobile.local.importConfirm'),
            cancelLabel: tProfile('mobile.local.importSkip'),
          });
          if (cancelled) return;
          if (!approved) {
            writePendingLocalProfileImportPrompt(false);
            return;
          }
          await importLocalProfileIntoAccount(localProfileDatabase, db, localUserId);
          writePendingLocalProfileImportPrompt(false);
          queryClient.removeQueries({ queryKey: ['logbook'] });
          await queryClient.invalidateQueries();
          await drainMutationQueue(db, queryClient, graphqlFetch);
        } finally {
          await localProfileDatabase.closeAsync();
        }
      } catch (error) {
        reportError(error, { tags: { source: 'offline-sync', op: 'account-owner-or-local-import' } });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountModeActive, confirm, db, graphqlFetch, localUserId, queryClient, schemaReady, tProfile]);

  // The login-free database is a separate file. Stamp it with a stable local
  // owner before any tick write so local filters never rely on nullable legacy
  // rows. A restored database keeps its existing stamp; the backup owns that
  // profile identity and must not be silently rewritten.
  useEffect(() => {
    setLocalOwnerReady(false);
    if (!localModeActive || !partyProfile?.id || !schemaReady) return undefined;
    let cancelled = false;
    void (async () => {
      const ownerUserId = await getLocalUserId(db);
      if (ownerUserId === null) await stampLocalUserId(db, `local:${partyProfile.id}`);
      const localBoard = await getLocalBoard();
      const catalogReady =
        localBoard !== null && (await isScopeDownloadComplete(db, offlineBoardKeyForBoard(localBoard)));
      if (!cancelled) {
        // SecureStore is only a launch hint. The SQLite completeness marker is
        // authoritative so deleting, replacing, or failing to restore the
        // local database always sends the climber back through setup.
        await setLocalCatalogReady(catalogReady);
        setLocalOwnerReady(true);
      }
    })().catch((error: unknown) => {
      if (__DEV__) console.warn('[OfflineSyncBridge] failed to stamp local profile owner:', error);
    });
    return () => {
      cancelled = true;
      setLocalOwnerReady(false);
    };
  }, [db, localModeActive, partyProfile?.id, schemaReady, setLocalCatalogReady, setLocalOwnerReady]);

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
  // gated on account mode so a local profile cannot report account telemetry,
  // even if an auth token remains available for a future mode switch.
  // sign-out already reported and cleared. Self-limiting across re-runs: it
  // clears the markers it reports, so a second pass finds nothing.
  useEffect(() => {
    if (!accountModeActive || !schemaReady) return;
    void sweepDelistedDownloadTerminals(db);
  }, [accountModeActive, db, schemaReady]);

  // Unconditional (unlike the scheduler effect below): the offline-sync
  // engine's backgrounding guard must cover ad-hoc drainMutationQueue() calls
  // from mutation hooks too, not just the scheduler's own pull/drain loop —
  // see startBackgroundTracking's doc.
  useEffect(() => startBackgroundTracking(), []);

  // How much unsynced work this launch inherited. reportOutboxBacklogOnce
  // self-guards against this effect re-running on auth changes and swallows its
  // own errors.
  // Gated on the schema like every other db effect: pending_mutations does not
  // exist yet on a contended launch, and a gauge that throws there would report
  // no backlog rather than the backlog it could not read.
  useEffect(() => {
    if (!accountModeActive || !schemaReady) return;
    void reportOutboxBacklogOnce(db);
  }, [accountModeActive, db, schemaReady]);

  // Push-then-pull sync loop (foreground + reconnect triggers). Returns its own
  // teardown, so React calls it on unmount / dependency change — including the
  // account/local mode flip, which stops and replaces the scheduler.
  useEffect(() => {
    const catalogOnly = localModeActive;
    if (!accountModeActive && !catalogOnly) return undefined;
    if (accountModeActive && networkPolicy !== 'online') return undefined;
    if (catalogOnly && networkPolicy !== 'local-catalog-only') return undefined;
    // Both branches below WRITE to the database — the scheduler pulls catalog rows
    // and the leftover drain flushes queued mutations — so both wait for a stamped
    // schema. Readiness usually lands before the first commit; when a contended
    // launch makes it late, this effect re-runs on the flip and starts then.
    if (!schemaReady) return undefined;
    try {
      const stop = startSyncScheduler(
        db,
        queryClient,
        catalogOnly ? rejectCatalogGraphql : graphqlFetch,
        () => getSetting('syncEnabledBoards'),
        catalogOnly ? rejectCatalogDrain : () => drainMutationQueue(db, queryClient, graphqlFetch),
        {
          // Publish pull progress to the module-level store so the Settings
          // screen can render "last synced" + live progress without
          // prop-drilling. A missing build-time URL is the only reason the
          // snapshot source is absent.
          onProgress: setSyncProgress,
          onBootstrapMetadataChanged: notifyBootstrapMetadataChanged,
          onScopeDownloadComplete: notifyScopeDownloadComplete,
          snapshotSource,
          catalogOnly,
        },
      );
      return stop;
    } catch (error) {
      if (__DEV__) {
        console.warn('[OfflineSyncBridge] failed to start sync scheduler:', error);
      }
      return undefined;
    }
  }, [accountModeActive, db, queryClient, graphqlFetch, localModeActive, networkPolicy, snapshotSource, schemaReady]);

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
