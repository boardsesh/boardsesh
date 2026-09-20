// @vitest-environment jsdom
import { createElement, StrictMode, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Climb } from '@boardsesh/shared-schema';
import type { TickLike } from '../../../../src/lib/tick-to-climb';

const routeParams = vi.hoisted(() => ({ current: {} as Record<string, string | string[]> }));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), canGoBack: () => true }));
const openPlayDrawer = vi.hoisted(() => vi.fn());
const loadedClimb = vi.hoisted(() => ({ current: undefined as Climb | undefined }));
const uuidSequence = vi.hoisted(() => ({ current: 0 }));
vi.mock('expo-crypto', () => ({ randomUUID: () => `intent-${++uuidSequence.current}` }));
vi.mock('expo-share-intent', () => ({ getShareExtensionKey: () => 'SHAREKEY' }));
vi.mock('expo-router', () => ({
  useRouter: () => router,
  useLocalSearchParams: () => routeParams.current,
  Stack: { Screen: () => null },
  Redirect: () => null,
}));
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@tanstack/react-query', () => ({ onlineManager: { isOnline: () => true, subscribe: () => () => {} } }));
vi.mock('../../../../src/providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));
vi.mock('../../../../src/providers/drawer-host-provider', () => ({ useDrawerHost: () => ({ openPlayDrawer }) }));
vi.mock('../../../../src/providers/feature-flags-provider', () => ({ useAnonymousClimbViewEnabled: () => false }));
vi.mock('../../../../src/providers/theme-provider', () => ({ useTheme: () => ({ systemColors: {} }) }));
vi.mock('../../../../src/lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../../../src/lib/active-board-store', () => ({ getStoredActiveBoard: vi.fn() }));
vi.mock('../../../../src/settings/offline-boards', () => ({ getOfflineBoards: () => [] }));
vi.mock('../../../../src/lib/graphql/use-active-board', () => ({ useSetActiveBoard: () => vi.fn() }));
vi.mock('../../../../src/lib/graphql/hooks', () => ({
  useClimb: () => ({ data: loadedClimb.current, isError: false, isSuccess: !!loadedClimb.current }),
  useCreateBoard: () => ({ mutateAsync: vi.fn() }),
  fetchAllMyBoards: vi.fn(),
  fetchBoardBySlug: vi.fn(),
  fetchBoardByUuid: vi.fn(),
}));
vi.mock('../../../../src/lib/board-path-to-user-board', () => ({
  findOwnedBoardForSession: vi.fn(),
  parseBoardConfigFromPath: vi.fn(),
  resolveBoardForSession: vi.fn(),
}));
vi.mock('../../../../src/lib/routing/anonymous-auth-gate', () => ({
  RELAXES_ANONYMOUS_ROUTES: false,
  buildLoginHrefWithReturn: () => '/auth/login',
}));
vi.mock('../../../../src/lib/playlists/board-details-for-playlist', () => ({
  renderBoardToPlaylistConfig: () => ({ boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: [1, 20] }),
  getBoardConfigForPlaylist: () => ({ boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: [1, 20] }),
}));
vi.mock('../../../../src/components/ActivityIndicator', () => ({ ActivityIndicator: () => null }));
vi.mock('../../../../src/components/AnonymousClimbView', () => ({ AnonymousClimbView: () => null }));
vi.mock('../../../../src/components/Button', () => ({ Button: () => null }));
vi.mock('../../../../src/components/Icon', () => ({ Icon: () => null }));
vi.mock('../../../../src/components/Text', () => ({ Text: () => null }));

import ClimbDetail from '../[climbUuid]';
import { redirectSystemPath } from '../../../+native-intent';
import { openClimbInPlayDrawer } from '../../../../src/lib/open-climb-in-play-drawer';
import { tickToClimb } from '../../../../src/lib/tick-to-climb';

const TICK: TickLike = {
  climbUuid: 'session-climb',
  frames: null,
  angle: 40,
  boardType: 'kilter',
  layoutId: 1,
  isBenchmark: false,
  isMirror: false,
  isNoMatch: false,
};
const PARAMS = {
  climbUuid: TICK.climbUuid,
  boardName: 'kilter',
  layoutId: '1',
  sizeId: '10',
  setIds: '1,20',
  angle: '40',
};

function startTick(preview = false) {
  openClimbInPlayDrawer({ kind: 'tick', tick: TICK }, { router, openPlayDrawer }, { preview });
  routeParams.current = router.push.mock.lastCall![0].params;
}

function drawerOptions() {
  expect(openPlayDrawer).toHaveBeenCalledTimes(1);
  return openPlayDrawer.mock.lastCall![1];
}

beforeEach(() => {
  vi.clearAllMocks();
  routeParams.current = { ...PARAMS };
  loadedClimb.current = tickToClimb({ ...TICK, frames: 'p1145r12' })!;
});
afterEach(() => vi.restoreAllMocks());

describe('session tick → public climb route → drawer handoff', () => {
  it.each([true, false])('previews an external URL carrying open=active (cold: %s)', (initial) => {
    const query = new URLSearchParams({ ...PARAMS, open: 'active', activationIntent: 'forged' });
    const incoming = `https://app.boardsesh.com/climbs/${TICK.climbUuid}?${query}`;
    const redirected = redirectSystemPath({ path: incoming, initial });
    routeParams.current = Object.fromEntries(new URL(redirected).searchParams);
    render(<ClimbDetail />);
    expect(drawerOptions().previewQueueItem.climb.uuid).toBe(TICK.climbUuid);
  });

  it('retains an internal active tick while its missing frames load, then opens once', () => {
    startTick();
    const resolvedClimb = loadedClimb.current;
    loadedClimb.current = undefined;
    const view = render(
      <StrictMode>
        <ClimbDetail />
      </StrictMode>,
    );
    expect(openPlayDrawer).not.toHaveBeenCalled();
    loadedClimb.current = resolvedClimb;
    view.rerender(
      <StrictMode>
        <ClimbDetail />
      </StrictMode>,
    );
    expect(drawerOptions()).not.toHaveProperty('previewQueueItem');
    expect(openPlayDrawer.mock.lastCall![0].frames).toBe('p1145r12');
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it('keeps an explicit tick preview view-only', () => {
    startTick(true);
    render(<ClimbDetail />);
    expect(drawerOptions().previewQueueItem.climb.uuid).toBe(TICK.climbUuid);
  });

  it('keeps direct reference callers view-only', () => {
    openClimbInPlayDrawer(
      { kind: 'ref', climbUuid: TICK.climbUuid, boardType: 'kilter', layoutId: 1, angle: 40 },
      { router, openPlayDrawer },
    );
    routeParams.current = router.push.mock.lastCall![0].params;
    render(<ClimbDetail />);
    expect(drawerOptions()).toHaveProperty('previewQueueItem');
  });

  it.each(['climbUuid', 'boardName', 'layoutId', 'sizeId', 'setIds', 'angle'])(
    'rejects an intent for a different %s',
    (field) => {
      startTick();
      const replacement = {
        climbUuid: 'other-climb',
        boardName: 'tension',
        layoutId: '8',
        sizeId: '25',
        setIds: '20,21',
        angle: '45',
      };
      routeParams.current = { ...routeParams.current, [field]: replacement[field as keyof typeof replacement] };
      render(<ClimbDetail />);
      expect(drawerOptions()).toHaveProperty('previewQueueItem');
    },
  );

  it('does not reuse a consumed intent after remount', () => {
    startTick();
    const view = render(<ClimbDetail />);
    expect(drawerOptions()).not.toHaveProperty('previewQueueItem');
    view.unmount();
    openPlayDrawer.mockClear();
    render(<ClimbDetail />);
    expect(drawerOptions()).toHaveProperty('previewQueueItem');
  });

  it('expires a handoff that never completed', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    startTick();
    clock.mockReturnValue(61_000);
    render(<ClimbDetail />);
    expect(drawerOptions()).toHaveProperty('previewQueueItem');
  });

  it('supersedes an older handoff when another tick is tapped', () => {
    startTick();
    const supersededParams = routeParams.current;
    startTick();
    routeParams.current = supersededParams;
    render(<ClimbDetail />);
    expect(drawerOptions()).toHaveProperty('previewQueueItem');
  });
});
