import { describe, expect, it } from 'vitest';
import {
  NEXT_PAGE_RETRY_COOLDOWN_MS,
  nextPageLookaheadRows,
  shouldFetchNextPage,
  type NextPageInput,
} from '../climb-list-pagination';

const PAGE_SIZE = 30;

/** A climber a few rows into the first page, nothing fetching, nothing failed. */
function input(overrides: Partial<NextPageInput>): NextPageInput {
  return {
    trigger: 'scroll',
    hasNextPage: true,
    isPlaceholderData: false,
    isLoading: false,
    isFetchingNextPage: false,
    isRefetching: false,
    fetchInFlight: false,
    lastFetchFailed: false,
    msSinceLastFailure: null,
    loadedCount: PAGE_SIZE,
    loadedCountAtLastFetch: null,
    firstVisibleIndex: 2,
    lastVisibleIndex: 8,
    endReachedPending: false,
    pageSize: PAGE_SIZE,
    ...overrides,
  };
}

describe('shouldFetchNextPage', () => {
  it('fetches once the rows left below the viewport drop to the look-ahead', () => {
    expect(shouldFetchNextPage(input({ lastVisibleIndex: 8 }))).toBe(false);
    expect(shouldFetchNextPage(input({ lastVisibleIndex: 9 }))).toBe(true);
  });

  // Opening the tab must stay one search. On an iPad ~10 rows are on screen, so
  // the rows below the viewport are already inside the look-ahead at rest.
  it('never fetches a second page while the climber is still at the top of the first', () => {
    expect(shouldFetchNextPage(input({ firstVisibleIndex: 0, lastVisibleIndex: 5 }))).toBe(false);
    expect(shouldFetchNextPage(input({ firstVisibleIndex: 0, lastVisibleIndex: 10 }))).toBe(false);
    expect(shouldFetchNextPage(input({ trigger: 'settle', firstVisibleIndex: 0, lastVisibleIndex: 10 }))).toBe(false);
    // One row of scroll on the iPad is enough.
    expect(shouldFetchNextPage(input({ firstVisibleIndex: 1, lastVisibleIndex: 11 }))).toBe(true);
  });

  it('keeps a deeper buffer once more than one page is loaded', () => {
    expect(nextPageLookaheadRows(PAGE_SIZE, PAGE_SIZE)).toBeLessThan(nextPageLookaheadRows(PAGE_SIZE * 2, PAGE_SIZE));
    // 60 loaded, row 19 on screen: 40 rows below, inside the scrolling buffer.
    expect(shouldFetchNextPage(input({ loadedCount: 60, lastVisibleIndex: 19 }))).toBe(true);
    expect(shouldFetchNextPage(input({ loadedCount: 60, lastVisibleIndex: 18 }))).toBe(false);
  });

  it.each([
    ['there is no next page', { hasNextPage: false }],
    ['the rows are the previous search', { isPlaceholderData: true }],
    ['the first page is still loading', { isLoading: true }],
    ['a next page is already being fetched', { isFetchingNextPage: true }],
    ['a refetch is running', { isRefetching: true }],
    ['this screen already issued a fetch', { fetchInFlight: true }],
  ] as const)('never fetches while %s, even at the very end', (_label, blocker) => {
    expect(shouldFetchNextPage(input({ lastVisibleIndex: 29, endReachedPending: true, ...blocker }))).toBe(false);
  });

  // The stuck-list bug: FlashList reports the end once. If a background refetch
  // was running at that moment the report used to be dropped for good.
  it('honours a remembered end-reached as soon as the blocking refetch finishes', () => {
    const atTheEnd = { trigger: 'settle', loadedCount: 60, lastVisibleIndex: 0, endReachedPending: true } as const;
    expect(shouldFetchNextPage(input({ ...atTheEnd, isRefetching: true }))).toBe(false);
    expect(shouldFetchNextPage(input({ ...atTheEnd, isRefetching: false }))).toBe(true);
  });

  it('asks again by itself when a page lands and the climber is already near its end', () => {
    // A flick outran the page: it took the list from 60 to 90, already at row 70.
    const landed = { trigger: 'settle', loadedCount: 90, loadedCountAtLastFetch: 60, lastVisibleIndex: 70 } as const;
    expect(shouldFetchNextPage(input(landed))).toBe(true);
  });

  describe('a re-ask nobody scrolled for', () => {
    // Every fetch that settles re-runs the screen's effect. Without these two
    // fences a failing search, or one returning only duplicates, refetched at
    // the speed of the network for as long as the climber sat near the end.
    it('is refused after a failed page', () => {
      const failed = {
        loadedCount: 60,
        loadedCountAtLastFetch: 60,
        lastVisibleIndex: 55,
        lastFetchFailed: true,
      } as const;
      expect(shouldFetchNextPage(input({ ...failed, trigger: 'settle', msSinceLastFailure: 60_000 }))).toBe(false);
      expect(shouldFetchNextPage(input({ ...failed, trigger: 'settle', endReachedPending: true }))).toBe(false);
    });

    it('is refused when the last page added no climbs', () => {
      const duplicates = {
        trigger: 'settle',
        loadedCount: 60,
        loadedCountAtLastFetch: 60,
        lastVisibleIndex: 55,
      } as const;
      expect(shouldFetchNextPage(input(duplicates))).toBe(false);
      // The climber moving the list is a new reason to ask.
      expect(shouldFetchNextPage(input({ ...duplicates, trigger: 'scroll' }))).toBe(true);
    });
  });

  describe('a scroll after a failed page', () => {
    const failed = {
      loadedCount: 60,
      loadedCountAtLastFetch: 60,
      lastVisibleIndex: 55,
      lastFetchFailed: true,
    } as const;

    it('waits out the cooldown, so a rate-limited search is not retried per row', () => {
      expect(shouldFetchNextPage(input({ ...failed, msSinceLastFailure: 0 }))).toBe(false);
      expect(shouldFetchNextPage(input({ ...failed, msSinceLastFailure: NEXT_PAGE_RETRY_COOLDOWN_MS - 1 }))).toBe(
        false,
      );
    });

    it('retries once the cooldown has passed', () => {
      expect(shouldFetchNextPage(input({ ...failed, msSinceLastFailure: NEXT_PAGE_RETRY_COOLDOWN_MS }))).toBe(true);
    });

    it('retries straight away when this screen never saw the failure happen', () => {
      // A remounted screen over a query that is still in its error state.
      expect(shouldFetchNextPage(input({ ...failed, msSinceLastFailure: null }))).toBe(true);
    });
  });
});
