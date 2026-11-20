'use client';

import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import {
  browserSessionGuard,
  isSessionSuperseded,
  SessionSupersededError,
  sessionViewerKey,
  signedInViewer,
} from '@/app/lib/auth/session-guard';
import { requestWebSessionRefresh } from '@/app/lib/auth/web-session-events';
import {
  accessTokenRefreshInterval,
  accessTokenStaleTime,
  holdsBrowserAccessToken,
  noteAccessTokenRefreshFailed,
  registerAccessTokenRefresher,
  rememberBrowserAccessToken,
  wsAuthTokenLifetime,
} from '@/app/lib/auth/browser-access-token';

type WsAuthResponse = {
  token: string | null;
  authenticated: boolean;
  userId?: string;
  authSessionId?: string;
  /** When the token ends: only the 15-minute browser token has one (`better-auth`). */
  expiresAt?: string;
  /** Seconds left when the server answered: what the refresh is timed by, from receipt. */
  expiresIn?: number;
  error?: string;
};

/** The part of React Query's query the timing reads: the last answer and when it arrived. */
type WsAuthQuery = { readonly state: { readonly data?: WsAuthResponse; readonly dataUpdatedAt: number } };

const LEGACY_STALE_TIME_MS = 5 * 60_000;

/** ws-auth answered 401: the cookie's session ended. The session read decides what the page shows. */
class WsAuthSessionEndedError extends Error {
  constructor() {
    super('Failed to fetch auth token: 401');
    this.name = 'WsAuthSessionEndedError';
  }
}

async function fetchWsAuthToken(): Promise<WsAuthResponse> {
  const response = await fetch('/api/internal/ws-auth');
  if (!response.ok) {
    if (response.status === 401) throw new WsAuthSessionEndedError();
    throw new Error(`Failed to fetch auth token: ${response.status}`);
  }
  return response.json();
}

/**
 * The legacy JWE has no lifetime and keeps five minutes. A browser token goes
 * stale three minutes (plus jitter) before its end, counted from its receipt
 * (`dataUpdatedAt`, which React Query adds this to), and not before the
 * backoff while refreshes fail.
 */
function staleTimeOf(query: WsAuthQuery): number {
  const lifetimeMs = wsAuthTokenLifetime(query.state.data?.expiresIn);
  if (lifetimeMs === undefined) return LEGACY_STALE_TIME_MS;
  return accessTokenStaleTime(query.state.data?.token, lifetimeMs, query.state.dataUpdatedAt);
}

/** Only a browser token is refreshed on a timer: at its stale time, or after the backoff while refreshes fail. */
function refetchIntervalOf(query: WsAuthQuery): number | false {
  const lifetimeMs = wsAuthTokenLifetime(query.state.data?.expiresIn);
  if (lifetimeMs === undefined) return false;
  return accessTokenRefreshInterval(query.state.data?.token, lifetimeMs, query.state.dataUpdatedAt);
}

/** The viewer whose ws-auth answered 401 once already while the session read kept it signed in. */
let sessionEndedAskedFor: string | null = null;

/**
 * Hook to get a WebSocket authentication token from the server.
 * Uses TanStack Query for deduplication and caching — all callers
 * share a single fetch via the shared query key.
 *
 * Keys tokens by both the account and login identity so another account or
 * a new login cannot reuse a still-fresh token from a previous session.
 *
 * Under `AUTH_BROWSER_SESSION_MODE=better-auth` the token lives 15 minutes
 * (#7596 B3b): it is refreshed about three minutes before its end, on focus or
 * `pageshow` once fewer than three minutes remain, and once after the backend
 * refuses it (`browser-access-token.ts`). A socket is keyed and opened by
 * `socketCredentialHandle(token)`, which stays the same while the viewer
 * does, so a refresh does not reopen it. With the mode off it is the token.
 */
export function useWsAuthToken(enabled = true) {
  const { data: session, status } = useSession();
  const sessionUserId = session?.user?.id ?? null;
  const authSessionId = session?.authSessionId ?? null;
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ['wsAuthToken', status, sessionUserId, authSessionId],
    queryFn: async (): Promise<WsAuthResponse> => {
      const guard = browserSessionGuard();
      const generation = guard.capture();
      const expectedViewer = sessionViewerKey(sessionUserId ? signedInViewer(sessionUserId, authSessionId) : null);
      // The session provider may accept a new login before this render or before the response body arrives.
      const assertCurrentLogin = () => {
        const currentViewer = guard.viewerKey();
        if (
          guard.isRetiring() ||
          guard.capture() !== generation ||
          (currentViewer !== undefined && currentViewer !== expectedViewer)
        )
          throw new SessionSupersededError();
      };
      assertCurrentLogin();
      let result: WsAuthResponse;
      try {
        result = await fetchWsAuthToken();
      } catch (fetchError) {
        assertCurrentLogin();
        // Every failed refresh backs off: 30 s, doubling, at most 5 minutes.
        noteAccessTokenRefreshFailed();
        if (fetchError instanceof WsAuthSessionEndedError) {
          // The session read decides. Asked once per login: if it still says
          // signed in, a repeated 401 is a transient fault, not a reason to ask again.
          const asking = `${sessionUserId ?? ''}:${authSessionId ?? ''}`;
          if (sessionEndedAskedFor !== asking) {
            sessionEndedAskedFor = asking;
            requestWebSessionRefresh();
          }
        }
        throw fetchError;
      }
      assertCurrentLogin();
      sessionEndedAskedFor = null;
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
        // The cookie names another login than the page shows: read the session again.
        requestWebSessionRefresh();
        throw new Error('ws-auth returned a token for a different session identity');
      }
      // A closure that keeps this token after the account changes is refused by the guard.
      if (result.token && result.userId) {
        const owner = signedInViewer(result.userId, result.authSessionId);
        guard.rememberToken(result.token, owner);
        rememberBrowserAccessToken(result.token, owner, result.expiresIn);
      }
      return result;
    },
    // The NextAuth JWT is long-lived, but revalidate periodically and on
    // focus/reconnect so a transient failure self-heals. When the token value
    // is unchanged this is a no-op; only a null→token recovery tears down and
    // reconnects the socket (persistent-session-context) — now authenticated.
    // A 15-minute browser token goes stale three minutes before its end, so
    // focus refetches it only then, and the interval refreshes it in time.
    // Both count from when the token arrived, never from the client clock.
    staleTime: staleTimeOf,
    refetchInterval: refetchIntervalOf,
    // A session that ended is the session read's to show; retrying cannot help.
    // While the tab holds a browser token, a failure waits for the backoff
    // above instead of three quick retries.
    retry: (failureCount, retryError) =>
      !isSessionSuperseded(retryError) &&
      !(retryError instanceof WsAuthSessionEndedError) &&
      !holdsBrowserAccessToken() &&
      failureCount < 3,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    enabled: enabled && status !== 'loading',
  });

  useEffect(() => {
    if (!enabled || status === 'loading') return;
    const queryKey = ['wsAuthToken', status, sessionUserId, authSessionId];
    // The tab's one refresh: joins a fetch already in flight instead of cancelling it.
    return registerAccessTokenRefresher(() =>
      queryClient.refetchQueries({ queryKey, exact: true }, { cancelRefetch: false }),
    );
  }, [authSessionId, enabled, queryClient, sessionUserId, status]);

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
  };
}
