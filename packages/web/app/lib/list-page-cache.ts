import { SUPPORTED_BOARDS } from '@/app/lib/board-data';
import { USER_SPECIFIC_SEARCH_PARAMS } from '@boardsesh/shared-schema';
import type { SearchRequestPagination } from '@/app/lib/types';

// List data tolerates a full day of staleness (a new/edited climb showing up a
// little late in a list is harmless), so list pages cache for 24h.
const LIST_PAGE_CACHE_TTL_SECONDS = 86400;

// A climb view page is fully determined by its URL and reads no server-side
// personalization (queue/session/auth all live in client components). Its only
// data source, `getClimb`, is `unstable_cache`d at 3600s — so the page HTML is
// already up to an hour stale today. Matching that keeps the CDN from adding a
// new staleness class beyond what the data cache already allows.
const CLIMB_VIEW_PAGE_CACHE_TTL_SECONDS = 3600;

/**
 * Checks whether search params contain any user-specific filters.
 * Used by SSR pages to decide whether to resolve a user session.
 */
export function hasUserSpecificFilters(searchParams: SearchRequestPagination): boolean {
  return USER_SPECIFIC_SEARCH_PARAMS.some((param) => !!searchParams[param]);
}

/**
 * True when the query string carries a user-specific filter that would make the
 * server render personalized HTML. Such a request must never share a CDN cache
 * entry with the anonymous version, so it is not cached.
 */
function hasUserSpecificQueryParams(searchParams: URLSearchParams): boolean {
  return USER_SPECIFIC_SEARCH_PARAMS.some((param) => {
    const value = searchParams.get(param);
    return value === 'true' || value === '1';
  });
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

  if (hasUserSpecificQueryParams(searchParams)) {
    return null;
  }

  return LIST_PAGE_CACHE_TTL_SECONDS;
}

/**
 * Checks whether a request is a cacheable climb view page and returns the CDN
 * cache duration in seconds, or null if it should not be CDN-cached.
 *
 * Matches both URL shapes, and — because it matches on segment shape rather than
 * on slug-vs-numeric — it also matches the legacy numeric variants that
 * permanent-redirect to their slug form. Caching those lets the CDN answer the
 * deterministic 308 without re-rendering:
 *   - /[board]/[layout]/[size]/[sets]/[angle]/view/[climb_uuid]  (legacy + numeric, 7 segments)
 *   - /b/[board_slug]/[angle]/view/[climb_uuid]                  (slug format, 5 segments)
 */
export function getClimbViewPageCacheTTL(pathname: string, searchParams: URLSearchParams): number | null {
  const pathParts = pathname.split('/').filter(Boolean);

  const isSlugFormat = pathParts.length === 5 && pathParts[0] === 'b' && pathParts[3] === 'view';

  const isLegacyFormat =
    pathParts.length === 7 &&
    (SUPPORTED_BOARDS as readonly string[]).includes(pathParts[0].toLowerCase()) &&
    pathParts[5] === 'view';

  if (!isSlugFormat && !isLegacyFormat) {
    return null;
  }

  if (hasUserSpecificQueryParams(searchParams)) {
    return null;
  }

  return CLIMB_VIEW_PAGE_CACHE_TTL_SECONDS;
}
