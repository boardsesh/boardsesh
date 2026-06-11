import { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { useSegments, Redirect } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { getAuthToken, isTokenExpiringSoon } from '../lib/auth-store';
import {
  signInWithApple as authSignInWithApple,
  signInWithGoogle as authSignInWithGoogle,
  signOut as authSignOut,
  signInWithCredentials as authSignInWithCredentials,
  type CredentialsSignInResult,
  type OAuthSignInResult,
} from '../lib/auth';
import { reset as resetAnalytics, track } from '../lib/analytics';
import { reportError } from '../lib/sentry';
import { setOnForcedSignOut } from '../lib/auth-interceptor';
import { resetHttpClient } from '../lib/graphql/client';
import { disposeWsClient } from '../lib/graphql/ws-client';
import { clearStoredSessionId } from '../lib/session-store';
import { clearStoredActiveBoard, clearStoredAuthenticatedActiveBoard } from '../lib/active-board-store';
import { ACTIVE_BOARD_QUERY_KEY } from '../lib/graphql/use-active-board';

type AuthState = {
  isAuthenticated: boolean;
  isLoading: boolean;
  signInWithApple: () => Promise<OAuthSignInResult>;
  signInWithGoogle: () => Promise<OAuthSignInResult>;
  signInWithCredentials: (email: string, password: string) => Promise<CredentialsSignInResult>;
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

export function AuthProvider({ children, onReady }: AuthProviderProps) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const segments = useSegments();
  const queryClient = useQueryClient();
  const authStateRef = useRef({ isAuthenticated: false, isLoading: true });
  authStateRef.current = { isAuthenticated, isLoading };

  const resetAnalyticsForSignedOutTransition = useCallback(() => {
    const authState = authStateRef.current;
    if (authState.isLoading || authState.isAuthenticated) {
      resetAnalytics();
    }
  }, []);

  // Persisted (SecureStore/AsyncStorage-backed) per-user state that outlives a
  // relaunch. allSettled (not all) so one failing delete can't abort the rest.
  // The active board is user-scoped during an authenticated session, so real
  // auth transitions clear it. A logged-out cold start preserves deliberately
  // local guest boards, but still clears any real board left behind by a prior
  // authenticated user.
  const clearPersistedUserStores = useCallback(
    () => Promise.allSettled([clearStoredSessionId(), clearStoredActiveBoard()]),
    [],
  );
  const clearSignedOutLaunchStores = useCallback(
    () => Promise.allSettled([clearStoredSessionId(), clearStoredAuthenticatedActiveBoard()]),
    [],
  );

  // The shared signed-out cleanup, used by the manual `signOut`, the
  // interceptor's forced sign-out (failed-refresh 401), and checkAuth's
  // proactive expiry path. It deliberately omits the two caller-specific steps:
  // the manual `Logout` analytics event, and `authSignOut()` (the token revoke +
  // clear) — the forced/expiry paths' token is already revoked, so running it
  // here would double-revoke.
  const runSignedOutCleanup = useCallback(async () => {
    resetAnalytics();
    await clearPersistedUserStores();
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
    setIsAuthenticated(false);
  }, [clearPersistedUserStores, queryClient]);

  // checkAuth lands here when a token read/refresh shows the session is gone. If
  // we were authenticated this session, run the full cleanup (cache + clients are
  // live). Otherwise — a logged-out cold start / relaunch — the cache is empty
  // and the clients are null, so only the persisted stores can carry a prior
  // user forward; clear those. Gating the heavy cleanup on the transition keeps a
  // normal logged-out launch from churning an empty cache. Both branches flip
  // isAuthenticated → false, so checkAuth doesn't repeat it.
  const handleSignedOutTransition = useCallback(async () => {
    if (authStateRef.current.isAuthenticated) {
      await runSignedOutCleanup();
    } else {
      resetAnalyticsForSignedOutTransition();
      await clearSignedOutLaunchStores();
      setIsAuthenticated(false);
    }
  }, [runSignedOutCleanup, clearSignedOutLaunchStores, resetAnalyticsForSignedOutTransition]);

  const checkAuth = useCallback(async () => {
    try {
      const token = await getAuthToken();
      if (!token) {
        await handleSignedOutTransition();
        return;
      }
      const expiring = await isTokenExpiringSoon();
      if (expiring) {
        const { ensureFreshToken } = await import('../lib/auth-interceptor');
        const refreshed = await ensureFreshToken();
        if (!refreshed) {
          await handleSignedOutTransition();
          return;
        }
      }
      setIsAuthenticated(true);
    } catch (authCheckError) {
      // SecureStore.getItemAsync REJECTS (not returns null) when the keychain
      // is inaccessible — a background launch before first unlock, or an
      // undecryptable entry after an Android backup restore. Without this catch
      // the rejection escapes, isLoading never clears, onReady never fires, and
      // the splash screen hangs forever. Treat a read failure as logged-out so
      // the loading gate always releases. Do NOT clear tokens: a later
      // successful read (the AppState 'active' re-check below) restores auth.
      reportError(authCheckError);
      setIsAuthenticated(false);
    } finally {
      setIsLoading(false);
    }
  }, [handleSignedOutTransition]);

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

  // `method` distinguishes a plain Sign Out ('manual') from an account deletion
  // ('account_deleted') in analytics, matching web. The cleanup is identical:
  // authSignOut()'s revoke is best-effort (src/lib/auth.ts), so revoking a token
  // whose session was just deleted server-side won't block local cleanup.
  const signOut = useCallback(
    async (method: 'manual' | 'account_deleted' = 'manual') => {
      track(SHARED_EVENTS.Logout, { method });
      await authSignOut();
      await runSignedOutCleanup();
    },
    [runSignedOutCleanup],
  );

  // Let the lib-layer 401 interceptor drive the same cleanup. On a failed-refresh
  // 401 it has already revoked + cleared tokens; this flips the provider out of
  // the authenticated UI right away instead of waiting for the next foreground
  // checkAuth. `setOnForcedSignOut` is our own module setter (not React state),
  // so the function value is stored verbatim. Each caller emits its own Logout
  // event so manual vs. server-revoked sign-outs are distinguishable in PostHog.
  useEffect(() => {
    setOnForcedSignOut(() => {
      track(SHARED_EVENTS.Logout, { method: 'forced' });
      // runSignedOutCleanup swallows store-clear failures internally; report any
      // unexpected rejection rather than letting it become an unhandled one.
      runSignedOutCleanup().catch(reportError);
    });
    return () => setOnForcedSignOut(null);
  }, [runSignedOutCleanup]);

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
      signInWithCredentials,
      signOut,
      refreshAuthState: checkAuth,
    }),
    [isAuthenticated, isLoading, signInWithApple, signInWithGoogle, signInWithCredentials, signOut, checkAuth],
  );

  if (isLoading) {
    return null;
  }

  const inAuthGroup = segments[0] === 'auth';

  if (isAuthenticated && inAuthGroup) {
    return <Redirect href="/(tabs)/climbs" />;
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
