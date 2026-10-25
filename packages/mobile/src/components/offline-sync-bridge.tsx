import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOfflineDatabase } from '../db/use-offline-database';
import { AppState } from 'react-native';
import { onlineManager, useQueryClient } from '@tanstack/react-query';
import { notifyBootstrapMetadataChanged, notifyScopeDownloadComplete, setSyncProgress } from '../sync';
import { assertLocalUserDataOwner, stampLocalUserId, type GraphQLFetch } from '@boardsesh/offline-sync';
import {
  startSyncScheduler,
  drainMutationQueue,
  startBackgroundTracking,
  readSignedInAccount,
} from '../offline/offline-sync-adapter';
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
import { reportError, reportHandledError } from '../lib/error-reporting';
import { useOfflineSchemaReady } from '../db/use-offline-schema-ready';
import { loadFollowedAuthors, useFollowedAuthors } from '../lib/graphql/hooks/use-followed-authors';
import { invalidateFollowingCatalogueQueries, isCatalogueQuery } from '../lib/graphql/author-query-invalidation';
import { useLaunchWritesReady } from '../providers/launch-ready-context';

/** How often one sign-in retries an owner claim that failed without deciding anything. */
const CLAIM_RETRY_LIMIT = 3;

/**
 * Why sync is held (#6824). `wipe-failed` and `no-user-id` hold for the session;
 * `claim-failed` is reported once the retries above are spent.
 */
