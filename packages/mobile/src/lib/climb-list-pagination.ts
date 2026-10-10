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
 */

/**
 * Rows of look-ahead while only the first page is loaded. Twenty is roughly
 * three screens: the first page (30 climbs, ~6 on screen) is not followed by a
 * second request until the climber actually scrolls, so opening the tab still
 * costs one search.
 */
const FIRST_PAGE_LOOKAHEAD_ROWS = 20;
/**
 * Rows of look-ahead once more than one page is loaded. By then the climber is
 * scrolling, and a deeper buffer is what lets a few hard flicks land on rows
 * rather than on skeletons.
 */
const SCROLLING_LOOKAHEAD_ROWS = 40;

export type NextPageInput = {
  hasNextPage: boolean;
  /** Rows on screen belong to the previous search; there is nothing to page from yet. */
  isPlaceholderData: boolean;
  isLoading: boolean;
  isFetchingNextPage: boolean;
  isRefetching: boolean;
  /** A next-page request this screen already issued has not settled. */
  fetchInFlight: boolean;
  /** Climbs loaded so far, after de-duplication. */
  loadedCount: number;
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
  if (input.endReachedPending) return true;
  const rowsBelow = input.loadedCount - 1 - input.lastVisibleIndex;
  return rowsBelow <= nextPageLookaheadRows(input.loadedCount, input.pageSize);
}
