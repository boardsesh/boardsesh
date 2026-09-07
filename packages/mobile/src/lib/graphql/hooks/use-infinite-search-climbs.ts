import { useInfiniteQuery, type InfiniteData } from '@tanstack/react-query';
import type { ClimbSearchInput } from '@boardsesh/shared-schema';
import { offlineAwareRequest } from '../offline-request';
import { SEARCH_CLIMBS, type SearchClimbsQueryResponse } from '../operations';
import { INFINITE_SEARCH_CLIMBS_QUERY_KEY } from '../query-keys';

// Map the raw pages down to their `searchClimbs` payload so consumers keep
// seeing `pages[i].climbs`. Module scope (stable identity) so React Query's
// memoized-select fast path applies instead of re-running per render.
function selectSearchClimbPages(rawPages: InfiniteData<SearchClimbsQueryResponse, number>) {
  return { pages: rawPages.pages.map((page) => page.searchClimbs), pageParams: rawPages.pageParams };
}

function getSearchClimbsQueryKey(input: ClimbSearchInput) {
  const { page: _page, ...queryInput } = input;
  // Keyed on the input only. `offlineAwareRequest` picks the source (local-first)
  // live per call, so connectivity isn't part of the key; a completed board sync
  // invalidates ['searchClimbs']/['infiniteSearchClimbs'] to refresh local reads.
  return [...INFINITE_SEARCH_CLIMBS_QUERY_KEY, queryInput] as const;
}

export function useInfiniteSearchClimbs(
  input: ClimbSearchInput,
  enabled = true,
  options?: { staleTime?: number; gcTime?: number },
) {
  return useInfiniteQuery({
    queryKey: getSearchClimbsQueryKey(input),
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input: { ...input, page: pageParam } }),
    // getNextPageParam receives RAW pre-select pages in React Query v5.
    getNextPageParam: (lastPage, allPages) => (lastPage.searchClimbs.hasMore ? allPages.length : undefined),
    select: selectSearchClimbPages,
    enabled,
    staleTime: options?.staleTime,
    gcTime: options?.gcTime,
  });
}
