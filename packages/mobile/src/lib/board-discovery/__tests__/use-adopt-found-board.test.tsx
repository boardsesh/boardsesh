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
  isAuthenticated: true,
  profileId: 'viewer-1' as string | undefined,
  storedUserId: undefined as string | undefined,
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
  useProfile: () => ({ data: cfg.profileId ? { id: cfg.profileId } : undefined }),
}));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: cfg.isAuthenticated }) }));
vi.mock('../../../hooks/use-current-user-id', () => ({
  useStoredUserId: (enabled: boolean) => ({ userId: enabled ? cfg.storedUserId : undefined, isLoading: false }),
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

import { useAdoptFoundBoard, useWillFollowFoundBoard } from '../use-adopt-found-board';

const makeBoard = (over: Partial<UserBoard> = {}): UserBoard =>
  ({
    uuid: 'b1',
    name: 'Garage Kilter',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    // Someone else's board, marked by its creator as a real wall: the default
    // for every board built in the app.
    ownerId: 'setter-1',
    isOwned: true,
    isPublic: true,
    isFollowedByMe: false,
    ...over,
  }) as unknown as UserBoard;

beforeEach(() => {
  cfg.offlineEnabled = false;
  cfg.autoOffline = false;
  cfg.syncEnabled = [];
  cfg.confirmResult = true;
  cfg.isAuthenticated = true;
  cfg.profileId = 'viewer-1';
  cfg.storedUserId = undefined;
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

  // #5654: `isOwned` is the creator's "a real wall" flag, true for every board
  // built in the app. Reading it as "yours" left these boards unfollowed.
  it("follows someone else's board even though its creator marked it as their own wall", async () => {
    const { result } = renderHook(() => useAdoptFoundBoard());
    const board = makeBoard({ ownerId: 'setter-1', isOwned: true });
    await result.current(board);
    expect(spies.mutate).toHaveBeenCalledWith(board);
  });

  it('does not follow a board the viewer built', async () => {
    const { result } = renderHook(() => useAdoptFoundBoard());
    await result.current(makeBoard({ ownerId: 'viewer-1' }));
    expect(spies.mutate).not.toHaveBeenCalled();
  });

  it('follows an Aurora gym pin (isOwned false)', async () => {
    const { result } = renderHook(() => useAdoptFoundBoard());
    const board = makeBoard({ ownerId: '00000000-0000-0000-0000-000000000000', isOwned: false });
    await result.current(board);
    expect(spies.mutate).toHaveBeenCalledWith(board);
  });

  // No signal: the profile never answers, but the id on the device does.
  it('recognises the viewer from the stored id when the profile has not loaded', async () => {
    cfg.profileId = undefined;
    cfg.storedUserId = 'viewer-1';
    const { result } = renderHook(() => useAdoptFoundBoard());
    await result.current(makeBoard({ ownerId: 'viewer-1' }));
    expect(spies.mutate).not.toHaveBeenCalled();
  });

  it('does not ask about offline while the viewer is unresolved', async () => {
    cfg.profileId = undefined;
    cfg.offlineEnabled = true;
    const { result } = renderHook(() => useAdoptFoundBoard());
    const board = makeBoard();
    await result.current(board);
    // A harmless self-follow at worst, never a download prompt for your own wall.
    expect(spies.mutate).toHaveBeenCalledWith(board);
    expect(spies.confirm).not.toHaveBeenCalled();
  });

  it("does not try to follow someone else's private board", async () => {
    const { result } = renderHook(() => useAdoptFoundBoard());
    await result.current(makeBoard({ isPublic: false }));
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
    // 'adopt-confirmed', not 'adopt-auto': the split is what makes discovery
    // work measurable against deliberate opt-ins (issue #4316).
    expect(spies.enableBoardsOffline).toHaveBeenCalledWith(board, {
      trigger: 'adopt-confirmed',
      source: 'adopt',
    });
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
    // The setting acting on its own — NOT a tap.
    expect(spies.enableBoardsOffline).toHaveBeenCalledWith(board, { trigger: 'adopt-auto', source: 'adopt' });
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

  // The onboarding bind and the drawer's wall switch: the follow stays, the
  // dialog goes, and only the climber's own auto-offline setting still downloads.
  describe('with offerOffline: false', () => {
    it('follows but never asks about offline', async () => {
      cfg.offlineEnabled = true;
      const { result } = renderHook(() => useAdoptFoundBoard({ offerOffline: false }));
      const board = makeBoard();
      await result.current(board);
      expect(spies.mutate).toHaveBeenCalledWith(board);
      expect(spies.confirm).not.toHaveBeenCalled();
      expect(spies.enableBoardsOffline).not.toHaveBeenCalled();
    });

    it('still auto-downloads when auto-offline is on', async () => {
      cfg.offlineEnabled = true;
      cfg.autoOffline = true;
      const { result } = renderHook(() => useAdoptFoundBoard({ offerOffline: false }));
      const board = makeBoard();
      await result.current(board);
      expect(spies.confirm).not.toHaveBeenCalled();
      expect(spies.enableBoardsOffline).toHaveBeenCalledWith(board, { trigger: 'adopt-auto', source: 'adopt' });
    });
  });

  // followBoard needs a session. Without this gate a signed-out pick (guest mode)
  // would end in a "Couldn't add X" toast and an error report.
  it('never tries to follow while signed out', async () => {
    cfg.isAuthenticated = false;
    const { result } = renderHook(() => useAdoptFoundBoard());
    await result.current(makeBoard());
    expect(spies.mutate).not.toHaveBeenCalled();
    expect(spies.showToast).not.toHaveBeenCalled();
    expect(spies.reportError).not.toHaveBeenCalled();
    expect(spies.confirm).not.toHaveBeenCalled();
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

describe('useWillFollowFoundBoard', () => {
  it('agrees with adoption about whether a pick follows the board', () => {
    const { result } = renderHook(() => useWillFollowFoundBoard());
    expect(result.current(makeBoard())).toBe(true);
    expect(result.current(makeBoard({ ownerId: 'viewer-1' }))).toBe(false);
    expect(result.current(makeBoard({ isFollowedByMe: true }))).toBe(false);
    expect(result.current(makeBoard({ isPublic: false }))).toBe(false);
  });

  it('says a signed-out pick follows nothing', () => {
    cfg.isAuthenticated = false;
    const { result } = renderHook(() => useWillFollowFoundBoard());
    expect(result.current(makeBoard())).toBe(false);
  });
});
