import { useInfiniteQuery } from '@tanstack/react-query';
import type { ClimbSearchInput } from '@boardsesh/shared-schema';
import { resolveClimbSearch } from '../offline-search';
import { useIsOffline } from '../../../hooks/use-is-offline';

function getSearchClimbsQueryKey(input: ClimbSearchInput, offline: boolean) {
  const { page: _page, ...queryInput } = input;
  // The offline flag is a coarse key discriminator: a connectivity flip swaps to a
  // different cache entry (network ⇄ local) instead of reusing stale results. It's
  // last so ['infiniteSearchClimbs', ...] prefix invalidations still match.
  return ['infiniteSearchClimbs', queryInput, offline] as const;
}

export function useInfiniteSearchClimbs(
  input: ClimbSearchInput,
  enabled = true,
  options?: { staleTime?: number; gcTime?: number },
) {
  const offline = useIsOffline();
  return useInfiniteQuery({
    queryKey: getSearchClimbsQueryKey(input, offline),
    initialPageParam: 0,
    queryFn: ({ pageParam }) => resolveClimbSearch({ ...input, page: pageParam }),
    getNextPageParam: (lastPage, allPages) => (lastPage.hasMore ? allPages.length : undefined),
    enabled,
    staleTime: options?.staleTime,
    gcTime: options?.gcTime,
  });
}
