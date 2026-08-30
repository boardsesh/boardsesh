import 'server-only';

import type { BoardDetails, Climb, ParsedBoardRouteParameters, SearchRequestPagination } from '@/app/lib/types';
import { cachedSearchClimbs } from '@/app/lib/db/queries/climbs/search-climbs';
import { getBoardDetailsForBoard } from '@/app/lib/board-utils';
import { buildOverlayPreloadUrls } from '@/app/components/board-renderer/util';
import { DEFAULT_SEARCH_PARAMS } from '@/app/lib/url-utils';
import { FRONT_DOOR_PAGE_SIZE } from '@/app/lib/seo/list-page-robots';

export type FrontDoorListPage = {
  boardDetails: BoardDetails;
  climbs: Climb[];
  hasMore: boolean;
  /** Pre-resolved overlay URL for the first climb so the page can `<link rel="preload">` it. */
  preloadUrls: string[];
};

/**
 * The `/list` front door's fetch: exactly one page of `FRONT_DOOR_PAGE_SIZE`
 * climbs at the default sort (most ascents first), no filters, no session.
 *
 * It never calls `getServerSession`. `middleware.ts` puts a shared
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

  const firstClimb = searchResponse.climbs[0];
  const preloadUrls = buildOverlayPreloadUrls(boardDetails, firstClimb?.frames, true);

  return { boardDetails, climbs: searchResponse.climbs, hasMore: searchResponse.hasMore, preloadUrls };
}
