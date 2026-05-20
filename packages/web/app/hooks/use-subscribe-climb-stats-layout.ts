'use client';

import { useContext, useEffect } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { createGraphQLClient, subscribe, type ExtendedClient } from '@/app/components/graphql-queue/graphql-client';
import { getBackendWsUrl } from '@/app/lib/backend-url';
import {
  CLIMB_STATS_UPDATED_SUBSCRIPTION,
  type ClimbStatsUpdatedSubscriptionResponse,
} from '@/app/lib/graphql/operations';
import type { BoardName } from '@/app/lib/types';
import { useWsAuthToken } from './use-ws-auth-token';
import { setLiveClimbStats } from './use-climb-stats-live';

/**
 * Module-scoped shared GraphQL-WS client. The hook is now mounted once per
 * board-layout page (inside `BoardProvider`), not per row, so a single
 * client suffices per browser tab. The cache is keyed by `(url, token)`
 * because the climb-stats subscription is auth-gated on the backend — a
 * different user's auth token needs a fresh client.
 */
type SharedEntry = {
  client: ExtendedClient;
  refCount: number;
  url: string;
  token: string;
};

let shared: SharedEntry | null = null;

type Acquired = {
  client: ExtendedClient;
  /** The entry that was current at acquire time. `release` decrements
   *  *this* entry, not `shared`, so a URL/token change between acquire
   *  and release doesn't leave the new client's refCount permanently off. */
  entry: SharedEntry;
};

function acquire(token: string): Acquired | null {
  if (typeof window === 'undefined') return null;
  const url = getBackendWsUrl();
  if (!url) return null;

  if (shared && shared.url === url && shared.token === token) {
    shared.refCount += 1;
    return { client: shared.client, entry: shared };
  }

  // URL or token changed — tear down and recreate.
  if (shared) {
    void shared.client.dispose();
    shared = null;
  }

  const client = createGraphQLClient({
    url,
    authToken: token,
    connectionName: 'climb-stats',
  });
  shared = { client, refCount: 1, url, token };
  return { client, entry: shared };
}

function release(acquired: Acquired) {
  // Only mutate the entry we captured. If `shared` has since been swapped
  // (URL/token change disposed the old one and pointed `shared` at a new
  // one), our refCount on the captured entry is moot — the dispose call
  // already happened.
  const entry = acquired.entry;
  entry.refCount -= 1;
  if (entry === shared && entry.refCount <= 0) {
    void entry.client.dispose();
    shared = null;
  }
}

/**
 * Subscribe to `climbStatsUpdated` for a board layout. Mount once at the
 * page level (inside `BoardProvider` when both `boardName` and `layoutId`
 * are present). The single subscription receives stat updates for every
 * climb on that layout; each event carries `climbUuid` + `angle` so the
 * hook can route it into the matching live-stats cache entry.
 *
 * Auth-gated: anonymous users get an early return and rely on local
 * optimistic deltas. The shared WS client connects with the user's
 * Boardsesh auth token so the backend resolver's auth check passes.
 *
 * No-ops when `boardName`/`layoutId` are missing, when no
 * `QueryClientProvider` wraps the tree (tests), when the user isn't
 * authenticated, or when no auth token is available yet.
 */
export function useSubscribeClimbStatsLayout(boardName: BoardName | undefined, layoutId: number | undefined | null) {
  // Read the QueryClient via context — same rationale as
  // `useClimbStatsLive`: gracefully no-op in test envs without a provider.
  const queryClient = useContext(QueryClientContext);
  const { token, isAuthenticated } = useWsAuthToken();

  useEffect(() => {
    if (!queryClient || !boardName || typeof layoutId !== 'number') return;
    if (!isAuthenticated || !token) return;

    const acquired = acquire(token);
    if (!acquired) return;

    const unsub = subscribe<ClimbStatsUpdatedSubscriptionResponse>(
      acquired.client,
      {
        query: CLIMB_STATS_UPDATED_SUBSCRIPTION,
        variables: { boardType: boardName, layoutId },
      },
      {
        next: (data) => {
          const event = data?.climbStatsUpdated;
          if (!event) return;
          // The event carries the climbUuid + angle this update applies
          // to. Route into the matching cache entry; every visible
          // ClimbTitle reading `(boardName, event.climbUuid, event.angle)`
          // via `useEffectiveClimbStats` re-renders.
          setLiveClimbStats(queryClient, boardName, event.climbUuid, event.angle, {
            ascensionistCount: event.ascensionistCount,
            qualityAverage: event.qualityAverage,
            difficultyAverage: event.difficultyAverage,
            displayDifficulty: event.displayDifficulty,
          });
        },
        error: (err) => {
          // Don't surface — stale stats just means missed live bumps. The
          // next page render still reads the canonical numbers from the
          // server cache.
          console.error('[climbStats] subscription error:', err);
        },
        complete: () => {
          // Server-side close or client unsubscribe. Cache survives gc time.
        },
      },
    );

    return () => {
      unsub();
      release(acquired);
    };
  }, [boardName, layoutId, token, isAuthenticated, queryClient]);
}
