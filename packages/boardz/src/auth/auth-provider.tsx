import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { onSignedOut, signInWithPassword, signOut, type SignInResult } from '../api/auth-session';
import { graphqlRequest } from '../api/graphql-client';
import { GET_PROFILE, type GetProfileResponse, type Profile } from '../api/profile';
import { readTokens } from '../api/token-store';

type AuthStatus = 'loading' | 'signedOut' | 'signedIn';

type AuthContextValue = {
  status: AuthStatus;
  /** The signed-in climber, once their profile has loaded. */
  profile: Profile | null;
  signIn: (email: string, password: string) => Promise<SignInResult>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AuthStatus>('loading');

  useEffect(() => {
    let cancelled = false;
    readTokens()
      .then((tokens) => {
        if (!cancelled) setStatus(tokens ? 'signedIn' : 'signedOut');
      })
      .catch(() => {
        if (!cancelled) setStatus('signedOut');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The backend rejected the session (revoked or expired refresh token).
  useEffect(
    () =>
      onSignedOut(() => {
        queryClient.clear();
        setStatus('signedOut');
      }),
    [queryClient],
  );

  const profileQuery = useQuery({
    queryKey: ['profile'],
    queryFn: async () => (await graphqlRequest<GetProfileResponse>(GET_PROFILE)).profile,
    enabled: status === 'signedIn',
    staleTime: 5 * 60 * 1000,
  });

  const value: AuthContextValue = {
    status,
    profile: status === 'signedIn' ? (profileQuery.data ?? null) : null,
    signIn: async (email, password) => {
      const result = await signInWithPassword(email, password);
      if (result.ok) {
        queryClient.clear();
        setStatus('signedIn');
      }
      return result;
    },
    signOut: async () => {
      await signOut();
      queryClient.clear();
      setStatus('signedOut');
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
