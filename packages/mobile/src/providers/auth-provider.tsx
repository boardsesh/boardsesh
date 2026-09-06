import { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback, type ReactNode } from 'react';
import { AppState, Platform } from 'react-native';
import { useSegments, Redirect } from 'expo-router';
import { onlineManager, useQueryClient } from '@tanstack/react-query';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { AppLoadingSplash } from '../components/AppLoadingSplash';
import { resolveAuthSession, type AuthSessionResult } from '../lib/auth-session';
import { captureAuthCredentialGeneration, isAuthCredentialGenerationCurrent } from '../lib/auth-store';
import { subscribeAuthTokenChanges } from '../lib/auth-token-events';
import { bumpAuthTransportRevision } from '../lib/auth-transport-revision';
import {
  signInWithApple as authSignInWithApple,
  signInWithGoogle as authSignInWithGoogle,
  signInWithGoogleWeb as authSignInWithGoogleWeb,
  signInWithAppleWeb as authSignInWithAppleWeb,
  signOutForGeneration as authSignOutForGeneration,
  signInWithCredentials as authSignInWithCredentials,
  registerWithCredentials as authRegisterWithCredentials,
  type CredentialsSignInResult,
  type OAuthSignInResult,
  type RegistrationResult,
} from '../lib/auth';
import { SCREENSHOT_USER_EMAIL, SCREENSHOT_USER_PASSWORD } from '../lib/screenshot-mode';
import { reset as resetAnalytics, track } from '../lib/analytics';
import { resetOfflineUsageSignal } from '../offline/offline-usage-signal';
import { reportError, reportHandledError } from '../lib/error-reporting';
import { setOnForcedSignOut } from '../lib/auth-interceptor';
import { getHttpClient, resetHttpClient } from '../lib/graphql/client';
import { disposeWsClient } from '../lib/graphql/ws-client';
import { setOfflineMode } from '../lib/connectivity/connectivity-store';
import { clearStoredSessionId } from '../lib/session-store';
import { clearStoredQueueSnapshot } from '../lib/queue-snapshot-store';
import { clearAllCreateClimbDrafts } from '../lib/create-climb-draft-store';
import { clearSessionCommentDraft } from '../lib/session-comment-draft-store';
import { setCurrentUserStorageOwner, type UserStorageOwner } from '../lib/user-storage-owner';
import { ACTIVE_BOARD_QUERY_KEY, clearStoredActiveBoardCoordinated } from '../lib/graphql/use-active-board';
import { resetActiveBoardSelfHealValidationCache } from '../lib/boards/active-board-self-heal-validation-cache';
import { clearUserData, purgeLocalDataForSignOut, getDatabaseHandle } from '../db';
import { resetSyncStatus } from '../sync/sync-status';
import { setSetting, clearOfflineBoards } from '../settings';
import { getOutboxSummary, setSigningOut } from '@boardsesh/offline-sync';
import { drainMutationQueue, reportScopeDownloadAbandonedOnSignOut } from '../offline/offline-sync-adapter';
import { reportAbandonedDownloadsOnSignOut } from '../offline/abandoned-download-terminals';
import { reportOutboxDiscardedOnSignOut } from '../offline/outbox-telemetry';
import { stopTokenManagement } from '../notifications';
import { consumeFreshOAuthPending } from '../lib/oauth-pending-store';
import { consumeWebOAuthReturn } from '../lib/oauth-return';
import { isAnonymousReadOnlyLocation, readPostLoginReturnHref } from '../lib/routing/anonymous-auth-gate';

type AuthState = {
  isAuthenticated: boolean;
  isLoading: boolean;
  signInWithApple: (webAttemptId?: string, isRegistration?: boolean) => Promise<OAuthSignInResult>;
  signInWithGoogle: (webAttemptId?: string, isRegistration?: boolean) => Promise<OAuthSignInResult>;
  // Browser-OAuth fallback for supported native Google presentation/config failures.
  signInWithGoogleWeb: (isRegistration?: boolean) => Promise<OAuthSignInResult>;
  // Browser-OAuth fallback for when native Sign in with Apple throws (code 1000).
  signInWithAppleWeb: (isRegistration?: boolean) => Promise<OAuthSignInResult>;
  signInWithCredentials: (email: string, password: string) => Promise<CredentialsSignInResult>;
  register: (email: string, password: string, name?: string) => Promise<RegistrationResult>;
  signOut: (method?: 'manual' | 'account_deleted') => Promise<void>;
  refreshAuthState: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}

type AuthProviderProps = {
  children: ReactNode;
  onReady?: () => void;
};

// Cap on the best-effort queue flush before sign-out proceeds. Deliberately a
// UX bound, not a delivery guarantee: sign-out must not hang on a slow/absent
// connection, the user already confirmed the pending-writes dialog when the
// queue was non-empty, and whatever the race leaves behind is wiped with the
// rest of the local data (the account is leaving this device).
const SIGN_OUT_DRAIN_TIMEOUT_MS = 3000;
const AUTH_CLEANUP_PHASE_TIMEOUT_MS = 1000;

async function waitForCleanupPhase(cleanup: Promise<unknown>): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const handledCleanup = cleanup.catch(reportError);
  await Promise.race([
    handledCleanup,
    new Promise<void>((resolve) => {
      timeoutId = setTimeout(resolve, AUTH_CLEANUP_PHASE_TIMEOUT_MS);
    }),
  ]);
  if (timeoutId !== undefined) clearTimeout(timeoutId);
}

function sameStorageOwner(left: UserStorageOwner, right: UserStorageOwner): boolean {
  return left.userId === right.userId && left.authSessionId === right.authSessionId;
}

