import 'server-only';

import { getServerSession } from 'next-auth/next';
import type { BoardDetails, Climb, ParsedBoardRouteParameters, SearchRequestPagination } from '@/app/lib/types';
import { cachedSearchClimbs } from '@/app/lib/db/queries/climbs/search-climbs';
import { hasUserSpecificFilters } from '@/app/lib/list-page-cache';
import { getBoardDetailsForBoard } from '@/app/lib/board-utils';
import { resolveSsrInitialPageSize } from '@/app/lib/climb-list-constants';
import { authOptions } from '@/app/lib/auth/auth-options';
import { FRONT_DOOR_WARM_LIMIT, scheduleOverlayWarming } from '@/app/lib/warm-overlay-cache';
import { buildOverlayUrl } from '@/app/components/board-renderer/util';
import { DEFAULT_SEARCH_PARAMS, parsedRouteSearchParamsToSearchParams } from '@/app/lib/url-utils';
import { FRONT_DOOR_PAGE_SIZE } from '@/app/lib/seo/list-page-robots';

export type ListPageData = {
  boardDetails: BoardDetails;
  searchResponse: { climbs: Climb[]; hasMore: boolean };
  /** Pre-resolved overlay URL for the first climb so the page can `<link rel="preload">` it. */
  preloadUrl: string | null;
};

/**
 * Shared server-side fetch for the board climbs list — used by the canonical
 * `/list` route and the short `/b/{slug}/{angle}/list` route. The two
 * `/view/{climb_uuid}` routes intentionally do NOT call this; they pass
 * `initialClimbs=[]` and let React Query load the list asynchronously so the
 * drawer can paint immediately on SSR without waiting on the catalog query.
 *
 * Returns `null` if board details can't be resolved — callers should `notFound()`.
 */
export async function fetchListPageData(
  parsedParams: ParsedBoardRouteParameters,
  rawSearchParams: SearchRequestPagination,
): Promise<ListPageData | null> {
  const searchParamsObject = parsedRouteSearchParamsToSearchParams(rawSearchParams);
  searchParamsObject.pageSize = resolveSsrInitialPageSize(
    Number(searchParamsObject.page),
    Number(searchParamsObject.pageSize),
  );
  searchParamsObject.page = 0;

  const hasProgressFilters = hasUserSpecificFilters(searchParamsObject);

  const isDefaultSearch =
    !searchParamsObject.gradeAccuracy &&
    !searchParamsObject.minGrade &&
    !searchParamsObject.maxGrade &&
    !searchParamsObject.minAscents &&
    !searchParamsObject.minRating &&
    !searchParamsObject.name &&
    (!searchParamsObject.settername || searchParamsObject.settername.length === 0) &&
    (searchParamsObject.sortBy || 'ascents') === 'ascents' &&
    (searchParamsObject.sortOrder || 'desc') === 'desc' &&
    !searchParamsObject.onlyTallClimbs &&
    !searchParamsObject.onlyWideClimbs &&
    !searchParamsObject.onlyWithBetaVideos &&
    (!searchParamsObject.holdsFilter || Object.keys(searchParamsObject.holdsFilter).length === 0) &&
    !hasProgressFilters;

  let boardDetails: BoardDetails;
  try {
    boardDetails = getBoardDetailsForBoard(parsedParams);
  } catch (error) {
    console.error('Error resolving board details:', error);
    return null;
  }

  let userId: string | undefined;
  if (hasProgressFilters) {
    const session = await getServerSession(authOptions);
    userId = session?.user?.id;
  }

  let searchResponse: { climbs: Climb[]; hasMore: boolean };
  try {
    searchResponse = await cachedSearchClimbs(parsedParams, searchParamsObject, isDefaultSearch, userId, {
      cacheable: !hasProgressFilters,
    });
  } catch (error) {
    console.error(
      'Error fetching climb search results (degrading to empty results for SSR):',
      { boardName: parsedParams.board_name },
      error,
    );
    searchResponse = { climbs: [], hasMore: false };
  }

  scheduleOverlayWarming({ boardDetails, climbs: searchResponse.climbs, variant: 'thumbnail' });

  const firstClimb = searchResponse.climbs[0];
  const preloadUrl = firstClimb?.frames ? buildOverlayUrl(boardDetails, firstClimb.frames, true) : null;

  return { boardDetails, searchResponse, preloadUrl };
}

export type FrontDoorListPage = {
  boardDetails: BoardDetails;
  climbs: Climb[];
  hasMore: boolean;
  /** Pre-resolved overlay URL for the first climb so the page can `<link rel="preload">` it. */
  preloadUrl: string | null;
};

/**
 * The `/list` front door's fetch: exactly one page of `FRONT_DOOR_PAGE_SIZE`
 * climbs at the default sort (most ascents first), no filters, no session.
 *
 * Deliberately NOT `fetchListPageData`. That one pins `page = 0` and derives
 * its page size from `resolveSsrInitialPageSize` — an aggregated 0..N window
 * sized for an infinite-scrolling client list, which can neither serve `?page=3`
 * nor hand back a clean 50-row slice.
 *
 * It also never calls `getServerSession`. `middleware.ts` puts a shared
 * `s-maxage` on these URLs with no session split, on the premise that they are
 * personalization-free; reading the cookie here would be the first step toward
 * caching one viewer's page for everyone.
 *
 * `page` is the 1-based `?page=N` from the URL. Callers clamp it; anything at
 * or below 1 is the first page.
 */
export async function fetchFrontDoorListPage(
  parsedParams: ParsedBoardRouteParameters,
  page: number,
): Promise<FrontDoorListPage | null> {
  let boardDetails: BoardDetails;
  try {
    boardDetails = getBoardDetailsForBoard(parsedParams);
  } catch (error) {
    console.error('Error resolving board details:', error);
    return null;
  }

  const zeroBasedPage = Math.max(0, Math.trunc(page) - 1);
  const searchParams: SearchRequestPagination = {
    ...DEFAULT_SEARCH_PARAMS,
    page: zeroBasedPage,
    pageSize: FRONT_DOOR_PAGE_SIZE,
  };

  let searchResponse: { climbs: Climb[]; hasMore: boolean };
  try {
    // `isDefaultSearch` is true by construction here — no filters are ever
    // applied — which is what lets the query ride the shared cache.
    searchResponse = await cachedSearchClimbs(parsedParams, searchParams, true, undefined, { cacheable: true });
  } catch (error) {
    // Rethrow, deliberately. This used to degrade to an empty list, which
    // rendered a 200 with zero climbs on a sitemapped URL — Google reads that
    // as legitimate thin content and drops the page, where a 5xx makes it
    // retry and keep the URL. The CDN's stale-while-revalidate window keeps
    // serving the last good copy meanwhile.
    console.error(
      'Error fetching front-door climbs:',
      { boardName: parsedParams.board_name, page: zeroBasedPage },
      error,
    );
    throw error;
  }

  // 50 climbs × one same-origin WASM render each is a 20× invocation amplifier
  // on the page whose whole purpose is to be crawled. Six covers what a reader
  // sees before scrolling; the rest warm lazily on demand.
  scheduleOverlayWarming({
    boardDetails,
    climbs: searchResponse.climbs,
    variant: 'thumbnail',
    maxImages: FRONT_DOOR_WARM_LIMIT,
  });

  const firstClimb = searchResponse.climbs[0];
  const preloadUrl = firstClimb?.frames ? buildOverlayUrl(boardDetails, firstClimb.frames, true) : null;

  return { boardDetails, climbs: searchResponse.climbs, hasMore: searchResponse.hasMore, preloadUrl };
}
