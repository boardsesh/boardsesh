import { useState, useEffect, useCallback, useRef } from 'react';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  GET_POPULAR_BOARD_CONFIGS,
  type GetPopularBoardConfigsQueryResponse,
} from '@/app/lib/graphql/operations';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';

interface UsePopularBoardConfigsOptions {
  /** Number of configs per page */
  limit?: number;
  /** SSR-provided initial data to avoid loading flash */
  initialData?: PopularBoardConfig[];
}

interface PopularBoardConfigsResult {
  configs: PopularBoardConfig[];
  isLoading: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  loadMore: () => void;
}

/**
 * Fetches popular board configurations with pagination support.
 * These are catalog configurations (board type + layout + size + sets)
 * ranked by climb count, for users who can't find a nearby board.
 */
export function usePopularBoardConfigs({
  limit = 12,
  initialData,
}: UsePopularBoardConfigsOptions = {}): PopularBoardConfigsResult {
  const hasInitialData = initialData !== undefined && initialData.length > 0;
  // If initialData has fewer items than the limit, the server returned everything — no more pages
  const initialHasMore = hasInitialData && initialData.length >= limit;
  const [configs, setConfigs] = useState<PopularBoardConfig[]>(hasInitialData ? initialData : []);
  const [isLoading, setIsLoading] = useState(!hasInitialData);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [error, setError] = useState<string | null>(null);
  const hasMoreRef = useRef(initialHasMore);
  const offsetRef = useRef(hasInitialData ? initialData.length : 0);
  const isFetchingRef = useRef(false);
  const loadMoreFailCountRef = useRef(0);

  const fetchPage = useCallback(async (offset: number, isInitial: boolean) => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;

    if (isInitial) {
      setIsLoading(true);
    } else {
      setIsLoadingMore(true);
    }

    try {
      const client = createGraphQLHttpClient();
      const result = await client.request<GetPopularBoardConfigsQueryResponse>(
        GET_POPULAR_BOARD_CONFIGS,
        { input: { limit, offset } },
      );

      const { configs: newConfigs, hasMore: more } = result.popularBoardConfigs;

      setConfigs((prev) => isInitial ? newConfigs : [...prev, ...newConfigs]);
      setHasMore(more);
      hasMoreRef.current = more;
      offsetRef.current = offset + newConfigs.length;
      loadMoreFailCountRef.current = 0;
    } catch (err) {
      console.error('Failed to fetch popular board configs:', err);
      if (isInitial) {
        setError('Failed to load board configurations');
      } else {
        // Stop infinite retries from IntersectionObserver by disabling loadMore after 3 failures
        loadMoreFailCountRef.current += 1;
        if (loadMoreFailCountRef.current >= 3) {
          setHasMore(false);
          hasMoreRef.current = false;
        }
      }
    } finally {
      if (isInitial) {
        setIsLoading(false);
      } else {
        setIsLoadingMore(false);
      }
      isFetchingRef.current = false;
    }
  }, [limit]);

  useEffect(() => {
    // Skip the initial fetch when SSR data is provided — the revalidation
    // effect below handles refreshing stale static data.
    if (hasInitialData) return;
    offsetRef.current = 0;
    fetchPage(0, true);
  }, [fetchPage, hasInitialData]);

  // Revalidate SSR data in the background to handle stale static pages
  // (e.g., when the backend was unavailable during the Vercel build).
  useEffect(() => {
    if (!hasInitialData) return;

    let cancelled = false;
    const revalidate = async () => {
      try {
        const client = createGraphQLHttpClient();
        const result = await client.request<GetPopularBoardConfigsQueryResponse>(
          GET_POPULAR_BOARD_CONFIGS,
          { input: { limit, offset: 0 } },
        );
        if (cancelled) return;
        const { configs: freshConfigs, hasMore: more } = result.popularBoardConfigs;
        // Only replace if backend returned data — avoid wiping SSR data on transient failure
        if (freshConfigs.length > 0) {
          setConfigs(freshConfigs);
          setHasMore(more);
          hasMoreRef.current = more;
          offsetRef.current = freshConfigs.length;
        }
      } catch {
        // Silent failure — SSR data is already displayed
      }
    };
    revalidate();
    return () => { cancelled = true; };
  }, [hasInitialData, limit]);

  const loadMore = useCallback(() => {
    if (hasMoreRef.current && !isFetchingRef.current) {
      fetchPage(offsetRef.current, false);
    }
  }, [fetchPage]);

  return { configs, isLoading, isLoadingMore, hasMore, error, loadMore };
}
