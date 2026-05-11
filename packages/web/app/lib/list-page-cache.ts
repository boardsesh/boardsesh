import { SUPPORTED_BOARDS } from '@/app/lib/board-data';
import { USER_SPECIFIC_SEARCH_PARAMS } from '@boardsesh/shared-schema';
import type { SearchRequestPagination } from '@/app/lib/types';

/**
 * Checks whether search params contain any user-specific filters.
 * Used by SSR pages to decide whether to resolve a user session.
 */
export function hasUserSpecificFilters(searchParams: SearchRequestPagination): boolean {
  return USER_SPECIFIC_SEARCH_PARAMS.some((param) => !!searchParams[param]);
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

  const hasUserParams = USER_SPECIFIC_SEARCH_PARAMS.some((param) => {
    const value = searchParams.get(param);
    if (value === 'true' || value === '1') return true;
    // Numeric user-specific params (e.g. minUserQuality=3) serialise as a
    // plain integer string, not the literal 'true'. Treat any positive
    // finite number as "user-specific" so the CDN won't cache one user's
    // filtered results and serve them to everyone else. Negative / NaN /
    // empty / '0' all fall through to the default-cacheable case.
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0;
  });

  if (hasUserParams) {
    return null;
  }

  return 86400; // 24 hours
}
