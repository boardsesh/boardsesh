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
 * Fixed height (px) of a single virtualized climb row in list mode.
 *
 * Derived deterministically from the row's CSS: it is thumbnail-dominated —
 * ClimbThumbnail renders a `spacing[16]` (64px) wide box at `aspect-ratio:
 * 5 / 7` ≈ 89.6px tall, plus the row's vertical padding (2 × `spacing[2]` =
 * 16px) and a 1px bottom border ≈ 106.6px, which rounds to the pre-existing
 * 107px estimate. (An in-browser getBoundingClientRect check was intentionally
 * skipped — see the PR — so if this ever visibly clips or gaps a row, measure a
 * real `[data-index]` wrapper and set this to that value.)
 *
 * This is the single source of truth shared by:
 *  - the virtualizer `estimateSize` AND the measured row wrapper's `minHeight`
 *    in `climbs-list.tsx`, so a freshly rendered row measures to exactly the
 *    estimate — no post-mount reflow that shifts every row below it (CLS), and
 *    SSR layout matches the client. Rows that render extra content below the
 *    item (session-detail tick details via `renderItemExtra`) still grow past
 *    this floor via `measureElement`.
 *  - `ClimbListItemSkeleton`, so the skeleton→content swap on /view and empty
 *    /list doesn't grow each row (~43px) as placeholders resolve.
 */
export const LIST_ROW_HEIGHT = 107;
