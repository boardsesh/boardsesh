import { useMemo } from 'react';
import { useInfiniteQuery, type InfiniteData, type QueryKey, type UseInfiniteQueryResult } from '@tanstack/react-query';
import {
  GET_SMART_PLAYLIST,
  type GetSmartPlaylistInput,
  type GetSmartPlaylistQueryResponse,
  type SmartPlaylistMeta,
  type SmartPlaylistResult,
  type SmartPlaylistType,
} from '@boardsesh/graphql/operations/playlists';
import type { Climb } from '@boardsesh/queue';
import { usePlaylistsAdapter, type ExecutePlaylistsGraphQL } from './adapter';
import { keepPreviousViewResults, type PlaylistClimbsView, type ViewQueryKeyLayout } from './use-playlist-climbs';

/** The active board a smart list's view reads (its active-board filters), as the request sends it. */
export type SmartPlaylistActiveBoardInput = Pick<
  GetSmartPlaylistInput,
  'activeBoardName' | 'activeAngle' | 'activeLayoutId' | 'activeSizeId' | 'activeSetIds'
>;

/** What a smart list's query key is built from. */
export type SmartPlaylistQueryKeyParts = {
  smartPlaylistType: SmartPlaylistType;
  userId: string;
  boardUuid?: string | null;
  /** The recommendation size and angle overrides. */
  sizeId?: number;
  angle?: number;
  /** The active board a view's request sends (`smartPlaylistGeometryKey`), or null when it sends none. */
  geometry?: string | null;
  view?: PlaylistClimbsView;
};

/** A smart list's key: the geometry after the board and the recommendation overrides, then the view. */
const SMART_PLAYLIST_KEY_LAYOUT: ViewQueryKeyLayout = { geometryIndex: 6, viewIndex: 7 };

/**
 * The React Query key one view of a smart list is cached under. Fixed length,
 * so the placeholder rule (`keepPreviousViewResults`) can find the geometry and
 * the view by position. The view is the object itself, which React Query hashes
 * with its keys sorted.
 */
export function smartPlaylistQueryKey({
  smartPlaylistType,
  userId,
  boardUuid,
  sizeId,
  angle,
  geometry,
  view,
}: SmartPlaylistQueryKeyParts) {
  return [
    'smartPlaylist',
    smartPlaylistType,
    userId,
    boardUuid ?? 'all',
    sizeId ?? null,
    angle ?? null,
    geometry ?? null,
    view ?? 'default',
  ] as const;
}

/**
 * The geometry segment: the active board, angle included (a view's progress and
 * rating filters read the ticks at it), or null without one. Only a request with
 * a view sends it, so only that request's key carries it.
 */
export function smartPlaylistGeometryKey(activeBoardInput: SmartPlaylistActiveBoardInput | undefined): string | null {
  if (!activeBoardInput?.activeBoardName) return null;
  const { activeBoardName, activeAngle, activeLayoutId, activeSizeId, activeSetIds } = activeBoardInput;
  return [activeBoardName, activeAngle ?? '', activeLayoutId ?? '', activeSizeId ?? '', activeSetIds ?? ''].join('|');
}

export type UseSmartPlaylistOptions = {
  smartPlaylistType: SmartPlaylistType;
  userId: string;
  /** Stable query-key segment identifying the selected board (or 'all'). */
  boardUuid?: string | null;
  /** Optional board name forwarded as the `boardName` query input. */
  boardName?: string;
  /** Optional board geometry forwarded to the existing smart-playlist input. */
  sizeId?: number;
  angle?: number;
  /** Page size per page. Defaults to 20. */
  pageSize?: number;
  /**
   * Sort and filters, on the logbook lists only (a recommendation rejects one).
   * Omit for the list's own order: the request then carries no view and no
   * active-board fields, exactly as before views.
   */
  view?: PlaylistClimbsView;
  /** The active board the view's active-board filters read. Sent only with a view. */
  activeBoardInput?: SmartPlaylistActiveBoardInput;
  /** True while the token is still resolving — disables the query until ready. */
  tokenLoading?: boolean;
  /** SSR-fetched first page so the hero + climbs paint without a spinner. */
  initialData?: SmartPlaylistResult | null;
  /** Whether the SSR payload still matches the live query key. Gates both
   *  `initialData` and `initialDataUpdatedAt` so they can never disagree. */
  initialDataApplicable?: boolean;
  /** Timestamp the SSR payload was fetched at, so react-query honours
   *  staleTime instead of refetching immediately (defaults to epoch). */
  initialDataUpdatedAt?: number;
  /** Override the adapter's `executeGraphQL` (used in tests). */
  executeGraphQL?: ExecutePlaylistsGraphQL;
};

