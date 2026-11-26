import { SUPPORTED_BOARDS } from '@/app/lib/board-data';
import { USER_SPECIFIC_SEARCH_PARAMS } from '@boardsesh/shared-schema';
import type { SearchRequestPagination } from '@/app/lib/types';
import { WALL_CAPABILITY_PARAM } from '@/app/lib/spray/spray-visibility';
import { isBoardInviteRequest } from '@/app/lib/board-invite';
import { hasLiveSearchData, LIVE_SEARCH_DATA_TTL_SECONDS } from '@/app/lib/live-search-data-boards';
export { isClimbViewRequest } from './climb-view-request';

// List data tolerates a full day of staleness (a new/edited climb showing up a
// little late in a list is harmless), so list pages cache for 24h. MoonBoard
// and Woods lists (and every `/b/{slug}` list, whose board middleware cannot
// tell without a backend call) use the 15 minute live-data TTL instead, to
// match their Next data cache (#6803).
const LIST_PAGE_CACHE_TTL_SECONDS = 86400;

/** The printable board poster, `/poster/b/{slug}` (#4415). Never cached; see `isBoardPosterRequest`. */
const BOARD_POSTER_PATH_PREFIX = '/poster/b';

/**
 * Checks whether search params contain any user-specific filters.
 * Used by SSR pages to decide whether to resolve a user session.
 */
export function hasUserSpecificFilters(searchParams: SearchRequestPagination): boolean {
  return USER_SPECIFIC_SEARCH_PARAMS.some((param) => !!searchParams[param]);
}

// User-specific params carrying a number rather than a flag. A flag test
// (`'true' | '1'`) would read `?minUserRating=4` as absent and let personalized
// HTML share the anonymous CDN entry.
const NUMERIC_USER_SPECIFIC_PARAMS: ReadonlySet<string> = new Set(['minUserRating']);

/**
 * True when the query string carries a user-specific filter that would make the
 * server render personalized HTML. Such a request must never share a CDN cache
 * entry with the anonymous version, so it is not cached.
 *
 * Parsed per type on purpose: treating any non-empty value as user-specific
 * would turn `?onlyDrafts=x` from a crawler into a CDN bypass on every list page.
 */
function hasUserSpecificQueryParams(searchParams: URLSearchParams): boolean {
  return USER_SPECIFIC_SEARCH_PARAMS.some((param) => {
    const value = searchParams.get(param);
    if (value == null) return false;
    if (NUMERIC_USER_SPECIFIC_PARAMS.has(param)) return Number(value) > 0;
    return value === 'true' || value === '1';
  });
}

/**
 * True for a `/b/...` request carrying a spray wall's share-link capability
 * (`?wall=<uuid>`). Takes the LOCALE-STRIPPED pathname, like the TTL helpers.
 *
 * Such a response must never enter a shared cache, for two reasons:
 *
 *  - privacy: an unlisted wall's page answers 200 only while the wall stays
 *    unlisted and unhidden. A cached copy would keep serving it at the edge for
 *    a day (plus 7 days of stale-while-revalidate) after an admin hides it or
 *    its owner makes it private;
 *  - correctness: while www is ahead of the backend, the same URL answers 404,
 *    and a cached 404 would outlive the backend deploy that fixes it.
 *
 * The cost is small: these URLs are noindex and only reach people the owner sent
 * the link to, so they are not part of the crawl surface the cache exists for.
 */
export function isSprayWallCapabilityRequest(pathname: string, searchParams: URLSearchParams): boolean {
  return (pathname === '/b' || pathname.startsWith('/b/')) && searchParams.has(WALL_CAPABILITY_PARAM);
}

/**
 * True for every printable board poster, `/poster/b/{slug}` (#4415), with or
 * without a `?wall=`. Takes the LOCALE-STRIPPED pathname.
 *
 * Never cached, by any shared cache: the poster prints the board's visibility as
 * of this request (a board switched to private must stop printing on the next
 * request, not the next day), an unlisted wall's poster URL carries its
 * capability, and the wall's photo is a fifteen-minute signed URL that must not
 * outlive the page. Nobody but the owner prints a poster, so it costs the cache
 * nothing.
 */
export function isBoardPosterRequest(pathname: string): boolean {
  return pathname.startsWith(`${BOARD_POSTER_PATH_PREFIX}/`);
}

/**
 * Checks whether a request is a cacheable list page and returns the CDN cache
 * duration in seconds, or null if the request should not be CDN-cached.
 *
 * Matches both URL formats:
 *   - /[board]/[layout]/[size]/[sets]/[angle]/list  (legacy numeric)
 *   - /b/[board_slug]/[angle]/list                  (new slug format)
 */
export function getListPageCacheTTL(pathname: string, searchParams: URLSearchParams): number | null {
  // Fast-path: skip parsing for routes that clearly aren't list pages
  if (!pathname.endsWith('/list')) {
    return null;
  }

  const pathParts = pathname.split('/').filter(Boolean);

  const isLegacyFormat =
    pathParts.length >= 6 && (SUPPORTED_BOARDS as readonly string[]).includes(pathParts[0].toLowerCase());

  const isSlugFormat = pathParts.length >= 4 && pathParts[0] === 'b';

  if (!isLegacyFormat && !isSlugFormat) {
    return null;
  }

  if (
    hasUserSpecificQueryParams(searchParams) ||
    isSprayWallCapabilityRequest(pathname, searchParams) ||
    isBoardInviteRequest(pathname, searchParams)
  ) {
    return null;
  }

  if (isSlugFormat || hasLiveSearchData(pathParts[0])) {
    return LIVE_SEARCH_DATA_TTL_SECONDS;
  }

  return LIST_PAGE_CACHE_TTL_SECONDS;
}
