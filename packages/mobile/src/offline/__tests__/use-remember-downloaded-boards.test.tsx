// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { UserBoard, UserBoardConnection } from '@boardsesh/shared-schema';

const rememberOfflineBoardsMock = vi.hoisted(() => vi.fn());
const pruneOfflineBoardsMock = vi.hoisted(() => vi.fn());

const state = vi.hoisted(() => ({
  isOffline: false,
  enabledBoards: [] as string[],
}));

vi.mock('../../hooks/use-is-offline', () => ({ useIsOffline: () => state.isOffline }));
vi.mock('../../settings', () => ({
  rememberOfflineBoards: (boards: unknown) => rememberOfflineBoardsMock(boards),
  pruneOfflineBoards: (uuids: unknown, options?: unknown) =>
    options === undefined ? pruneOfflineBoardsMock(uuids) : pruneOfflineBoardsMock(uuids, options),
  useSetting: () => [state.enabledBoards, vi.fn()],
  offlineBoardKeyForBoard: (input: { boardType: string; layoutId: number; sizeId: number }) =>
    `${input.boardType}:${input.layoutId}:${input.sizeId}`,
}));

const { useRememberDownloadedBoards } = await import('../use-remember-downloaded-boards');

const board = (overrides: Partial<UserBoard> & { uuid: string; name: string }): UserBoard =>
  ({
    boardType: 'kilter',
    layoutId: 8,
    sizeId: 17,
    setIds: '20,21',
    angle: 40,
    ...overrides,
  }) as unknown as UserBoard;

const connection = (boards: UserBoard[], hasMore = false): UserBoardConnection => ({
  boards,
  totalCount: boards.length,
  hasMore,
});

const garage = board({ uuid: 'garage', name: 'Marco garage' });
const tension = board({ uuid: 'tension', name: 'Tension wall', boardType: 'tension', layoutId: 12, sizeId: 3 });

const rememberedUuids = () => (rememberOfflineBoardsMock.mock.calls[0]?.[0] as UserBoard[]).map((entry) => entry.uuid);

beforeEach(() => {
  vi.clearAllMocks();
  state.isOffline = false;
  state.enabledBoards = [];
});

describe('useRememberDownloadedBoards', () => {
  it('remembers only the boards whose scope is enabled for offline', () => {
    state.enabledBoards = ['kilter:8:17'];

    renderHook(() => useRememberDownloadedBoards(connection([garage, tension])));

    expect(rememberOfflineBoardsMock).toHaveBeenCalledTimes(1);
    expect(rememberedUuids()).toEqual(['garage']);
  });

  it('backfills a board downloaded before snapshots existed', () => {
    // The pre-fix-build upgrade path: the download predates this feature, so there is
    // no card — but enabling is the only way to download, so the scope is still listed.
    state.enabledBoards = ['tension:12:3'];

    renderHook(() => useRememberDownloadedBoards(connection([garage, tension])));

    expect(rememberedUuids()).toEqual(['tension']);
  });

  it('does not re-remember a board whose offline toggle was just turned off', () => {
    // Turning "Available offline" off drops the scope from syncEnabledBoards but
    // deliberately leaves the rows and checkpoint on disk so re-enabling resumes
    // instantly. Keying the refresh off "downloaded" instead of "enabled" would write
    // the card straight back and undo the forget two lines earlier in manage.tsx.
    state.enabledBoards = [];

    renderHook(() => useRememberDownloadedBoards(connection([garage])));

    // `rememberOfflineBoards` is add-only and ignores an empty list, so what matters is
    // that the board is not in it.
    expect(rememberedUuids()).toEqual([]);
  });

  it('prunes cards for boards the server no longer lists', () => {
    state.enabledBoards = ['kilter:8:17'];

    renderHook(() => useRememberDownloadedBoards(connection([garage])));

    // Deleted / unfollowed on another device: nothing local fires, so the complete
    // list is the only signal that the board is gone.
    expect(pruneOfflineBoardsMock).toHaveBeenCalledWith(['garage'], { keepBoardType: 'spray' });
  });

  it('never prunes from a truncated page', () => {
    // myBoards pages at 20; pruning on the first page would delete every card past it.
    state.enabledBoards = ['kilter:8:17'];

    renderHook(() => useRememberDownloadedBoards(connection([garage], true)));

    expect(rememberOfflineBoardsMock).toHaveBeenCalledTimes(1);
    expect(pruneOfflineBoardsMock).not.toHaveBeenCalled();
  });

  it('does nothing while offline — the live list is stale or absent', () => {
    state.isOffline = true;
    state.enabledBoards = ['kilter:8:17'];

    renderHook(() => useRememberDownloadedBoards(connection([garage])));

    expect(rememberOfflineBoardsMock).not.toHaveBeenCalled();
    expect(pruneOfflineBoardsMock).not.toHaveBeenCalled();
  });

  it('does nothing before the board list resolves', () => {
    state.enabledBoards = ['kilter:8:17'];

    renderHook(() => useRememberDownloadedBoards(undefined));

    expect(rememberOfflineBoardsMock).not.toHaveBeenCalled();
    expect(pruneOfflineBoardsMock).not.toHaveBeenCalled();
  });

  it('does not re-run on a re-render with the same inputs', () => {
    state.enabledBoards = ['kilter:8:17'];
    const stable = connection([garage]);

    const { rerender } = renderHook(() => useRememberDownloadedBoards(stable));
    rerender();
    rerender();

    // The effect deps must stay stable, or every myBoards refetch would churn the
    // settings store (and with it every useSetting consumer app-wide).
    expect(rememberOfflineBoardsMock).toHaveBeenCalledTimes(1);
    expect(pruneOfflineBoardsMock).toHaveBeenCalledTimes(1);
  });

  // An archived spray wall is not in `myBoards`; its download card must survive
  // a complete list, or the wall could not be opened offline.
  it('keeps the cards of archived walls the caller names', () => {
    renderHook(() => useRememberDownloadedBoards(connection([garage]), ['old-wall']));
    expect(pruneOfflineBoardsMock).toHaveBeenCalledWith(['garage', 'old-wall']);
  });

  it('prunes no spray card when the archived list is unknown', () => {
    renderHook(() => useRememberDownloadedBoards(connection([garage])));
    expect(pruneOfflineBoardsMock).toHaveBeenCalledWith(['garage'], { keepBoardType: 'spray' });
  });
});
