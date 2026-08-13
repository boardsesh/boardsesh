import 'server-only';

import { getServerSession } from 'next-auth/next';
import type { BoardDetails, Climb, ParsedBoardRouteParameters, SearchRequestPagination } from '@/app/lib/types';
import { cachedSearchClimbs } from '@/app/lib/db/queries/climbs/search-climbs';
import { hasUserSpecificFilters } from '@/app/lib/list-page-cache';
import { getBoardDetailsForBoard } from '@/app/lib/board-utils';
import { resolveSsrInitialPageSize } from '@/app/lib/climb-list-constants';
import { authOptions } from '@/app/lib/auth/auth-options';
import { scheduleOverlayWarming } from '@/app/lib/warm-overlay-cache';
import { buildOverlayUrl } from '@/app/components/board-renderer/util';
import { parsedRouteSearchParamsToSearchParams } from '@/app/lib/url-utils';

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
