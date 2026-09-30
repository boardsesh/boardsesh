import { useQuery } from '@tanstack/react-query';
import { graphqlRequest } from '../api/graphql-client';
import { SEARCH_SETTERS, type SearchSettersResponse } from '../api/setters';
import { toSearchConfig, type ActiveBoard } from '../board/active-board';

/** Shorter terms match too many setters to be worth listing their climbs. */
const MIN_SETTER_SEARCH = 3;
/** The best-matching setters whose climbs a search also lists. */
const MAX_SETTERS = 5;

/**
 * Setters on this board whose username contains the search, best match first
 * (exact, then prefix, then the rest, as Boardsesh ranks them).
 */
export function useSetterMatches(board: ActiveBoard | null, term: string) {
  const search = term.trim();
  const searchConfig = board ? toSearchConfig(board) : null;
  return useQuery({
    queryKey: ['setterMatches', searchConfig, search],
    queryFn: async () => {
      if (!searchConfig) return [];
      const { boardName, layoutId, sizeId, setIds, angle } = searchConfig;
      const input = { boardName, layoutId, sizeId, setIds, angle, search };
      const { setterStats } = await graphqlRequest<SearchSettersResponse>(SEARCH_SETTERS, { input });
      return setterStats.slice(0, MAX_SETTERS).map((setter) => setter.setterUsername);
    },
    enabled: searchConfig !== null && search.length >= MIN_SETTER_SEARCH,
    staleTime: 5 * 60_000,
  });
}
