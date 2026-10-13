import type { QueryClient } from '@tanstack/react-query';

export const FOLLOWING_CATALOGUE_QUERY_KEYS = [
  'setterStats',
  'searchClimbs',
  'infiniteSearchClimbs',
  'searchClimbsCount',
] as const;

/** Retry author-dependent reads without refetching the ordinary catalogue. */
export function invalidateFollowingCatalogueQueries(queryClient: QueryClient) {
  void queryClient.invalidateQueries({
    predicate: ({ queryKey }) => {
      const [queryHead, input] = queryKey;
      return (
        FOLLOWING_CATALOGUE_QUERY_KEYS.some((head) => head === queryHead) &&
        typeof input === 'object' &&
        input !== null &&
        'onlyFollowedAuthors' in input &&
        input.onlyFollowedAuthors === true
      );
    },
  });
}