export type UseSmartPlaylistResult = {
  query: UseInfiniteQueryResult<InfiniteData<SmartPlaylistResult>>;
  allClimbs: Climb[];
  meta?: SmartPlaylistMeta;
};

/**
 * Paginated smart-playlist climbs for a user. Flattens the infinite-query
 * pages into a single `allClimbs` list and surfaces the first page's `meta`.
 */
export function useSmartPlaylist({
  smartPlaylistType,
  userId,
  boardUuid,
  boardName,
  sizeId,
  angle,
  pageSize = 20,
  view,
  activeBoardInput,
  tokenLoading = false,
  initialData,
  initialDataApplicable = false,
  initialDataUpdatedAt = 0,
  executeGraphQL: executeGraphQLOverride,
}: UseSmartPlaylistOptions): UseSmartPlaylistResult {
  const adapter = usePlaylistsAdapter();
  const executeGraphQL = executeGraphQLOverride ?? adapter.executeGraphQL;

  // The active board rides along only with a view, so only then is it in the key.
  const geometryKey = view ? smartPlaylistGeometryKey(activeBoardInput) : null;
  const queryKey = useMemo(
    () => smartPlaylistQueryKey({ smartPlaylistType, userId, boardUuid, sizeId, angle, geometry: geometryKey, view }),
    [smartPlaylistType, userId, boardUuid, sizeId, angle, geometryKey, view],
  );
  // While a new view loads, the rows of the same list and board under the
  // previous view stay up (the playlist rule, at the smart key's positions). A
  // new function whenever anything but the view changes, so a showing
  // placeholder is never reused across lists or boards.
  const placeholderData = useMemo(() => {
    const keyAroundView: QueryKey = smartPlaylistQueryKey({
      smartPlaylistType,
      userId,
      boardUuid,
      sizeId,
      angle,
      geometry: geometryKey,
    });
    return (
      previousData: InfiniteData<SmartPlaylistResult, number> | undefined,
      previousQuery: { queryKey: QueryKey } | undefined,
    ) => keepPreviousViewResults(keyAroundView, previousData, previousQuery?.queryKey, SMART_PLAYLIST_KEY_LAYOUT);
  }, [smartPlaylistType, userId, boardUuid, sizeId, angle, geometryKey]);

  const query = useInfiniteQuery({
    queryKey,
    queryFn: async ({ pageParam }) => {
      const input: GetSmartPlaylistInput = {
        type: smartPlaylistType,
        userId,
        page: pageParam,
        pageSize,
        ...(boardName !== undefined && { boardName }),
        ...(sizeId !== undefined && { sizeId }),
        ...(angle !== undefined && { angle }),
        // Recommendations resolve the target from this specific owned board;
        // logbook playlists ignore it.
        ...(boardUuid ? { boardUuid } : {}),
        // Nothing new without a view: the default request is the one sent
        // before views existed, which an older backend still answers.
        ...(view ? { ...activeBoardInput, view } : {}),
      };
      const response = await executeGraphQL<GetSmartPlaylistQueryResponse, { input: GetSmartPlaylistInput }>(
        GET_SMART_PLAYLIST,
        { input },
      );
      return response.smartPlaylist;
    },
    enabled: !tokenLoading,
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => (lastPage.hasMore ? allPages.length : undefined),
    staleTime: 5 * 60 * 1000,
    placeholderData,
    // Only seed when the current query key still matches the tuple the SSR
    // payload was fetched for. Beyond the obvious first-render case this also
    // avoids re-applying stale SSR data if the user switches away from and
    // back to the default view much later.
    initialData:
      initialDataApplicable && initialData
        ? {
            pages: [initialData],
            pageParams: [0],
          }
        : undefined,
    initialDataUpdatedAt: initialDataApplicable ? initialDataUpdatedAt : 0,
  });

  const allClimbs: Climb[] = useMemo(
    () => query.data?.pages.flatMap((page) => page.climbs as Climb[]) ?? [],
    [query.data],
  );

  const meta: SmartPlaylistMeta | undefined = query.data?.pages[0]?.meta ?? initialData?.meta;

  return { query, allClimbs, meta };
}
