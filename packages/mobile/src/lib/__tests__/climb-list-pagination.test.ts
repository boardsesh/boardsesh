import { describe, expect, it } from 'vitest';
import { nextPageLookaheadRows, shouldFetchNextPage, type NextPageInput } from '../climb-list-pagination';

const PAGE_SIZE = 30;

function input(overrides: Partial<NextPageInput>): NextPageInput {
  return {
    hasNextPage: true,
    isPlaceholderData: false,
    isLoading: false,
    isFetchingNextPage: false,
    isRefetching: false,
    fetchInFlight: false,
    loadedCount: PAGE_SIZE,
    lastVisibleIndex: 5,
    endReachedPending: false,
    pageSize: PAGE_SIZE,
    ...overrides,
  };
}

describe('shouldFetchNextPage', () => {
  it('does not fetch a second page for a climber resting at the top of the first', () => {
    // ~6 rows on screen, 24 below: opening the tab must stay one search.
    expect(shouldFetchNextPage(input({ lastVisibleIndex: 5 }))).toBe(false);
  });

  it('fetches once the rows left below the viewport drop to the look-ahead', () => {
    expect(shouldFetchNextPage(input({ lastVisibleIndex: 8 }))).toBe(false);
    expect(shouldFetchNextPage(input({ lastVisibleIndex: 9 }))).toBe(true);
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
    const atTheEnd = { loadedCount: 60, lastVisibleIndex: 0, endReachedPending: true };
    expect(shouldFetchNextPage(input({ ...atTheEnd, isRefetching: true }))).toBe(false);
    expect(shouldFetchNextPage(input({ ...atTheEnd, isRefetching: false }))).toBe(true);
  });

  it('asks again by itself when a page lands and the climber is already near its end', () => {
    // A flick outran the page: 90 loaded, already looking at row 70.
    expect(shouldFetchNextPage(input({ loadedCount: 90, lastVisibleIndex: 70 }))).toBe(true);
  });
});
