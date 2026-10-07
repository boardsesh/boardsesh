import { SUPPORTED_BOARDS } from '@/app/lib/board-data';
import { USER_SPECIFIC_SEARCH_PARAMS } from '@boardsesh/shared-schema';
import type { SearchRequestPagination } from '@/app/lib/types';
import { WALL_CAPABILITY_PARAM } from '@/app/lib/spray/spray-visibility';

// List data tolerates a full day of staleness (a new/edited climb showing up a
// little late in a list is harmless), so list pages cache for 24h.
const LIST_PAGE_CACHE_TTL_SECONDS = 86400;

// A climb view page is fully determined by its URL and reads no server-side
// personalization (queue/session/auth all live in client components), so it's
// as cacheable as a list page. The crawl surface is 4 locale twins × ~53k
// climbs (~212k distinct URLs, #4650); at a 1h CDN window nearly every
// crawler fetch missed and re-rendered at origin (~40k/day). The data caches
// underneath (`getClimb`/stats in `app/lib/data/queries.ts`, and the
// front-door similar-climbs/beta-links cache) stay at 3600s, so a re-render
// is still ≤1h stale even though the CDN copy may now be ≤24h stale (plus a
// 7d stale-while-revalidate window from the ×7 in middleware). The #4592 fix
// for the CDN-cacheable self-redirect loop on non-Latin climb names must stay
// in place — a cacheable redirect loop at this TTL would pin for a full day.
const CLIMB_VIEW_PAGE_CACHE_TTL_SECONDS = 86400;

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

  if (hasUserSpecificQueryParams(searchParams) || isSprayWallCapabilityRequest(pathname, searchParams)) {
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

  if (hasUserSpecificQueryParams(searchParams) || isSprayWallCapabilityRequest(pathname, searchParams)) {
    return null;
  }

  return CLIMB_VIEW_PAGE_CACHE_TTL_SECONDS;
}
