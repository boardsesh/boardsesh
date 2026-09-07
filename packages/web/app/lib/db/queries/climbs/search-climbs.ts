import 'server-only';
import { unstable_cache } from 'next/cache';
import { getReadDb } from '@/app/lib/db/db';
import { searchClimbs as sharedSearchClimbs, mapSearchInputToParams } from '@boardsesh/db/queries';
import { getBoardClimbSearchTag } from '@/app/lib/climb-search-cache';
import type { ParsedBoardRouteParameters, SearchRequestPagination, BoardName, Climb } from '@/app/lib/types';
import { sortObjectKeys } from '@/app/lib/cache-utils';
import { isNoMatch, isNoMatchClimb, usesAuroraNoMatchDescription } from '@/app/lib/no-match-climb';
import { withReadDeadline } from '@/app/lib/db/read-deadline';

/**
 * Cache durations for climb search queries (in seconds)
 */
const CACHE_DURATION_DEFAULT_SEARCH = 24 * 60 * 60; // 24 hours for default searches
const CACHE_DURATION_FILTERED_SEARCH = 60 * 60; // 1 hour for filtered searches
/**
 * MoonBoard front doors only. Short enough that an in-progress import shows up
 * within a quarter hour — the freshness the blanket bypass below was protecting
 * — but not so short that a crawler pays a live search per page view. MoonBoard
 * is the largest board in the catalogue, so it is also the biggest single
 * contributor to the crawl surface.
 */
const CACHE_DURATION_MOONBOARD_FRONT_DOOR = 15 * 60;

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
  //
  // The deadline is what stops a saturated pool turning this into an unbounded
  // wait — postgres.js queues with no acquire timeout. drizzle exposes no
  // `.cancel()`, so this bounds the caller, not the statement.
  const result = await withReadDeadline(
    'climb-search',
    sharedSearchClimbs(db, params, mapSearchInputToParams(searchParams), userId),
  );

  const climbs: Climb[] = result.climbs.map((row) => ({
    ...row,
    mirrored: undefined,
    // Prefer the structured characteristic; fall back to the Aurora description
    // convention for rows synced before the column was backfilled.
    is_no_match:
      row.characteristics != null
        ? isNoMatch(row.characteristics)
        : usesAuroraNoMatchDescription(params.board_name) && isNoMatchClimb(row.description),
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
    // v6: onlyBenchmarks now included in buildClimbSearchParamsJson (was previously
    // omitted entirely, so the SSR path never forwarded it — see issue #2320). The key
    // rotates naturally since the JSON payload gains a field, but bumping documents intent.
    // v7: searches past the stats-having boundary now return stats-less climbs (issue
    // #1971), and the stats-driven fallback orders stats-having climbs ahead of
    // stats-less ones — cached truncated pages must not keep serving the old result.
    // v8: rows now carry compatibleSizeIds; a cached v7 row lacks it, which reads
    // as "no compatibility data" and switches the client-side size check off.
    fn = unstable_cache(_executeClimbSearch, [`climb-search-v9:${boardName}`], {
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
      // Only key on a non-empty seed. Random bypasses this cache entirely, so this
      // just stops a stale `sortSeed` on a non-random URL from sharding the key.
      ...(searchParams.sortSeed ? { sortSeed: searchParams.sortSeed } : {}),
      name: searchParams.name,
      settername: searchParams.settername,
      onlyBenchmarks: searchParams.onlyBenchmarks,
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
  // MoonBoard list data is still being actively imported/curated, so it bypasses
  // the server cache by default to surface new climbs immediately — except when
  // a caller asks for caching explicitly. Only the `/list` front door does
  // (`fetchFrontDoorListPage`), and every one of those renders was a live search
  // on the biggest board in the catalogue; a 15-minute entry keeps the import
  // freshness the bypass was protecting, and `revalidateClimbSearchTags` still
  // clears it on demand via the board-level tag.
  //
  // Random sort bypasses unconditionally: each shuffle carries a unique ~31-bit
  // seed, so caching per seed is a 0%-hit-rate entry that only bloats the
  // Next.js data cache.
  const isMoonboard = params.board_name === 'moonboard';
  const explicitlyCacheable = options?.cacheable === true;
  const cacheable =
    (options?.cacheable ?? !userId) && searchParams.sortBy !== 'random' && (explicitlyCacheable || !isMoonboard);

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

  // Keyed on the board, not on `explicitlyCacheable`: the front door is the only
  // cacheable MoonBoard caller today, and if a second one appears it inherits
  // the *shorter* TTL — erring toward import freshness rather than away from it.
  const revalidate = isMoonboard
    ? CACHE_DURATION_MOONBOARD_FRONT_DOOR
    : isDefaultSearch
      ? CACHE_DURATION_DEFAULT_SEARCH
      : CACHE_DURATION_FILTERED_SEARCH;
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
