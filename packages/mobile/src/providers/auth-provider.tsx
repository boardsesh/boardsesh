import { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { useSegments, Redirect } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { getAuthToken, isTokenExpiringSoon } from '../lib/auth-store';
import {
  signInWithApple as authSignInWithApple,
  signInWithGoogle as authSignInWithGoogle,
  signInWithGoogleWeb as authSignInWithGoogleWeb,
  signInWithAppleWeb as authSignInWithAppleWeb,
  signOut as authSignOut,
  signInWithCredentials as authSignInWithCredentials,
  registerWithCredentials as authRegisterWithCredentials,
  type CredentialsSignInResult,
  type OAuthSignInResult,
} from '../lib/auth';
import { SCREENSHOT_USER_EMAIL, SCREENSHOT_USER_PASSWORD } from '../lib/screenshot-mode';
import { reset as resetAnalytics, track } from '../lib/analytics';
import { reportError } from '../lib/error-reporting';
import { setOnForcedSignOut } from '../lib/auth-interceptor';
import { resetHttpClient } from '../lib/graphql/client';
import { disposeWsClient } from '../lib/graphql/ws-client';
import { clearStoredSessionId } from '../lib/session-store';
import { clearStoredActiveBoard } from '../lib/active-board-store';
import { ACTIVE_BOARD_QUERY_KEY } from '../lib/graphql/use-active-board';

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
  register: (email: string, password: string, name?: string) => Promise<CredentialsSignInResult>;
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
  // These are the only sign-out leftovers that can carry a previous user across
  // a cold start on a shared device, so a signed-out checkAuth clears them even
  // when there's no live in-session cache to wipe (see handleSignedOutTransition).
  const clearPersistedUserStores = useCallback(
    () => Promise.allSettled([clearStoredSessionId(), clearStoredActiveBoard()]),
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
      await clearPersistedUserStores();
      setIsAuthenticated(false);
    }
  }, [runSignedOutCleanup, clearPersistedUserStores, resetAnalyticsForSignedOutTransition]);

  const checkAuth = useCallback(async () => {
    try {
      const token = await getAuthToken();
      if (!token) {
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
            const screenshotSignIn = await authSignInWithCredentials(SCREENSHOT_USER_EMAIL, SCREENSHOT_USER_PASSWORD);
            if (screenshotSignIn.success) {
              console.info('[screenshot] auto sign-in succeeded; rendering straight into home');
              setIsAuthenticated(true);
              return;
            }
            console.warn(
              `[screenshot] auto sign-in FAILED — status=${screenshotSignIn.status ?? 'null'} error=${screenshotSignIn.error}` +
                ` (emailLen=${SCREENSHOT_USER_EMAIL.length} passwordLen=${SCREENSHOT_USER_PASSWORD.length})`,
            );
          } else {
            console.warn(
              `[screenshot] auto sign-in SKIPPED — credentials not inlined into the bundle` +
                ` (emailSet=${Boolean(SCREENSHOT_USER_EMAIL)} passwordSet=${Boolean(SCREENSHOT_USER_PASSWORD)})`,
            );
          }
        }
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

  // Registration auto-logs-in: the backend returns a JWT pair, so on success we
  // re-run checkAuth — which flips isAuthenticated and lets the auth-group
  // Redirect carry the user into the app, exactly like signInWithCredentials.
  const register = useCallback(
    async (email: string, password: string, name?: string): Promise<CredentialsSignInResult> => {
      const result = await authRegisterWithCredentials(email, password, name);
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

  if (!isAuthenticated && !inAuthGroup) {
    return <Redirect href="/auth/login" />;
  }
  if (isAuthenticated && inAuthGroup) {
    return <Redirect href="/(tabs)/home" />;
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
