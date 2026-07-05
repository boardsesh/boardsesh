import { useInfiniteQuery } from '@tanstack/react-query';
import type { ClimbSearchInput } from '@boardsesh/shared-schema';
import { resolveClimbSearch } from '../offline-search';

function getSearchClimbsQueryKey(input: ClimbSearchInput) {
  const { page: _page, ...queryInput } = input;
  // Keyed on the input only. `resolveClimbSearch` picks the source (local-first)
  // live per call, so connectivity isn't part of the key; a completed board sync
  // invalidates ['searchClimbs']/['infiniteSearchClimbs'] to refresh local reads.
  return ['infiniteSearchClimbs', queryInput] as const;
}

export function useInfiniteSearchClimbs(
  input: ClimbSearchInput,
  enabled = true,
  options?: { staleTime?: number; gcTime?: number },
) {
  return useInfiniteQuery({
    queryKey: getSearchClimbsQueryKey(input),
    initialPageParam: 0,
    queryFn: ({ pageParam }) => resolveClimbSearch({ ...input, page: pageParam }),
    getNextPageParam: (lastPage, allPages) => (lastPage.hasMore ? allPages.length : undefined),
    enabled,
    staleTime: options?.staleTime,
    gcTime: options?.gcTime,
  });
}
