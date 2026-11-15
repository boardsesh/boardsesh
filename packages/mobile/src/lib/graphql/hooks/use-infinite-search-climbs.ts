import { useEffect, useMemo, useRef } from 'react';
import { hashKey, useInfiniteQuery, useQueryClient, type InfiniteData, type QueryKey } from '@tanstack/react-query';
import type { ClimbSearchInput } from '@boardsesh/shared-schema';
import { useFeatureFlag } from '../../../providers/feature-flags-provider';
import { offlineAwareRequest } from '../offline-request';
import { SEARCH_CLIMBS, type SearchClimbsQueryResponse } from '../operations';
import { INFINITE_SEARCH_CLIMBS_QUERY_KEY } from '../query-keys';
import { useStoredUserId } from '../../../hooks/use-current-user-id';
import { screenshotModeNextPageParam } from '../../screenshot-mode';
import { useGradeSourceSearchInput } from './search-grade-source';
import { resolveSearchCrossAngleStats } from './search-cross-angle-stats';

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
  const { userId } = useStoredUserId(!!input.onlyFollowedAuthors);
  const keepPreviousResults = options?.keepPreviousResults === true && !input.onlyFollowedAuthors;
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

  // Resolved here rather than at the call sites: this is the one choke point both
  // the climbs tab and the board preview go through, it rides `offlineAwareRequest`
  // into the on-device search for free, and putting it on the input means the query
  // key rotates by itself when the flag or the filter flips. The rule is
  // `resolveSearchCrossAngleStats`. Unresolved reads as off, which is the
  // shipped behaviour for every board this flag can move — nothing to invert.
  // `useFeatureFlag` runs on every board so the hook order never changes.
  //
  // It is deliberately NOT part of the placeholder's board scope above: flipping it
  // keeps the previous rows on screen while the re-ranked page loads, which is the
  // same board and the right behaviour.
  const crossAngleStatsFlagOn = useFeatureFlag('cross-angle-stats') === true;
  const crossAngleStats = resolveSearchCrossAngleStats(input, crossAngleStatsFlagOn);
  // The grade source rides the input the same way, so flipping "Show Boardsesh
  // grades" rotates the query key and refetches (issue #5643). Like the flag
  // above it stays out of the placeholder's board scope.
  const searchInput: ClimbSearchInput = useGradeSourceSearchInput({ ...input, crossAngleStats });
  const queryClient = useQueryClient();
  const queryKey = [...getSearchClimbsQueryKey(searchInput), ...(input.onlyFollowedAuthors ? [userId] : [])];
  const query = useInfiniteQuery({
    queryKey,
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, {
        input: { ...searchInput, page: pageParam },
      }),
    // getNextPageParam receives RAW pre-select pages in React Query v5.
    getNextPageParam: (lastPage, allPages) =>
      screenshotModeNextPageParam(lastPage.searchClimbs.hasMore ? allPages.length : undefined, allPages.length),
    select: selectSearchClimbPages,
    placeholderData,
    enabled: enabled && (!input.onlyFollowedAuthors || !!userId),
    // Preserve the provider's offlineFirst default for downloaded-board reads.
    ...(input.onlyFollowedAuthors ? { networkMode: 'always' as const } : {}),
    staleTime: options?.staleTime,
    gcTime: options?.gcTime,
  });

  // A search whose first attempt failed (a wifi drop mid-request) and whose
  // retry then paused because the phone went offline sits in `pending` until
  // the signal returns: the previous search's rows tinted as "loading", or
  // skeleton rows on a first load or board switch, the whole time. Ask again
  // instead: under `offlineFirst` the first attempt of a new fetch runs even
  // offline, and `offlineAwareRequest` answers it on-device or with its offline
  // fallback, which the screen already knows how to explain. The paused fetch
  // is cancelled first because `refetch` on a query with no data of its own
  // only nudges the paused retryer, which stays paused.
  //
  // `status` reads `success` while a placeholder is up, so "still waiting for
  // its own answer" is pending OR showing a placeholder.
  //
  // Once per search per settled state: the guard is the key plus when the
  // query last got data or an error. A re-ask that pauses again changes
  // neither, so it can't loop, and the cancel's brief revert to an earlier
  // state can't clear it. A search that settles and later pauses again (an
  // error, then a sync invalidation's refetch) has a new stamp and is re-asked.
  //
  // Backgrounding the app mid-retry also pauses it (focus, not connectivity);
  // the re-ask then costs one request, and a re-pause resumes on foreground.
  const { fetchStatus, isPending, isPlaceholderData, dataUpdatedAt, errorUpdatedAt } = query;
  const searchHash = hashKey(queryKey);
  const isWaitingForOwnAnswer = isPending || isPlaceholderData;
  const reaskedSearchRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isWaitingForOwnAnswer || fetchStatus !== 'paused') return;
    const guard = `${searchHash}|${dataUpdatedAt}|${errorUpdatedAt}`;
    if (reaskedSearchRef.current === guard) return;
    reaskedSearchRef.current = guard;
    const pausedKey = queryClient.getQueryCache().get(searchHash)?.queryKey;
    if (!pausedKey) return;
    void queryClient
      .cancelQueries({ queryKey: pausedKey, exact: true })
      .then(() => queryClient.refetchQueries({ queryKey: pausedKey, exact: true }));
  }, [isWaitingForOwnAnswer, fetchStatus, searchHash, dataUpdatedAt, errorUpdatedAt, queryClient]);

  return query;
}
