import {
  useQuery,
  useInfiniteQuery,
  useQueryClient,
  QueryObserver,
  type QueryKey,
  type QueryFunctionContext,
} from '@tanstack/react-query';
import {
  GET_USER_TICKS,
  GET_USER_TICK_COUNTS_BY_BOARD,
  GET_USER_PROFILE_STATS,
  GET_USER_CLIMB_PERCENTILE,
  GET_USER_ASCENTS_FEED,
  GET_USER_GROUPED_ASCENTS_FEED,
  GET_USER_ASCENT_CAPTION_MATCHES,
  GET_ACTIVITY_FEED,
  GET_SESSION_GROUPED_FEED,
  type GetUserTicksQueryResponse,
  type GetUserTickCountsByBoardQueryResponse,
  type GetUserProfileStatsQueryResponse,
  type GetUserClimbPercentileQueryResponse,
  type GetUserAscentsFeedQueryResponse,
  type GetUserGroupedAscentsFeedQueryResponse,
  type GetUserAscentsFeedQueryVariables,
  type GetUserAscentCaptionMatchesQueryResponse,
  type GetUserAscentCaptionMatchesQueryVariables,
  type GetActivityFeedQueryResponse,
  type GetSessionGroupedFeedQueryResponse,
} from '@boardsesh/graphql/operations';
import { BOARD_TYPES, type LogbookEntry } from '@boardsesh/profile-stats';
import type { ActivityFeedInput } from '@boardsesh/shared-schema';
import { getHttpClient } from '../client';
import { createHttpOperation, type HttpOperation } from '../http-operation';
import { useHttpQueryScope } from '../use-http-query-scope';

type FiniteYouQuery<Result> = {
  queryKey: QueryKey;
  queryFn: (operation: HttpOperation) => Promise<Result>;
  enabled: boolean;
  staleTime: number;
  refetchOnWindowFocus?: false;
};

/** This finite family needs the full operation's exact-error assertion after
 * its fanout settles. Its data is HTTP-only; no local result can mint a cause. */
function useFiniteYouQuery<Result>({ queryKey, queryFn, enabled, ...behavior }: FiniteYouQuery<Result>) {
  const scope = useHttpQueryScope();
  const client = useQueryClient();
  const execute = async (context: QueryFunctionContext<QueryKey>, assertIntent?: () => void) => {
    assertIntent?.();
    scope.assertView();
    // Do not even read the signal getter in native/wholly legacy mode: the
    // original finite reads kept completing after their observer unmounted.
    const operation = createHttpOperation(scope.scope, scope.scoped ? { signal: context.signal } : undefined);
    try {
      assertIntent?.();
      operation.assertView();
      const result = await queryFn(operation);
      operation.assertDeliveries();
      return result;
    } catch (error: unknown) {
      // Only this same invocation's exact authentic error can survive the
      // physical settlement barrier. Unknown/stale selected errors refuse.
      if (scope.scoped) operation.assertErrorDeliveries(error);
      throw error;
    } finally {
      // All finite physical work has settled. No retained page/updater receipt
      // is issued by this helper, unlike the separate paginated source API.
      operation.dispose();
    }
  };
  const original = {
    ...behavior,
    queryKey: scope.key(queryKey),
    queryFn: execute,
    enabled: enabled && scope.isReady(),
  };
  const result = useQuery<Result>(original);
  const refetchOriginal = async (assertIntent?: () => void) => {
    assertIntent?.();
    scope.assertView();
    const fixed = new QueryObserver<Result>(client, {
      ...original,
      queryFn: (context) => execute(context, assertIntent),
      // Query.fetch snapshots this behavior before cache fetch events. A
      // reentrant render can replace shared Query.options.queryFn, but cannot
      // erase this invocation's original intent from the retryer's fetchFn.
      behavior: {
        onFetch(context) {
          const fetchOriginal = context.fetchFn;
          context.fetchFn = () => {
            assertIntent?.();
            scope.assertView();
            return fetchOriginal();
          };
        },
      },
      enabled: false,
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchInterval: false,
    });
    // Never subscribe this temporary observer. Destroying it must not remove
    // the last shared observer and cancel somebody else's request.
    try {
      assertIntent?.();
      scope.assertView();
      const pending = fixed.refetch({ throwOnError: false });
      let held = false;
      let refusal: unknown;
      try {
        assertIntent?.();
        scope.assertView();
      } catch (error) {
        held = true;
        refusal = error;
      }
      const observed = await pending;
      if (held) throw refusal;
      assertIntent?.();
      scope.assertView();
      return observed;
    } finally {
      fixed.destroy();
    }
  };
  return { ...result, refetchOriginal };
}

