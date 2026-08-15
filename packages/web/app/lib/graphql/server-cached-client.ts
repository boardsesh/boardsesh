import 'server-only';
import { unstable_cache } from 'next/cache';
import { type RequestDocument, type Variables, GraphQLClient } from 'graphql-request';
import { sortObjectKeys } from '@/app/lib/cache-utils';
import { getGraphQLHttpUrl } from './client';
import type { DiscoverablePlaylist, DiscoverPlaylistsQueryResponse } from '@boardsesh/graphql/operations/playlists';
import type {
  GetUserClimbPercentileQueryResponse,
  GetUserProfileStatsQueryResponse,
  GetUserTicksQueryResponse,
} from '@boardsesh/graphql/operations/ticks';

// Re-export uncached authenticated server functions so existing imports
// from this file continue to work without changes.
export { serverMyBoards, serverUserPlaylists, serverPlaylist, serverPlaylistClimbs } from './server-graphql';

export const USER_CLIMB_PERCENTILE_CACHE_TAG = 'user-climb-percentile';

/**
 * Execute a GraphQL query via HTTP (non-cached version for internal use).
 * Pass `signal` to enforce a deadline via `AbortController`.
 */
export async function executeGraphQLInternal<T = unknown, V extends Variables = Variables>(
  document: RequestDocument,
  variables?: V,
  signal?: AbortSignal,
): Promise<T> {
  const url = getGraphQLHttpUrl();
  const client = new GraphQLClient(url, {
    headers: {
      'Content-Type': 'application/json',
    },
    signal,
  });

  return client.request<T>(document, variables);
}

/**
 * Create a stable cache key from GraphQL variables
 * Recursively sorts all object keys to ensure consistent key generation
 */
function createCacheKeyFromVariables(variables: Variables | undefined): string[] {
  if (!variables) return ['no-variables'];

  // Recursively sort all keys for stable JSON representation
  const sortedVariables = sortObjectKeys(variables);
  return [JSON.stringify(sortedVariables)];
}

/**
 * Execute a cached GraphQL query for server-side rendering
 *
 * Uses Next.js unstable_cache to cache results at the data cache layer.
 * This ensures repeated requests with the same parameters return cached data.
 *
 * @param document - GraphQL query document
 * @param variables - Query variables
 * @param cacheTag - Tag for cache invalidation (e.g., 'climb-search')
 * @param revalidate - Cache duration in seconds
 * @param timeoutMs - Optional wall-clock ceiling. Without one a wedged backend
 *   hangs the caller indefinitely; `graphql-request` honours the signal, so the
 *   call rejects with an abort error the caller can degrade on.
 */
export function createCachedGraphQLQuery<T = unknown, V extends Variables = Variables>(
  document: RequestDocument,
  cacheTag: string,
  revalidate: number,
  timeoutMs?: number,
) {
  return async (variables?: V): Promise<T> => {
    const cachedFn = unstable_cache(
      async () => {
        if (!timeoutMs) {
          return executeGraphQLInternal<T, V>(document, variables);
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          return await executeGraphQLInternal<T, V>(document, variables, controller.signal);
        } finally {
          clearTimeout(timer);
        }
      },
      ['graphql', cacheTag, ...createCacheKeyFromVariables(variables)],
      {
        revalidate,
        tags: [cacheTag],
      },
    );

    return cachedFn();
  };
}

/**
 * Server-side cached fetch of discover playlists (public, no auth needed).
 *
 * Surfaces per-stream `hasMore` + `totalCount` so the client hook can seed
 * pagination state without firing a redundant first request.
 */
