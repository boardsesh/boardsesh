// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
const boards = vi.hoisted(() => ({
  primary: { uuid: 'primary', boardType: 'kilter', layoutId: 8, sizeId: 25, setIds: '26', angle: 35 },
  active: { uuid: 'restored-spray', boardType: 'spray', layoutId: 47, sizeId: 47, setIds: '1', angle: 40 },
  pending: false,
  set: vi.fn(),
}));
vi.mock('../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: boards.active, isPending: boards.pending }),
  useSetActiveBoard: () => boards.set,
}));
vi.mock('../../lib/graphql/hooks', () => ({ useSearchClimbs: () => ({ data: null }) }));
vi.mock('../../lib/screenshot-board-selection', () => ({ resolveScreenshotBoard: () => boards.primary }));
vi.mock('../../hooks/use-screenshot-boards', () => ({ useScreenshotBoards: () => [boards.primary] }));
vi.mock('../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('../../lib/screenshot-mode', () => ({ SCREENSHOT_NOW_MS: null }));
vi.mock('../../lib/board-presence/screenshot-wall-seed', () => ({
  buildScreenshotWallSeed: vi.fn(),
  publishScreenshotWallClimbs: vi.fn(),
  SCREENSHOT_WALL_SEED_COUNT: 6,
}));
import { ScreenshotBoardAutoActivator } from '../screenshot-board-auto-activator';
afterEach(() => {
  vi.restoreAllMocks();
  boards.set.mockClear();
});
describe('ScreenshotBoardAutoActivator', () => {
  it('replaces a restored board once, then permits later capture slots', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const restored = boards.active;
    boards.pending = true;
    const { rerender, unmount } = renderHook(() => ScreenshotBoardAutoActivator());
    expect(boards.set).not.toHaveBeenCalled();
    boards.pending = false;
    rerender();
    expect(boards.set).toHaveBeenCalledWith(boards.primary);
    boards.active = boards.primary;
    rerender();
    boards.set.mockClear();
    boards.active = restored;
    rerender();
    expect(boards.set).not.toHaveBeenCalled();
    unmount();
  });
});
