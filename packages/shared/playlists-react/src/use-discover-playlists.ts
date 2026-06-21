import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DISCOVER_PLAYLISTS,
  type DiscoverablePlaylist,
  type DiscoverPlaylistsInput,
  type DiscoverPlaylistsQueryResponse,
} from '@boardsesh/graphql/operations/playlists';
import { usePlaylistsAdapter, type ExecutePlaylistsGraphQL } from './adapter';

export type UseDiscoverPlaylistsOptions = {
  /** Optional board filter. Changing it resets pagination for both streams. */
  boardType?: string;
  /** Optional layout filter. Changing it resets pagination for both streams. */
  layoutId?: number;
  /** Optional size filter for generated recommendations. */
  sizeId?: number;
  /** Optional angle filter for generated recommendations. */
  angle?: number;
  /** Page size per stream per request. Defaults to 10 (matches the existing UX). */
  pageSize?: number;
  /** Optional generated recommendation filter. */
  generatedRecommendation?: boolean;
  /** Whether requests should run. Defaults to true. */
  enabled?: boolean;
  /** SSR-provided initial data. When supplied, the first page fetch is skipped. */
  initialData?: { popular: DiscoverablePlaylist[]; recent: DiscoverablePlaylist[] };
  /** Whether the SSR popular slice has more pages. Pass through the server's
   *  hasMore so the IntersectionObserver doesn't fire a redundant first
   *  request just to learn there's nothing more. */
  initialPopularHasMore?: boolean;
  /** Same as `initialPopularHasMore`, but for the recent stream. */
  initialRecentHasMore?: boolean;
  /** Override the adapter's `executeGraphQL` (used in tests). */
  executeGraphQL?: ExecutePlaylistsGraphQL;
};

export type UseDiscoverPlaylistsResult = {
  popular: DiscoverablePlaylist[];
  recent: DiscoverablePlaylist[];
  isLoading: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  hasError: boolean;
  loadMore: () => void;
  refetch: () => void;
};

/**
 * Fetches the public Discover playlists (popular + recent), paginated.
 * Sibling of `useUserPlaylists` for the same horizontal slider:
 *  - Two parallel page cursors, one per sort. `hasMore` is the OR.
 *  - On `loadMore`, fetches the next page of *only* the streams that still
 *    have more — exhausted streams are left untouched.
 *  - Filter (boardType/layoutId) changes reset both cursors and refetch
 *    page 0 of each.
 *  - Three consecutive loadMore failures freeze the hook to prevent the
 *    IntersectionObserver from retrying forever.
 */
