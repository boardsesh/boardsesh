import type { QueryClient } from '@tanstack/react-query';

export const FOLLOWING_CATALOGUE_QUERY_KEYS = [
  'setterStats',
  'searchClimbs',
  'infiniteSearchClimbs',
  'searchClimbsCount',
] as const;

/** Match catalogue reads that can race database readiness or owner stamping. */
export function isCatalogueQuery({ queryKey }: { queryKey: readonly unknown[] }): boolean {
  return FOLLOWING_CATALOGUE_QUERY_KEYS.some((head) => head === queryKey[0]);
}

/** Retry author-dependent reads without refetching the ordinary catalogue. */
export function invalidateFollowingCatalogueQueries(queryClient: QueryClient) {
  void queryClient.invalidateQueries({
    predicate: (query) => {
      const input = query.queryKey[1];
      return (
        isCatalogueQuery(query) &&
        typeof input === 'object' &&
        input !== null &&
        'onlyFollowedAuthors' in input &&
        input.onlyFollowedAuthors === true
      );
    },
  });
}
