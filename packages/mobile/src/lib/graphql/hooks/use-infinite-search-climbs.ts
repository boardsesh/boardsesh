import { useMemo } from 'react';
import { useInfiniteQuery, type InfiniteData, type QueryKey } from '@tanstack/react-query';
import type { ClimbSearchInput } from '@boardsesh/shared-schema';
import { offlineAwareRequest } from '../offline-request';
import { SEARCH_CLIMBS, type SearchClimbsQueryResponse } from '../operations';
import { INFINITE_SEARCH_CLIMBS_QUERY_KEY } from '../query-keys';

type SearchClimbsBoardScope = Pick<ClimbSearchInput, 'boardName' | 'layoutId' | 'sizeId' | 'setIds'>;

export type InfiniteSearchClimbsOptions = {
  staleTime?: number;
  gcTime?: number;
  /**
   * Keep the previous results on screen (as placeholder data) while a new
   * search on the SAME board loads, instead of dropping to no data. A board
   * switch still starts empty so the wrong board's climbs never show.
   */
  keepPreviousResults?: boolean;
};

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

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
}

/**
 * The `placeholderData` rule behind `keepPreviousResults`. React Query v5 hands
 * it the last query that had data (raw, pre-`select`) and that query; the data
 * is kept only when that query searched the same board, layout, size and sets.
 */
export function keepSameBoardSearchResults<TData>(
  boardScope: SearchClimbsBoardScope,
  previousData: TData | undefined,
  previousQueryKey: QueryKey | undefined,
): TData | undefined {
  if (previousData === undefined || !previousQueryKey) return undefined;
  if (previousQueryKey[0] !== INFINITE_SEARCH_CLIMBS_QUERY_KEY[0]) return undefined;
  const previousInput = previousQueryKey[INFINITE_SEARCH_CLIMBS_QUERY_KEY.length];
  if (!isRecord(previousInput)) return undefined;
  const isSameBoard =
    previousInput.boardName === boardScope.boardName &&
    previousInput.layoutId === boardScope.layoutId &&
    previousInput.sizeId === boardScope.sizeId &&
    previousInput.setIds === boardScope.setIds;
  return isSameBoard ? previousData : undefined;
}

export function useInfiniteSearchClimbs(
  input: ClimbSearchInput,
  enabled = true,
  options?: InfiniteSearchClimbsOptions,
) {
  const { boardName, layoutId, sizeId, setIds } = input;
  const keepPreviousResults = options?.keepPreviousResults === true;
  // Memoized per board on purpose. While a placeholder is showing, React Query
  // reuses it without calling this function again as long as its identity is
  // unchanged. A board switch must therefore mint a new function, or the old
  // board's rows would stay up until the new board's first page lands.
  const placeholderData = useMemo(() => {
    if (!keepPreviousResults) return undefined;
    const boardScope: SearchClimbsBoardScope = { boardName, layoutId, sizeId, setIds };
    return (
      previousData: InfiniteData<SearchClimbsQueryResponse, number> | undefined,
      previousQuery: { queryKey: QueryKey } | undefined,
    ) => keepSameBoardSearchResults(boardScope, previousData, previousQuery?.queryKey);
  }, [keepPreviousResults, boardName, layoutId, sizeId, setIds]);

  return useInfiniteQuery({
    queryKey: getSearchClimbsQueryKey(input),
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input: { ...input, page: pageParam } }),
    // getNextPageParam receives RAW pre-select pages in React Query v5.
    getNextPageParam: (lastPage, allPages) => (lastPage.searchClimbs.hasMore ? allPages.length : undefined),
    select: selectSearchClimbPages,
    placeholderData,
    enabled,
    staleTime: options?.staleTime,
    gcTime: options?.gcTime,
  });
}