const PROFILE_STALE_TIME_MS = 30 * 1000;
const FEED_PAGE_SIZE = 20;

/**
 * Freshness policy for the three You-page reads (the logbook fan-out, profile
 * stats and percentile). One open costs 8 `userTicks` walks of the climber's
 * whole logbook plus 24 profile-stats aggregates, so these refetch only when
 * something says the data changed — never on a timer shorter than 30 minutes,
 * and never just because the app came back to the foreground.
 *
 * What says it changed: a tick save/edit/delete (board-react's tick hooks) and a
 * synced or drained `boardsesh_ticks` row (TABLE_INVALIDATE_KEYS) invalidate
 * these keys. The caller passes `onScreen: false` while the You screen is not
 * on screen, which disables the queries: an invalidation only marks the data
 * stale, and re-enabling on focus refetches it then. So a tick logged from the
 * climb screen is on the You page the moment the climber opens it, without
 * costing the backend a refetch per tick in between.
 *
 * `enabled`, not `subscribed: false`: an unsubscribed query has no observer, so
 * the cache drops it after gcTime (30 min) and the tab comes back to a skeleton
 * instead of the last numbers. A disabled observer keeps the entry alive, the
 * same as the always-mounted tab did before.
 */
const YOU_PAGE_STALE_TIME_MS = 30 * 60 * 1000;

export type YouPageQueryOptions = {
  /** False while the You screen is off screen (see YOU_PAGE_STALE_TIME_MS). Defaults to true. */
  onScreen?: boolean;
};

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
export function useAllBoardsTicks(userId: string | undefined, options?: YouPageQueryOptions) {
  return useFiniteYouQuery({
    queryKey: ['userTicks', userId],
    queryFn: async (operation) => {
      const collected: Record<string, LogbookEntry[]> = {};
      let hasFailure = false;
      let firstError: unknown;
      await Promise.allSettled(
        BOARD_TYPES.map(async (boardType) => {
          try {
            const response = await operation.request<GetUserTicksQueryResponse>(GET_USER_TICKS, { userId, boardType });
            collected[boardType] = response.userTicks.map((tick) => toLogbookEntry(tick, boardType));
          } catch (error: unknown) {
            if (!hasFailure) {
              hasFailure = true;
              firstError = error;
            }
            throw error;
          }
        }),
      );
      // This is chronological first failure, including rejection(undefined),
      // not the first rejected board in array order. No partial map escapes.
      if (hasFailure) throw firstError;
      return collected;
    },
    enabled: !!userId && options?.onScreen !== false,
    staleTime: YOU_PAGE_STALE_TIME_MS,
    refetchOnWindowFocus: false,
  });
}

/**
 * Per-board-type tick counts for a user, as a single grouped aggregate — the
 * input the home-board inference needs (which board type has the most ticks)
 * without pulling every tick per board. One request instead of `useAllBoardsTicks`'
 * 6-7. Returns a `Record<boardType, count>` for O(1) lookups.
 */
