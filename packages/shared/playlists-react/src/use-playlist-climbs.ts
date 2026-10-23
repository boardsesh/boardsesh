import { useMemo } from 'react';
import { useInfiniteQuery, type QueryKey, type UseInfiniteQueryResult, type InfiniteData } from '@tanstack/react-query';
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
export type PlaylistClimbsBoardInput = Omit<GetPlaylistClimbsInput, 'playlistId' | 'page' | 'pageSize' | 'view'>;

/** The sort and filters, as `toPlaylistClimbViewInput` (@boardsesh/climb-filters) builds them. */
export type PlaylistClimbsView = NonNullable<GetPlaylistClimbsInput['view']>;

/** Where the view sits in the query key: after the playlist, board and angle, before the refresh key. */
const VIEW_KEY_INDEX = 4;

/** What a playlist climbs query key is built from. */
export type PlaylistClimbsQueryKeyParts = {
  playlistUuid: string;
  boardUuid?: string | null;
  /** The angle the grades resolve at (`activeAngle` in all-boards mode, `angle` for one board). */
  angle?: number | null;
  view?: PlaylistClimbsView;
  refreshKey?: number;
};

/**
 * The React Query key `usePlaylistClimbs` caches one view under, so a screen can
 * invalidate exactly one view (the playlist's own order, before the editor reads
 * it) without rebuilding the key by hand. The view is the object itself, which
 * React Query hashes with its keys sorted, so a re-built view with the same
 * content keeps the same cache entry. It sits after the playlist uuid, so
 * `invalidateQueries({ queryKey: ['playlistClimbs', uuid] })` still clears every
 * view of the playlist.
 */
export function playlistClimbsQueryKey({
  playlistUuid,
  boardUuid,
  angle,
  view,
  refreshKey = 0,
}: PlaylistClimbsQueryKeyParts) {
  return ['playlistClimbs', playlistUuid, boardUuid ?? 'all', angle ?? null, view ?? 'default', refreshKey] as const;
}

/**
 * The angle segment of the key: grades resolve at it, so it must be part of the
 * key. All-boards mode sends `activeAngle`, specific-board mode sends `angle`.
 */
export function playlistClimbsAngleKey(boardInput: PlaylistClimbsBoardInput | undefined): number | null {
  return boardInput?.activeAngle ?? boardInput?.angle ?? null;
}

/**
 * The key `usePlaylistClimbs` uses for these exact options. A screen that needs
 * to touch one view's cache (the editor marking the playlist's own order stale)
 * calls this with the options it passes the hook, so the two can never disagree
 * about the angle.
 */
export function playlistClimbsQueryKeyFor({
  playlistUuid,
  boardUuid,
  boardInput,
  view,
  refreshKey,
}: Pick<UsePlaylistClimbsOptions, 'playlistUuid' | 'boardUuid' | 'boardInput' | 'view' | 'refreshKey'>) {
  return playlistClimbsQueryKey({
    playlistUuid,
    boardUuid,
    angle: playlistClimbsAngleKey(boardInput),
    view,
    refreshKey,
  });
}

/**
 * The `placeholderData` rule: while a new view's first page loads, keep showing
 * the rows of the same playlist, board, angle and refresh under the previous
 * view, so changing the sort or a filter never flashes an empty list. Any other
 * difference (another playlist, board or angle, a refresh) shows nothing stale.
 */
export function keepPreviousViewResults<TData>(
  queryKey: QueryKey,
  previousData: TData | undefined,
  previousQueryKey: QueryKey | undefined,
): TData | undefined {
  if (previousData === undefined || !previousQueryKey) return undefined;
  if (previousQueryKey.length !== queryKey.length) return undefined;
  const onlyTheViewDiffers = queryKey.every(
    (segment, index) => index === VIEW_KEY_INDEX || segment === previousQueryKey[index],
  );
  return onlyTheViewDiffers ? previousData : undefined;
}

export type UsePlaylistClimbsOptions = {
  playlistUuid: string;
  /** Stable query-key segment identifying the selected board (or 'all'). */
  boardUuid?: string | null;
  /** Bump to force a fresh fetch (e.g. after editing the playlist). Part of
   *  the query key. Defaults to 0. */
  refreshKey?: number;
  /** Board-scoping query input. When omitted, climbs are fetched all-boards. */
  boardInput?: PlaylistClimbsBoardInput;
  /** Sort and filters. Omit (or pass undefined) for the playlist's own order:
   *  the request then carries no `view` at all, exactly as before views. */
  view?: PlaylistClimbsView;
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
  view,
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
  const angleKey = playlistClimbsAngleKey(boardInput);
  const queryKey = useMemo(
    () => playlistClimbsQueryKey({ playlistUuid, boardUuid, angle: angleKey, view, refreshKey }),
    [playlistUuid, boardUuid, angleKey, view, refreshKey],
  );
  // A new function whenever anything but the view changes: React Query keeps a
  // showing placeholder without asking again while this identity holds. The
  // view segment is left null because the rule never reads it.
  const placeholderData = useMemo(() => {
    const keyAroundView: QueryKey = ['playlistClimbs', playlistUuid, boardUuid ?? 'all', angleKey, null, refreshKey];
    return (
      previousData: InfiniteData<PlaylistClimbsResult, number> | undefined,
      previousQuery: { queryKey: QueryKey } | undefined,
    ) => keepPreviousViewResults(keyAroundView, previousData, previousQuery?.queryKey);
  }, [playlistUuid, boardUuid, angleKey, refreshKey]);

  const query = useInfiniteQuery({
    queryKey,
    queryFn: async ({ pageParam }) => {
      const input: GetPlaylistClimbsInput = {
        playlistId: playlistUuid,
        page: pageParam,
        pageSize,
        ...boardInput,
        ...(view ? { view } : {}),
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
    placeholderData,
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