export async function cachedDiscoverPlaylists(input: { boardType?: string; layoutId?: number } = {}): Promise<{
  popular: DiscoverablePlaylist[];
  recent: DiscoverablePlaylist[];
  popularHasMore: boolean;
  recentHasMore: boolean;
  popularTotalCount: number;
  recentTotalCount: number;
} | null> {
  const { DISCOVER_PLAYLISTS } = await import('@boardsesh/graphql/operations/playlists');
  type Response = DiscoverPlaylistsQueryResponse;

  try {
    const popularQuery = createCachedGraphQLQuery<Response>(
      DISCOVER_PLAYLISTS,
      'discover-playlists-popular',
      300, // 5 min cache
    );
    const recentQuery = createCachedGraphQLQuery<Response>(DISCOVER_PLAYLISTS, 'discover-playlists-recent', 300);

    const [popularRes, recentRes] = await Promise.all([
      popularQuery({ input: { ...input, pageSize: 10, sortBy: 'popular' } }),
      recentQuery({ input: { ...input, pageSize: 10, sortBy: 'recent' } }),
    ]);

    return {
      popular: popularRes.discoverPlaylists.playlists,
      recent: recentRes.discoverPlaylists.playlists,
      popularHasMore: popularRes.discoverPlaylists.hasMore,
      recentHasMore: recentRes.discoverPlaylists.hasMore,
      popularTotalCount: popularRes.discoverPlaylists.totalCount,
      recentTotalCount: recentRes.discoverPlaylists.totalCount,
    };
  } catch {
    return null;
  }
}

/**
 * Cached server-side fetch of user profile stats (public, no auth needed).
 */
export async function cachedUserProfileStats(
  userId: string,
): Promise<GetUserProfileStatsQueryResponse['userProfileStats'] | null> {
  const { GET_USER_PROFILE_STATS } = await import('@boardsesh/graphql/operations/ticks');
  type Response = GetUserProfileStatsQueryResponse;

  try {
    const tag = `user-profile-stats-${userId}`;
    const query = createCachedGraphQLQuery<Response>(GET_USER_PROFILE_STATS, tag, 300);
    const result = await query({ userId });
    return result.userProfileStats;
  } catch {
    return null;
  }
}

/**
 * Uncached server-side fetch of user profile stats. Used by /you (the user's
 * own dashboard) where freshly-logged ticks must appear immediately rather
 * than waiting on the cache TTL.
 */
export async function serverUserProfileStats(
  userId: string,
): Promise<GetUserProfileStatsQueryResponse['userProfileStats'] | null> {
  const { GET_USER_PROFILE_STATS } = await import('@boardsesh/graphql/operations/ticks');
  try {
    const result = await executeGraphQLInternal<GetUserProfileStatsQueryResponse>(GET_USER_PROFILE_STATS, { userId });
    return result.userProfileStats;
  } catch {
    return null;
  }
}

/**
 * Cached server-side fetch of user climb percentile (public, no auth needed).
 */
export async function cachedUserClimbPercentile(
  userId: string,
): Promise<GetUserClimbPercentileQueryResponse['userClimbPercentile'] | null> {
  const { GET_USER_CLIMB_PERCENTILE } = await import('@boardsesh/graphql/operations/ticks');
  type Response = GetUserClimbPercentileQueryResponse;

  try {
    const query = createCachedGraphQLQuery<Response>(
      GET_USER_CLIMB_PERCENTILE,
      USER_CLIMB_PERCENTILE_CACHE_TAG,
      604800,
    );
    const result = await query({ userId });
    return result.userClimbPercentile;
  } catch {
    return null;
  }
}

/**
 * Cached server-side fetch of user ticks for a specific board type (public, no auth needed).
 */
export async function cachedUserTicks(
  userId: string,
  boardType: string,
): Promise<GetUserTicksQueryResponse['userTicks'] | null> {
  const { GET_USER_TICKS } = await import('@boardsesh/graphql/operations/ticks');
  type Response = GetUserTicksQueryResponse;

  try {
    const tag = `user-ticks-${userId}-${boardType}`;
    const query = createCachedGraphQLQuery<Response>(GET_USER_TICKS, tag, 300);
    const result = await query({ userId, boardType });
    return result.userTicks;
  } catch {
    return null;
  }
}

/**
 * Uncached counterpart of {@link cachedUserTicks} for /you. Logging a tick
 * must show up on the user's own dashboard immediately.
 */
export async function serverUserTicks(
  userId: string,
  boardType: string,
): Promise<GetUserTicksQueryResponse['userTicks'] | null> {
  const { GET_USER_TICKS } = await import('@boardsesh/graphql/operations/ticks');
  try {
    const result = await executeGraphQLInternal<GetUserTicksQueryResponse>(GET_USER_TICKS, { userId, boardType });
    return result.userTicks;
  } catch {
    return null;
  }
}
