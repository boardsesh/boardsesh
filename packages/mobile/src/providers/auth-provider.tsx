import { createContext, useContext, useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import { useSegments, Redirect } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { getAuthToken, isTokenExpiringSoon } from '../lib/auth-store';
import {
  startSignIn,
  signOut as authSignOut,
  signInWithCredentials as authSignInWithCredentials,
  type AuthProvider as AuthProviderType,
  type CredentialsSignInResult,
} from '../lib/auth';
import { resetHttpClient } from '../lib/graphql/client';
import { disposeWsClient } from '../lib/graphql/ws-client';
import { clearStoredSessionId } from '../lib/session-store';
import { clearStoredBoardConfig } from '../lib/board-store';
import { getDatabaseHandle, clearUserData } from '../db';
import { drainMutationQueue, setSigningOut } from '../mutation-queue';
import { getHttpClient } from '../lib/graphql/client';
import { stopTokenManagement } from '../notifications';

type AuthState = {
  isAuthenticated: boolean;
  isLoading: boolean;
  signIn: (provider: AuthProviderType) => Promise<void>;
  signInWithCredentials: (email: string, password: string) => Promise<CredentialsSignInResult>;
  signOut: () => Promise<void>;
  refreshAuthState: () => Promise<void>;
};

// Upper bound on the best-effort queue flush during sign-out. Long enough for a
// healthy backend to drain a handful of mutations, short enough that a flaky
// network can't stall the user from getting out.
const SIGN_OUT_DRAIN_TIMEOUT_MS = 3000;

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

  const checkAuth = useCallback(async () => {
    const token = await getAuthToken();
    if (!token) {
      setIsAuthenticated(false);
      setIsLoading(false);
      return;
    }
    const expiring = await isTokenExpiringSoon();
    if (expiring) {
      const { ensureFreshToken } = await import('../lib/auth-interceptor');
      const refreshed = await ensureFreshToken();
      setIsAuthenticated(refreshed);
    } else {
      setIsAuthenticated(true);
    }
    setIsLoading(false);
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  const signIn = useCallback(async (provider: AuthProviderType) => {
    await startSignIn(provider);
  }, []);

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

  const signOut = useCallback(async () => {
    await authSignOut();
    await Promise.all([clearStoredSessionId(), clearStoredBoardConfig()]);

    // Account lifecycle (I11): tear down the APNs token-refresh listener so it
    // can't re-register against the now-stale session, and wipe this user's local
    // data so the next account on the device starts clean. Both are best-effort —
    // a failure here must not block sign-out (the user still needs to get out).
    // No session-scoped unregister exists at this layer, so pass a no-op; the
    // point is cancelling the listener, not a server-side token delete.
    try {
      await stopTokenManagement(async () => {});
    } catch (error) {
      if (__DEV__) {
        console.warn('[Auth] stopTokenManagement during sign-out failed:', error);
      }
    }

    const db = getDatabaseHandle();
    if (db) {
      // Last-ditch flush: the backend is usually up, so give the queue one
      // bounded chance to reach the server before we wipe it. This is purely
      // best-effort — it must never hang sign-out, so we race it against a short
      // timeout and swallow any error. Runs BEFORE the signing-out guard so it
      // isn't blocked by it.
      try {
        const graphqlFetch = (query: string, variables?: Record<string, unknown>) =>
          getHttpClient().request(query, variables);
        await Promise.race([
          drainMutationQueue(db, queryClient, graphqlFetch),
          new Promise<void>((resolve) => setTimeout(resolve, SIGN_OUT_DRAIN_TIMEOUT_MS)),
        ]);
      } catch (error) {
        if (__DEV__) {
          console.warn('[Auth] best-effort drain during sign-out failed:', error);
        }
      }

      // Block any scheduler-/listener-triggered drain from racing the wipe, then
      // clear local user data. Anything still queued (offline, or it didn't
      // flush in time) is discarded with the local rows — documented
      // account-lifecycle behaviour, not silent data loss. The guard is always
      // cleared, even on failure, so a later sign-in's drain isn't stuck off.
      setSigningOut(true);
      try {
        await clearUserData(db);
      } catch (error) {
        if (__DEV__) {
          console.warn('[Auth] clearUserData during sign-out failed:', error);
        }
      } finally {
        setSigningOut(false);
      }
    }

    resetHttpClient();
    disposeWsClient();
    setIsAuthenticated(false);
  }, [queryClient]);

  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    if (!isLoading) {
      onReadyRef.current?.();
    }
  }, [isLoading]);

  if (isLoading) {
    return null;
  }

  const inAuthGroup = segments[0] === 'auth';

  if (!isAuthenticated && !inAuthGroup) {
    return <Redirect href="/auth/login" />;
  }
  if (isAuthenticated && inAuthGroup) {
    return <Redirect href="/(tabs)/boards" />;
  }

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated,
        isLoading,
        signIn,
        signInWithCredentials,
        signOut,
        refreshAuthState: checkAuth,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
