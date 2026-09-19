import 'server-only';
import { unstable_cache } from 'next/cache';
import { type RequestDocument, type Variables, GraphQLClient } from 'graphql-request';
import { sortObjectKeys } from '@/app/lib/cache-utils';
import { compactErrorMessage } from '@/app/lib/observability/compact-error';
import { getGraphQLHttpUrl } from './client';
import type { DiscoverablePlaylist, DiscoverPlaylistsQueryResponse } from '@boardsesh/graphql/operations/playlists';
import type { GetCommunityStatsQueryResponse } from '@boardsesh/graphql/operations';
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
        try {
          if (!timeoutMs) {
            return await executeGraphQLInternal<T, V>(document, variables);
          }
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          try {
            return await executeGraphQLInternal<T, V>(document, variables, controller.signal);
          } finally {
            clearTimeout(timer);
          }
        } catch (error) {
          // Next's `unstable_cache` console.errors the WHOLE rejection itself
          // during stale-while-revalidate — a call site inside next/dist we
          // cannot intercept. Rethrowing a compact error here bounds the SIZE
          // of that unavoidable log event (a graphql-request ClientError or a
          // DrizzleQueryError otherwise embeds the whole query/SQL). Every
          // consumer of this function already catches and degrades without
          // inspecting the error's shape, and `unstable_cache` never caches a
          // rejection, so failure semantics are unchanged — only the log size
          // shrinks.
          throw new Error(compactErrorMessage(error));
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
/**
 * The two numbers the hero quotes. Cached for five minutes and fail-soft: the
 * homepage must render with or without them, and the copy has a no-count sibling
 * for exactly that. Never call this without the cache — it aggregates over an
 * events table, not a materialised row.
 */
export async function cachedCommunityStats(): Promise<{
  climbersLast30Days: number;
  litLast30Days: number;
} | null> {
  const { GET_COMMUNITY_STATS } = await import('@boardsesh/graphql/operations');
  type Response = GetCommunityStatsQueryResponse;

  try {
    const query = createCachedGraphQLQuery<Response>(GET_COMMUNITY_STATS, 'community-stats', 300);
    const result = await query({});
    const { climbersLast30Days, litLast30Days } = result.communityStats;
    // A zero is not a number worth printing: it reads as "nobody uses this"
    // rather than "we could not ask", which is what it actually means.
    if (climbersLast30Days <= 0 || litLast30Days <= 0) return null;
    return { climbersLast30Days, litLast30Days };
  } catch {
    return null;
  }
}

/** How many cards each section server-renders. */
const CURATED_PAGE_SIZE = 12;
const COMMUNITY_PAGE_SIZE = 24;

/**
 * The two streams `/playlists` shows: the nightly-rebuilt cohort lists, and the
 * playlists climbers actually kept.
 *
 * They are two queries rather than one sorted list because they are two
 * different claims. The cohort lists are generated and say so; the community
 * ones are climbers' own and are ranked by how many people pinned or followed
 * them. Mixing them would mean the page either lies about one or ranks them
 * against each other on a signal only one of them can have.
 *
 * The community band (5..150 climbs) is what keeps one-climb scratch lists and
 * 600-climb exports off the page — see the discover resolver for why that has to
 * be a HAVING.
 */
export async function cachedCommunityPlaylists(viewerId?: string | null): Promise<{
  curated: DiscoverablePlaylist[];
  community: DiscoverablePlaylist[];
  communityTotalCount: number;
} | null> {
  const { DISCOVER_PLAYLISTS } = await import('@boardsesh/graphql/operations/playlists');
  type Response = DiscoverPlaylistsQueryResponse;

  try {
    const curatedQuery = createCachedGraphQLQuery<Response>(DISCOVER_PLAYLISTS, 'discover-playlists-curated', 300);
    // The viewer id is part of the community query, so it cannot share a cache
    // entry with everyone else's. Signed-out visitors — every crawler, and most
    // first-time readers — still hit one warm entry.
    const communityTag = viewerId ? `discover-playlists-community-${viewerId}` : 'discover-playlists-community';
    const communityQuery = createCachedGraphQLQuery<Response>(DISCOVER_PLAYLISTS, communityTag, 300);

    const [curatedRes, communityRes] = await Promise.all([
      curatedQuery({
        input: { pageSize: CURATED_PAGE_SIZE, sortBy: 'popular', generatedRecommendation: true },
      }),
      communityQuery({
        input: {
          pageSize: COMMUNITY_PAGE_SIZE,
          sortBy: 'popular',
          generatedRecommendation: false,
          minClimbs: 5,
          maxClimbs: 150,
          ...(viewerId ? { excludeCreatorIds: [viewerId] } : {}),
        },
      }),
    ]);

    return {
      curated: curatedRes.discoverPlaylists.playlists,
      community: communityRes.discoverPlaylists.playlists,
      communityTotalCount: communityRes.discoverPlaylists.totalCount,
    };
  } catch {
    return null;
  }
}

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
