import { useInfiniteQuery } from '@tanstack/react-query';
import { gql } from 'graphql-request';
import type { Scope } from '@boardsesh/leaderboard';
import { scopeToId } from '@boardsesh/leaderboard';
import { getHttpClient } from '../client';

export type StandingsWindow = 'week' | 'month';

export type StandingsEntry = {
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
  isAnonymous: boolean;
  rank: number;
  tieSize: number;
  score: number;
  hardestGrade: number | null;
  isViewer: boolean;
};

export type StandingsScopeResult = {
  kind: Scope['kind'];
  key: string;
  label: string;
  climberCount: number;
};

export type StandingsViewer = {
  rank: number;
  score: number;
  tieSize: number;
  percentile: number;
  scoresAbove: number[];
};

export type StandingsPage = {
  requestedScope: StandingsScopeResult;
  resolvedScope: StandingsScopeResult;
  demotionReason: 'empty' | 'unknownScope' | null;
  entries: StandingsEntry[];
  totalCount: number;
  hasMore: boolean;
  viewer: StandingsViewer | null;
  coverage: number;
};

const GET_STANDINGS = gql`
  query GetStandings($input: StandingsInput!) {
    standings(input: $input) {
      requestedScope {
        kind
        key
        label
        climberCount
      }
      resolvedScope {
        kind
        key
        label
        climberCount
      }
      demotionReason
      entries {
        userId
        displayName
        avatarUrl
        isAnonymous
        rank
        tieSize
        score
        hardestGrade
        isViewer
      }
      totalCount
      hasMore
      viewer {
        rank
        score
        tieSize
        percentile
        scoresAbove
      }
      coverage
    }
  }
`;

const STANDINGS_PAGE_SIZE = 50;

/**
 * A scope's ranking, paged by offset.
 *
 * One page per end-reach — never a drain-until-`hasMore` loop, which the mobile
 * performance checklist treats as a review failure. The query key carries the
 * scope id and window so switching either is a different cache entry rather
 * than a refetch that briefly shows the wrong board.
 */
export function useStandings(scope: Scope, window: StandingsWindow, enabled = true) {
  return useInfiniteQuery({
    queryKey: ['standings', scopeToId(scope), window],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const response = await getHttpClient().request<{ standings: StandingsPage }>(GET_STANDINGS, {
        input: {
          scope: { kind: scope.kind, key: scope.key || null },
          window,
          limit: STANDINGS_PAGE_SIZE,
          offset: Number(pageParam),
        },
      });
      return response.standings;
    },
    getNextPageParam: (lastPage, allPages) =>
      lastPage.hasMore ? allPages.reduce((sum, page) => sum + page.entries.length, 0) : undefined,
    enabled,
    // A ranking is stale-tolerant: nobody needs a re-fetch because they
    // backgrounded the app for a minute.
    staleTime: 60_000,
  });
}
