// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FlashListRef } from '@shopify/flash-list';
import type { Climb } from '@boardsesh/shared-schema';

vi.mock('../../../components/ClimbListThumbnail', () => ({ ClimbListThumbnailPrewarm: () => null }));
import { useClimbsListLifecycle } from '../use-climbs-list-lifecycle';
import { createClimberScrollTracker } from '../../../lib/climber-scroll-tracker';

type Options = Parameters<typeof useClimbsListLifecycle>[0];
function deferredPage() {
  let resolve!: (result: { isFetchNextPageError: boolean }) => void;
  const promise = new Promise<{ isFetchNextPageError: boolean }>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
type ViewableReport = Parameters<ReturnType<typeof useClimbsListLifecycle>['handleViewableItemsChanged']>[0];
/** FlashList's report that rows `first` to `last` are on screen. */
function rowsOnScreen(first: number, last: number): ViewableReport {
  return { viewableItems: [{ index: first }, { index: last }] } as unknown as ViewableReport;
}
/** A scroll event with the list at `offsetY`. */
function scrollAt(offsetY: number): Parameters<Options['climberScroll']['handlers']['onScroll']>[0] {
  return { nativeEvent: { contentOffset: { x: 0, y: offsetY } } } as unknown as Parameters<
    Options['climberScroll']['handlers']['onScroll']
  >[0];
}
function alwaysScrolled(): Options['climberScroll'] {
  const tracker = createClimberScrollTracker(() => undefined);
  return { ...tracker, hasScrolled: () => true };
}
function setup(overrides: Partial<Options> = {}) {
  const scrollToIndex = vi.fn();
  const fetchNextPage = vi.fn(() => Promise.resolve({ isFetchNextPageError: false }));
  const initialProps: Options = {
    searchKey: 'first',
    listColumns: 1,
    listRef: { current: { scrollToIndex } as unknown as FlashListRef<Climb> },
    topClearance: 120,
    resetScrollToTop: vi.fn(),
    // The climber always counts as having scrolled, unless a test says otherwise.
    climberScroll: alwaysScrolled(),
    fetchNextPage,
    hasNextPage: true,
    isPlaceholderData: false,
    isLoading: false,
    isFetchingNextPage: false,
    isRefetching: false,
    lastFetchFailed: false,
    loadedCount: 30,
    ...overrides,
  };
  return { ...renderHook(useClimbsListLifecycle, { initialProps }), initialProps, scrollToIndex, fetchNextPage };
}
async function finish(request: ReturnType<typeof deferredPage>, failed = false) {
  await act(async () => {
    request.resolve({ isFetchNextPageError: failed });
    await request.promise;
  });
}

describe('useClimbsListLifecycle', () => {
  it('does not let an old search completion release the new search fetch latch', async () => {
    const first = deferredPage();
    const second = deferredPage();
    const fetchNextPage = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const screen = setup({ fetchNextPage });
    act(() => screen.result.current.handleEndReached());
    screen.rerender({ ...screen.initialProps, searchKey: 'second' });
    act(() => screen.result.current.handleEndReached());
    expect(fetchNextPage).toHaveBeenCalledTimes(2);
    await finish(first);
    act(() => screen.result.current.handleEndReached());
    expect(fetchNextPage).toHaveBeenCalledTimes(2);
    await finish(second);
    screen.unmount();
  });

  it('does not carry an old search failure cooldown into the new search', async () => {
    const first = deferredPage();
    const second = deferredPage();
    const third = deferredPage();
    const fetchNextPage = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);
    const screen = setup({ fetchNextPage });
    act(() => screen.result.current.handleEndReached());
    screen.rerender({ ...screen.initialProps, searchKey: 'second', lastFetchFailed: true });
    act(() => screen.result.current.handleEndReached());
    await finish(second);
    await finish(first, true);
    act(() => screen.result.current.handleEndReached());
    expect(fetchNextPage).toHaveBeenCalledTimes(3);
    await finish(third);
    screen.unmount();
  });

  it('remembers end reached during a refetch and requests one page when it settles', async () => {
    const request = deferredPage();
    const fetchNextPage = vi.fn(() => request.promise);
    const screen = setup({ isRefetching: true, fetchNextPage });
    act(() => screen.result.current.handleEndReached());
    expect(fetchNextPage).not.toHaveBeenCalled();
    screen.rerender({ ...screen.initialProps, isRefetching: false });
    expect(fetchNextPage).toHaveBeenCalledOnce();
    await finish(request);
    screen.unmount();
  });

  it('does not drain duplicate pages on settlement without another scroll', async () => {
    const request = deferredPage();
    const fetchNextPage = vi.fn(() => request.promise);
    const screen = setup({ fetchNextPage });
    screen.result.current.visibleRowsStore.set(10, 29);
    act(() => screen.result.current.handleEndReached());
    screen.rerender({ ...screen.initialProps, isFetchingNextPage: true });
    await finish(request);
    screen.rerender({ ...screen.initialProps, isFetchingNextPage: false });
    expect(fetchNextPage).toHaveBeenCalledOnce();
    screen.unmount();
  });

  it('restores the first saved column anchor once, using the latest clearance', () => {
    const screen = setup({ hasNextPage: false, loadedCount: 90 });
    screen.result.current.visibleRowsStore.set(21, 27);
    screen.rerender({ ...screen.initialProps, listColumns: 2 });
    screen.result.current.visibleRowsStore.set(0, 12);
    screen.rerender({ ...screen.initialProps, listColumns: 1, topClearance: 180 });
    act(() => screen.result.current.handleListLoad());
    expect(screen.scrollToIndex).toHaveBeenCalledWith({ index: 21, animated: false, viewOffset: -180 });
    act(() => screen.result.current.handleListLoad());
    expect(screen.scrollToIndex).toHaveBeenCalledOnce();
    screen.unmount();
  });

  it('drops the column anchor and pending end report when the search changes', () => {
    const screen = setup({ loadedCount: 90, isRefetching: true });
    screen.result.current.visibleRowsStore.set(21, 27);
    act(() => screen.result.current.handleEndReached());
    screen.rerender({ ...screen.initialProps, listColumns: 2 });
    screen.rerender({ ...screen.initialProps, searchKey: 'new', listColumns: 2, loadedCount: 30, isRefetching: false });
    act(() => screen.result.current.handleListLoad());
    expect(screen.scrollToIndex).not.toHaveBeenCalled();
    expect(screen.fetchNextPage).not.toHaveBeenCalled();
    expect(screen.initialProps.resetScrollToTop).toHaveBeenCalledOnce();
    expect(screen.result.current.visibleRowsStore.getFirst()).toBe(0);
    screen.unmount();
  });

  // The Android out-of-memory crash: rows at zero height all read as on screen,
  // and each landed page asked for the next until the app ran out of memory.
  it('needs the climber to scroll between page asks after the first', async () => {
    const climberScroll = createClimberScrollTracker(() => undefined);
    const screen = setup({ climberScroll, loadedCount: 60 });
    act(() => screen.result.current.handleViewableItemsChanged(rowsOnScreen(1, 59)));
    await act(async () => {});
    expect(screen.fetchNextPage).toHaveBeenCalledTimes(1);

    // The page lands and every row still reads as on screen: no scroll, no ask.
    screen.rerender({ ...screen.initialProps, climberScroll, loadedCount: 90 });
    act(() => screen.result.current.handleViewableItemsChanged(rowsOnScreen(1, 89)));
    await act(async () => {});
    expect(screen.fetchNextPage).toHaveBeenCalledTimes(1);

    act(() => climberScroll.handlers.onMomentumScrollBegin());
    screen.rerender({ ...screen.initialProps, climberScroll, loadedCount: 90 });
    act(() => screen.result.current.handleViewableItemsChanged(rowsOnScreen(2, 89)));
    await act(async () => {});
    expect(screen.fetchNextPage).toHaveBeenCalledTimes(2);
    screen.unmount();
  });

  it('forgets a fling cut short by a new search', () => {
    const climberScroll = createClimberScrollTracker(() => undefined);
    const screen = setup({ climberScroll });
    act(() => climberScroll.handlers.onMomentumScrollBegin());
    expect(climberScroll.hasScrolled()).toBe(true);
    screen.rerender({ ...screen.initialProps, climberScroll, searchKey: 'second' });
    expect(climberScroll.hasScrolled()).toBe(false);
    // The coasting is forgotten too: the scroll to the top that follows only
    // records where the list is.
    act(() => climberScroll.handlers.onScroll(scrollAt(0)));
    expect(climberScroll.hasScrolled()).toBe(false);
    screen.unmount();
  });
});
