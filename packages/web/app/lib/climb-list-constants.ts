export const PAGE_LIMIT = 20;
export const MAX_PAGE_SIZE = 100; // Maximum page size to prevent excessive database queries

/**
 * On page=0 SSR (the default landing case), we only need enough climbs to
 * fill the first viewport — SWR fetches the rest after hydration. Shipping
 * fewer climbs in the SSR HTML/RSC payload speeds up mobile parse time.
 * Roughly one viewport of cards: keep it small but big enough that a fast
 * mobile scroll doesn't outrun SWR's first fetch.
 */
export const SSR_INITIAL_PAGE_SIZE = 10;

/**
 * Resolves the SSR pageSize for the climb list pages.
 *
 * On page=0 (the default landing case) we ship a small initial batch
 * (SSR_INITIAL_PAGE_SIZE) so the HTML/RSC payload stays light — SWR fetches
 * the rest after hydration.
 *
 * On page>0 (deep-link to a paginated result) we aggregate pages 0..N into a
 * single SSR fetch so the rendered list matches what SWR will reconstruct
 * client-side, preventing a flicker as cached pages backfill. We cap the
 * aggregated size at MAX_PAGE_SIZE to prevent excessive database queries.
 */
export function resolveSsrInitialPageSize(requestedPage: number, requestedPageSize: number): number {
  if (requestedPage === 0) return SSR_INITIAL_PAGE_SIZE;
  return Math.min((requestedPage + 1) * requestedPageSize, MAX_PAGE_SIZE);
}

// Threshold for proactive fetching of suggestions
// When suggestedClimbs falls below this, we fetch more automatically
// Set to 10 to keep a healthy buffer of suggestions available
export const SUGGESTIONS_THRESHOLD = 10;

/**
 * Initial estimate and minimum height for a virtualized climb row.
 *
 * Offscreen spacers use the estimate until measured. Mounted public rows stay
 * in normal flow and can grow for their responsive thumbnails or session
 * details; `measureElement` then records their actual height.
 */
export const LIST_ROW_HEIGHT = 107;
