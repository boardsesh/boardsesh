import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  SEARCH_CLIMBS,
  SEARCH_CLIMBS_COUNT,
  type ClimbSearchCountResponse,
  type ClimbSearchResponse,
} from '@boardsesh/graphql/operations/climb-search';
import { graphqlRequest } from '../api/graphql-client';
import { useAuth } from '../auth/auth-provider';
import { toSearchConfig, type ActiveBoard } from '../board/active-board';
import { buildSearchInput, type ClimbFilters } from './climb-filters';

/** A search: a name to match, or the setters whose climbs to list instead. */
type SearchTerms = { name: string; setters?: readonly string[] };

function useSearchKey(board: ActiveBoard | null, filters: ClimbFilters, terms: SearchTerms) {
  const { status } = useAuth();
  const signedIn = status === 'signedIn';
  const searchConfig = board ? toSearchConfig(board) : null;
  return {
    signedIn,
    searchConfig,
    boardKey: JSON.stringify(searchConfig),
    key: [searchConfig, filters, terms.name, terms.setters ?? null, signedIn] as const,
    // A setter search with no setters found has nothing to ask.
    enabled: board !== null && status !== 'loading' && (terms.setters === undefined || terms.setters.length > 0),
  };
}

/** Paged climbs for the active board. Disabled until a board is set up. */
export function useClimbSearch(board: ActiveBoard | null, filters: ClimbFilters, terms: SearchTerms) {
  const search = useSearchKey(board, filters, terms);
  return useInfiniteQuery({
    queryKey: ['climbSearch', ...search.key],
    queryFn: async ({ pageParam }) => {
      if (!board) throw new Error('No board set up');
      const input = buildSearchInput(board, filters, { ...terms, page: pageParam, signedIn: search.signedIn });
      return (await graphqlRequest<ClimbSearchResponse>(SEARCH_CLIMBS, { input })).searchClimbs;
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, _allPages, lastPageParam) => (lastPage.hasMore ? lastPageParam + 1 : undefined),
    enabled: search.enabled,
    // A new sort or filter keeps the current climbs on screen until its own
    // arrive, so the list doesn't collapse to a spinner and back. Never across
    // boards: another wall's climbs would be wrong, not just stale.
    placeholderData: (previous, previousQuery) =>
      previousQuery && JSON.stringify(previousQuery.queryKey[1]) === search.boardKey ? previous : undefined,
  });
}

/**
 * How many climbs the same search finds. Counted in its own query, as
 * Boardsesh does, so the first page never waits on the count.
 */
export function useClimbCount(board: ActiveBoard | null, filters: ClimbFilters, terms: SearchTerms) {
  const search = useSearchKey(board, filters, terms);
  return useQuery({
    queryKey: ['climbCount', ...search.key],
    queryFn: async () => {
      if (!board) throw new Error('No board set up');
      const input = buildSearchInput(board, filters, { ...terms, page: 0, signedIn: search.signedIn });
      const { searchClimbs } = await graphqlRequest<ClimbSearchCountResponse>(SEARCH_CLIMBS_COUNT, { input });
      return searchClimbs.totalCount;
    },
    enabled: search.enabled,
    staleTime: 60_000,
    placeholderData: (previous, previousQuery) =>
      previousQuery && JSON.stringify(previousQuery.queryKey[1]) === search.boardKey ? previous : undefined,
  });
}
