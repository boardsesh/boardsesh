// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { UserBoard } from '@boardsesh/shared-schema';

// The drawer's wall switch through the REAL adoption hook, with only its I/O
// mocked. Since #5654 every wall someone else built counts as new to the
// climber, so without `offerOffline: false` a "Download X?" dialog would land on
// nearly every hop between walls, often mid-session.

const cfg = vi.hoisted(() => ({
  offlineEnabled: true,
  autoOffline: false,
}));

const spies = vi.hoisted(() => ({
  setActiveBoard: vi.fn((): Promise<void> => Promise.resolve()),
  followMutate: vi.fn(),
  enableBoardsOffline: vi.fn(),
  confirm: vi.fn((): Promise<boolean> => Promise.resolve(true)),
  showToast: vi.fn(),
}));

vi.mock('../../graphql/use-active-board', () => ({ useSetActiveBoard: () => spies.setActiveBoard }));
vi.mock('../../graphql/hooks', () => ({
  useFollowBoard: () => ({ mutate: spies.followMutate }),
  useProfile: () => ({ data: { id: 'viewer-1' } }),
}));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('../../../hooks/use-current-user-id', () => ({
  useStoredUserId: () => ({ userId: undefined, isLoading: false }),
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
  getSetting: () => [],
  offlineBoardKeyForBoard: (board: UserBoard) => `${board.boardType}:${board.layoutId}:${board.sizeId}`,
}));
vi.mock('../board-angle-store', () => ({
  resolveBoardAngle: (board: UserBoard) => Promise.resolve(board.angle),
}));
vi.mock('../../haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../analytics', () => ({ track: vi.fn() }));
vi.mock('../../error-reporting', () => ({ reportError: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { useSwitchBoard } from '../use-switch-board';

// The other wall at the same gym, built by the gym's setter: the board a hop
// usually lands on.
const CURRENT_WALL = {
  uuid: 'kilter-1',
  name: 'Pump Station - Kilter',
  boardType: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '1,20',
  angle: 40,
  gymUuid: 'gym-1',
  ownerId: 'setter-1',
  isOwned: true,
  isPublic: true,
  isFollowedByMe: true,
} as unknown as UserBoard;

const OTHER_WALL = {
  uuid: 'tension-1',
  name: 'Pump Station - Tension',
  boardType: 'tension',
  layoutId: 8,
  sizeId: 3,
  setIds: '5,6',
  angle: 25,
  gymUuid: 'gym-1',
  ownerId: 'setter-1',
  isOwned: true,
  isPublic: true,
  isFollowedByMe: false,
} as unknown as UserBoard;

/** Let the fire-and-forget adoption run past its awaits. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  cfg.offlineEnabled = true;
  cfg.autoOffline = false;
  spies.setActiveBoard.mockImplementation(() => Promise.resolve());
});

describe('useSwitchBoard adoption', () => {
  it('follows the wall it hops to without asking to download it', async () => {
    const { result } = renderHook(() => useSwitchBoard({ source: 'presence_sheet_sibling' }));

    await expect(result.current(OTHER_WALL, CURRENT_WALL)).resolves.toBe('switched');
    await settle();

    expect(spies.followMutate).toHaveBeenCalledWith(expect.objectContaining({ uuid: 'tension-1' }));
    expect(spies.confirm).not.toHaveBeenCalled();
    expect(spies.enableBoardsOffline).not.toHaveBeenCalled();
  });

  it('still downloads the wall when the climber keeps every board offline', async () => {
    cfg.autoOffline = true;
    const { result } = renderHook(() => useSwitchBoard({ source: 'move_to_wall_callout' }));

    await result.current(OTHER_WALL, CURRENT_WALL);
    await settle();

    expect(spies.confirm).not.toHaveBeenCalled();
    expect(spies.enableBoardsOffline).toHaveBeenCalledWith(expect.objectContaining({ uuid: 'tension-1' }), {
      trigger: 'adopt-auto',
      source: 'adopt',
    });
  });
});
