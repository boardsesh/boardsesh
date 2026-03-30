import { useCallback, useRef, useEffect, useMemo } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { PAGE_LIMIT } from '../../board-page/constants';
import { ClimbQueue } from '../types';
import { ParsedBoardRouteParameters, SearchRequestPagination, SearchClimbsResult } from '@/app/lib/types';
import { useOptionalBoardProvider } from '../../board-provider/board-provider-context';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { SEARCH_CLIMBS, SEARCH_CLIMBS_COUNT, type ClimbSearchResponse, type ClimbSearchCountResponse } from '@/app/lib/graphql/operations/climb-search';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { useSSRInitialClimbs } from '../ssr-initial-climbs-context';

interface UseQueueDataFetchingProps {
  searchParams: SearchRequestPagination;
  countSearchParams: SearchRequestPagination;
  queue: ClimbQueue;
  parsedParams: ParsedBoardRouteParameters;
  hasDoneFirstFetch: boolean;
  setHasDoneFirstFetch: () => void;
}

export const useQueueDataFetching = ({
  searchParams,
  countSearchParams,
  queue,
  parsedParams,
  hasDoneFirstFetch,
  setHasDoneFirstFetch,
}: UseQueueDataFetchingProps) => {
  const getLogbook = useOptionalBoardProvider()?.getLogbook;
  // Use wsAuthToken for GraphQL backend auth (NextAuth session token)
  const { token: wsAuthToken } = useWsAuthToken();
  const fetchedUuidsRef = useRef<string>('');

  // SSR initial data bridge: when the page component fetched climbs server-side,
  // hydrate TanStack Query to avoid a redundant client-side re-fetch.
  const ssrInitialClimbs = useSSRInitialClimbs();
  // Memoize the timestamp so Date.now() is computed once when SSR data is present,
  // not on every render (which would reset the staleness clock).
  const ssrDataTimestamp = useMemo(
    () => (ssrInitialClimbs ? Date.now() : undefined),
    [ssrInitialClimbs],
  );

  // Create a stable query key with flattened primitive values to avoid object reference changes
  const queryKey = useMemo(() => {
    // Exclude page from the key since pagination is handled by useInfiniteQuery
    const { page: _, ...paramsWithoutPage } = searchParams;
    // Flatten to primitives for stable key
    const stableFilterKey = JSON.stringify(paramsWithoutPage);
    return [
      'climbSearch',
      parsedParams.board_name,
      parsedParams.layout_id,
      parsedParams.size_id,
      parsedParams.set_ids.join(','),
      parsedParams.angle,
      stableFilterKey,
    ] as const;
  }, [searchParams, parsedParams]);

  // Shared base input for both search and count queries — single source of truth
  const baseInput = useMemo(() => ({
    boardName: parsedParams.board_name,
    layoutId: parsedParams.layout_id,
    sizeId: parsedParams.size_id,
    setIds: parsedParams.set_ids.join(','),
    angle: parsedParams.angle,
    gradeAccuracy: searchParams.gradeAccuracy ? String(searchParams.gradeAccuracy) : undefined,
    minGrade: searchParams.minGrade || undefined,
    maxGrade: searchParams.maxGrade || undefined,
    minAscents: searchParams.minAscents || undefined,
    sortBy: searchParams.sortBy || 'ascents',
    sortOrder: searchParams.sortOrder || 'desc',
    name: searchParams.name || undefined,
    setter: searchParams.settername && searchParams.settername.length > 0 ? searchParams.settername : undefined,
    onlyTallClimbs: searchParams.onlyTallClimbs || undefined,
    holdsFilter: searchParams.holdsFilter && Object.keys(searchParams.holdsFilter).length > 0
      ? Object.fromEntries(
          Object.entries(searchParams.holdsFilter).map(([key, value]) => [
            key.replace('hold_', ''),
            value.state
          ])
        )
      : undefined,
    hideAttempted: searchParams.hideAttempted || undefined,
    hideCompleted: searchParams.hideCompleted || undefined,
    showOnlyAttempted: searchParams.showOnlyAttempted || undefined,
    showOnlyCompleted: searchParams.showOnlyCompleted || undefined,
  }), [searchParams, parsedParams]);

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetching,
    isFetchingNextPage,
    error: searchError,
  } = useInfiniteQuery({
    queryKey,
    queryFn: async ({ pageParam }): Promise<SearchClimbsResult> => {
      const input = {
        ...baseInput,
        page: pageParam,
        pageSize: searchParams.pageSize || PAGE_LIMIT,
      };

      const client = createGraphQLHttpClient(wsAuthToken);

      try {
        const result = await client.request<ClimbSearchResponse>(SEARCH_CLIMBS, { input });
        return {
          climbs: result.searchClimbs.climbs,
          totalCount: result.searchClimbs.totalCount,
          hasMore: result.searchClimbs.hasMore,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[GraphQL] Search climbs error for ${parsedParams.board_name}:`, error);
        throw new Error(`Failed to fetch climbs: ${errorMessage}`);
      }
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      if (lastPage.hasMore === false) {
        return undefined;
      }
      if (lastPage.hasMore === true) {
        return allPages.length;
      }
      return undefined;
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: false,
    // Hydrate with SSR data to avoid redundant first fetch
    ...(ssrInitialClimbs
      ? {
          initialData: {
            pages: [{
              climbs: ssrInitialClimbs.climbs,
              totalCount: ssrInitialClimbs.climbs.length,
              hasMore: ssrInitialClimbs.hasMore,
            }],
            pageParams: [0],
          },
          initialDataUpdatedAt: ssrDataTimestamp,
        }
      : {}),
  });

  // Count query uses instant (un-debounced) params so the count updates
  // immediately as the user tweaks filters, without waiting for the search debounce.
  const countInput = useMemo(() => ({
    boardName: parsedParams.board_name,
    layoutId: parsedParams.layout_id,
    sizeId: parsedParams.size_id,
    setIds: parsedParams.set_ids.join(','),
    angle: parsedParams.angle,
    gradeAccuracy: countSearchParams.gradeAccuracy ? String(countSearchParams.gradeAccuracy) : undefined,
    minGrade: countSearchParams.minGrade || undefined,
    maxGrade: countSearchParams.maxGrade || undefined,
    minAscents: countSearchParams.minAscents || undefined,
    sortBy: countSearchParams.sortBy || 'ascents',
    sortOrder: countSearchParams.sortOrder || 'desc',
    name: countSearchParams.name || undefined,
    setter: countSearchParams.settername && countSearchParams.settername.length > 0 ? countSearchParams.settername : undefined,
    onlyTallClimbs: countSearchParams.onlyTallClimbs || undefined,
    holdsFilter: countSearchParams.holdsFilter && Object.keys(countSearchParams.holdsFilter).length > 0
      ? Object.fromEntries(
          Object.entries(countSearchParams.holdsFilter).map(([key, value]) => [
            key.replace('hold_', ''),
            value.state
          ])
        )
      : undefined,
    hideAttempted: countSearchParams.hideAttempted || undefined,
    hideCompleted: countSearchParams.hideCompleted || undefined,
    showOnlyAttempted: countSearchParams.showOnlyAttempted || undefined,
    showOnlyCompleted: countSearchParams.showOnlyCompleted || undefined,
  }), [countSearchParams, parsedParams]);

  const countQueryKey = useMemo(() => {
    const { page: _, ...paramsWithoutPage } = countSearchParams;
    return ['climbSearchCount', parsedParams.board_name, parsedParams.layout_id,
      parsedParams.size_id, parsedParams.set_ids.join(','), parsedParams.angle,
      JSON.stringify(paramsWithoutPage)] as const;
  }, [countSearchParams, parsedParams]);

  const { data: countData } = useQuery({
    queryKey: countQueryKey,
    queryFn: async () => {
      const client = createGraphQLHttpClient(wsAuthToken);
      const result = await client.request<ClimbSearchCountResponse>(SEARCH_CLIMBS_COUNT, { input: countInput });
      return result.searchClimbs.totalCount;
    },
    staleTime: 24 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
    // Defer count query until after the first climb results are shown.
    // The count is only displayed in the search footer, not needed for initial render.
    enabled: hasDoneFirstFetch,
  });

  const totalSearchResultCount = countData ?? null;
  const hasMoreResults = hasNextPage ?? false;

  const climbSearchResults = useMemo(
    () => (data ? data.pages.flatMap((page) => page.climbs) : null),
    [data],
  );

  const suggestedClimbs = useMemo(
    () => {
      const filtered = (climbSearchResults || []).filter((item) => !queue.find((queueItem) => queueItem.climb?.uuid === item.uuid));
      // Deduplicate by uuid to prevent React key warnings
      return filtered.filter((climb, index, self) =>
        index === self.findIndex((c) => c.uuid === climb.uuid)
      );
    },
    [climbSearchResults, queue],
  );

  // Combine and deduplicate climb UUIDs from both search results and queue
  // Returned so callers (e.g. QueueContext) can pass to useClimbActionsData
  const climbUuids = useMemo(() => {
    const searchUuids = climbSearchResults?.map((climb) => climb.uuid) || [];
    const queueUuids = queue.map((item) => item.climb?.uuid).filter(Boolean) as string[];
    return Array.from(new Set([...searchUuids, ...queueUuids])).sort();
  }, [climbSearchResults, queue]);

  const climbUuidsString = useMemo(() => JSON.stringify(climbUuids), [climbUuids]);

  // Update the logbook query's climbUuids when the set of visible climbs changes.
  // getLogbook just sets state; TanStack Query handles the actual fetch and
  // automatically retries when auth becomes available (via its `enabled` flag).
  useEffect(() => {
    if (climbUuidsString === fetchedUuidsRef.current) {
      return; // Skip if UUIDs haven't changed
    }
    fetchedUuidsRef.current = climbUuidsString;

    const uuids = JSON.parse(climbUuidsString);
    if (uuids.length > 0 && getLogbook) {
      getLogbook(uuids);
    }
  }, [climbUuidsString, getLogbook]);

  useEffect(() => {
    if (climbSearchResults && climbSearchResults.length > 0 && !hasDoneFirstFetch) {
      setHasDoneFirstFetch();
    }
  }, [climbSearchResults, hasDoneFirstFetch, setHasDoneFirstFetch]);

  const fetchMoreClimbs = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return {
    data,
    climbSearchResults,
    suggestedClimbs,
    totalSearchResultCount,
    hasMoreResults,
    isFetchingClimbs: isFetching,
    isFetchingNextPage,
    fetchMoreClimbs,
    // Combined climb UUIDs for use by useClimbActionsData
    climbUuids,
    // Error states
    searchError,
  };
};
