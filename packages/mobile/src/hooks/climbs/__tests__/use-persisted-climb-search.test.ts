// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CLIMB_FILTER_STATE, DEFAULT_CLIMB_BOARD_FILTER_STATE } from '@boardsesh/climb-filters';
import type { LastSearch } from '../../../lib/last-search-store';

const storage = vi.hoisted(() => ({ getLastSearch: vi.fn(), saveLastSearch: vi.fn() }));
vi.mock('../../../lib/last-search-store', () => ({
  ...storage,
  boardConfigKey: (board: { layoutId: number }) => `board-${board.layoutId}`,
}));
import { usePersistedClimbSearch } from '../use-persisted-climb-search';

type Options = Parameters<typeof usePersistedClimbSearch>[0];
function deferredSearch() {
  let resolve!: (search: LastSearch | null) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<LastSearch | null>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function saved(searchText: string): LastSearch {
  return {
    filters: DEFAULT_CLIMB_FILTER_STATE,
    boardFilters: DEFAULT_CLIMB_BOARD_FILTER_STATE,
    searchText,
    updatedAt: 1,
  };
}
function setup() {
  const initialProps: Options = {
    boardConfig: { boardName: 'kilter', layoutId: 1, sizeId: 2, setIds: '3', angle: 40 },
    filters: DEFAULT_CLIMB_FILTER_STATE,
    boardFilters: DEFAULT_CLIMB_BOARD_FILTER_STATE,
    name: '',
    isAuthenticated: true,
    replaceSearch: vi.fn(),
  };
  return { ...renderHook(usePersistedClimbSearch, { initialProps }), initialProps };
}
async function finish(request: ReturnType<typeof deferredSearch>, search: LastSearch | null) {
  await act(async () => {
    request.resolve(search);
    await request.promise;
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());

describe('usePersistedClimbSearch', () => {
  it('ignores a previous board restore that completes after the current board', async () => {
    const first = deferredSearch();
    const second = deferredSearch();
    storage.getLastSearch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const screen = setup();
    screen.rerender({ ...screen.initialProps, boardConfig: { ...screen.initialProps.boardConfig!, layoutId: 2 } });
    expect(screen.result.current).toBe(false);
    await finish(second, saved('current'));
    expect(screen.result.current).toBe(true);
    await finish(first, saved('stale'));
    expect(screen.initialProps.replaceSearch).toHaveBeenCalledExactlyOnceWith(
      DEFAULT_CLIMB_FILTER_STATE,
      'current',
      DEFAULT_CLIMB_BOARD_FILTER_STATE,
    );
    screen.unmount();
  });

  it('gates saves and cancels the old save timer while auth restoration is pending', async () => {
    const signedIn = deferredSearch();
    const signedOut = deferredSearch();
    storage.getLastSearch.mockReturnValueOnce(signedIn.promise).mockReturnValueOnce(signedOut.promise);
    const screen = setup();
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(storage.saveLastSearch).not.toHaveBeenCalled();
    await finish(signedIn, saved('old'));
    screen.rerender({ ...screen.initialProps, name: 'old' });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    screen.rerender({ ...screen.initialProps, name: 'old', isAuthenticated: false });
    expect(screen.result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(storage.saveLastSearch).not.toHaveBeenCalled();
    await finish(signedOut, {
      ...saved('public'),
      filters: { ...DEFAULT_CLIMB_FILTER_STATE, status: 'drafts', onlyFavorited: true },
    });
    expect(screen.initialProps.replaceSearch).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'any', onlyFavorited: undefined }),
      'public',
      DEFAULT_CLIMB_BOARD_FILTER_STATE,
    );
    screen.rerender({ ...screen.initialProps, name: 'public', isAuthenticated: false });
    act(() => {
      vi.advanceTimersByTime(599);
    });
    expect(storage.saveLastSearch).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(storage.saveLastSearch).toHaveBeenCalledExactlyOnceWith(
      screen.initialProps.boardConfig,
      DEFAULT_CLIMB_FILTER_STATE,
      'public',
      DEFAULT_CLIMB_BOARD_FILTER_STATE,
    );
    screen.unmount();
  });

  it('uses clean defaults after a failed read and becomes ready', async () => {
    const request = deferredSearch();
    storage.getLastSearch.mockReturnValueOnce(request.promise);
    const screen = setup();
    await act(async () => {
      request.reject(new Error('storage unavailable'));
      await request.promise.catch(() => {});
    });
    expect(screen.result.current).toBe(true);
    expect(screen.initialProps.replaceSearch).toHaveBeenCalledExactlyOnceWith(
      DEFAULT_CLIMB_FILTER_STATE,
      '',
      DEFAULT_CLIMB_BOARD_FILTER_STATE,
    );
    screen.unmount();
  });

  it('ignores a read after unmount and never starts a save', async () => {
    const request = deferredSearch();
    storage.getLastSearch.mockReturnValueOnce(request.promise);
    const screen = setup();
    screen.unmount();
    await finish(request, saved('late'));
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(screen.initialProps.replaceSearch).not.toHaveBeenCalled();
    expect(storage.saveLastSearch).not.toHaveBeenCalled();
  });
});
