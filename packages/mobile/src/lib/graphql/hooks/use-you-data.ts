import { useQuery, useInfiniteQuery } from '@tanstack/react-query';
import {
  GET_USER_TICKS,
  GET_USER_PROFILE_STATS,
  GET_USER_CLIMB_PERCENTILE,
  GET_USER_ASCENTS_FEED,
  GET_USER_ASCENT_CAPTION_MATCHES,
  GET_ACTIVITY_FEED,
  GET_SESSION_GROUPED_FEED,
  type GetUserTicksQueryResponse,
  type GetUserProfileStatsQueryResponse,
  type GetUserClimbPercentileQueryResponse,
  type GetUserAscentsFeedQueryResponse,
  type GetUserAscentsFeedQueryVariables,
  type GetUserAscentCaptionMatchesQueryResponse,
  type GetUserAscentCaptionMatchesQueryVariables,
  type GetActivityFeedQueryResponse,
  type GetSessionGroupedFeedQueryResponse,
} from '@boardsesh/graphql/operations';
import { BOARD_TYPES, type LogbookEntry } from '@boardsesh/profile-stats';
import type { ActivityFeedInput } from '@boardsesh/shared-schema';
import { getHttpClient } from '../client';

const PROFILE_STALE_TIME_MS = 30 * 1000;
const FEED_PAGE_SIZE = 20;

// Normalise a `userTicks` row into the @boardsesh/profile-stats LogbookEntry
// shape (snake_case `climbed_at`, `tries`), matching web's ticksQuery mapper.
function toLogbookEntry(tick: GetUserTicksQueryResponse['userTicks'][number], boardType: string): LogbookEntry {
  return {
    climbed_at: tick.climbedAt,
    difficulty: tick.difficulty,
    effectiveDifficulty: tick.effectiveDifficulty ?? null,
    tries: tick.attemptCount,
    angle: tick.angle,
    status: tick.status,
    layoutId: tick.layoutId,
    boardType,
    climbUuid: tick.climbUuid,
  };
}

/**
 * All of a user's ticks across every supported board, keyed by board type —
 * the input `deriveProfileViewModel` expects. Shares the `['userTicks', userId]`
 * key prefix that `useSaveTick`/`useUpdateTick`/`useDeleteTick` invalidate.
 */
export function useAllBoardsTicks(userId: string | undefined) {
  return useQuery({
    queryKey: ['userTicks', userId],
    queryFn: async () => {
      const client = getHttpClient();
      const collected: Record<string, LogbookEntry[]> = {};
      await Promise.all(
        BOARD_TYPES.map(async (boardType) => {
          const response = await client.request<GetUserTicksQueryResponse>(GET_USER_TICKS, { userId, boardType });
          collected[boardType] = response.userTicks.map((tick) => toLogbookEntry(tick, boardType));
        }),
      );
      return collected;
    },
    enabled: !!userId,
    staleTime: PROFILE_STALE_TIME_MS,
  });
}

export function useUserProfileStats(userId: string | undefined) {
  return useQuery({
    queryKey: ['userProfileStats', userId],
    queryFn: async () => {
      const response = await getHttpClient().request<GetUserProfileStatsQueryResponse>(GET_USER_PROFILE_STATS, {
        userId,
      });
      return response.userProfileStats;
    },
    enabled: !!userId,
    staleTime: PROFILE_STALE_TIME_MS,
  });
}

export function useUserClimbPercentile(userId: string | undefined) {
  return useQuery({
    queryKey: ['userClimbPercentile', userId],
    queryFn: async () => {
      const response = await getHttpClient().request<GetUserClimbPercentileQueryResponse>(GET_USER_CLIMB_PERCENTILE, {
        userId,
      });
      return response.userClimbPercentile;
    },
    enabled: !!userId,
    staleTime: PROFILE_STALE_TIME_MS,
  });
}

/** Paginated logbook (ascents) feed for the Logbook tab. */
export function useUserAscentsFeed(userId: string | undefined, input?: GetUserAscentsFeedQueryVariables['input']) {
  return useInfiniteQuery({
    queryKey: ['userAscentsFeed', userId, input],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      getHttpClient().request<GetUserAscentsFeedQueryResponse>(GET_USER_ASCENTS_FEED, {
        userId,
        // Spread caller input first so the paginator's limit/offset always win.
        input: { ...input, limit: FEED_PAGE_SIZE, offset: pageParam },
      }),
    getNextPageParam: (lastPage, allPages) =>
      lastPage.userAscentsFeed.hasMore
        ? allPages.reduce((total, page) => total + page.userAscentsFeed.items.length, 0)
        : undefined,
    enabled: !!userId,
  });
}

/**
 * Whole-logbook caption matches for the share-beta picker. The backend matches
 * the shared reel's caption against the user's entire logbook of sends/flashes
 * and returns full ascent rows (with board art) for the matched climbs — so a
 * climb older than the recent feed page still gets suggested. Disabled until a
 * non-empty caption is available.
 */
export function useAscentCaptionMatches(userId: string | undefined, caption: string | null | undefined) {
  const trimmedCaption = caption?.trim() ?? '';
  return useQuery({
    queryKey: ['ascentCaptionMatches', userId, trimmedCaption],
    queryFn: async () => {
      const response = await getHttpClient().request<
        GetUserAscentCaptionMatchesQueryResponse,
        GetUserAscentCaptionMatchesQueryVariables
      >(GET_USER_ASCENT_CAPTION_MATCHES, { userId: userId!, caption: trimmedCaption });
      return response.userAscentCaptionMatches;
    },
    enabled: !!userId && trimmedCaption.length > 0,
    staleTime: PROFILE_STALE_TIME_MS,
  });
}

/** Session-grouped activity feed for the Sessions tab (cursor-paginated). */
export function useSessionGroupedFeed(input?: ActivityFeedInput, enabled = true) {
  return useInfiniteQuery({
    queryKey: ['sessionGroupedFeed', input],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      getHttpClient().request<GetSessionGroupedFeedQueryResponse>(GET_SESSION_GROUPED_FEED, {
        input: { limit: FEED_PAGE_SIZE, ...input, cursor: pageParam },
      }),
    getNextPageParam: (lastPage) =>
      lastPage.sessionGroupedFeed.hasMore ? (lastPage.sessionGroupedFeed.cursor ?? undefined) : undefined,
    enabled,
  });
}

/** Itemized home activity feed for people and setters the viewer follows. */
export function useActivityFeed(input?: ActivityFeedInput, enabled = true) {
  return useInfiniteQuery({
    queryKey: ['activityFeed', input],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      getHttpClient().request<GetActivityFeedQueryResponse>(GET_ACTIVITY_FEED, {
        input: { limit: FEED_PAGE_SIZE, ...input, cursor: pageParam },
      }),
    getNextPageParam: (lastPage) =>
      lastPage.activityFeed.hasMore ? (lastPage.activityFeed.cursor ?? undefined) : undefined,
    enabled,
  });
}
