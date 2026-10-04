'use client';

import { useQuery } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';

type WsAuthResponse = {
  token: string | null;
  authenticated: boolean;
  userId?: string;
  authSessionId?: string;
  error?: string;
};

async function fetchWsAuthToken(): Promise<WsAuthResponse> {
  const response = await fetch('/api/internal/ws-auth');
  if (!response.ok) {
    throw new Error(`Failed to fetch auth token: ${response.status}`);
  }
  return response.json();
}

/**
 * Hook to get a WebSocket authentication token from the server.
 * Uses TanStack Query for deduplication and caching — all callers
 * share a single fetch via the shared query key.
 *
 * Keys tokens by both the account and login identity so another account or
 * a new login cannot reuse a still-fresh token from a previous session.
 */
export function useWsAuthToken(enabled = true) {
  const { data: session, status } = useSession();
  const sessionUserId = session?.user?.id ?? null;
  const authSessionId = session?.authSessionId ?? null;

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['wsAuthToken', status, sessionUserId, authSessionId],
    queryFn: async () => {
      const result = await fetchWsAuthToken();
      // A logged-in NextAuth session must yield a token. A null here is a
      // transient cookie/endpoint hiccup, not a genuine "anonymous" — throw so
      // React Query retries with backoff instead of caching null forever.
      // Caching null strands the persistent-session WebSocket on
      // `authToken: null`: it connects the session anonymously, so every
      // reconnect becomes a fresh connection-keyed participant (a ghost) and
      // inflates the crew/peer count into a false "party".
      if (status === 'authenticated' && (!result.token || !result.authenticated)) {
        throw new Error('ws-auth returned no token for an authenticated session');
      }
      if (
        result.authenticated &&
        (status !== 'authenticated' ||
          !sessionUserId ||
          result.userId !== sessionUserId ||
          (result.authSessionId ?? null) !== authSessionId)
      ) {
        throw new Error('ws-auth returned a token for a different session identity');
      }
      return result;
    },
    // The NextAuth JWT is long-lived, but revalidate periodically and on
    // focus/reconnect so a transient failure self-heals. When the token value
    // is unchanged this is a no-op; only a null→token recovery tears down and
    // reconnects the socket (persistent-session-context) — now authenticated.
    staleTime: 5 * 60_000,
    retry: 3,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    enabled: enabled && status !== 'loading',
  });

  let errorMessage: string | null;
  if (error) {
    errorMessage = error instanceof Error ? error.message : 'Unknown error';
  } else {
    errorMessage = data?.error ?? null;
  }

  return {
    token: enabled ? (data?.token ?? null) : null,
    isAuthenticated: enabled ? (data?.authenticated ?? false) : false,
    isLoading: enabled && (isLoading || status === 'loading'),
    error: enabled ? errorMessage : null,
    refetch,
  };
}
