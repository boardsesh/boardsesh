import { useMemo } from 'react';
import { useInfiniteQuery, type UseInfiniteQueryResult, type InfiniteData } from '@tanstack/react-query';
import {
  GET_PLAYLIST_CLIMBS,
  type GetPlaylistClimbsInput,
  type GetPlaylistClimbsQueryResponse,
  type PlaylistClimbsResult,
} from '@boardsesh/graphql/operations/playlists';
import type { Climb } from '@boardsesh/queue';
import { usePlaylistsAdapter, type ExecutePlaylistsGraphQL } from './adapter';

/** Board-scoping fields merged into the per-page query input. Omit for the
 *  all-boards view; supply when a specific board is selected. `playlistId`,
 *  `page`, and `pageSize` are added by the hook. */
export type PlaylistClimbsBoardInput = Omit<GetPlaylistClimbsInput, 'playlistId' | 'page' | 'pageSize'>;

export type UsePlaylistClimbsOptions = {
  playlistUuid: string;
  /** Stable query-key segment identifying the selected board (or 'all'). */
  boardUuid?: string | null;
  /** Bump to force a fresh fetch (e.g. after editing the playlist). Part of
   *  the query key. Defaults to 0. */
  refreshKey?: number;
  /** Board-scoping query input. When omitted, climbs are fetched all-boards. */
  boardInput?: PlaylistClimbsBoardInput;
  /** Page size per page. Defaults to 20. */
  pageSize?: number;
  /** True while the token is still resolving — disables the query until ready.
   *  Public playlists are readable without a token, so the hook is *not* gated
   *  on auth — only on token resolution. */
  tokenLoading?: boolean;
  /** SSR-fetched first page of climbs so the screen paints without a spinner. */
  initialData?: PlaylistClimbsResult | null;
  /** Whether the SSR payload still matches the live query key. Gates both
   *  `initialData` and `initialDataUpdatedAt` so they can never disagree. */
  initialDataApplicable?: boolean;
  /** Timestamp the SSR payload was fetched at, so react-query honours
   *  staleTime instead of refetching immediately (defaults to epoch). */
  initialDataUpdatedAt?: number;
  /** Override the adapter's `executeGraphQL` (used in tests). */
  executeGraphQL?: ExecutePlaylistsGraphQL;
};

export type UsePlaylistClimbsResult = {
  query: UseInfiniteQueryResult<InfiniteData<PlaylistClimbsResult>>;
  allClimbs: Climb[];
};

/**
 * Paginated playlist climbs (all-boards by default, board-scoped when a
 * `boardInput` is supplied). Flattens the infinite-query pages into a single
 * `allClimbs` list.
 */
export function usePlaylistClimbs({
  playlistUuid,
  boardUuid,
  refreshKey = 0,
  boardInput,
  pageSize = 20,
  tokenLoading = false,
  initialData,
  initialDataApplicable = false,
  initialDataUpdatedAt = 0,
  executeGraphQL: executeGraphQLOverride,
}: UsePlaylistClimbsOptions): UsePlaylistClimbsResult {
  const adapter = usePlaylistsAdapter();
  const executeGraphQL = executeGraphQLOverride ?? adapter.executeGraphQL;

  // The selected angle parameterises the response (grades resolve at it), but a
  // board's UUID is angle-agnostic — so the angle must be its own key segment.
  // Without it, dialing to a new angle on the same board keeps the same key and
  // React Query serves stale grades until staleTime lapses. Covers all-boards
  // mode (activeAngle) and specific-board mode (angle).
  const angleKey = boardInput?.activeAngle ?? boardInput?.angle ?? null;

  const query = useInfiniteQuery({
    queryKey: ['playlistClimbs', playlistUuid, boardUuid ?? 'all', angleKey, refreshKey],
    queryFn: async ({ pageParam }) => {
      const input: GetPlaylistClimbsInput = {
        playlistId: playlistUuid,
        page: pageParam,
        pageSize,
        ...boardInput,
      };
      const response = await executeGraphQL<GetPlaylistClimbsQueryResponse, { input: GetPlaylistClimbsInput }>(
        GET_PLAYLIST_CLIMBS,
        { input },
      );
      return response.playlistClimbs;
    },
    // Public playlists are readable without a token, so don't gate the query on
    // auth — otherwise signed-out viewers see the SSR first page and "load
    // more" silently does nothing.
    enabled: !tokenLoading,
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      if (!lastPage.hasMore) return undefined;
      return allPages.length;
    },
    staleTime: 5 * 60 * 1000,
    initialData:
      initialDataApplicable && initialData
        ? {
            pages: [initialData],
            pageParams: [0],
          }
        : undefined,
    // Without this, react-query treats initialData as epoch-stale and fires an
    // immediate refetch, defeating the SSR optimisation. Only meaningful when
    // initialData itself is being supplied.
    initialDataUpdatedAt: initialDataApplicable ? initialDataUpdatedAt : 0,
  });

  const allClimbs: Climb[] = useMemo(
    () => query.data?.pages.flatMap((page) => page.climbs as Climb[]) ?? [],
    [query.data],
  );

  return { query, allClimbs };
}