type OwnerClaimHold = 'wipe-failed' | 'no-user-id' | 'claim-failed';

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
  //
  // It is also the gate for everything below that touches the outbox or pulls
  // (#6824). The outbox records no owner and the server files a replayed write
  // under the token that sends it, so a scheduler started before this effect
  // settles would drain the previous account's queued writes into this one.
  // `ownerClaim` records the connection the stamp was confirmed on for this
  // sign-in; the scheduler, the launch sweep and the outbox recovery wait for it.
  //
  // The account comes from the token itself (`readSignedInAccount`), the one the
  // drainer checks and the HTTP client attaches. Never from `useStoredUserId`:
  // that query never goes stale, and an observer mounted on the login screen
  // keeps what it read there (nothing on a fresh install, or the previous
  // account's id from the token a lapsed session left behind).
  //
  // What a failure does depends on what failed. A wipe of the previous account's
  // rows that throws holds sync for the session: those rows cannot be told apart
  // from this account's. A token with no user id holds it too, since nothing can
  // ever match it. Anything else (a read, the stamp write, credentials still
  // settling) decided nothing, so the claim runs again on the next foreground or
  // reconnect, up to CLAIM_RETRY_LIMIT times per sign-in. Nothing persists a
  // hold, so the next launch starts from scratch. The drainer and the pull check
  // the stamp themselves as well, which covers the drains this bridge does not
  // start.
  const { userId: storedUserId } = useStoredUserId(isAuthenticated);
  useNotificationUpdates(isAuthenticated && !isLoading, storedUserId);
  const previousDatabase = useRef(db);
  const catalogueRecoveryPending = useRef(!schemaReady);
  const [ownerClaim, setOwnerClaim] = useState<{ db: typeof db } | null>(null);
  const ownerClaimed = isAuthenticated && ownerClaim?.db === db;
  // Bumped by a foreground or a reconnect after a claim that failed without
  // deciding anything; see the retry effect below.
  const [claimAttempt, setClaimAttempt] = useState(0);
  const claimRetry = useRef({ pending: false, left: CLAIM_RETRY_LIMIT });
  // One report per reason per sign-in: a held session would otherwise repeat it
  // on every re-run, and a sign-out clears it so the next account's hold is
  // reported too. No ids.
  const reportedHolds = useRef(new Set<string>());
  const reportHoldOnce = useCallback((reason: OwnerClaimHold, cause?: unknown) => {
    if (reportedHolds.current.has(reason)) return;
    reportedHolds.current.add(reason);
    reportHandledError(new Error(`Offline sync held for this session: ${reason}`, { cause }), {
      level: 'warning',
      tags: { source: 'offline-sync', op: 'owner-claim-hold', reason },
    });
  }, []);
  useEffect(() => {
    // Ordinary offline reads can cache an empty fallback before initialization,
    // or personal results before the owner stamp. Remember recovery across auth
    // delays and canceled preparations, without refreshing normal ready launches.
    if (!schemaReady || previousDatabase.current !== db) catalogueRecoveryPending.current = true;
    previousDatabase.current = db;
    if (!isAuthenticated) {
      // A claim belongs to one sign-in: the next one proves itself again.
      setOwnerClaim(null);
      claimRetry.current = { pending: false, left: CLAIM_RETRY_LIMIT };
      reportedHolds.current.clear();
      return;
    }
    if (!schemaReady || !launchWritesReady) return;
    let cancelled = false;
    // This attempt answers any retry an earlier one asked for, whatever started
    // it: a claim that re-runs on a replacement connection (#5410) and succeeds,
    // or holds, must not leave a request behind for the next foreground.
    claimRetry.current.pending = false;
    void (async () => {
      let localUserId: string;
      // Which step threw decides the catch below.
      let step: 'claim' | 'wipe' = 'claim';
      try {
        const account = await readSignedInAccount();
        if (cancelled) return;
        if (account.status === 'no-user-id') {
          reportHoldOnce('no-user-id');
          return;
        }
        if (account.status === 'unsettled') throw new Error('The signed-in credentials could not be read yet');
        localUserId = account.userId;
        const ownership = await assertLocalUserDataOwner(db, localUserId);
        if (cancelled) return;
        if (ownership !== 'ok') catalogueRecoveryPending.current = true;
        // Only `mismatch` wipes. `unstamped` (nobody has claimed the database)
        // and `ok` go straight to the stamp, on the `claim` path.
        step = ownership === 'mismatch' ? 'wipe' : 'claim';
        if (ownership === 'mismatch') {
          reportError(new Error('Local offline user data belonged to a different account'), {
            tags: { source: 'offline-sync', op: 'owner-stamp-mismatch' },
          });
          // Nothing drains or pulls for this account before the claim below
          // (#6824). The wipe still bumps the global purge epoch first, as every
          // global wipe does.
          await wipePreviousAccountLocalData(db);
          if (cancelled) return;
        }
        step = 'claim';
        if (ownership !== 'ok') await stampLocalUserId(db, localUserId);
        if (cancelled) return;
        // The device is this account's now: release the scheduler and the
        // launch passes below.
        setOwnerClaim({ db });
      } catch (error) {
        if (cancelled) return;
        if (__DEV__) {
          console.warn('[OfflineSyncBridge] failed to claim local user data:', error);
        }
        if (step === 'wipe') {
          // Fail closed: the previous account's rows are still on disk.
          reportHoldOnce('wipe-failed', error);
        } else if (claimRetry.current.left > 0) {
          claimRetry.current.pending = true;
        } else {
          reportHoldOnce('claim-failed', error);
        }
        return;
      }
      try {
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
  }, [db, isAuthenticated, schemaReady, launchWritesReady, queryClient, reportHoldOnce, claimAttempt]);

  // The claim's second chance (#6824): a claim that failed without deciding
  // anything runs again when the app comes back to the foreground or the
  // connection returns, which is when a locked database or a keychain that was
  // unavailable is likely to have recovered.
  useEffect(() => {
    if (!isAuthenticated) return undefined;
    const retryClaim = () => {
      const retry = claimRetry.current;
      if (!retry.pending || retry.left <= 0) return;
      retry.pending = false;
      retry.left -= 1;
      setClaimAttempt((attempt) => attempt + 1);
    };
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') retryClaim();
    });
    const unsubscribeOnline = onlineManager.subscribe((online) => {
      if (online) retryClaim();
    });
    return () => {
      appStateSubscription.remove();
      unsubscribeOnline();
    };
  }, [isAuthenticated]);

  // The download funnel's launch backstop (issue #4452). Every in-session
  // de-listing path reports its own terminal now — the My Boards toggle-off and
  // all three sign-outs — but a `scope-started:` marker whose scope is no longer
  // in `syncEnabledBoards` is still reachable three ways: a crash between the
  // de-list and the report, a device upgrading from a build that predates those
  // reports, and any future de-listing path nobody instruments. Sweeping at
  // launch makes the invariant structural rather than a list of remembered call
  // sites (the lesson #4391 wrote down).
  //
  // Waits for the owner claim so a mismatch wipe runs first and the previous
  // account's downloads are never reported as this one's (#6824), and gated on
  // `isAuthenticated` so a signed-out cold start cannot re-report what
  // sign-out already reported and cleared. Self-limiting across re-runs: it
  // clears the markers it reports, so a second pass finds nothing.
  useEffect(() => {
    if (!isAuthenticated || !schemaReady || !launchWritesReady || !ownerClaimed) return;
    void sweepDelistedDownloadTerminals(db);
  }, [db, isAuthenticated, schemaReady, launchWritesReady, ownerClaimed]);

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
  // no backlog rather than the backlog it could not read. And for the owner
  // claim: before it, the backlog may be the previous account's (#6824).
  useEffect(() => {
    if (!isAuthenticated || !schemaReady || !launchWritesReady || !ownerClaimed) return;
    void recoverAndReportOutboxOnce(db);
  }, [db, isAuthenticated, schemaReady, launchWritesReady, ownerClaimed]);

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
    // And for this account to own the database (#6824). Every cycle drains the
    // outbox first, and before the claim that outbox can hold the previous
    // account's writes. A write this account queued meanwhile was declined by
    // the drainer untouched, and this first cycle sends it.
    if (!ownerClaimed) return undefined;
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
  }, [db, queryClient, graphqlFetch, snapshotSource, isAuthenticated, schemaReady, launchWritesReady, ownerClaimed]);

  return null;
}
