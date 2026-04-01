import { useMemo, useCallback } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { InfiniteData } from '@tanstack/react-query';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  GET_POPULAR_BOARD_CONFIGS,
  type GetPopularBoardConfigsQueryResponse,
} from '@/app/lib/graphql/operations';
import type { PopularBoardConfig, PopularBoardConfigConnection } from '@boardsesh/shared-schema';

interface UsePopularBoardConfigsOptions {
  /** Number of configs per page */
  limit?: number;
  /** SSR-provided initial data to avoid loading flash */
  initialData?: PopularBoardConfig[];
}

interface PopularBoardConfigsResult {
  configs: PopularBoardConfig[];
  isLoading: boolean;
  isFetchingNextPage: boolean;
  hasNextPage: boolean;
  error: string | null;
  fetchNextPage: () => void;
}

const DEFAULT_LIMIT = 7;

/**
 * Fetches popular board configurations with pagination support.
 * These are catalog configurations (board type + layout + size + sets)
 * ranked by climb count, for users who can't find a nearby board.
 *
 * Uses TanStack Query's useInfiniteQuery for caching & pagination,
 * consistent with the rest of the app (climb lists, activity feeds, etc.).
 */
export function usePopularBoardConfigs({
  limit = DEFAULT_LIMIT,
  initialData,
}: UsePopularBoardConfigsOptions = {}): PopularBoardConfigsResult {
  const hasInitialData = initialData !== undefined && initialData.length > 0;
  const initialHasMore = hasInitialData && initialData.length >= limit;

  const tanstackInitialData = useMemo<InfiniteData<PopularBoardConfigConnection> | undefined>(() => {
    if (!hasInitialData) return undefined;
    return {
      pages: [{
        configs: initialData,
        totalCount: initialData.length,
        hasMore: initialHasMore,
      }],
      pageParams: [0],
    };
  }, [hasInitialData, initialData, initialHasMore]);

  const {
    data,
    fetchNextPage: tanstackFetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    error: queryError,
  } = useInfiniteQuery<PopularBoardConfigConnection, Error>({
    queryKey: ['popularBoardConfigs', limit],
    queryFn: async ({ pageParam }: { pageParam: number }) => {
      const client = createGraphQLHttpClient();
      const result = await client.request<GetPopularBoardConfigsQueryResponse>(
        GET_POPULAR_BOARD_CONFIGS,
        { input: { limit, offset: pageParam } },
      );
      return result.popularBoardConfigs;
    },
    initialPageParam: 0 as number,
    getNextPageParam: (lastPage: PopularBoardConfigConnection, _allPages: PopularBoardConfigConnection[], lastPageParam: number) => {
      if (!lastPage.hasMore) return undefined;
      return lastPageParam + lastPage.configs.length;
    },
    initialData: tanstackInitialData,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 2,
  });

  const configs = useMemo(
    () => data?.pages.flatMap((page: PopularBoardConfigConnection) => page.configs) ?? [],
    [data],
  );

  const fetchNextPage = useCallback(() => {
    tanstackFetchNextPage();
  }, [tanstackFetchNextPage]);

  return {
    configs,
    isLoading,
    isFetchingNextPage,
    hasNextPage: hasNextPage ?? false,
    error: queryError ? 'Failed to load board configurations' : null,
    fetchNextPage,
  };
}
