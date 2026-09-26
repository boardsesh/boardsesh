import { USER_SPECIFIC_SEARCH_PARAMS, type Climb } from '@boardsesh/shared-schema';
import type { ClimbSearchParams, ParsedBoardRouteParameters } from '../../../db/queries/climbs/index';
import { DEFAULT_SEARCH_CACHE_TTL, searchCache } from '../../../services/search-cache';
import { readThroughRedis } from '../../../utils/redis-read-through';

/**
 * A shared page cache and a concurrency gate in front of the popular sort.
 *
 * ## Why the popular sort gets its own treatment
 *
 * `sortBy: 'popular'` ranks by a climb's ascents summed over EVERY angle, and
 * `searchClimbs` computes that sum on each call: a layout-wide `SUM ... GROUP
 * BY climb_uuid` over `board_climb_stats` (the `popular_counts` subquery in
 * `packages/db/src/queries/climbs/search-climbs.ts`). On production that
 * statement averaged 20.2 s and wrote about 2.4 GB of temp per call. On the DR
 * replica, Kilter layout 1 at 40° takes about 1.5 s and 125k buffers warm, and
 * that cost does not move with the page: OFFSET 0, 2,000 and 10,000 all read
 * the same 125,279 buffers. Every page of an infinite scroll pays for the whole
 * aggregate again.
 *
 * The permanent fix is a precomputed popularity table (C9, second half). This
 * is the first half: make sure the aggregate runs at most once per page per
 * ten minutes across the fleet, and at most one copy at a time per process.
 *
 * ## What it covers
 *
 * - Boards the 24 h search cache already covers (every board but MoonBoard,
 *   Woods and spray, when the search has no user-specific filters) keep that
 *   key and TTL. Their miss now runs through single-flight, so a burst of
 *   identical first requests runs one copy of the aggregate, not N.
 * - MoonBoard and Woods are excluded from the 24 h cache because climbs are
 *   created under the search. A popular page tolerates ten minutes of that: a
 *   new climb has no ascents, so it sorts to the tail of the popular order
 *   (`NULLS LAST`) and would not appear on an early page anyway. The web
 *   MoonBoard front door already accepts 15 minutes for the same reason.
 *
 * ## What it never covers
 *
 * - Any search with a user-specific filter (`USER_SPECIFIC_SEARCH_PARAMS`:
 *   hide sent, personal ratings and grades, followed setters, drafts). Those
 *   pages differ per climber, so they bypass this cache entirely.
 * - Spray walls. A spray page is keyed by layout, not viewer, so one owner's
 *   private wall would be served to the next caller who asked for it.
 *
 * ## No OFFSET cap
 *
 * The audit paired the popularity table with an OFFSET cap. For this path it
 * buys nothing: the measurements above show the aggregate dominates and a deep
 * page costs the same as page 0. The existing `MAX_SEARCH_PAGE` clamp stays the
 * only bound, and the GraphQL contract is unchanged.
 */

/** Ten minutes: the freshness MoonBoard and Woods popular pages give up. */
export const POPULAR_PAGE_CACHE_TTL_SECONDS = 600;

/** Key suffix for the pages only this cache writes (MoonBoard, Woods). */
const POPULAR_PAGE_KEY_SUFFIX = 'popular-page';

/** The 24 h search cache's suffix, shared so a popular page lands where it always did. */
const SEARCH_CACHE_CLIMBS_SUFFIX = 'climbs';

export type PopularPage = {
  climbs: Climb[];
  hasMore: boolean;
};

/** Where a popular page came from, for the search latency log. */
export type PopularPageSource = 'db' | 'redis';

/**
 * True when a search is a popular-sort page that every viewer sees the same
 * way. Reads the same `USER_SPECIFIC_SEARCH_PARAMS` list the resolver uses to
 * decide whether to resolve a viewer at all, so the two cannot drift.
 */
export function isPopularPageCacheable(boardName: string, searchParams: ClimbSearchParams): boolean {
  if (boardName === 'spray') return false;
  if (searchParams.sortBy !== 'popular') return false;
  return !USER_SPECIFIC_SEARCH_PARAMS.some((param) => !!searchParams[param as keyof ClimbSearchParams]);
}

/**
 * The Redis key and TTL a popular page is stored under. Every input that
 * changes the page is in the key: board, layout, size, sets and angle as key
 * segments, and every search param (filters, sort, order, page, pageSize) in
 * the params hash. Nothing per-viewer is, because a page is only cached when
 * no user-specific filter is set.
 */
export function popularPageCacheSlot(
  params: ParsedBoardRouteParameters,
  searchParams: ClimbSearchParams,
  coveredBySearchCache: boolean,
): { key: string; ttlSeconds: number } {
  if (coveredBySearchCache) {
    return {
      key: searchCache.buildCacheKey(params, searchParams, SEARCH_CACHE_CLIMBS_SUFFIX),
      ttlSeconds: DEFAULT_SEARCH_CACHE_TTL,
    };
  }
  return {
    key: searchCache.buildCacheKey(params, searchParams, POPULAR_PAGE_KEY_SUFFIX),
    ttlSeconds: POPULAR_PAGE_CACHE_TTL_SECONDS,
  };
}

/**
 * Read one popular page through Redis, collapsing concurrent misses for the
 * same key to one database read per process.
 *
 * An unreachable Redis degrades to single-flight alone: the page is read from
 * the database, and concurrent identical requests still share one read.
 *
 * `source` is `db` only for the caller that ran `load`. A caller that joined
 * another's in-flight read reports `redis`, because it did not touch the
 * database either.
 */
export async function readPopularPage(options: {
  params: ParsedBoardRouteParameters;
  searchParams: ClimbSearchParams;
  coveredBySearchCache: boolean;
  load: () => Promise<PopularPage>;
}): Promise<{ page: PopularPage; source: PopularPageSource }> {
  const { params, searchParams, coveredBySearchCache, load } = options;
  const { key, ttlSeconds } = popularPageCacheSlot(params, searchParams, coveredBySearchCache);

  let loadedHere = false;
  const page = await readThroughRedis<PopularPage>({
    key,
    ttlSeconds,
    label: 'PopularPageCache',
    load: async () => {
      loadedHere = true;
      const { climbs, hasMore } = await load();
      return { climbs, hasMore };
    },
  });

  return { page, source: loadedHere ? 'db' : 'redis' };
}
