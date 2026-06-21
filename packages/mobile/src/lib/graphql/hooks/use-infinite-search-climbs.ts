import { useInfiniteQuery } from '@tanstack/react-query';
import type { ClimbSearchInput } from '@boardsesh/shared-schema';
import { getHttpClient } from '../client';
import { SEARCH_CLIMBS, type SearchClimbsQueryResponse } from '../operations';

function getSearchClimbsQueryKey(input: ClimbSearchInput) {
  const { page: _page, ...queryInput } = input;
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
    queryFn: async ({ pageParam }) => {
      const response = await getHttpClient().request<SearchClimbsQueryResponse>(SEARCH_CLIMBS, {
        input: { ...input, page: pageParam },
      });
      return response.searchClimbs;
    },
    getNextPageParam: (lastPage, allPages) => (lastPage.hasMore ? allPages.length : undefined),
    enabled,
    staleTime: options?.staleTime,
    gcTime: options?.gcTime,
  });
}
