import { useMemo } from 'react';
import { replaceEqualDeep, useInfiniteQuery, type InfiniteData, type QueryKey } from '@tanstack/react-query';
import type { ClimbSearchInput } from '@boardsesh/shared-schema';
import { getBoardCapabilities } from '@boardsesh/board-config';
import { useFeatureFlag } from '../../../providers/feature-flags-provider';
import { offlineAwareRequest } from '../offline-request';
import { SEARCH_CLIMBS, type SearchClimbsQueryResponse } from '../operations';
import { INFINITE_SEARCH_CLIMBS_QUERY_KEY } from '../query-keys';
import { useStoredUserId } from '../../../hooks/use-current-user-id';
import { screenshotModeNextPageParam } from '../../screenshot-mode';
import { useGradeSourceSearchInput } from './search-grade-source';
import { getPrivacyRevocationGeneration } from '../../privacy/privacy-cache';

// Query data is shared across observers and survives observer remounts. Its
// provenance must do the same; weak keys do not retain evicted cache snapshots.
const searchClimbSnapshotGenerations = new WeakMap<object, number>();

/** Preserve equal rows only when both reads belong to the same privacy epoch. */
function createSearchClimbsSharing() {
  const initialGeneration = getPrivacyRevocationGeneration();
  const generations = searchClimbSnapshotGenerations;
  const remember = (snapshot: object, generation: number) => {
    // An already-known projection must never acquire new authorization.
    if (!generations.has(snapshot)) generations.set(snapshot, generation);
  };
  const rememberSharedPages = (snapshot: unknown, generation: number) => {
    if (!isRecord(snapshot)) return;
    remember(snapshot, generation);
    if (!Array.isArray(snapshot.pages)) return;
    for (const page of snapshot.pages) {
      if (!isRecord(page)) continue;
      remember(page, generation);
      if (isRecord(page.searchClimbs)) remember(page.searchClimbs, generation);
    }
  };
  const generationFor = (snapshot: unknown): number => {
    if (!isRecord(snapshot)) return initialGeneration;
    const knownGeneration = generations.get(snapshot);
    if (knownGeneration !== undefined) return knownGeneration;
    // React Query invokes sharing for both raw InfiniteData and selected data.
    // Their wrappers are new, but each constituent page has read provenance.
    const generation =
      Array.isArray(snapshot.pages) && snapshot.pages.length > 0
        ? Math.min(...snapshot.pages.map(generationFor))
        : initialGeneration;
    remember(snapshot, generation);
    return generation;
  };
  return {
    rememberResponse(response: SearchClimbsQueryResponse, generation: number) {
      remember(response, generation);
      remember(response.searchClimbs, generation);
    },
    structuralSharing: (previous: unknown, incoming: unknown): unknown => {
      const incomingGeneration = generationFor(incoming);
      const shared =
        previous !== undefined && generationFor(previous) === incomingGeneration
          ? replaceEqualDeep(previous, incoming)
          : incoming;
      // Equal-deep sharing can construct page wrappers around shared rows.
      // Carry the read epoch through those wrappers into the select stage too.
      rememberSharedPages(shared, incomingGeneration);
      return shared;
    },
  };
}

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
  const privacySharing = useMemo(createSearchClimbsSharing, []);
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
  // key rotates by itself when the flag or the filter flips. Always an explicit
  // boolean, so the server never has to guess what an absent value meant.
  //
  // On an angle-bound board (Woods) the climber decides: the "Other angles" filter
  // switch sets `input.crossAngleStats` through `toClimbSearchInput`, and off (the
  // default) keeps the list to climbs set at the browsed angle. The flag is ignored
  // there, so the list always matches the switch the climber can see.
  //
  // Everywhere else the flag can also turn it on. Unresolved reads as off, which is
  // the shipped behaviour for every board this flag can move — nothing to invert.
  // `useFeatureFlag` runs on every board so the hook order never changes.
  //
  // It is deliberately NOT part of the placeholder's board scope above: flipping it
  // keeps the previous rows on screen while the re-ranked page loads, which is the
  // same board and the right behaviour.
  const crossAngleStatsFlagOn = useFeatureFlag('cross-angle-stats') === true;
  const crossAngleStatsRequested = input.crossAngleStats === true;
  const crossAngleStats = getBoardCapabilities(boardName).angleBoundClimbs
    ? crossAngleStatsRequested
    : crossAngleStatsRequested || crossAngleStatsFlagOn;
  // The grade source rides the input the same way, so flipping "Show Boardsesh
  // grades" rotates the query key and refetches (issue #5643). Like the flag
  // above it stays out of the placeholder's board scope.
  const searchInput: ClimbSearchInput = useGradeSourceSearchInput({ ...input, crossAngleStats });
  return useInfiniteQuery({
    queryKey: [...getSearchClimbsQueryKey(searchInput), ...(input.onlyFollowedAuthors ? [userId] : [])],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const generation = getPrivacyRevocationGeneration();
      const response = await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, {
        input: { ...searchInput, page: pageParam },
      });
      // offlineAwareRequest fences responses crossing a privacy boundary.
      // Keep the original read epoch even if a caller retains its projection.
      privacySharing.rememberResponse(response, generation);
      return response;
    },
    structuralSharing: privacySharing.structuralSharing,
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
}
