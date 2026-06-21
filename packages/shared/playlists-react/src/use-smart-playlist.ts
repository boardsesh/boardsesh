import { useMemo } from 'react';
import { useInfiniteQuery, type UseInfiniteQueryResult, type InfiniteData } from '@tanstack/react-query';
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

export type UseSmartPlaylistOptions = {
  smartPlaylistType: SmartPlaylistType;
  userId: string;
  /** Stable query-key segment identifying the selected board (or 'all'). */
  boardUuid?: string | null;
  /** Optional board name forwarded as the `boardName` query input. */
  boardName?: string;
  /** Page size per page. Defaults to 20. */
  pageSize?: number;
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
  pageSize = 20,
  tokenLoading = false,
  initialData,
  initialDataApplicable = false,
  initialDataUpdatedAt = 0,
  executeGraphQL: executeGraphQLOverride,
}: UseSmartPlaylistOptions): UseSmartPlaylistResult {
  const adapter = usePlaylistsAdapter();
  const executeGraphQL = executeGraphQLOverride ?? adapter.executeGraphQL;

  const query = useInfiniteQuery({
    queryKey: ['smartPlaylist', smartPlaylistType, userId, boardUuid ?? 'all'],
    queryFn: async ({ pageParam }) => {
      const input: GetSmartPlaylistInput = {
        type: smartPlaylistType,
        userId,
        page: pageParam,
        pageSize,
        ...(boardName !== undefined && { boardName }),
        // Recommendations resolve the target from this specific owned board;
        // logbook playlists ignore it.
        ...(boardUuid ? { boardUuid } : {}),
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