export function useDiscoverPlaylists({
  boardType,
  layoutId,
  sizeId,
  angle,
  pageSize = 10,
  generatedRecommendation,
  enabled = true,
  initialData,
  initialPopularHasMore,
  initialRecentHasMore,
  executeGraphQL: executeGraphQLOverride,
}: UseDiscoverPlaylistsOptions): UseDiscoverPlaylistsResult {
  const adapter = usePlaylistsAdapter();
  const executeGraphQL = executeGraphQLOverride ?? adapter.executeGraphQL;

  const hasInitialData = initialData != null;
  const [popular, setPopular] = useState<DiscoverablePlaylist[]>(hasInitialData ? initialData.popular : []);
  const [recent, setRecent] = useState<DiscoverablePlaylist[]>(hasInitialData ? initialData.recent : []);
  const [isLoading, setIsLoading] = useState(enabled && !hasInitialData);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [popularHasMore, setPopularHasMore] = useState(hasInitialData ? (initialPopularHasMore ?? false) : false);
  const [recentHasMore, setRecentHasMore] = useState(hasInitialData ? (initialRecentHasMore ?? false) : false);
  const [hasError, setHasError] = useState(false);

  // SSR delivers page 0 for both streams; the next loadMore() must request
  // page 1, not page 0 again (which would duplicate the SSR rows).
  const popularPageRef = useRef(hasInitialData ? 1 : 0);
  const recentPageRef = useRef(hasInitialData ? 1 : 0);
  const popularHasMoreRef = useRef(popularHasMore);
  const recentHasMoreRef = useRef(recentHasMore);
  const isFetchingRef = useRef(false);
  const activeFetchIdRef = useRef(0);
  const loadMoreFailCountRef = useRef(0);

  const resetPagination = useCallback(() => {
    popularPageRef.current = 0;
    recentPageRef.current = 0;
    popularHasMoreRef.current = false;
    recentHasMoreRef.current = false;
    loadMoreFailCountRef.current = 0;
    setPopularHasMore(false);
    setRecentHasMore(false);
  }, []);

  const fetchPages = useCallback(
    async (popularPage: number, recentPage: number, isInitial: boolean) => {
      if (!enabled) return;
      if (!isInitial && isFetchingRef.current) return;

      const fetchId = activeFetchIdRef.current + 1;
      activeFetchIdRef.current = fetchId;
      isFetchingRef.current = true;

      if (isInitial) {
        setIsLoading(true);
        setIsLoadingMore(false);
      } else {
        setIsLoadingMore(true);
      }

      // Initial load always pulls both streams. Subsequent loadMore calls
      // skip a stream once it's exhausted so we don't waste requests.
      const wantPopular = isInitial || popularHasMoreRef.current;
      const wantRecent = isInitial || recentHasMoreRef.current;

      const baseInput: DiscoverPlaylistsInput = {
        pageSize,
        ...(boardType !== undefined && { boardType }),
        ...(layoutId !== undefined && { layoutId }),
        ...(sizeId !== undefined && { sizeId }),
        ...(angle !== undefined && { angle }),
        ...(generatedRecommendation !== undefined && { generatedRecommendation }),
      };

      try {
        const [popularRes, recentRes] = await Promise.all([
          wantPopular
            ? executeGraphQL<DiscoverPlaylistsQueryResponse, { input: DiscoverPlaylistsInput }>(DISCOVER_PLAYLISTS, {
                input: { ...baseInput, sortBy: 'popular', page: popularPage },
              })
            : Promise.resolve(null),
          wantRecent
            ? executeGraphQL<DiscoverPlaylistsQueryResponse, { input: DiscoverPlaylistsInput }>(DISCOVER_PLAYLISTS, {
                input: { ...baseInput, sortBy: 'recent', page: recentPage },
              })
            : Promise.resolve(null),
        ]);

        if (activeFetchIdRef.current !== fetchId) return;

        if (popularRes) {
          const { playlists: nextPopular, hasMore: more } = popularRes.discoverPlaylists;
          setPopular((prev) => (isInitial ? nextPopular : [...prev, ...nextPopular]));
          setPopularHasMore(more);
          popularHasMoreRef.current = more;
          popularPageRef.current = popularPage + 1;
        }
        if (recentRes) {
          const { playlists: nextRecent, hasMore: more } = recentRes.discoverPlaylists;
          setRecent((prev) => (isInitial ? nextRecent : [...prev, ...nextRecent]));
          setRecentHasMore(more);
          recentHasMoreRef.current = more;
          recentPageRef.current = recentPage + 1;
        }
        loadMoreFailCountRef.current = 0;
        setHasError(false);
      } catch (err: unknown) {
        if (activeFetchIdRef.current !== fetchId) return;
        console.error('Failed to fetch discover playlists:', err);
        if (isInitial) {
          setHasError(true);
        } else {
          loadMoreFailCountRef.current += 1;
          if (loadMoreFailCountRef.current >= 3) {
            setPopularHasMore(false);
            setRecentHasMore(false);
            popularHasMoreRef.current = false;
            recentHasMoreRef.current = false;
          }
        }
      } finally {
        if (activeFetchIdRef.current !== fetchId) return;
        if (isInitial) {
          setIsLoading(false);
        } else {
          setIsLoadingMore(false);
        }
        isFetchingRef.current = false;
      }
    },
    [boardType, layoutId, sizeId, angle, pageSize, generatedRecommendation, enabled, executeGraphQL],
  );

  // Reset + re-fetch when filters change. Skip the very first run if SSR
  // already populated initialData for the current filter.
  const skipFirstFetchRef = useRef(hasInitialData);
  useEffect(() => {
    if (!enabled) {
      activeFetchIdRef.current += 1;
      isFetchingRef.current = false;
      skipFirstFetchRef.current = false;
      setPopular([]);
      setRecent([]);
      resetPagination();
      setIsLoading(false);
      setIsLoadingMore(false);
      setHasError(false);
      return;
    }
    if (skipFirstFetchRef.current) {
      skipFirstFetchRef.current = false;
      return;
    }
    setPopular([]);
    setRecent([]);
    resetPagination();
    void fetchPages(0, 0, true);
  }, [enabled, fetchPages, resetPagination]);

  const loadMore = useCallback(() => {
    if (isFetchingRef.current) return;
    if (!popularHasMoreRef.current && !recentHasMoreRef.current) return;
    void fetchPages(popularPageRef.current, recentPageRef.current, false);
  }, [fetchPages]);

  const refetch = useCallback(() => {
    resetPagination();
    void fetchPages(0, 0, true);
  }, [fetchPages, resetPagination]);

  return {
    popular,
    recent,
    isLoading,
    isLoadingMore,
    hasMore: popularHasMore || recentHasMore,
    hasError,
    loadMore,
    refetch,
  };
}
