import 'server-only';
import { unstable_cache } from 'next/cache';
import { getReadDb } from '@/app/lib/db/db';
import { searchClimbs as sharedSearchClimbs, mapSearchInputToParams } from '@boardsesh/db/queries';
import { getBoardClimbSearchTag } from '@/app/lib/climb-search-cache';
import type { ParsedBoardRouteParameters, SearchRequestPagination, BoardName, Climb } from '@/app/lib/types';
import { sortObjectKeys } from '@/app/lib/cache-utils';

/**
 * Cache durations for climb search queries (in seconds)
 */
const CACHE_DURATION_DEFAULT_SEARCH = 24 * 60 * 60; // 24 hours for default searches
const CACHE_DURATION_FILTERED_SEARCH = 60 * 60; // 1 hour for filtered searches

/**
 * Module-level query function with explicit arguments so unstable_cache holds a
 * stable function reference across requests. The board params are passed as
 * primitives and the search params as a pre-sorted JSON string to guarantee
 * deterministic cache key generation.
 */
async function _executeClimbSearch(
  boardName: string,
  layoutId: number,
  sizeId: number,
  setIdsStr: string,
  angle: number,
  searchParamsJson: string,
  userId: string | undefined,
): Promise<{ climbs: Climb[]; hasMore: boolean }> {
  const params: ParsedBoardRouteParameters = {
    board_name: boardName as BoardName,
    layout_id: layoutId,
    size_id: sizeId,
    set_ids: setIdsStr.split(',').map(Number),
    angle,
  };
  const searchParams = JSON.parse(searchParamsJson) as SearchRequestPagination;

  const db = getReadDb();
  // `mapSearchInputToParams` lives in `@boardsesh/db` so the SSR path and the
  // GraphQL resolver share the same input → params shape. Don't duplicate the
  // falsy-collapse rules here.
  const result = await sharedSearchClimbs(db, params, mapSearchInputToParams(searchParams), userId);

  const climbs: Climb[] = result.climbs.map((row) => ({
    ...row,
    mirrored: undefined,
    is_no_match: /^no match/i.test(row.description || ''),
  }));

  return { climbs, hasMore: result.hasMore };
}

type CachedClimbSearchFn = (
  boardName: string,
  layoutId: number,
  sizeId: number,
  setIdsStr: string,
  angle: number,
  searchParamsJson: string,
  userId: string | undefined,
) => Promise<{ climbs: Climb[]; hasMore: boolean }>;

/**
 * Lazily-created unstable_cache instances, one per (boardName, revalidate) pair.
 * Keeping them board-scoped preserves board-specific cache tag invalidation:
 * revalidateTag('climb-search:kilter') still targets only kilter entries.
 *
 * Layout-level tags are dropped (they were previously used for per-layout
 * invalidation on climb save). Board-level invalidation covers that use case —
 * revalidateClimbSearchTags always calls the board-level revalidateTag too.
 */
const _cacheRegistry = new Map<string, CachedClimbSearchFn>();

function _getCachedFn(boardName: BoardName, revalidate: number): CachedClimbSearchFn {
  const key = `${boardName}:${revalidate}`;
  let fn = _cacheRegistry.get(key);
  if (!fn) {
    // Bumped when search result content changes; keep in lockstep with the backend
    // Redis CACHE_VERSION. v4: hold LIKE / minRating / popular NULL / ILIKE / zone.
    // v5: stars now maps quality_average 1-5 to 0-5 (was the saturating 0-15 scale).
    fn = unstable_cache(_executeClimbSearch, [`climb-search-v5:${boardName}`], {
      revalidate,
      tags: ['climb-search', getBoardClimbSearchTag(boardName)],
    });
    _cacheRegistry.set(key, fn);
  }
  return fn;
}

export function buildClimbSearchParamsJson(searchParams: SearchRequestPagination): string {
  return JSON.stringify(
    sortObjectKeys({
      page: searchParams.page,
      pageSize: searchParams.pageSize,
      gradeAccuracy: searchParams.gradeAccuracy,
      minGrade: searchParams.minGrade,
      maxGrade: searchParams.maxGrade,
      minAscents: searchParams.minAscents,
      minRating: searchParams.minRating,
      sortBy: searchParams.sortBy,
      sortOrder: searchParams.sortOrder,
      name: searchParams.name,
      settername: searchParams.settername,
      onlyTallClimbs: searchParams.onlyTallClimbs,
      onlyWideClimbs: searchParams.onlyWideClimbs,
      onlyWithBetaVideos: searchParams.onlyWithBetaVideos,
      holdsFilter: searchParams.holdsFilter,
      zoneBox: searchParams.zoneBox,
      zoneMode: searchParams.zoneBox ? searchParams.zoneMode : undefined,
      hideAttempted: searchParams.hideAttempted,
      hideCompleted: searchParams.hideCompleted,
      showOnlyAttempted: searchParams.showOnlyAttempted,
      showOnlyCompleted: searchParams.showOnlyCompleted,
      onlyDrafts: searchParams.onlyDrafts,
      projectsOnly: searchParams.projectsOnly,
      boulders: searchParams.boulders,
      routes: searchParams.routes,
    }),
  );
}

/**
 * Search for climbs directly from the database (no GraphQL round-trip).
 * Used by SSR page components for faster initial page loads.
 *
 * @param params Board route parameters
 * @param searchParams Search/filter parameters from URL
 * @param isDefaultSearch Whether this is a default/unfiltered search (caches longer)
 * @param userId Optional user ID for personal progress filters
 */
export async function cachedSearchClimbs(
  params: ParsedBoardRouteParameters,
  searchParams: SearchRequestPagination,
  isDefaultSearch: boolean,
  userId?: string,
  options?: { cacheable?: boolean },
): Promise<{ climbs: Climb[]; hasMore: boolean }> {
  // MoonBoard list data is still being actively imported/curated, so bypass
  // the server cache there to surface new climbs immediately.
  const cacheable = (options?.cacheable ?? !userId) && params.board_name !== 'moonboard';

  const setIdsStr = [...params.set_ids].sort((a, b) => a - b).join(',');
  const searchParamsJson = buildClimbSearchParamsJson(searchParams);

  if (!cacheable) {
    return _executeClimbSearch(
      params.board_name,
      params.layout_id,
      params.size_id,
      setIdsStr,
      params.angle,
      searchParamsJson,
      userId,
    );
  }

  const revalidate = isDefaultSearch ? CACHE_DURATION_DEFAULT_SEARCH : CACHE_DURATION_FILTERED_SEARCH;
  return _getCachedFn(params.board_name, revalidate)(
    params.board_name,
    params.layout_id,
    params.size_id,
    setIdsStr,
    params.angle,
    searchParamsJson,
    userId,
  );
}