export function useUserTickCountsByBoard(userId: string | undefined) {
  return useFiniteYouQuery({
    queryKey: ['userTickCountsByBoard', userId],
    queryFn: async (operation) => {
      const response = await operation.request<GetUserTickCountsByBoardQueryResponse>(GET_USER_TICK_COUNTS_BY_BOARD, {
        userId,
      });
      const counts: Record<string, number> = {};
      for (const row of response.userTickCountsByBoard) {
        counts[row.boardType] = row.count;
      }
      return counts;
    },
    enabled: !!userId,
    staleTime: PROFILE_STALE_TIME_MS,
  });
}

export function useUserProfileStats(userId: string | undefined, options?: YouPageQueryOptions) {
  return useFiniteYouQuery({
    queryKey: ['userProfileStats', userId],
    queryFn: async (operation) => {
      const response = await operation.request<GetUserProfileStatsQueryResponse>(GET_USER_PROFILE_STATS, {
        userId,
      });
      return response.userProfileStats;
    },
    enabled: !!userId && options?.onScreen !== false,
    staleTime: YOU_PAGE_STALE_TIME_MS,
    refetchOnWindowFocus: false,
  });
}

export function useUserClimbPercentile(userId: string | undefined, options?: YouPageQueryOptions) {
  return useFiniteYouQuery({
    queryKey: ['userClimbPercentile', userId],
    queryFn: async (operation) => {
      const response = await operation.request<GetUserClimbPercentileQueryResponse>(GET_USER_CLIMB_PERCENTILE, {
        userId,
      });
      return response.userClimbPercentile;
    },
    enabled: !!userId && options?.onScreen !== false,
    staleTime: YOU_PAGE_STALE_TIME_MS,
    refetchOnWindowFocus: false,
  });
}

/** Paginated logbook (ascents) feed for the Logbook tab. */
export function useUserAscentsFeed(
  userId: string | undefined,
  input?: GetUserAscentsFeedQueryVariables['input'],
  options?: { enabled?: boolean },
) {
  return useInfiniteQuery({
    queryKey: ['userAscentsFeed', userId, input],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      getHttpClient().request<GetUserAscentsFeedQueryResponse>(GET_USER_ASCENTS_FEED, {
        userId,
        // Spread caller input first so the paginator's limit/offset always win.
        input: { ...input, limit: FEED_PAGE_SIZE, offset: pageParam },
      }),
    // Offset from pageParam arithmetic, NOT from summing cached item counts:
    // the optimistic delete strip shrinks cached pages, and a count-derived
    // offset would then re-request (and re-receive) rows the list already has.
    getNextPageParam: (lastPage, _allPages, lastPageParam) =>
      lastPage.userAscentsFeed.hasMore ? lastPageParam + FEED_PAGE_SIZE : undefined,
    enabled: !!userId && (options?.enabled ?? true),
  });
}

/**
 * Paginated (climb, day)-grouped logbook feed — the Logbook tab's data source
 * in date-ordered views, where repeats of a climb collapse to one row. Same
 * input as the flat feed (filters share one backend definition); pagination is
 * at GROUP level, so a day's groups can straddle pages exactly like ticks do
 * (the complete-day rule handles both).
 */
export function useUserGroupedAscentsFeed(
  userId: string | undefined,
  input?: GetUserAscentsFeedQueryVariables['input'],
  options?: { enabled?: boolean },
) {
  return useInfiniteQuery({
    queryKey: ['userGroupedAscentsFeed', userId, input],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      getHttpClient().request<GetUserGroupedAscentsFeedQueryResponse>(GET_USER_GROUPED_ASCENTS_FEED, {
        userId,
        // Spread caller input first so the paginator's limit/offset always win.
        input: { ...input, limit: FEED_PAGE_SIZE, offset: pageParam },
      }),
    // Same pageParam arithmetic as the flat feed: group-strips must not shift
    // the server offset (see the note on useUserAscentsFeed).
    getNextPageParam: (lastPage, _allPages, lastPageParam) =>
      lastPage.userGroupedAscentsFeed.hasMore ? lastPageParam + FEED_PAGE_SIZE : undefined,
    enabled: !!userId && (options?.enabled ?? true),
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
