// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
const boards = vi.hoisted(() => ({
  primary: {
    name: 'Primary Wall',
    uuid: 'primary',
    boardType: 'kilter',
    layoutId: 8,
    sizeId: 25,
    setIds: '26',
    angle: 35,
  },
  active: { uuid: 'restored-spray', boardType: 'spray', layoutId: 47, sizeId: 47, setIds: '1', angle: 40 },
  pending: false,
  set: vi.fn(async (_board: { uuid: string }, _isCurrent?: () => boolean) => true),
  route: '/home',
  params: {} as Record<string, string>,
  replace: vi.fn(),
}));
vi.mock('expo-router', () => ({
  router: { replace: boards.replace },
  usePathname: () => boards.route,
  useGlobalSearchParams: () => boards.params,
}));
vi.mock('../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: boards.active, isPending: boards.pending }),
  useSetActiveBoard: () => boards.set,
}));
vi.mock('../../lib/graphql/hooks', () => ({ useSearchClimbs: () => ({ data: null }) }));
vi.mock('../../lib/screenshot-board-selection', () => ({ resolveScreenshotBoard: () => boards.primary }));
vi.mock('../../hooks/use-screenshot-boards', () => ({
  useScreenshotBoards: () => [{ ...boards.primary, uuid: 'old-board', sizeId: 19, setIds: '27' }, boards.primary],
}));
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
  boards.set.mockReset().mockResolvedValue(true);
  boards.replace.mockClear();
  boards.route = '/home';
  boards.params = {};
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
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
  it('applies a CPP navigation once and acknowledges only the requested native route', async () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_CPP_URL', 'http://localhost:19870/cpp');
    vi.stubEnv(
      'EXPO_PUBLIC_SCREENSHOT_CPP_COMMANDS',
      JSON.stringify({
        'hero-1': {
          selector: 'Primary Wall',
          identity: { uuid: 'primary', boardType: 'kilter', layoutId: 8, sizeId: 25, setIds: [26], angle: 35 },
          route: '/climbs?screenshotBoardIndex=0&screenshotCppScene=hero-1',
        },
      }),
    );
    const fetchCommand = vi.fn(async (_endpoint: string) => ({ json: async () => ({ sequence: 1, scene: 'hero-1' }) }));
    vi.stubGlobal('fetch', fetchCommand);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    boards.pending = false;
    const { rerender, unmount } = renderHook(() => ScreenshotBoardAutoActivator());
    await waitFor(() =>
      expect(boards.replace).toHaveBeenCalledWith('/climbs?screenshotBoardIndex=0&screenshotCppScene=hero-1'),
    );
    expect(boards.set.mock.calls.some(([board]) => board === boards.primary)).toBe(true);
    expect(boards.set.mock.calls.some(([board]) => board.uuid === 'old-board')).toBe(false);
    expect(fetchCommand.mock.calls.some(([endpoint]) => String(endpoint).includes('/ack'))).toBe(false);
    boards.route = '/climbs';
    boards.params = { screenshotBoardIndex: '0', screenshotCppScene: 'hero-1' };
    rerender();
    await waitFor(() => expect(fetchCommand).toHaveBeenCalledWith('http://localhost:19870/cpp/ack?sequence=1'));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 550));
    expect(boards.replace).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('retries an uncommitted board selection without navigating or acknowledging it', async () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_CPP_URL', 'http://localhost:19870/cpp');
    vi.stubEnv(
      'EXPO_PUBLIC_SCREENSHOT_CPP_COMMANDS',
      JSON.stringify({
        'hero-1': {
          selector: boards.primary.name,
          identity: { uuid: 'primary', boardType: 'kilter', layoutId: 8, sizeId: 25, setIds: [26], angle: 35 },
          route: '/climbs?screenshotCppScene=hero-1',
        },
      }),
    );
    boards.active = boards.primary;
    boards.pending = false;
    boards.set.mockResolvedValueOnce(false).mockResolvedValue(true);
    const fetchCommand = vi.fn(async (_endpoint: string) => ({ json: async () => ({ sequence: 1, scene: 'hero-1' }) }));
    vi.stubGlobal('fetch', fetchCommand);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { rerender, unmount } = renderHook(() => ScreenshotBoardAutoActivator());
    await waitFor(() => expect(boards.set).toHaveBeenCalledTimes(1));
    expect(boards.replace).not.toHaveBeenCalled();
    expect(fetchCommand.mock.calls.some(([endpoint]) => endpoint.includes('/ack'))).toBe(false);
    await waitFor(() => expect(boards.replace).toHaveBeenCalledWith('/climbs?screenshotCppScene=hero-1'));
    expect(boards.set).toHaveBeenCalledTimes(2);
    expect(fetchCommand.mock.calls.some(([endpoint]) => endpoint.includes('/ack'))).toBe(false);
    boards.route = '/climbs';
    boards.params = { screenshotCppScene: 'hero-1' };
    rerender();
    await waitFor(() => expect(fetchCommand).toHaveBeenCalledWith('http://localhost:19870/cpp/ack?sequence=1'));
    unmount();
  });
});
