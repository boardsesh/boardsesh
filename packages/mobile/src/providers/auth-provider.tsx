import { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback, type ReactNode } from 'react';
import { AppState, Platform } from 'react-native';
import { useSegments, Redirect } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { resolveAuthSession } from '../lib/auth-session';
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
import { reportError } from '../lib/error-reporting';
import { setOnForcedSignOut } from '../lib/auth-interceptor';
import { getHttpClient, resetHttpClient } from '../lib/graphql/client';
import { disposeWsClient } from '../lib/graphql/ws-client';
import { clearStoredSessionId } from '../lib/session-store';
import { clearStoredActiveBoard } from '../lib/active-board-store';
import { clearStoredQueueSnapshot } from '../lib/queue-snapshot-store';
import { clearAllCreateClimbDrafts } from '../lib/create-climb-draft-store';
import { clearSessionCommentDraft } from '../lib/session-comment-draft-store';
import { setCurrentUserStorageOwner, type UserStorageOwner } from '../lib/user-storage-owner';
import { ACTIVE_BOARD_QUERY_KEY } from '../lib/graphql/use-active-board';
import { clearUserData, getDatabaseHandle } from '../db';
import { setSetting } from '../settings';
import { getPendingCount, setSigningOut } from '@boardsesh/offline-sync';
import { drainMutationQueue } from '../offline/offline-sync-adapter';
import { stopTokenManagement } from '../notifications';

