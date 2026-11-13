'use client';

import { useQuery } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { useSyncExternalStore } from 'react';
import {
  readBrowserBackendSessionScope,
  browserBackendSessionKey,
} from '@boardsesh/auth-protocol/browser-backend-session';
import { browserBackendClient } from '@/app/lib/auth/browser-backend-client';

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
  const observation = readBrowserBackendSessionScope(session ?? null);
  const owner = observation.status === 'selected' ? observation.owner : null;
  const selectedKey = owner ? browserBackendSessionKey(owner) : null;
  // A terminal refusal or another accepted account retires the receipt before
  // this hook can return an earlier positive query result to its callers.
  useSyncExternalStore(
    browserBackendClient.subscribe,
    browserBackendClient.getSnapshot,
    browserBackendClient.getSnapshot,
  );

  const { data, isLoading, error } = useQuery({
    queryKey: ['wsAuthToken', status, sessionUserId, authSessionId, ...(selectedKey ? [selectedKey] : [])],
    queryFn: async (): Promise<WsAuthResponse> => {
      if (owner) {
        const lease = await browserBackendClient.acquire(owner);
        const scope = browserBackendClient.capture(lease.token);
        if (!scope) throw new Error('Selected browser session changed');
        browserBackendClient.assertCurrent(scope, lease);
        return {
          token: lease.token,
          authenticated: true,
          userId: owner.userId,
          authSessionId: owner.authSessionId,
        };
      }
      if (observation.status === 'anonymous' && browserBackendClient.isSelected() && status === 'unauthenticated')
        return { token: null, authenticated: false };
      if (observation.status === 'invalid' || browserBackendClient.isSelected())
        throw new Error('Selected browser session is unavailable');
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
    staleTime: selectedKey ? 0 : 5 * 60_000,
    refetchInterval: selectedKey ? 15_000 : false,
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
    token:
      enabled && (!selectedKey || (data?.token && browserBackendClient.capture(data.token)))
        ? (data?.token ?? null)
        : null,
    isAuthenticated:
      enabled && (!selectedKey || (data?.token && browserBackendClient.capture(data.token)))
        ? (data?.authenticated ?? false)
        : false,
    isLoading: enabled && (isLoading || status === 'loading'),
    error: enabled ? errorMessage : null,
  };
}
