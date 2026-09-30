import { useQuery } from '@tanstack/react-query';
import type { LogbookEntry, ProfileStatsData } from '@boardsesh/profile-stats';
import {
  GET_USER_CLIMB_PERCENTILE,
  GET_USER_PROFILE_STATS,
  GET_USER_TICKS,
  GET_USER_TICK_COUNTS_BY_BOARD,
  type GetUserClimbPercentileQueryResponse,
  type GetUserProfileStatsQueryResponse,
  type GetUserTickCountsByBoardQueryResponse,
  type GetUserTicksQueryResponse,
} from '@boardsesh/graphql/operations/ticks';
import { graphqlRequest } from '../api/graphql-client';

const PROFILE_STALE_MS = 5 * 60 * 1000;

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
 * The climber's ticks on every board they've logged on, keyed by board type,
 * plus Boardsesh's lifetime stats. Asks which boards have ticks first, so a
 * MoonBoard-only climber costs one ticks request rather than one per board type.
 */
export function useProfileData(userId: string | undefined) {
  const boardsQuery = useQuery({
    queryKey: ['userTickCountsByBoard', userId],
    queryFn: async () =>
      (await graphqlRequest<GetUserTickCountsByBoardQueryResponse>(GET_USER_TICK_COUNTS_BY_BOARD, { userId }))
        .userTickCountsByBoard,
    enabled: userId !== undefined,
    staleTime: PROFILE_STALE_MS,
  });
  const boardTypes = (boardsQuery.data ?? []).filter((row) => row.count > 0).map((row) => row.boardType);

  const ticksQuery = useQuery({
    queryKey: ['userTicks', userId, boardTypes.join(',')],
    queryFn: async () => {
      const entries = await Promise.all(
        boardTypes.map(async (boardType) => {
          const response = await graphqlRequest<GetUserTicksQueryResponse>(GET_USER_TICKS, { userId, boardType });
          return [boardType, response.userTicks.map((tick) => toLogbookEntry(tick, boardType))] as const;
        }),
      );
      return Object.fromEntries(entries) as Record<string, LogbookEntry[]>;
    },
    enabled: userId !== undefined && boardsQuery.isSuccess,
    staleTime: PROFILE_STALE_MS,
  });

  const statsQuery = useQuery({
    queryKey: ['profileStats', userId],
    queryFn: async (): Promise<ProfileStatsData> =>
      (await graphqlRequest<GetUserProfileStatsQueryResponse>(GET_USER_PROFILE_STATS, { userId })).userProfileStats,
    enabled: userId !== undefined,
    staleTime: PROFILE_STALE_MS,
  });

  return {
    ticksByBoard: ticksQuery.data ?? null,
    stats: statsQuery.data ?? null,
    isLoading: boardsQuery.isPending || ticksQuery.isPending || statsQuery.isPending,
    error: boardsQuery.error ?? ticksQuery.error ?? statsQuery.error,
    refetch: () => {
      void boardsQuery.refetch();
      void ticksQuery.refetch();
      void statsQuery.refetch();
    },
    isRefetching: boardsQuery.isRefetching || ticksQuery.isRefetching || statsQuery.isRefetching,
  };
}

/** Where the climber sits among everyone on Boardsesh, by distinct climbs sent. */
export function useClimbPercentile(userId: string | undefined) {
  return useQuery({
    queryKey: ['climbPercentile', userId],
    queryFn: async () =>
      (await graphqlRequest<GetUserClimbPercentileQueryResponse>(GET_USER_CLIMB_PERCENTILE, { userId }))
        .userClimbPercentile,
    enabled: userId !== undefined,
    staleTime: PROFILE_STALE_MS,
  });
}
