import { useInfiniteQuery, type InfiniteData } from '@tanstack/react-query';
import type { ClimbSearchInput } from '@boardsesh/shared-schema';
import { useFeatureFlag } from '../../../providers/feature-flags-provider';
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
  // Injected here rather than at the call sites: this is the one choke point both
  // the climbs tab and the board preview go through, it rides `offlineAwareRequest`
  // into the on-device search for free, and putting it on the input means the query
  // key rotates by itself when the flag flips. `toClimbSearchInput` is a pure
  // function and cannot read a hook, which is why it does not live there.
  //
  // Unresolved reads as off, which is the shipped Aurora behaviour — nothing to
  // invert. Woods and MoonBoard ignore this value entirely: the server turns
  // cross-angle on for them from the board capability (see resolveCrossAngleStats).
  const crossAngleStats = useFeatureFlag('cross-angle-stats') === true;
  const searchInput: ClimbSearchInput = { ...input, crossAngleStats };
  return useInfiniteQuery({
    queryKey: getSearchClimbsQueryKey(searchInput),
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, {
        input: { ...searchInput, page: pageParam },
      }),
    // getNextPageParam receives RAW pre-select pages in React Query v5.
    getNextPageParam: (lastPage, allPages) => (lastPage.searchClimbs.hasMore ? allPages.length : undefined),
    select: selectSearchClimbPages,
    enabled,
    staleTime: options?.staleTime,
    gcTime: options?.gcTime,
  });
}
