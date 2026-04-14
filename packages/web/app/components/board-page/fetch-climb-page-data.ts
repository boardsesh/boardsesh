import { SearchRequestPagination, BoardDetails, Climb, ParsedBoardRouteParameters } from '@/app/lib/types';
import { parsedRouteSearchParamsToSearchParams } from '@/app/lib/url-utils';
import { cachedSearchClimbs } from '@/app/lib/db/queries/climbs/search-climbs';
import { hasUserSpecificFilters } from '@/app/lib/list-page-cache';
import { getBoardDetailsForBoard } from '@/app/lib/board-utils';
import { MAX_PAGE_SIZE } from '@/app/components/board-page/constants';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/app/lib/auth/auth-options';
import { scheduleOverlayWarming } from '@/app/lib/warm-overlay-cache';
import { buildOverlayUrl } from '@/app/components/board-renderer/util';

export type ClimbPageData = {
  boardDetails: BoardDetails;
  climbs: Climb[];
  preloadUrl: string | null;
};

/**
 * Shared SSR data fetching for both list and grid page routes.
 * Handles search param parsing, climb search, overlay warming, and preload URL generation.
 */
export async function fetchClimbPageData(
  parsedParams: ParsedBoardRouteParameters,
  searchParams: SearchRequestPagination,
): Promise<ClimbPageData | null> {
  const searchParamsObject: SearchRequestPagination = parsedRouteSearchParamsToSearchParams(searchParams);

  // For the SSR version we increase the pageSize so it also gets whatever page number
  // is in the search params. Without this, it would load the SSR version of the page on page 2
  // which would then flicker once SWR runs on the client.
  const requestedPageSize = (Number(searchParamsObject.page) + 1) * Number(searchParamsObject.pageSize);

  // Enforce max page size to prevent excessive database queries
  searchParamsObject.pageSize = Math.min(requestedPageSize, MAX_PAGE_SIZE);
  searchParamsObject.page = 0;

  const hasProgressFilters = hasUserSpecificFilters(searchParamsObject);

  // Check if this is a default search (no custom filters applied)
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
    (!searchParamsObject.holdsFilter || Object.keys(searchParamsObject.holdsFilter).length === 0) &&
    !hasProgressFilters;

  let boardDetails: BoardDetails;

  try {
    boardDetails = getBoardDetailsForBoard(parsedParams);
  } catch (error) {
    console.error('Error resolving board details:', error);
    return null;
  }

  // Resolve userId for personal progress filters
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

  // Preload the first climb's thumbnail so the browser can fetch it before JS hydration.
  const firstClimb = searchResponse.climbs[0];
  const preloadUrl = firstClimb?.frames ? buildOverlayUrl(boardDetails, firstClimb.frames, true) : null;

  return {
    boardDetails,
    climbs: searchResponse.climbs,
    preloadUrl,
  };
}
