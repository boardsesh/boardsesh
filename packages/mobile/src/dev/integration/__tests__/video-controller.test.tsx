// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const harness = vi.hoisted(() => ({
  pathname: '/dev/integration/video',
  params: { command: 'request-one', boardIndex: '1', openFirst: '1' } as Record<string, string>,
  active: { uuid: 'old', name: 'Old board', boardType: 'kilter', layoutId: 1, sizeId: 7, setIds: '1', angle: 40 },
  roster: [] as unknown[],
  queries: [] as unknown[],
  listeners: new Set<() => void>(),
  activateBoard: vi.fn(async () => {}),
  activateClimb: vi.fn(async () => {}),
  replace: vi.fn(),
  error: vi.fn(),
}));
vi.mock('expo-router', () => ({
  router: { replace: harness.replace },
  usePathname: () => harness.pathname,
  useGlobalSearchParams: () => harness.params,
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: harness.roster }),
  useQueryClient: () => queryClient,
}));
const queryClient = {
  getQueryCache: () => ({
    findAll: () => harness.queries,
    subscribe: (listener: () => void) => {
      harness.listeners.add(listener);
      return () => harness.listeners.delete(listener);
    },
  }),
};
vi.mock('../../../lib/graphql/hooks', () => ({ fetchAllMyBoards: vi.fn() }));
vi.mock('../../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: harness.active }),
  useSetActiveBoard: () => harness.activateBoard,
}));
vi.mock('../../../lib/graphql/query-keys', () => ({ INFINITE_SEARCH_CLIMBS_QUERY_KEY: ['search'] }));
vi.mock('../../../lib/graphql/operations', () => ({ SEARCH_CLIMBS: 'search' }));
vi.mock('../../../lib/graphql/offline-request', () => ({ offlineAwareRequest: vi.fn() }));
vi.mock('../../../lib/climb-types', () => ({ toQueueClimbs: (climbs: unknown) => climbs }));
vi.mock('../../../lib/playlists/use-playlist-activation', () => ({
  usePlaylistActivation: () => ({ activate: harness.activateClimb }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../config', () => ({ boardSelectors: ['Old board', 'Target board'] }));
vi.mock('../screenshot-smoke', () => ({ reportScreenshotSmokeError: harness.error }));
import { IntegrationVideoController } from '../IntegrationVideoController';
const target = {
  uuid: 'target',
  name: 'Target board',
  boardType: 'tension',
  layoutId: 10,
  sizeId: 1,
  setIds: '2',
  angle: 40,
};
const targetClimb = { uuid: 'target-climb', boardType: 'tension', layoutId: 10, frames: 'p1r1' };
function query(board: typeof target, climb = targetClimb) {
  return {
    queryKey: [
      'search',
      {
        boardName: board.boardType,
        layoutId: board.layoutId,
        sizeId: board.sizeId,
        setIds: board.setIds,
        angle: board.angle,
      },
    ],
    state: {
      status: 'success',
      fetchStatus: 'idle',
      dataUpdatedAt: 1,
      data: { pages: [{ searchClimbs: { climbs: [climb], hasMore: false } }] },
    },
  };
}
beforeEach(() => {
  harness.pathname = '/dev/integration/video';
  harness.params = { command: 'request-one', boardIndex: '1', openFirst: '1' };
  harness.active = {
    uuid: 'old',
    name: 'Old board',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 7,
    setIds: '1',
    angle: 40,
  };
  harness.roster = [harness.active, target];
  harness.queries = [];
  harness.listeners.clear();
  vi.clearAllMocks();
  vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_READY_URL', 'http://localhost:1234/ready/primary');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true })),
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe('real-data recording setup', () => {
  it('selects one real board and waits for its active query before opening its actual climb', async () => {
    const screen = render(<IntegrationVideoController />);
    await waitFor(() => expect(harness.activateBoard).toHaveBeenCalledExactlyOnceWith(target));
    await waitFor(() => expect(harness.replace).toHaveBeenCalledWith('/climbs'));
    harness.pathname = '/climbs';
    harness.active = target;
    harness.queries = [query({ ...target, boardType: 'kilter' }, { ...targetClimb, boardType: 'kilter' })];
    screen.rerender(<IntegrationVideoController />);
    expect(harness.activateClimb).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    harness.queries = [query(target)];
    act(() => harness.listeners.forEach((listener) => listener()));
    await waitFor(() => expect(harness.activateClimb).toHaveBeenCalledExactlyOnceWith(targetClimb));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(new URL('http://localhost:1234/set/integration-ready-request-one')),
    );
    screen.rerender(<IntegrationVideoController />);
    expect(harness.activateClimb).toHaveBeenCalledTimes(1);
  });
  it('fails ambiguous selectors without changing a board or claiming readiness', async () => {
    harness.roster = [target, { ...target, uuid: 'duplicate' }];
    render(<IntegrationVideoController />);
    await waitFor(() => expect(harness.error).toHaveBeenCalled());
    expect(harness.activateBoard).not.toHaveBeenCalled();
    expect(harness.replace).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(new URL('http://localhost:1234/set/integration-error-request-one'));
  });
  it('select-only commands retain real list readiness without opening the player', async () => {
    harness.params.openFirst = '0';
    const screen = render(<IntegrationVideoController />);
    await waitFor(() => expect(harness.replace).toHaveBeenCalled());
    harness.pathname = '/climbs';
    harness.active = target;
    harness.queries = [query(target)];
    screen.rerender(<IntegrationVideoController />);
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(new URL('http://localhost:1234/set/integration-ready-request-one')),
    );
    expect(harness.activateClimb).not.toHaveBeenCalled();
  });
});
