import { createContext, useContext, useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
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
