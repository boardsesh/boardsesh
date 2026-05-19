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
import { setLiveClimbStats } from './use-climb-stats-live';

// Module-scoped shared GraphQL-WS client. Per-row subscriptions all
// multiplex over this single connection rather than opening N sockets.
// climbStatsUpdated is a public subscription (no auth gate on the
// backend) so the client connects anonymously — this also lets the hook
// mount inside components tested without a SessionProvider.
type SharedEntry = {
  client: ExtendedClient;
  refCount: number;
  url: string;
};

let shared: SharedEntry | null = null;

function acquire(): ExtendedClient | null {
  if (typeof window === 'undefined') return null;
  const url = getBackendWsUrl();
  if (!url) return null;

  if (shared && shared.url === url) {
    shared.refCount += 1;
    return shared.client;
  }

  // URL changed (env override) — tear down and recreate.
  if (shared) {
    void shared.client.dispose();
    shared = null;
  }

  const client = createGraphQLClient({
    url,
    connectionName: 'climb-stats',
  });
  shared = { client, refCount: 1, url };
  return client;
}

function release(client: ExtendedClient) {
  if (!shared || shared.client !== client) return;
  shared.refCount -= 1;
  if (shared.refCount <= 0) {
    void shared.client.dispose();
    shared = null;
  }
}

/**
 * Subscribe to `climbStatsUpdated` for a single (boardName, climbUuid, angle).
 *
 * Mounts inside `ClimbTitle` (and any other surface that displays climb
 * stats). Each subscription writes incoming events into the live-stats
 * React Query cache via {@link setLiveClimbStats}; the display hook
 * (`useEffectiveClimbStats`) reads from there.
 *
 * When any of `boardName`/`climbUuid`/`angle` is missing the hook is a
 * no-op so legacy call sites that don't thread those fields through stay
 * silent. Unmount automatically tears the subscription down (and disposes
 * the shared WS client when the last subscriber leaves).
 */
export function useSubscribeClimbStatsUpdates(
  boardName: BoardName | undefined,
  climbUuid: string | undefined,
  angle: number | undefined,
) {
  // Read the QueryClient via context so the hook stays a no-op in test
  // environments that don't set up a QueryClientProvider — same rationale
  // as `useClimbStatsLive`.
  const queryClient = useContext(QueryClientContext);

  useEffect(() => {
    if (!queryClient || !boardName || !climbUuid || typeof angle !== 'number') return;

    const client = acquire();
    if (!client) return;

    const unsub = subscribe<ClimbStatsUpdatedSubscriptionResponse>(
      client,
      {
        query: CLIMB_STATS_UPDATED_SUBSCRIPTION,
        variables: { boardType: boardName, climbUuid, angle },
      },
      {
        next: (data) => {
          const event = data?.climbStatsUpdated;
          if (!event) return;
          setLiveClimbStats(queryClient, boardName, climbUuid, angle, {
            ascensionistCount: event.ascensionistCount,
            qualityAverage: event.qualityAverage,
            difficultyAverage: event.difficultyAverage,
            displayDifficulty: event.displayDifficulty,
          });
        },
        error: (err) => {
          // Don't surface to the user — stale stats just means we miss
          // the live bump for this climb. The next page render still
          // sees the canonical numbers from the server cache.
          console.error('[climbStats] subscription error:', err);
        },
        complete: () => {
          // Subscription ended (server-side close or client unsubscribe).
          // Nothing to do — the React Query cache entry stays put until gc.
        },
      },
    );

    return () => {
      unsub();
      release(client);
    };
  }, [boardName, climbUuid, angle, queryClient]);
}
