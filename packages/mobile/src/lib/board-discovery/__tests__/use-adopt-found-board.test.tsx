// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import type { UserBoard } from '@boardsesh/shared-schema';

// Wires the pure decision (decideAdoptFoundBoard, imported real) to follow +
// offline. We mock every I/O dep and assert which side effects fire per scenario,
// including the follow toast/error paths that ride useFollowBoard's config
// callbacks (they fire after the picker screen unmounts on navigation).

const cfg = vi.hoisted(() => ({
  offlineEnabled: false,
  autoOffline: false,
  syncEnabled: [] as string[],
  confirmResult: true,
}));

const spies = vi.hoisted(() => ({
  mutate: vi.fn(),
  enableBoardsOffline: vi.fn(),
  showToast: vi.fn(),
  confirm: vi.fn((): Promise<boolean> => Promise.resolve(cfg.confirmResult)),
  reportError: vi.fn(),
  followOptions: null as {
    onFollowed?: (board: Pick<UserBoard, 'uuid' | 'name'>) => void;
    onFollowError?: (board: Pick<UserBoard, 'uuid' | 'name'>, error: unknown) => void;
  } | null,
}));

vi.mock('../../graphql/hooks', () => ({
  useFollowBoard: (options: NonNullable<typeof spies.followOptions>) => {
    spies.followOptions = options;
    return { mutate: spies.mutate };
  },
}));
vi.mock('../../../offline/use-board-downloads', () => ({
  useBoardDownloads: () => ({ enableBoardsOffline: spies.enableBoardsOffline }),
}));
vi.mock('../../../providers/dialog-provider', () => ({ useConfirm: () => spies.confirm }));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: spies.showToast }) }));
vi.mock('../../../providers/feature-flags-provider', () => ({
  useOfflineDownloadsEnabled: () => cfg.offlineEnabled,
}));
vi.mock('../../../settings', () => ({
  useSetting: () => [cfg.autoOffline],
  getSetting: () => cfg.syncEnabled,
  offlineBoardKeyForBoard: (board: UserBoard) => `${board.boardType}:${board.layoutId}:${board.sizeId}`,
}));
vi.mock('../../error-reporting', () => ({ reportError: spies.reportError }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { useAdoptFoundBoard } from '../use-adopt-found-board';

const makeBoard = (over: Partial<UserBoard> = {}): UserBoard =>
  ({
    uuid: 'b1',
    name: 'Garage Kilter',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    isOwned: false,
    isFollowedByMe: false,
    ...over,
  }) as unknown as UserBoard;

beforeEach(() => {
  cfg.offlineEnabled = false;
  cfg.autoOffline = false;
  cfg.syncEnabled = [];
  cfg.confirmResult = true;
  spies.mutate.mockClear();
  spies.enableBoardsOffline.mockClear();
  spies.showToast.mockClear();
  spies.confirm.mockClear();
  spies.reportError.mockClear();
  spies.followOptions = null;
});

afterEach(() => cleanup());

describe('useAdoptFoundBoard', () => {
  it('follows a new board and makes no offline offer when the flag is off', async () => {
    const { result } = renderHook(() => useAdoptFoundBoard());
    const board = makeBoard();
    await result.current(board);
    expect(spies.mutate).toHaveBeenCalledWith(board);
    expect(spies.confirm).not.toHaveBeenCalled();
    expect(spies.enableBoardsOffline).not.toHaveBeenCalled();
  });

  it('does not follow a board the user already owns', async () => {
    const { result } = renderHook(() => useAdoptFoundBoard());
    await result.current(makeBoard({ isOwned: true }));
    expect(spies.mutate).not.toHaveBeenCalled();
  });

  it('does not follow a board the user already follows', async () => {
    const { result } = renderHook(() => useAdoptFoundBoard());
    await result.current(makeBoard({ isFollowedByMe: true }));
    expect(spies.mutate).not.toHaveBeenCalled();
  });

  it('asks before downloading a new board when the flag is on and auto-offline is off', async () => {
    cfg.offlineEnabled = true;
    const { result } = renderHook(() => useAdoptFoundBoard());
    const board = makeBoard();
    await result.current(board);
    expect(spies.confirm).toHaveBeenCalledTimes(1);
    expect(spies.enableBoardsOffline).toHaveBeenCalledWith(board);
  });

  it('does not download when the confirm is declined', async () => {
    cfg.offlineEnabled = true;
    cfg.confirmResult = false;
    const { result } = renderHook(() => useAdoptFoundBoard());
    await result.current(makeBoard());
    expect(spies.confirm).toHaveBeenCalledTimes(1);
    expect(spies.enableBoardsOffline).not.toHaveBeenCalled();
  });

  it('auto-downloads without asking when auto-offline is on', async () => {
    cfg.offlineEnabled = true;
    cfg.autoOffline = true;
    const { result } = renderHook(() => useAdoptFoundBoard());
    const board = makeBoard();
    await result.current(board);
    expect(spies.confirm).not.toHaveBeenCalled();
    expect(spies.enableBoardsOffline).toHaveBeenCalledWith(board);
  });

  it('never re-offers a board whose scope is already enabled for offline', async () => {
    cfg.offlineEnabled = true;
    cfg.syncEnabled = ['kilter:1:10'];
    const { result } = renderHook(() => useAdoptFoundBoard());
    await result.current(makeBoard());
    expect(spies.mutate).toHaveBeenCalledTimes(1); // still follows
    expect(spies.confirm).not.toHaveBeenCalled();
    expect(spies.enableBoardsOffline).not.toHaveBeenCalled();
  });

  it('shows a success toast via the follow onFollowed callback', async () => {
    const { result } = renderHook(() => useAdoptFoundBoard());
    const board = makeBoard();
    await result.current(board);
    spies.followOptions?.onFollowed?.(board);
    expect(spies.showToast).toHaveBeenCalledWith('mobile.discovery.followed', 'success');
  });

  it('surfaces a toast and reports the error when the follow fails', async () => {
    const { result } = renderHook(() => useAdoptFoundBoard());
    const board = makeBoard();
    await result.current(board);
    const error = new Error('network');
    spies.followOptions?.onFollowError?.(board, error);
    expect(spies.reportError).toHaveBeenCalledWith(error);
    expect(spies.showToast).toHaveBeenCalledWith('mobile.discovery.followError', 'error');
  });
});