type AuthState = {
  isAuthenticated: boolean;
  isLoading: boolean;
  signInWithApple: () => Promise<OAuthSignInResult>;
  signInWithGoogle: () => Promise<OAuthSignInResult>;
  // Browser-OAuth fallback for when native Google sign-in can't present (iOS 26.5.1).
  signInWithGoogleWeb: () => Promise<OAuthSignInResult>;
  // Browser-OAuth fallback for when native Sign in with Apple throws (code 1000).
  signInWithAppleWeb: () => Promise<OAuthSignInResult>;
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
    }
  }, []);

  // Persisted (SecureStore/AsyncStorage-backed) per-user state that outlives a
  // relaunch. allSettled (not all) so one failing delete can't abort the rest.
  // These are the only sign-out leftovers that can carry a previous user across
  // a cold start on a shared device, so a signed-out checkAuth clears them even
  // when there's no live in-session cache to wipe (see handleSignedOutTransition).
  const clearPersistedUserStores = useCallback(
    (owner?: UserStorageOwner | null) =>
      Promise.allSettled([
        clearStoredSessionId(owner),
        clearStoredActiveBoard(owner),
        clearStoredQueueSnapshot(owner),
        // Create-climb and session-recap drafts are wiped for account
        // isolation only on web (the new surface). Native sign-out keeps its
        // origin behavior and leaves these drafts intact, so shipping this via
        // OTA doesn't change what a native sign-out touches.
        ...(Platform.OS === 'web' ? [clearAllCreateClimbDrafts(owner), clearSessionCommentDraft(owner)] : []),
      ]),
    [],
  );

  const drainLocalMutationQueueBestEffort = useCallback(async () => {
    const localDb = getDatabaseHandle();
    if (!localDb) return;

    try {
      // Gated on the queue being non-empty, NOT on the offline feature flag:
      // writes queued while the flag was on must still flush after a rollback.
      // With an empty queue (every flag-off user) this is one local COUNT and
      // sign-out proceeds immediately, as pre-offline.
      const pendingCount = await getPendingCount(localDb);
      if (pendingCount === 0) return;

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

  const clearLocalOfflineUserData = useCallback(async () => {
    const localDb = getDatabaseHandle();
    if (!localDb) return;

    setSigningOut(true);
    try {
      await clearUserData(localDb);
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
  const runSignedOutCleanup = useCallback(
    async (transitionEpoch: number, storageOwner?: UserStorageOwner | null): Promise<boolean> => {
      if (!isAuthTransitionCurrent(transitionEpoch)) return false;
      resetAnalytics();
      const stopTokenCleanup = stopTokenManagement(async () => {});
      if (Platform.OS === 'web') await waitForCleanupPhase(stopTokenCleanup);
      else await stopTokenCleanup;
      if (!isAuthTransitionCurrent(transitionEpoch)) return false;
      const persistedStoreCleanup = clearPersistedUserStores(storageOwner);
      if (Platform.OS === 'web') await waitForCleanupPhase(persistedStoreCleanup);
      else await persistedStoreCleanup;
      if (!isAuthTransitionCurrent(transitionEpoch)) return false;
      const offlineUserDataCleanup = clearLocalOfflineUserData();
      if (Platform.OS === 'web') await waitForCleanupPhase(offlineUserDataCleanup);
      else await offlineUserDataCleanup;
      if (!isAuthTransitionCurrent(transitionEpoch)) return false;
      // Reset the per-user "downloaded boards" list so the next account on a shared
      // device doesn't inherit the previous user's offline selection. The cached board
      // rows + checkpoints survive (clearUserData preserves them), so if the next user
      // enables the same board the download resumes instantly.
      setSetting('syncEnabledBoards', []);
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
    async (transitionEpoch: number, forceFullCleanup = false): Promise<boolean> => {
      if (!isAuthTransitionCurrent(transitionEpoch)) return false;
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
        completed = await runSignedOutCleanup(transitionEpoch, previousStorageOwner);
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
    [clearPersistedUserStores, isAuthTransitionCurrent, resetAnalyticsForSignedOutTransition, runSignedOutCleanup],
  );

  const handleAuthenticatedTransition = useCallback(
    async (transitionEpoch: number, authSession: { userId?: string; authSessionId?: string }): Promise<boolean> => {
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
      return true;
    },
    [isAuthTransitionCurrent, runSignedOutCleanup],
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
        if (authSession.status === 'unavailable') {
          // A browser network outage is not a confirmed logout: preserve an
          // already-rendered web session, or show the retry route on cold start.
          // Native keychain failures retain their established policy below.
          reportError(authSession.error);
          if (Platform.OS !== 'web') {
            // Preserve native behavior for transient keychain failures: release
            // the current UI without running confirmed-sign-out cleanup, then
            // retry the keychain when the app becomes active again.
            setIsAuthenticated(false);
            setIsSessionUnavailable(false);
          } else {
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
                    console.info('[screenshot] auto sign-in succeeded; rendering straight into home');
                    await handleAuthenticatedTransition(transitionEpoch, screenshotSession);
                  } else if (screenshotSession.status === 'unavailable') {
                    reportError(screenshotSession.error);
                    setIsSessionUnavailable(true);
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
        await handleAuthenticatedTransition(transitionEpoch, authSession);
      } catch (authCheckError) {
        if (!isAuthTransitionCurrent(transitionEpoch)) return;
        // resolveAuthSession normally converts transport/storage errors into the
        // unavailable result above. Keep this final guard so an unexpected error
        // still releases the loading gate without clearing a potentially valid
        // persisted session.
        reportError(authCheckError);
        if (Platform.OS !== 'web') {
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
    [handleAuthenticatedTransition, handleSignedOutTransition, isAuthTransitionCurrent, runSignedOutCleanup],
  );

  const checkAuth = useCallback((): Promise<void> => {
    const transitionEpoch = beginAuthTransition();
    return enqueueAuthTransition(() => checkAuthForTransition(transitionEpoch));
  }, [beginAuthTransition, checkAuthForTransition, enqueueAuthTransition]);

  useEffect(() => {
    // Belt-and-braces: checkAuth already resolves its own rejections, but keep
    // the invocation from producing an unhandled rejection if that ever changes.
    void checkAuth();
  }, [checkAuth]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      if (nextAppState === 'active') {
        void checkAuth();
      }
    });
    return () => subscription.remove();
  }, [checkAuth]);

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

  // Browser-based Google fallback (native SDK can't present the OAuth browser on
  // iOS 26.5.1). Same success contract as the native flow: re-run checkAuth so the
  // provider flips to the authenticated UI.
  const signInWithGoogleWeb = useCallback(async (): Promise<OAuthSignInResult> => {
    const result = await authSignInWithGoogleWeb();
    if (result.success) {
      await checkAuth();
    }
    return result;
  }, [checkAuth]);

  // Browser-based Apple fallback (native Sign in with Apple threw a non-cancel
  // error). Same success contract as the native flow: re-run checkAuth so the
  // provider flips to the authenticated UI.
  const signInWithAppleWeb = useCallback(async (): Promise<OAuthSignInResult> => {
    const result = await authSignInWithAppleWeb();
    if (result.success) {
      await checkAuth();
    }
    return result;
  }, [checkAuth]);

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
      track(SHARED_EVENTS.Logout, { method });
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
        await enqueueAuthTransition(() => handleSignedOutTransition(transitionEpoch, true));
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
    return null;
  }

  const inAuthGroup = segments[0] === 'auth';
  const inSessionUnavailableRoute = segments.join('/') === 'auth/session-unavailable';

  if (isSessionUnavailable && !inSessionUnavailableRoute) {
    return <Redirect href="/auth/session-unavailable" />;
  }
  if (!isSessionUnavailable && inSessionUnavailableRoute) {
    return <Redirect href={isAuthenticated ? '/(tabs)/home' : '/auth/login'} />;
  }

  if (!isAuthenticated && !inAuthGroup) {
    return <Redirect href="/auth/login" />;
  }
  if (isAuthenticated && inAuthGroup) {
    return <Redirect href="/(tabs)/home" />;
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
