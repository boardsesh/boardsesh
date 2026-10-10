/**
 * When the climbs list should ask for its next page. Pure, so the rule can be
 * tested without mounting the screen.
 *
 * Two things the old "half a screen from the end" rule got wrong on a phone:
 *
 * - A page takes about two seconds to come back. Waiting for the end of the
 *   list meant every scroll past thirty climbs parked on skeleton rows.
 * - FlashList reports the end ONCE per content size. If that one call landed
 *   while another fetch was running — a background refetch after a sync is
 *   enough — it was dropped, nothing asked again, and the list sat at its last
 *   row until the climber scrolled away and back.
 *
 * So the trigger is "how many loaded rows are left below the last one on
 * screen", it is re-asked every time the list becomes free, and a dropped
 * end-reached is remembered until it can be honoured.
 *
 * The re-ask is what could turn into a drain, so it is fenced: an ask that the
 * climber did not cause (`settle`) only goes ahead when the last one made
 * progress. A failed page, or a page that added nothing, waits for a scroll.
 */

/**
 * Rows of look-ahead while only the first page is loaded. Twenty is roughly
 * three phone screens. The first page is never followed by a second request
 * while the climber is still at the top (see `firstVisibleIndex`), so opening
 * the tab costs one search on a phone and on an iPad alike.
 */
const FIRST_PAGE_LOOKAHEAD_ROWS = 20;
/**
 * Rows of look-ahead once more than one page is loaded. By then the climber is
 * scrolling, and a deeper buffer is what lets a few hard flicks land on rows
 * rather than on skeletons.
 */
const SCROLLING_LOOKAHEAD_ROWS = 40;
/**
 * After a next-page request fails, how long a scroll has to wait before it may
 * try again. Viewability fires on every row, so without this a rate-limited
 * search would be retried at the speed of the scroll.
 */
export const NEXT_PAGE_RETRY_COOLDOWN_MS = 3000;

/**
 * Who is asking. `scroll`: the climber moved the list (a row came on screen, or
 * FlashList reported the end). `settle`: nothing moved — a fetch finished and
 * the screen is checking whether another page is already due.
 */
export type NextPageTrigger = 'scroll' | 'settle';

export type NextPageInput = {
  trigger: NextPageTrigger;
  hasNextPage: boolean;
  /** Rows on screen belong to the previous search; there is nothing to page from yet. */
  isPlaceholderData: boolean;
  isLoading: boolean;
  isFetchingNextPage: boolean;
  isRefetching: boolean;
  /** A next-page request this screen already issued has not settled. */
  fetchInFlight: boolean;
  /** The most recent next-page request failed. */
  lastFetchFailed: boolean;
  /** Milliseconds since that failure was seen; null when this screen did not see it happen. */
  msSinceLastFailure: number | null;
  /** Climbs loaded so far, after de-duplication. */
  loadedCount: number;
  /** `loadedCount` when this screen last asked for a page; null before the first ask. */
  loadedCountAtLastFetch: number | null;
  /** Index of the first row on screen. Zero means the climber is still at the top. */
  firstVisibleIndex: number;
  /** Index of the last row on screen. */
  lastVisibleIndex: number;
  /** FlashList reported the end and that report has not been acted on yet. */
  endReachedPending: boolean;
  pageSize: number;
};

export function nextPageLookaheadRows(loadedCount: number, pageSize: number): number {
  return loadedCount > pageSize ? SCROLLING_LOOKAHEAD_ROWS : FIRST_PAGE_LOOKAHEAD_ROWS;
}

/** True when exactly one next-page fetch should start now. */
export function shouldFetchNextPage(input: NextPageInput): boolean {
  if (!input.hasNextPage || input.isPlaceholderData || input.isLoading) return false;
  if (input.isFetchingNextPage || input.isRefetching || input.fetchInFlight) return false;

  if (input.lastFetchFailed) {
    // Never retry a failure on our own; a scroll may, after the cooldown.
    if (input.trigger === 'settle') return false;
    if (input.msSinceLastFailure !== null && input.msSinceLastFailure < NEXT_PAGE_RETRY_COOLDOWN_MS) return false;
  }
  // The last ask added no climbs (every row was a duplicate, or it has not
  // landed). Asking again without the climber moving is a drain.
  const lastAskMadeProgress = input.loadedCountAtLastFetch === null || input.loadedCount > input.loadedCountAtLastFetch;
  if (input.trigger === 'settle' && !lastAskMadeProgress) return false;

  if (input.endReachedPending) return true;
  // Still at the top of the first page: opening the tab is one search.
  if (input.loadedCount <= input.pageSize && input.firstVisibleIndex === 0) return false;
  const rowsBelow = input.loadedCount - 1 - input.lastVisibleIndex;
  return rowsBelow <= nextPageLookaheadRows(input.loadedCount, input.pageSize);
}
