// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FlashListRef } from '@shopify/flash-list';
import type { Climb } from '@boardsesh/shared-schema';

vi.mock('../../../components/ClimbListThumbnail', () => ({ ClimbListThumbnailPrewarm: () => null }));
import { useClimbsListLifecycle } from '../use-climbs-list-lifecycle';

type Options = Parameters<typeof useClimbsListLifecycle>[0];
function deferredPage() {
  let resolve!: (result: { isFetchNextPageError: boolean }) => void;
  const promise = new Promise<{ isFetchNextPageError: boolean }>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
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
});
