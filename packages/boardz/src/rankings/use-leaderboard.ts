import { useInfiniteQuery } from '@tanstack/react-query';
import { GET_BOARD_LEADERBOARD, type GetBoardLeaderboardQueryResponse } from '@boardsesh/graphql/operations/boards';
import { graphqlRequest } from '../api/graphql-client';

export type RankingPeriod = 'week' | 'month' | 'year' | 'all';

const PAGE_SIZE = 50;

/**
 * Who has sent the most on one Boardsesh board in a period. Public and gym
 * boards answer anyone; a private board only its owner's crew.
 */
export function useLeaderboard(boardUuid: string | undefined, period: RankingPeriod) {
  return useInfiniteQuery({
    queryKey: ['leaderboard', boardUuid, period],
    queryFn: async ({ pageParam }) =>
      (
        await graphqlRequest<GetBoardLeaderboardQueryResponse>(GET_BOARD_LEADERBOARD, {
          input: { boardUuid, period, limit: PAGE_SIZE, offset: pageParam },
        })
      ).boardLeaderboard,
    initialPageParam: 0,
    getNextPageParam: (lastPage, _pages, lastOffset) => (lastPage.hasMore ? lastOffset + PAGE_SIZE : undefined),
    enabled: boardUuid !== undefined,
    staleTime: 60_000,
  });
}
