'use client';

import { useInfiniteQuery, type InfiniteData } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { useSession } from 'next-auth/react';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { GET_MY_GYMS, type GetMyGymsQueryResponse, type GetMyGymsQueryVariables } from '@boardsesh/graphql/operations';
import type { Gym, GymConnection } from '@boardsesh/shared-schema';

/**
 * Fetches the gyms the current user owns OR holds a gym_members row on
 * (admin/editor/member) via GraphQL — the `myGyms` resolver unions owned +
 * membership, so a climber granted editor/admin sees the gym here and the
 * role-chip logic lights up from each gym's `myRole`.
 * Gyms are fetched when `enabled` becomes true and the user is authenticated.
 *
 * Built on `useInfiniteQuery` so the homepage card and the My Gyms drawer share a
 * single cache entry per viewer — opening the drawer after the homepage has
 * already resolved reuses the cached first page instead of refetching.
 *
 * Call `loadMore` to fetch the next page; `hasMore` indicates whether more pages
 * exist. Mirrors {@link import('./use-my-boards').useMyBoards}'s shape so the My
 * Gyms drawer follows the same load/paginate/error contract as My Boards.
 *
 * `hasResolved` is the definitive "we know the answer" signal: it stays false
 * while the ws-auth token is still in flight (the query is `enabled: false`
 * with no cached data), so callers can gate a variant decision on it instead of
 * misreading "not loading yet" as "loaded with zero gyms" — see home-gym-card.tsx.
 */
export function useMyGyms(enabled: boolean, limit = 50) {
  const { token, isAuthenticated } = useWsAuthToken();
  const { data: session } = useSession();
  // Scope the cache entry to the viewer so an in-session login/logout can't
  // serve the previous user's gyms from the query cache.
  const viewerUserId = session?.user?.id ?? 'anonymous';

  // The query key is deliberately NOT keyed on `token`: the ws-auth JWT is
  // re-minted on its own ~5min revalidation cycle (see use-ws-auth-token.ts)
  // even when the signed-in user hasn't changed, and gyms data has no reason
  // to change alongside it — keying on it would re-fetch the whole gyms list
  // on every silent token refresh. Same convention as InsightsTab's gymStats
  // query. `queryFn` still closes over the latest `token` on every actual
  // fetch, so a genuine token rotation is never used stale.
  const query = useInfiniteQuery<
    GymConnection,
    Error,
    InfiniteData<GymConnection>,
    readonly ['myGyms', string, number],
    number
  >({
    queryKey: ['myGyms', viewerUserId, limit] as const,
    queryFn: async ({ pageParam }) => {
      // `enabled` guards `token` being non-null whenever this actually runs;
      // narrow explicitly so a future `createGraphQLHttpClient` signature
      // change can't silently accept a null token.
      if (!token) throw new Error('useMyGyms: queryFn ran without a token');
      const client = createGraphQLHttpClient(token);
      const response = await client.request<GetMyGymsQueryResponse, GetMyGymsQueryVariables>(GET_MY_GYMS, {
        input: { limit, offset: pageParam },
      });
      return response.myGyms;
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, _allPages, lastPageParam) => {
      if (!lastPage.hasMore) return undefined;
      return lastPageParam + lastPage.gyms.length;
    },
    enabled: enabled && isAuthenticated && !!token,
    staleTime: 60 * 1000,
  });

  const gyms: Gym[] = useMemo(() => query.data?.pages.flatMap((page) => page.gyms) ?? [], [query.data]);

  const { fetchNextPage } = query;
  const loadMore = useCallback(() => {
    void fetchNextPage();
  }, [fetchNextPage]);

  return {
    gyms,
    isLoading: query.isPending,
    isFetchingMore: query.isFetchingNextPage,
    hasMore: query.hasNextPage ?? false,
    loadMore,
    error: query.isError ? 'Failed to load your gyms' : null,
    // True once the first fetch attempt has settled (success or error) — false
    // while disabled (no token yet) or genuinely in flight for the first time.
    hasResolved: query.isFetched,
  };
}
