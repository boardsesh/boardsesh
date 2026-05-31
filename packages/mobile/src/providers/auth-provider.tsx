import { createContext, useContext, useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import { useSegments, Redirect } from 'expo-router';
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
import { stopTokenManagement } from '../notifications';

type AuthState = {
  isAuthenticated: boolean;
  isLoading: boolean;
  signIn: (provider: AuthProviderType) => Promise<void>;
  signInWithCredentials: (email: string, password: string) => Promise<CredentialsSignInResult>;
  signOut: () => Promise<void>;
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

    try {
      // Discards any not-yet-synced pending mutations along with local user data —
      // documented account-lifecycle behaviour, not a silent data loss.
      const db = getDatabaseHandle();
      if (db) {
        await clearUserData(db);
      }
    } catch (error) {
      if (__DEV__) {
        console.warn('[Auth] clearUserData during sign-out failed:', error);
      }
    }

    resetHttpClient();
    disposeWsClient();
    setIsAuthenticated(false);
  }, []);

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
