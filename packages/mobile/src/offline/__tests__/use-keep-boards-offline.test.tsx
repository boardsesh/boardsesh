// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { UserBoard } from '@boardsesh/shared-schema';

const enableBoardsOfflineMock = vi.hoisted(() => vi.fn());
const useMyBoardsMock = vi.hoisted(() => vi.fn());

// The persisted settings the hook reads, plus the real take/forget/remember
// semantics of the download-all tap: one tap attributes one batch.
const settings = vi.hoisted(() => ({
  offlineEnabled: true,
  autoOfflineBoards: true,
  syncEnabledBoards: [] as string[],
  downloadAllTapPending: false,
  boards: undefined as UserBoard[] | undefined,
}));

vi.mock('../../providers/feature-flags-provider', () => ({
  useOfflineDownloadsEnabled: () => settings.offlineEnabled,
}));
vi.mock('../../lib/graphql/hooks', () => ({
  useProfile: () => ({ data: { id: 'user-1' } }),
  useMyBoards: (input: unknown, options: { enabled?: boolean }) => useMyBoardsMock(input, options),
}));
vi.mock('../use-board-downloads', () => ({
  useBoardDownloads: () => ({ enableBoardsOffline: enableBoardsOfflineMock }),
}));
vi.mock('../../settings', () => ({
  useSetting: (key: string) => [key === 'autoOfflineBoards' ? settings.autoOfflineBoards : null, vi.fn()],
  getSetting: (key: string) => (key === 'syncEnabledBoards' ? settings.syncEnabledBoards : null),
  offlineBoardKeyForBoard: (board: { boardType: string; layoutId: number; sizeId: number }) =>
    `${board.boardType}:${board.layoutId}:${board.sizeId}`,
  takeDownloadAllTap: () => {
    const pending = settings.downloadAllTapPending;
    settings.downloadAllTapPending = false;
    return pending;
  },
  forgetDownloadAllTap: () => {
    settings.downloadAllTapPending = false;
  },
}));

const { useKeepBoardsOffline, useMissingOfflineBoards } = await import('../use-keep-boards-offline');

const board = (uuid: string, layoutId: number): UserBoard =>
  ({ uuid, name: uuid, boardType: 'kilter', layoutId, sizeId: 17, setIds: '1', angle: 40 }) as unknown as UserBoard;

const garage = board('garage', 8);
const gym = board('gym', 9);

beforeEach(() => {
  vi.clearAllMocks();
  settings.offlineEnabled = true;
  settings.autoOfflineBoards = true;
  settings.syncEnabledBoards = [];
  settings.downloadAllTapPending = false;
  settings.boards = [garage, gym];
  useMyBoardsMock.mockImplementation(() => ({
    data: settings.boards ? { boards: settings.boards, totalCount: settings.boards.length, hasMore: false } : undefined,
  }));
});

describe('useKeepBoardsOffline', () => {
  it('files the enable as a download-all once, after a remembered tap', () => {
    settings.downloadAllTapPending = true;

    const { rerender } = renderHook(() => useKeepBoardsOffline());

    expect(enableBoardsOfflineMock).toHaveBeenCalledTimes(1);
    expect(enableBoardsOfflineMock).toHaveBeenCalledWith([garage, gym], { trigger: 'download-all', source: 'more' });
    // The tap is spent: the next render with the same inputs does not run again.
    expect(settings.downloadAllTapPending).toBe(false);
    rerender();
    expect(enableBoardsOfflineMock).toHaveBeenCalledTimes(1);
  });

  it('files the enable as automatic when nobody tapped', () => {
    renderHook(() => useKeepBoardsOffline());

    expect(enableBoardsOfflineMock).toHaveBeenCalledWith([garage, gym], {
      trigger: 'auto-download-all',
      source: 'more',
    });
  });

  it('only enables the boards that are not offline yet', () => {
    settings.syncEnabledBoards = ['kilter:8:17'];

    renderHook(() => useKeepBoardsOffline());

    expect(enableBoardsOfflineMock).toHaveBeenCalledWith([gym], { trigger: 'auto-download-all', source: 'more' });
  });

  it('does nothing when every board is already offline, and forgets the spent tap', () => {
    settings.syncEnabledBoards = ['kilter:8:17', 'kilter:9:17'];
    settings.downloadAllTapPending = true;

    renderHook(() => useKeepBoardsOffline());

    expect(enableBoardsOfflineMock).not.toHaveBeenCalled();
    expect(settings.downloadAllTapPending).toBe(false);
  });

  it('keeps the tap armed while My Boards is still loading', () => {
    // The tap can land before the list resolves. Spending it on an empty list
    // would file the enable that eventually runs as automatic.
    settings.boards = undefined;
    settings.downloadAllTapPending = true;

    const { rerender } = renderHook(() => useKeepBoardsOffline());

    expect(enableBoardsOfflineMock).not.toHaveBeenCalled();
    expect(settings.downloadAllTapPending).toBe(true);

    settings.boards = [garage];
    rerender();
    expect(enableBoardsOfflineMock).toHaveBeenCalledWith([garage], { trigger: 'download-all', source: 'more' });
  });

  it('stays out of the way with the switch off', () => {
    settings.autoOfflineBoards = false;

    renderHook(() => useKeepBoardsOffline());

    expect(enableBoardsOfflineMock).not.toHaveBeenCalled();
  });

  it('stays out of the way with offline downloads switched off for this build', () => {
    settings.offlineEnabled = false;

    renderHook(() => useKeepBoardsOffline());

    expect(enableBoardsOfflineMock).not.toHaveBeenCalled();
    expect(useMyBoardsMock).toHaveBeenCalledWith(undefined, { enabled: false });
  });
});

describe('useMissingOfflineBoards', () => {
  it('reads the enabled boards when called, not when the hook rendered', () => {
    const { result } = renderHook(() => useMissingOfflineBoards());

    expect(result.current()).toEqual([garage, gym]);
    settings.syncEnabledBoards = ['kilter:8:17'];
    expect(result.current()).toEqual([gym]);
  });

  it('never runs the enabling effect itself', () => {
    renderHook(() => useMissingOfflineBoards());

    expect(enableBoardsOfflineMock).not.toHaveBeenCalled();
  });
});
