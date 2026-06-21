import { useCallback, useEffect, useRef, useState } from 'react';
import {
  GET_ALL_USER_PLAYLISTS,
  type GetAllUserPlaylistsQueryResponse,
  type GetAllUserPlaylistsQueryVariables,
  type Playlist,
} from '@boardsesh/graphql/operations/playlists';
import { usePlaylistsAdapter, type ExecutePlaylistsGraphQL } from './adapter';

export type UseUserPlaylistsOptions = {
  /** Auth token (when null, the hook is disabled). */
  token: string | null;
  /** Optional board filter. Changing it resets pagination. */
  boardType?: string;
  /** Optional layout filter. Changing it resets pagination. */
  layoutId?: number;
  /** Page size for each loadMore call. Defaults to 20. */
  pageSize?: number;
  /** SSR-provided initial data. When supplied, the first page fetch is skipped. */
  initialData?: Playlist[];
  /** Whether SSR initial data exhausts the user's library. Pass the server's
   *  hasMore so the IntersectionObserver doesn't fire a redundant first
   *  network request just to learn there's nothing more. */
  initialHasMore?: boolean;
  /** Server-reported total count for the current filter. Defaults to
   *  initialData.length, but that under-reports when SSR returns one page
   *  out of many — pass the real total from the server response. */
  initialTotalCount?: number;
  /** Override the adapter's `executeGraphQL` (used in tests). */
  executeGraphQL?: ExecutePlaylistsGraphQL;
};

export type UseUserPlaylistsResult = {
  playlists: Playlist[];
  isLoading: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  totalCount: number;
  /** True when the initial-page fetch failed. The screen renders its own
   *  translated error UI on top of this signal — the hook deliberately
   *  doesn't carry a translatable message. */
  hasError: boolean;
  /** True when background pagination (pages 2+) gave up after three
   *  consecutive failures. The loaded list is incomplete; surface this and
   *  offer `retryLoadMore` rather than letting the rest go missing silently. */
  hasLoadMoreError: boolean;
  loadMore: () => void;
  /** Re-arm and retry background pagination after `hasLoadMoreError`. */
  retryLoadMore: () => void;
  refetch: () => void;
};

/**
 * Fetches the authenticated user's owned playlists, paginated.
 * Offset pagination:
 *  - One page on mount, more pages on `loadMore`.
 *  - When `boardType` or `layoutId` changes, state resets and we re-fetch
 *    page 0 (so the board filter works correctly).
 *  - Three consecutive loadMore failures freeze the hook to prevent the
 *    IntersectionObserver from retrying forever.
 */
export function useUserPlaylists({
  token,
  boardType,
  layoutId,
  pageSize = 20,
  initialData,
  initialHasMore,
  initialTotalCount,
  executeGraphQL: executeGraphQLOverride,
}: UseUserPlaylistsOptions): UseUserPlaylistsResult {
  const adapter = usePlaylistsAdapter();
  const executeGraphQL = executeGraphQLOverride ?? adapter.executeGraphQL;

  const hasInitialData = initialData != null;
  const [playlists, setPlaylists] = useState<Playlist[]>(hasInitialData ? initialData : []);
  const [isLoading, setIsLoading] = useState(!hasInitialData);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(hasInitialData ? (initialHasMore ?? false) : false);
  const [totalCount, setTotalCount] = useState(hasInitialData ? (initialTotalCount ?? initialData.length) : 0);
  const [hasError, setHasError] = useState(false);
  const [hasLoadMoreError, setHasLoadMoreError] = useState(false);

  const hasMoreRef = useRef(hasMore);
  // SSR delivers page 0; the next loadMore() must request page 1, not page 0
  // again (which would duplicate the SSR rows). When there's no SSR data we
  // start at 0 and the initial-fetch effect requests it.
  const pageRef = useRef(hasInitialData ? 1 : 0);
  const isFetchingRef = useRef(false);
  const loadMoreFailCountRef = useRef(0);

  const fetchPage = useCallback(
    async (page: number, isInitial: boolean) => {
      if (!token) return;
      if (isFetchingRef.current) return;
      isFetchingRef.current = true;

      if (isInitial) {
        setIsLoading(true);
      } else {
        setIsLoadingMore(true);
      }

      try {
        const variables: GetAllUserPlaylistsQueryVariables = {
          input: { boardType, layoutId, page, pageSize },
        };
        const response = await executeGraphQL<GetAllUserPlaylistsQueryResponse, GetAllUserPlaylistsQueryVariables>(
          GET_ALL_USER_PLAYLISTS,
          variables,
        );
        const { playlists: newPlaylists, totalCount: nextTotal, hasMore: more } = response.allUserPlaylists;

        setPlaylists((prev) => (isInitial ? newPlaylists : [...prev, ...newPlaylists]));
        setTotalCount(nextTotal);
        setHasMore(more);
        hasMoreRef.current = more;
        pageRef.current = page + 1;
        loadMoreFailCountRef.current = 0;
        setHasError(false);
        setHasLoadMoreError(false);
      } catch (err: unknown) {
        console.error('Failed to fetch user playlists:', err);
        if (isInitial) {
          setHasError(true);
        } else {
          loadMoreFailCountRef.current += 1;
          if (loadMoreFailCountRef.current >= 3) {
            // Stop the auto-retry loop, but flag the list as incomplete so the
            // screen can show a "couldn't load the rest" affordance.
            setHasMore(false);
            hasMoreRef.current = false;
            setHasLoadMoreError(true);
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
    },
    [token, boardType, layoutId, pageSize, executeGraphQL],
  );

  // Reset + re-fetch when filters change. Skip the very first run if SSR
  // already populated initialData for the current filter.
  const skipFirstFetchRef = useRef(hasInitialData);
  useEffect(() => {
    if (skipFirstFetchRef.current) {
      skipFirstFetchRef.current = false;
      return;
    }
    loadMoreFailCountRef.current = 0;
    setHasLoadMoreError(false);
    if (!token) {
      setPlaylists([]);
      setIsLoading(false);
      setHasMore(false);
      setTotalCount(0);
      hasMoreRef.current = false;
      pageRef.current = 0;
      return;
    }
    setPlaylists([]);
    pageRef.current = 0;
    void fetchPage(0, true);
  }, [fetchPage, token]);

  const loadMore = useCallback(() => {
    if (hasMoreRef.current && !isFetchingRef.current) {
      void fetchPage(pageRef.current, false);
    }
  }, [fetchPage]);

  // Manual retry after the auto-retry loop gave up: clear the failure count,
  // re-arm pagination, and re-fetch the page that failed (pageRef wasn't
  // advanced on failure). Draining then resumes on its own.
  const retryLoadMore = useCallback(() => {
    if (isFetchingRef.current) return;
    loadMoreFailCountRef.current = 0;
    setHasLoadMoreError(false);
    setHasMore(true);
    hasMoreRef.current = true;
    void fetchPage(pageRef.current, false);
  }, [fetchPage]);

  const refetch = useCallback(() => {
    pageRef.current = 0;
    void fetchPage(0, true);
  }, [fetchPage]);

  return {
    playlists,
    isLoading,
    isLoadingMore,
    hasMore,
    totalCount,
    hasError,
    hasLoadMoreError,
    loadMore,
    retryLoadMore,
    refetch,
  };
}