export function AuthProvider({ children, onReady }: AuthProviderProps) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSessionUnavailable, setIsSessionUnavailable] = useState(false);
  const [isNativeSessionDegraded, setIsNativeSessionDegraded] = useState(false);
  const segments = useSegments();
  const queryClient = useQueryClient();
  const authStateRef = useRef({ isAuthenticated: false, isLoading: true });
  authStateRef.current = { isAuthenticated, isLoading };
  const authTransitionEpochRef = useRef(0);
  const authTransitionQueueRef = useRef<Promise<void>>(Promise.resolve());
  const anonymousSessionIsolatedRef = useRef(false);
  const authenticatedStorageOwnerRef = useRef<UserStorageOwner | null>(null);
  const pendingAuthTransportRestartRef = useRef(false);
  const remoteInvalidationVersionRef = useRef(0);
  const remoteRevalidationRef = useRef<Promise<void> | null>(null);
  const nativeSessionDegradedRef = useRef(false);
  const reconnectAuthCheckRef = useRef<Promise<void> | null>(null);
  // Android returns to `active` before Linking delivers the browser OAuth
  // callback. Suppress only the provider's generic foreground read while a
  // fallback owns that hand-off; each successful wrapper still runs its own
  // explicit check after the transfer token has been exchanged. A suppressed
  // active event is retained as one deferred check so a keychain read that
  // became available while the browser was open is not lost.
  const browserFallbackAuthChecksRef = useRef(0);
  const deferredBrowserFallbackAuthCheckRef = useRef(false);
  const authProviderMountedRef = useRef(true);

  useEffect(() => {
    // React StrictMode replays effects without recreating refs, so restore the
    // mounted bit in setup as well as clearing it during cleanup.
    authProviderMountedRef.current = true;
    return () => {
      authProviderMountedRef.current = false;
      browserFallbackAuthChecksRef.current = 0;
      deferredBrowserFallbackAuthCheckRef.current = false;
    };
  }, []);

  const updateNativeSessionDegraded = useCallback((degraded: boolean) => {
    nativeSessionDegradedRef.current = degraded;
    setIsNativeSessionDegraded(degraded);
  }, []);

  const beginAuthTransition = useCallback((): number => {
    authTransitionEpochRef.current += 1;
    return authTransitionEpochRef.current;
  }, []);

  const isAuthTransitionCurrent = useCallback(
    (transitionEpoch: number): boolean => Platform.OS !== 'web' || transitionEpoch === authTransitionEpochRef.current,
    [],
  );

  const enqueueAuthTransition = useCallback(<Result,>(transition: () => Promise<Result>): Promise<Result> => {
    if (Platform.OS !== 'web') return transition();
    const result = authTransitionQueueRef.current.then(transition, transition);
    authTransitionQueueRef.current = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }, []);

  const resetAnalyticsForSignedOutTransition = useCallback(() => {
    const authState = authStateRef.current;
    if (authState.isLoading || authState.isAuthenticated) {
      resetAnalytics();
      // The offline-usage rollup's suppression map is in-memory and not keyed by
      // user, so a same-day account switch would otherwise inherit the previous
      // user's counters and the new user's first offline day would never fire
      // (#4317).
      resetOfflineUsageSignal();
    }
  }, []);

  // Persisted (SecureStore/AsyncStorage-backed) per-user state that outlives a
  // relaunch. allSettled (not all) so one failing delete can't abort the rest.
  // These are the only sign-out leftovers that can carry a previous user across
  // a cold start on a shared device, so a signed-out checkAuth clears them even
  // when there's no live in-session cache to wipe (see handleSignedOutTransition).
  const clearPersistedUserStores = useCallback((owner?: UserStorageOwner | null) => {
    // This is the shared confirmed account boundary for manual/forced sign-out,
    // expiry, remote sign-out, and authenticated identity changes. Invalidate
    // cached tombstone checks before the coordinated clear synchronously bumps
    // the active-board write generation, so neither validation nor storage
    // state can leak into the next account.
    resetActiveBoardSelfHealValidationCache();
    return Promise.allSettled([
      clearStoredSessionId(owner),
      clearStoredActiveBoardCoordinated(owner),
      clearStoredQueueSnapshot(owner),
      // Create-climb and session-recap drafts are wiped for account
      // isolation only on web (the new surface). Native sign-out keeps its
      // origin behavior and leaves these drafts intact, so shipping this via
      // OTA doesn't change what a native sign-out touches.
      ...(Platform.OS === 'web' ? [clearAllCreateClimbDrafts(owner), clearSessionCommentDraft(owner)] : []),
    ]);
  }, []);

  const drainLocalMutationQueueBestEffort = useCallback(async () => {
    const localDb = getDatabaseHandle();
    if (!localDb) return;

    try {
      // Gated on the OUTBOX being empty, NOT on the offline feature flag: writes
      // queued while the flag was on must still flush after a rollback. With an
      // empty outbox (every flag-off user) this is one local grouped COUNT and
      // sign-out proceeds immediately, as pre-offline.
      //
      // Dead letters count toward the gate even though the drainer cannot push them
      // (peekPending filters `status = 'pending'`), so a dead-letters-only outbox
      // enters the drain and leaves again on the first empty peek — no network,
      // microseconds. Counting them is what keeps "is there unsynced work on this
      // device?" answering the same in every place that asks: this gate, the
      // confirmation dialog, the outbox telemetry below, and the purge's own
      // discard counts. Auto-retrying dead letters here is a product decision this
      // leaves alone: their retries are already spent, and requeueing them would
      // empty the Sync-issues screen for a sign-out that can still fail.
      const { pendingCount, deadLetterCount } = await getOutboxSummary(localDb);
      if (pendingCount + deadLetterCount === 0) return;

      const graphqlFetch = (query: string, variables?: Record<string, unknown>) =>
        getHttpClient().request(query, variables);
      await Promise.race([
        drainMutationQueue(localDb, queryClient, graphqlFetch),
        new Promise<void>((resolve) => setTimeout(resolve, SIGN_OUT_DRAIN_TIMEOUT_MS)),
      ]);
    } catch (error) {
      if (__DEV__) {
        console.warn('[Auth] best-effort offline queue drain during sign-out failed:', error);
      }
    }
  }, [queryClient]);

  // `purgeOfflineBoards` picks the FULL wipe (downloaded board catalogs included)
  // over the selective one. Only an explicit, confirmed sign-out asks for it — see
  // runSignedOutCleanup's option — so a token-refresh glitch can never cost someone
  // a 271MB Kilter download (issue #3621). setSigningOut bumps the wipe epoch around
  // either wipe, so in-flight pulls bail before the DELETEs land.
  const clearLocalOfflineUserData = useCallback(async (purgeOfflineBoards: boolean) => {
    const localDb = getDatabaseHandle();
    if (!localDb) return;

    setSigningOut(true);
    try {
      if (purgeOfflineBoards) {
        // Reported from here rather than the caller because the counts only exist
        // inside the wipe's own transaction: pending_mutations is emptied by it.
        const purge = await purgeLocalDataForSignOut(localDb, {
          // The wipe's `deleteAllSyncMeta` is what destroys the download funnel's
          // `scope-started:` markers, so it is the last code that can close their
          // funnel (issue #4452). The selective branch below keeps every marker
          // and is handled in runSignedOutCleanup instead — it needs to run after
          // this whole cleanup, next to the `syncEnabledBoards` reset that is the
          // thing actually ending those downloads.
          onDownloadAbandoned: reportScopeDownloadAbandonedOnSignOut,
        });
        track(SHARED_EVENTS.OfflineDataWipedOnSignOut, { ...purge });
      } else {
        await clearUserData(localDb);
      }
    } catch (error) {
      if (__DEV__) {
        console.warn('[Auth] local offline data cleanup during sign-out failed:', error);
      }
    } finally {
      setSigningOut(false);
    }
  }, []);

  // The shared signed-out cleanup, used by the manual `signOut`, the
  // interceptor's forced sign-out (failed-refresh 401), and checkAuth's
  // proactive expiry path. It deliberately omits the two caller-specific steps:
  // the manual `Logout` analytics event, and `authSignOut()` (the token revoke +
  // clear) — the forced/expiry paths' token is already revoked, so running it
  // here would double-revoke.
  //
  // `purgeOfflineBoards` is opt-in and defaults to false: only the explicit
  // `signOut()` passes it, so the forced 401, the expiry and the identity-change
  // paths keep the downloaded catalogs they always kept.
  const runSignedOutCleanup = useCallback(
    async (
      transitionEpoch: number,
      storageOwner?: UserStorageOwner | null,
      { purgeOfflineBoards = false }: { purgeOfflineBoards?: boolean } = {},
    ): Promise<boolean> => {
      if (!isAuthTransitionCurrent(transitionEpoch)) return false;
      // What the wipe below is about to delete. clearUserData DELETEs
      // pending_mutations wholesale — dead letters included, and those never get
      // a drain attempt (the drainer's peekPending only takes status = 'pending',
      // so entering the drain does nothing for them). This MUST stay ahead of
      // resetAnalytics():
      // afterwards the event would land on an anonymous distinct_id and could no
      // longer be joined to the account that lost the writes. Sitting in
      // runSignedOutCleanup rather than in the manual signOut covers all three
      // paths — manual, forced 401, and proactive expiry.
      const localDb = getDatabaseHandle();
      if (localDb) await reportOutboxDiscardedOnSignOut(localDb);
      resetOfflineUsageSignal();
      const stopTokenCleanup = stopTokenManagement(async () => {});
      if (Platform.OS === 'web') await waitForCleanupPhase(stopTokenCleanup);
      else await stopTokenCleanup;
      if (!isAuthTransitionCurrent(transitionEpoch)) return false;
      const persistedStoreCleanup = clearPersistedUserStores(storageOwner);
      if (Platform.OS === 'web') await waitForCleanupPhase(persistedStoreCleanup);
      else await persistedStoreCleanup;
      if (!isAuthTransitionCurrent(transitionEpoch)) return false;
      const offlineUserDataCleanup = clearLocalOfflineUserData(purgeOfflineBoards);
      if (Platform.OS === 'web') await waitForCleanupPhase(offlineUserDataCleanup);
      else await offlineUserDataCleanup;
      // Close the download funnel for anything that was still downloading (issue
      // #4452). The SELECTIVE branch only: the explicit wipe already reported
      // through purgeLocalDataForSignOut's seam and its markers are gone, while
      // this branch keeps every marker and every row — and still ends the
      // download for good, because `setSetting('syncEnabledBoards', [])` below
      // runs on all three sign-out paths and pullSync only ever visits enabled
      // scopes.
      if (localDb && !purgeOfflineBoards) await reportAbandonedDownloadsOnSignOut(localDb);
      // Only NOW. Every sign-out event above — the discarded outbox, the wipe's
      // own `Offline Data Wiped On Sign Out`, and the abandonment terminals —
      // has to land on the account that is leaving; after the reset they arrive
      // on a fresh anonymous distinct_id and no funnel query can pair them with
      // their `Offline Board Download Started`. Production showed exactly that:
      // every `Offline Data Wiped On Sign Out` sat on a different person_id from
      // the `Logout` half a second earlier.
      //
      // Before the analytics reset, for the same reason as everything above it:
      // `Offline Mode Toggled { source: 'sign_out' }` has to land on the account
      // that is leaving, not on a fresh anonymous distinct_id.
      //
      // The reset itself is the point (issue #4862). Offline mode gates the
      // backend, so a phone left signed out with the switch still on would show
      // a login screen whose own sign-in request is blocked — the climber would
      // be locked out of the app by a setting they cannot reach from there.
      setOfflineMode(false, 'sign_out');
      resetAnalytics();
      if (!isAuthTransitionCurrent(transitionEpoch)) return false;
      // Reset the per-user "downloaded boards" list so the next account on a shared
      // device doesn't inherit the previous user's offline selection. After a
      // selective wipe the cached board rows + checkpoints survive, so if the next
      // user enables the same board the download resumes instantly; after a purge
      // the rows those keys point at are gone, so leaving the list populated would
      // advertise boards as available offline over an empty catalog.
      setSetting('syncEnabledBoards', []);
      // "Last synced 5 minutes ago" belonged to the account that just left.
      resetSyncStatus();
      // ...and the board snapshots the offline picker replays. These carry the
      // previous account's board NAMES, so on a shared device a missed clear would
      // show one user's walls in the next user's picker.
      clearOfflineBoards();
      // Drop the in-memory active-board cache too. It's `staleTime: Infinity`, so
      // without this the next user to sign in on a shared device would inherit the
      // previous user's board until a manual switch.
      queryClient.removeQueries({ queryKey: ACTIVE_BOARD_QUERY_KEY });
      resetHttpClient();
      disposeWsClient();
      // Drop every cached query so the next signed-in user doesn't inherit the
      // previous user's data. Query keys don't currently include a user/token
      // dimension, and individual keys' staleTime (e.g. userPlaylists' 5 min)
      // would otherwise paper over the cross-user leak. Doing this at the auth
      // boundary keeps the rest of the hooks simple.
      queryClient.clear();
      return true;
    },
    [clearPersistedUserStores, clearLocalOfflineUserData, isAuthTransitionCurrent, queryClient],
  );

  // checkAuth lands here when a token read/refresh shows the session is gone. If
  // we were authenticated this session, run the full cleanup (cache + clients are
  // live). Otherwise — a logged-out cold start / relaunch — the cache is empty
  // and the clients are null, so only the persisted stores can carry a prior
  // user forward; clear those. Gating the heavy cleanup on the transition keeps a
  // normal logged-out launch from churning an empty cache. Both branches flip
  // isAuthenticated → false, so checkAuth doesn't repeat it.
  const handleSignedOutTransition = useCallback(
    async (
      transitionEpoch: number,
      forceFullCleanup = false,
      { purgeOfflineBoards = false }: { purgeOfflineBoards?: boolean } = {},
    ): Promise<boolean> => {
      if (!isAuthTransitionCurrent(transitionEpoch)) return false;
      updateNativeSessionDegraded(false);
      const previousStorageOwner = Platform.OS === 'web' ? authenticatedStorageOwnerRef.current : undefined;
      if (Platform.OS === 'web' && !forceFullCleanup && anonymousSessionIsolatedRef.current) {
        authStateRef.current = { ...authStateRef.current, isAuthenticated: false };
        setIsAuthenticated(false);
        return true;
      }

      const needsFullCleanup =
        forceFullCleanup ||
        authStateRef.current.isAuthenticated ||
        (Platform.OS === 'web' && previousStorageOwner !== null);
      // On web, publish the confirmed anonymous state before any storage await.
      // This unmounts authenticated consumers promptly, while epoch checks stop
      // this transition from writing after a newer login. Native keeps its
      // established behavior of publishing signed-out state after cleanup.
      if (Platform.OS === 'web') {
        setCurrentUserStorageOwner(null);
        authStateRef.current = { ...authStateRef.current, isAuthenticated: false };
        setIsAuthenticated(false);
      }

      let completed: boolean;
      if (needsFullCleanup) {
        completed = await runSignedOutCleanup(transitionEpoch, previousStorageOwner, { purgeOfflineBoards });
      } else {
        if (!isAuthTransitionCurrent(transitionEpoch)) return false;
        resetAnalyticsForSignedOutTransition();
        const persistedStoreCleanup = clearPersistedUserStores(previousStorageOwner);
        if (Platform.OS === 'web') await waitForCleanupPhase(persistedStoreCleanup);
        else await persistedStoreCleanup;
        completed = isAuthTransitionCurrent(transitionEpoch);
      }

      if (completed) {
        if (Platform.OS === 'web') {
          anonymousSessionIsolatedRef.current = true;
          authenticatedStorageOwnerRef.current = null;
          pendingAuthTransportRestartRef.current = false;
        } else setIsAuthenticated(false);
      }
      return completed;
    },
    [
      clearPersistedUserStores,
      isAuthTransitionCurrent,
      resetAnalyticsForSignedOutTransition,
      runSignedOutCleanup,
      updateNativeSessionDegraded,
    ],
  );

  const handleAuthenticatedTransition = useCallback(
    async (transitionEpoch: number, authSession: { userId?: string; authSessionId?: string }): Promise<boolean> => {
      const wasAuthenticated = authStateRef.current.isAuthenticated;
      let authenticatedIdentityChanged = false;
      if (Platform.OS === 'web') {
        const nextUserId = authSession.userId;
        const nextAuthSessionId = authSession.authSessionId;
        if (!nextUserId || !nextAuthSessionId) {
          reportError(new Error('Authenticated web session returned no login identity'));
          return false;
        }
        const nextStorageOwner = { userId: nextUserId, authSessionId: nextAuthSessionId };
        const previousStorageOwner = authenticatedStorageOwnerRef.current;
        if (previousStorageOwner !== null && !sameStorageOwner(previousStorageOwner, nextStorageOwner)) {
          authenticatedIdentityChanged = true;
          setCurrentUserStorageOwner(null);
          authStateRef.current = { ...authStateRef.current, isLoading: true };
          setIsLoading(true);
          const cleanedPreviousUser = await runSignedOutCleanup(transitionEpoch, previousStorageOwner);
          if (!cleanedPreviousUser || !isAuthTransitionCurrent(transitionEpoch)) return false;
        }
        setCurrentUserStorageOwner(nextStorageOwner);
        authenticatedStorageOwnerRef.current = nextStorageOwner;
      }

      anonymousSessionIsolatedRef.current = false;
      authStateRef.current = { ...authStateRef.current, isAuthenticated: true };
      setIsSessionUnavailable(false);
      setIsAuthenticated(true);
      if (Platform.OS === 'web' && (pendingAuthTransportRestartRef.current || authenticatedIdentityChanged)) {
        pendingAuthTransportRestartRef.current = false;
        bumpAuthTransportRevision();
      }
      const returnedOAuth = Platform.OS === 'web' && !wasAuthenticated ? consumeWebOAuthReturn() : null;
      if (returnedOAuth && returnedOAuth.error === null) {
        void consumeFreshOAuthPending(returnedOAuth.attemptId).then((marker) => {
          if (!marker || marker.provider !== returnedOAuth.provider) return;
          track(SHARED_EVENTS.LoginSucceeded, {
            auth_method: marker.provider,
            flow: 'web',
            ...(marker.isRegistration ? { is_registration: true } : {}),
          });
        });
      }
      return true;
    },
    [isAuthTransitionCurrent, runSignedOutCleanup],
  );

  const handleResolvedAuthenticatedTransition = useCallback(
    async (
      transitionEpoch: number,
      authSession: Extract<AuthSessionResult, { status: 'authenticated' }>,
    ): Promise<boolean> => {
      // resolveAuthSession checks its captured generation after every await, but
      // another login or logout can still win in the microtask between resolution
      // and this provider continuation. Recheck at the state-application boundary
      // so an old session can never revive or annotate a newer credential owner.
      if (Platform.OS !== 'web' && !isAuthCredentialGenerationCurrent(authSession.generation)) return false;

      if (Platform.OS !== 'web') {
        const degradation = authSession.degraded;
        // Refresh failures are reported with their original cause by the
        // interceptor. The remaining storage-read degradations originate in the
        // session resolver, so report those here through the handled-error policy.
        if (degradation && degradation.stage !== 'refresh-unavailable') {
          reportHandledError(degradation.error, {
            tags: { source: 'auth-session', auth_stage: degradation.stage },
          });
        }
        updateNativeSessionDegraded(degradation !== undefined);
      }

      return handleAuthenticatedTransition(transitionEpoch, authSession);
    },
    [handleAuthenticatedTransition, updateNativeSessionDegraded],
  );

  const checkAuthForTransition = useCallback(
    async (transitionEpoch: number) => {
      try {
        if (!isAuthTransitionCurrent(transitionEpoch)) return;
        const authSession = await resolveAuthSession();
        if (!isAuthTransitionCurrent(transitionEpoch) || authSession.status === 'superseded') {
          // A newer logout/login generation owns provider state. The stale check
          // must not redirect or clean up that newer session.
          return;
        }
        if (Platform.OS !== 'web' && !isAuthCredentialGenerationCurrent(authSession.generation)) {
          // The credential owner changed after resolveAuthSession settled but
          // before this continuation could apply its result.
          return;
        }
        if (authSession.status === 'unavailable') {
          // A browser network outage is not a confirmed logout: preserve an
          // already-rendered web session, or show the retry route on cold start.
          // Native keychain failures retain their established policy below.
          if (Platform.OS !== 'web') {
            // Preserve native behavior for transient keychain failures: release
            // the current UI without running confirmed-sign-out cleanup, then
            // retry the keychain when the app becomes active again.
            reportHandledError(authSession.error, {
              tags: { source: 'auth-session', auth_stage: authSession.stage },
            });
            updateNativeSessionDegraded(false);
            setIsAuthenticated(false);
            setIsSessionUnavailable(false);
          } else {
            reportError(authSession.error);
            const previousStorageOwner = authenticatedStorageOwnerRef.current;
            const confirmedIdentityChanged =
              authSession.identityInvalidated === true ||
              (authSession.confirmedIdentity !== undefined &&
                previousStorageOwner !== null &&
                !sameStorageOwner(previousStorageOwner, authSession.confirmedIdentity));
            if (confirmedIdentityChanged) {
              setCurrentUserStorageOwner(null);
              authStateRef.current = { isAuthenticated: false, isLoading: true };
              setIsAuthenticated(false);
              setIsLoading(true);
              const cleanedPreviousUser = previousStorageOwner
                ? await runSignedOutCleanup(transitionEpoch, previousStorageOwner)
                : isAuthTransitionCurrent(transitionEpoch);
              if (!cleanedPreviousUser || !isAuthTransitionCurrent(transitionEpoch)) return;
              authenticatedStorageOwnerRef.current = null;
              anonymousSessionIsolatedRef.current = true;
              setIsSessionUnavailable(true);
            } else if (!authStateRef.current.isAuthenticated) {
              setIsAuthenticated(false);
              setIsSessionUnavailable(true);
            }
          }
          return;
        }

        if (authSession.status === 'anonymous') {
          updateNativeSessionDegraded(false);
          pendingAuthTransportRestartRef.current = false;
          setIsSessionUnavailable(false);
          // Screenshot build: sign in programmatically here, before the loading gate
          // clears, so the app renders straight into /home — the login screen never
          // mounts. No form is shown, so there's no Maestro timing race and no iOS
          // "Save Password?" dialog. Inert in normal builds (dead-strips when
          // EXPO_PUBLIC_SCREENSHOT_MODE is unset — the comparison stays inlined here so the
          // release minifier folds it in place rather than across a module boundary).
          if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1') {
            // Diagnostics land in Metro's stdout (which the capture orchestrator tees to
            // a log it polls), so a silent sign-in failure is no longer invisible in CI.
            if (SCREENSHOT_USER_EMAIL && SCREENSHOT_USER_PASSWORD) {
              // Retried in-app because a transient network failure here (seen in CI as
              // `status=null error=network`) otherwise burns one of the orchestrator's
              // full 120-second relaunch cycles just to attempt the same call again.
              for (let attempt = 1; attempt <= 3; attempt += 1) {
                const screenshotSignIn = await authSignInWithCredentials(
                  SCREENSHOT_USER_EMAIL,
                  SCREENSHOT_USER_PASSWORD,
                );
                if (!isAuthTransitionCurrent(transitionEpoch)) return;
                if (screenshotSignIn.success) {
                  const screenshotSession = await resolveAuthSession();
                  if (!isAuthTransitionCurrent(transitionEpoch)) return;
                  if (screenshotSession.status === 'authenticated') {
                    if (Platform.OS !== 'web' && !isAuthCredentialGenerationCurrent(screenshotSession.generation)) {
                      return;
                    }
                    console.info('[screenshot] auto sign-in succeeded; rendering straight into home');
                    await handleResolvedAuthenticatedTransition(transitionEpoch, screenshotSession);
                  } else if (screenshotSession.status === 'unavailable') {
                    if (Platform.OS === 'web') {
                      reportError(screenshotSession.error);
                      setIsSessionUnavailable(true);
                    } else if (isAuthCredentialGenerationCurrent(screenshotSession.generation)) {
                      // Match the ordinary native token-read policy even in the
                      // screenshot harness: a keychain failure is not a confirmed
                      // logout and must not run cleanup or use the web-only retry
                      // route.
                      reportHandledError(screenshotSession.error, {
                        tags: { source: 'auth-session', auth_stage: screenshotSession.stage },
                      });
                      updateNativeSessionDegraded(false);
                      setIsAuthenticated(false);
                      setIsSessionUnavailable(false);
                    }
                  }
                  return;
                }
                console.warn(
                  `[screenshot] auto sign-in FAILED (attempt ${attempt}/3) — ` +
                    `status=${screenshotSignIn.status ?? 'null'} error=${screenshotSignIn.error}` +
                    ` (emailLen=${SCREENSHOT_USER_EMAIL.length} passwordLen=${SCREENSHOT_USER_PASSWORD.length})`,
                );
                // Bad credentials (4xx) will not get better; only retry what can
                // heal — network failures (status null) and transient 5xx.
                if (screenshotSignIn.status !== null && screenshotSignIn.status < 500) break;
                if (attempt < 3) {
                  await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 2000));
                }
              }
            } else {
              console.warn(
                `[screenshot] auto sign-in SKIPPED — credentials not inlined into the bundle` +
                  ` (emailSet=${Boolean(SCREENSHOT_USER_EMAIL)} passwordSet=${Boolean(SCREENSHOT_USER_PASSWORD)})`,
              );
            }
          }
          await handleSignedOutTransition(transitionEpoch);
          return;
        }
        await handleResolvedAuthenticatedTransition(transitionEpoch, authSession);
      } catch (authCheckError) {
        if (!isAuthTransitionCurrent(transitionEpoch)) return;
        // resolveAuthSession normally converts transport/storage errors into the
        // unavailable result above. Keep this final guard so an unexpected error
        // still releases the loading gate without clearing a potentially valid
        // persisted session.
        reportError(authCheckError);
        if (Platform.OS !== 'web') {
          updateNativeSessionDegraded(false);
          setIsAuthenticated(false);
          setIsSessionUnavailable(false);
        } else if (!authStateRef.current.isAuthenticated) {
          setIsAuthenticated(false);
          setIsSessionUnavailable(true);
        }
      } finally {
        if (isAuthTransitionCurrent(transitionEpoch)) setIsLoading(false);
      }
    },
    [
      handleResolvedAuthenticatedTransition,
      handleSignedOutTransition,
      isAuthTransitionCurrent,
      runSignedOutCleanup,
      updateNativeSessionDegraded,
    ],
  );

  const checkAuth = useCallback((): Promise<void> => {
    const transitionEpoch = beginAuthTransition();
    return enqueueAuthTransition(() => checkAuthForTransition(transitionEpoch));
  }, [beginAuthTransition, checkAuthForTransition, enqueueAuthTransition]);

  const checkAuthAfterSuccessfulBrowserFallback = useCallback(async (): Promise<void> => {
    if (!authProviderMountedRef.current) return;
    // The explicit success read subsumes active events that happened before it.
    // Keep suppression held during the await so a newer active event can re-arm
    // the deferred read for the final fallback release.
    deferredBrowserFallbackAuthCheckRef.current = false;
    await checkAuth();
  }, [checkAuth]);

  const releaseBrowserFallbackAuthCheckSuppression = useCallback(async (): Promise<void> => {
    if (!authProviderMountedRef.current) return;
    browserFallbackAuthChecksRef.current = Math.max(0, browserFallbackAuthChecksRef.current - 1);
    if (browserFallbackAuthChecksRef.current !== 0 || !deferredBrowserFallbackAuthCheckRef.current) return;

    // Coalesce every active event suppressed by this group of overlapping
    // fallbacks into exactly one read after the last fallback has released.
    deferredBrowserFallbackAuthCheckRef.current = false;
    await checkAuth();
  }, [checkAuth]);

  useEffect(() => {
    // Belt-and-braces: checkAuth already resolves its own rejections, but keep
    // the invocation from producing an unhandled rejection if that ever changes.
    void checkAuth();
  }, [checkAuth]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      if (!authProviderMountedRef.current) return;
      if (nextAppState !== 'active') return;
      if (browserFallbackAuthChecksRef.current > 0) {
        deferredBrowserFallbackAuthCheckRef.current = true;
        return;
      }
      void checkAuth();
    });
    return () => subscription.remove();
  }, [checkAuth]);

  useEffect(() => {
    if (Platform.OS === 'web' || !isNativeSessionDegraded) return;

    let wasOnline = onlineManager.isOnline();
    return onlineManager.subscribe((isOnline) => {
      const reconnected = !wasOnline && isOnline;
      wasOnline = isOnline;
      if (!reconnected || !nativeSessionDegradedRef.current || reconnectAuthCheckRef.current) return;

      const reconnectCheck = checkAuth().finally(() => {
        if (reconnectAuthCheckRef.current === reconnectCheck) reconnectAuthCheckRef.current = null;
      });
      reconnectAuthCheckRef.current = reconnectCheck;
      // checkAuth owns telemetry as well as expected failure handling. Keep a
      // no-op rejection handler only as an unhandled-rejection guard; reporting
      // here would duplicate the original error if that ownership ever regressed.
      reconnectCheck.catch(() => {});
    });
  }, [checkAuth, isNativeSessionDegraded]);

  // Both native OAuth flows run their provider sheet, exchange the identity
  // token for our JWT pair, and — on success — re-run checkAuth so the provider
  // flips to the authenticated UI (matching signInWithCredentials).
  const signInWithApple = useCallback(async (): Promise<OAuthSignInResult> => {
    const result = await authSignInWithApple();
    if (result.success) {
      await checkAuth();
    }
    return result;
  }, [checkAuth]);

  const signInWithGoogle = useCallback(async (): Promise<OAuthSignInResult> => {
    const result = await authSignInWithGoogle();
    if (result.success) {
      await checkAuth();
    }
    return result;
  }, [checkAuth]);

  // Browser-based Google fallback for supported iOS presentation and Android
  // config failures. Same success contract as the native flow: re-run checkAuth
  // so the provider flips to the authenticated UI.
  const signInWithGoogleWeb = useCallback(
    async (isRegistration = false): Promise<OAuthSignInResult> => {
      browserFallbackAuthChecksRef.current += 1;
      try {
        const result = await authSignInWithGoogleWeb(isRegistration);
        if (result.success) {
          await checkAuthAfterSuccessfulBrowserFallback();
        }
        return result;
      } finally {
        await releaseBrowserFallbackAuthCheckSuppression();
      }
    },
    [checkAuthAfterSuccessfulBrowserFallback, releaseBrowserFallbackAuthCheckSuppression],
  );

  // Browser-based Apple fallback (native Sign in with Apple threw a non-cancel
  // error). Same success contract as the native flow: re-run checkAuth so the
  // provider flips to the authenticated UI.
  const signInWithAppleWeb = useCallback(
    async (isRegistration = false): Promise<OAuthSignInResult> => {
      browserFallbackAuthChecksRef.current += 1;
      try {
        const result = await authSignInWithAppleWeb(isRegistration);
        if (result.success) {
          await checkAuthAfterSuccessfulBrowserFallback();
        }
        return result;
      } finally {
        await releaseBrowserFallbackAuthCheckSuppression();
      }
    },
    [checkAuthAfterSuccessfulBrowserFallback, releaseBrowserFallbackAuthCheckSuppression],
  );

  const signInWithCredentials = useCallback(
    async (email: string, password: string): Promise<CredentialsSignInResult> => {
      const result = await authSignInWithCredentials(email, password);
      if (result.success) {
        await checkAuth();
      }
      return result;
    },
    [checkAuth],
  );

  // Native registration auto-logs-in. Web registration may instead create the
  // account and require email verification, in which case there is deliberately
  // no session for checkAuth to resolve yet.
  const register = useCallback(
    async (email: string, password: string, name?: string): Promise<RegistrationResult> => {
      const result = await authRegisterWithCredentials(email, password, name);
      if (result.success && result.authenticated !== false) {
        await checkAuth();
      }
      return result;
    },
    [checkAuth],
  );

  // `method` distinguishes a plain Sign Out ('manual') from an account deletion
  // ('account_deleted') in analytics, matching web. The cleanup is identical:
  // server revocation is best-effort, while durable credential cleanup failures
  // remain visible to callers after local account isolation has completed.
  const signOut = useCallback(
    async (method: 'manual' | 'account_deleted' = 'manual') => {
      const credentialGeneration = captureAuthCredentialGeneration();
      const transitionEpoch = beginAuthTransition();
      updateNativeSessionDegraded(false);
      track(SHARED_EVENTS.Logout, { method });
      // BEFORE the drain, not just in `runSignedOutCleanup` further down. The
      // store holds `onlineManager` false while offline mode is on, so the
      // drainer's `if (!options.isOnline()) return;` would bail in microseconds
      // and `purgeLocalDataForSignOut` would then delete the very
      // pending_mutations the confirm dialog promised to try and send. The
      // cleanup call stays where it is for the forced-401 and expiry paths,
      // which never reach this function; a second call is idempotent, so it
      // neither writes the setting nor files a second event.
      setOfflineMode(false, 'sign_out');
      await drainLocalMutationQueueBestEffort();

      // A login in this or another tab supersedes the old account's intent. Do
      // not let a delayed queue drain sign out or clean the newer owner.
      if (!isAuthCredentialGenerationCurrent(credentialGeneration) || !isAuthTransitionCurrent(transitionEpoch)) {
        return;
      }

      // Hide the browser's authenticated tree before the two NextAuth network
      // phases. authSignOutForGeneration synchronously clears the exposed JWE
      // before its first fetch; the remaining durable cookie revocation may be
      // slow or fail without leaving private UI visible.
      if (Platform.OS === 'web') {
        resetHttpClient();
        disposeWsClient();
        pendingAuthTransportRestartRef.current = true;
        setCurrentUserStorageOwner(null);
        authStateRef.current = { ...authStateRef.current, isAuthenticated: false };
        setIsAuthenticated(false);
      }

      let durableSignOutError: unknown;
      let signOutPerformed = false;
      const isolatedCredentialGeneration = credentialGeneration + 1;
      try {
        signOutPerformed = await authSignOutForGeneration(credentialGeneration);
      } catch (error) {
        durableSignOutError = error;
      }

      if (!isAuthTransitionCurrent(transitionEpoch)) {
        if (durableSignOutError) {
          if (method === 'account_deleted') reportError(durableSignOutError);
          throw durableSignOutError;
        }
        return;
      }

      // `false` means another credential owner superseded this request while
      // durable sign-out was in flight. That newer transition owns provider and
      // cache state, so the old request must not run its cleanup. Recheck the
      // isolated generation for errors too: a newer native login can take
      // ownership between SecureStore rejecting and this continuation running.
      const signOutStillOwnsCredentialState = isAuthCredentialGenerationCurrent(isolatedCredentialGeneration);
      if (signOutStillOwnsCredentialState && (signOutPerformed || durableSignOutError)) {
        // The one call site that asks for the full wipe. This is the deliberate,
        // confirmed "I'm done on this device" — both 'manual' (behind
        // useConfirmSignOut's dialog) and 'account_deleted' (behind its own typed
        // DELETE gate) — so the downloaded catalogs go with the rest of the data.
        await enqueueAuthTransition(() =>
          handleSignedOutTransition(transitionEpoch, true, { purgeOfflineBoards: true }),
        );
      }

      if (durableSignOutError) {
        if (method === 'account_deleted') reportError(durableSignOutError);
        // Account deletion cannot silently succeed while native credentials may
        // still survive in SecureStore. Local isolation above is complete, but
        // the failure must remain observable to the caller and error reporting.
        throw durableSignOutError;
      }
    },
    [
      beginAuthTransition,
      drainLocalMutationQueueBestEffort,
      enqueueAuthTransition,
      handleSignedOutTransition,
      isAuthTransitionCurrent,
      updateNativeSessionDegraded,
    ],
  );

  const handleForcedSignOut = useCallback(() => {
    track(SHARED_EVENTS.Logout, { method: 'forced' });
    const transitionEpoch = beginAuthTransition();
    // The interceptor already confirmed this credential owner is anonymous.
    // Serialize its cleanup with session checks so a later login cannot be
    // erased by the tail of an older asynchronous cleanup.
    enqueueAuthTransition(() => handleSignedOutTransition(transitionEpoch, true)).catch(reportError);
  }, [beginAuthTransition, enqueueAuthTransition, handleSignedOutTransition]);

  const handleRemoteConfirmedSignOut = useCallback(() => {
    // The other tab already received a successful durable sign-out response, so
    // no network revalidation is needed. Hide private UI and stop credential-
    // bound transports before any persisted-store cleanup awaits.
    resetHttpClient();
    disposeWsClient();
    setCurrentUserStorageOwner(null);
    authStateRef.current = { ...authStateRef.current, isAuthenticated: false };
    setIsAuthenticated(false);
    const transitionEpoch = beginAuthTransition();
    enqueueAuthTransition(() => handleSignedOutTransition(transitionEpoch, true)).catch(reportError);
  }, [beginAuthTransition, enqueueAuthTransition, handleSignedOutTransition]);

  const handleRemoteAuthInvalidation = useCallback(
    (confirmedIdentityChanged: boolean, invalidateTransports = true) => {
      // Stop transports before any session or storage await. They were created
      // with the invalidated in-memory JWE and must not keep issuing requests while
      // the shared HttpOnly cookie is being revalidated.
      if (invalidateTransports) {
        resetHttpClient();
        disposeWsClient();
        pendingAuthTransportRestartRef.current = true;
      }

      if (confirmedIdentityChanged) {
        // `/api/auth/session` has already proved that this login scope changed.
        // Hide the old account before the replacement bridge token is fetched;
        // an unavailable bridge must never leave the old account tree visible.
        setCurrentUserStorageOwner(null);
        authStateRef.current = { isAuthenticated: false, isLoading: true };
        setIsAuthenticated(false);
        setIsLoading(true);
      }

      // Supersede an in-flight session check or cleanup immediately, including
      // when another remote revalidation loop is already coalescing messages.
      beginAuthTransition();

      remoteInvalidationVersionRef.current += 1;
      if (remoteRevalidationRef.current) return;

      const revalidation = (async () => {
        let handledVersion: number;
        do {
          handledVersion = remoteInvalidationVersionRef.current;
          await checkAuth();
        } while (handledVersion !== remoteInvalidationVersionRef.current);
      })().finally(() => {
        if (remoteRevalidationRef.current === revalidation) remoteRevalidationRef.current = null;
      });
      remoteRevalidationRef.current = revalidation;
      revalidation.catch(reportError);
    },
    [beginAuthTransition, checkAuth],
  );

  // Let the lib-layer 401 interceptor drive the same cleanup. On a failed-refresh
  // 401 it has already revoked + cleared tokens; this flips the provider out of
  // the authenticated UI right away instead of waiting for the next foreground
  // checkAuth. `setOnForcedSignOut` is our own module setter (not React state),
  // so the function value is stored verbatim. Each caller emits its own Logout
  // event so manual vs. server-revoked sign-outs are distinguishable in PostHog.
  useEffect(() => {
    setOnForcedSignOut(handleForcedSignOut);
    return () => setOnForcedSignOut(null);
  }, [handleForcedSignOut]);

  // The HttpOnly session cookie is shared by every browser tab, while each tab
  // owns a separate in-memory backend token and GraphQL client. A remote clear is
  // only an invalidation hint: successful sign-in rotates the same credential
  // generation as logout. Revalidate remote hints against the cookie. A local
  // rotation only tears down its credential-bound WebSocket; its sign-in/out
  // caller owns the subsequent transition. A session-source event means the
  // cookie identity was already confirmed different, so the old tree is hidden.
  useEffect(
    () =>
      subscribeAuthTokenChanges((token, source) => {
        if (source === 'hint') {
          handleRemoteAuthInvalidation(false, false);
          return;
        }
        if (token !== null) return;
        if (source === 'local') {
          if (!pendingAuthTransportRestartRef.current) disposeWsClient();
          pendingAuthTransportRestartRef.current = true;
          return;
        }
        if (source === 'remote-signout') {
          handleRemoteConfirmedSignOut();
          return;
        }
        handleRemoteAuthInvalidation(source === 'session');
      }),
    [handleRemoteAuthInvalidation, handleRemoteConfirmedSignOut],
  );

  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    if (!isLoading) {
      onReadyRef.current?.();
    }
  }, [isLoading]);

  // Stable context value: every callback below is a stable useCallback, so the
  // value reference only changes when isAuthenticated / isLoading actually flip
  // — not on each AuthProvider render. Declared before the early returns so the
  // hook order stays unconditional.
  const value = useMemo<AuthState>(
    () => ({
      isAuthenticated,
      isLoading,
      signInWithApple,
      signInWithGoogle,
      signInWithGoogleWeb,
      signInWithAppleWeb,
      signInWithCredentials,
      register,
      signOut,
      refreshAuthState: checkAuth,
    }),
    [
      isAuthenticated,
      isLoading,
      signInWithApple,
      signInWithGoogle,
      signInWithGoogleWeb,
      signInWithAppleWeb,
      signInWithCredentials,
      register,
      signOut,
      checkAuth,
    ],
  );

  if (isLoading) {
    // Not `null`: on web there's no native splash to cover a blank render, so
    // returning nothing here leaves the page white until the session round-trip
    // resolves (~2s cold). Paint the splash placeholder instead — instant FCP on
    // web. AppLoadingSplash renders nothing on native, where expo-splash-screen
    // owns this window and draws the mark at its own size. Redirect/auth logic
    // below is unchanged; it only runs once the session has actually resolved.
    return <AppLoadingSplash />;
  }

  const inAuthGroup = segments[0] === 'auth';
  const inSessionUnavailableRoute = segments.join('/') === 'auth/session-unavailable';

  if (isSessionUnavailable && !inSessionUnavailableRoute) {
    return <Redirect href="/auth/session-unavailable" />;
  }
  if (!isSessionUnavailable && inSessionUnavailableRoute) {
    return <Redirect href={isAuthenticated ? '/(tabs)/home' : '/auth/login'} />;
  }

  // Web only: the canonical board URLs the Next front door links into render for
  // a signed-out visitor instead of bouncing them to a login wall that loses the
  // climb they arrived for. The route itself then hands off to login carrying the
  // path (see BoardRouteRedirect). Native resolves anonymous-auth-gate to the
  // inert fork — `isAnonymousReadOnlyLocation()` is a constant `false` and
  // `readPostLoginReturnHref()` a constant `null` — so both branches below are
  // exactly what ships today on the store fleet. Asserted by test, because this
  // change auto-OTAs to every installed binary.
  if (!isAuthenticated && !inAuthGroup && !isAnonymousReadOnlyLocation()) {
    return <Redirect href="/auth/login" />;
  }
  if (isAuthenticated && inAuthGroup) {
    return <Redirect href={readPostLoginReturnHref() ?? '/(tabs)/home'} />;
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
