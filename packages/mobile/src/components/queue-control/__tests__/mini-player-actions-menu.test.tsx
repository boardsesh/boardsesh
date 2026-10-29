// @vitest-environment jsdom
// The MiniPlayer's ⋯ runs the REAL `useClimbActions` and the real row builder;
// the menu's native shell, the bar's own button hooks and the I/O behind them
// are doubles. The bar sits over the tabs, so its sheets open through the root
// openers on `useDrawerHost()`.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import type { Climb } from '@boardsesh/queue';
import type { AppMenuProps } from '../../AppMenu.types';
import type { MiniPlayerButtonId } from '../../../lib/mini-player-buttons';

const menu = vi.hoisted(() => ({ props: null as AppMenuProps | null }));
const rootOpeners = vi.hoisted(() => ({
  openPlayDrawer: vi.fn(),
  openAddToPlaylist: vi.fn(),
  openLogAscent: vi.fn(),
  openAddBetaVideo: vi.fn(),
  openReportClimb: vi.fn(),
  openAnglePicker: vi.fn(),
}));
const bar = vi.hoisted(() => ({
  isFavorited: false,
  toggleFavorite: vi.fn(),
  favoriteArgs: null as { source?: string; enabled?: boolean } | null,
  isMirrored: false,
  toggleMirror: vi.fn(),
  openQueue: vi.fn(),
  queueSurface: null as string | null,
}));
const route = vi.hoisted(() => ({ segments: ['(tabs)', 'climbs'] as string[], push: vi.fn() }));
const profile = vi.hoisted(() => ({ id: 'me' as string | undefined }));

vi.mock('../../AppMenu', () => ({
  AppMenu: (props: AppMenuProps) => {
    menu.props = props;
    return createElement(
      'div',
      { 'aria-label': props.accessibilityLabel, 'data-icon': props.iconName },
      props.actions.map((action, index) =>
        createElement(
          'button',
          {
            key: `${index}-${action.label}`,
            'data-divider': action.dividerBefore ? 'true' : 'false',
            onClick: () => props.onSelectIndex(index),
          },
          action.label,
        ),
      ),
    );
  },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key),
  }),
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: route.push }),
  useSegments: () => route.segments,
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'queue-uuid' }));
vi.mock('expo-web-browser', () => ({ openBrowserAsync: vi.fn(async () => {}) }));
vi.mock('@boardsesh/analytics', () => ({ SHARED_EVENTS: {} }));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../../lib/spray/use-spray-wall-archive', () => ({ useSprayWallIsArchived: () => false }));
vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ ...rootOpeners, boardConfig: null }),
  boardConfigsMatch: () => true,
}));
vi.mock('../../../providers/feature-flags-provider', () => ({ useClimbModerationEnabled: () => true }));
vi.mock('../../../providers/queue-provider', () => ({
  useQueueActions: () => ({
    addToQueue: vi.fn(),
    playNext: vi.fn(),
    setCurrentClimb: vi.fn(),
    findReplayFromHereItem: () => null,
    getQueueSnapshot: () => ({ queue: [], currentClimbQueueItem: null, sessionId: null }),
  }),
  useQueueSessionId: () => ({ sessionId: null }),
  useActiveClimbUuid: () => 'climb-1',
}));
vi.mock('../../../lib/climb-to-queue-item', () => ({ climbToQueueItem: (climb: unknown) => ({ uuid: 'qi', climb }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ actionColors: { success: '#0a0', favorite: '#f00', accent: '#00f' } }),
}));
vi.mock('../../../lib/graphql/hooks', () => ({
  useProfile: () => ({ data: profile.id ? { id: profile.id } : undefined }),
  useToggleFavorite: () => ({ mutate: vi.fn() }),
  useFavoriteStatus: () => ({ data: false }),
}));
vi.mock('../../../lib/ble/bluetooth-status-store', () => ({ useBluetoothConnectedStatus: () => false }));
vi.mock('../../../hooks/use-share-climb', () => ({ useShareClimb: () => vi.fn(async () => {}) }));
vi.mock('../../climb-actions/use-delete-climb-action', () => ({ useDeleteClimbAction: () => vi.fn() }));
vi.mock('../../create-climb/use-create-climb-navigation', () => ({
  useCreateClimbNavigation: () => ({ openRemix: vi.fn(), openEdit: vi.fn(), resetActionGuard: vi.fn() }),
}));
// The bar's own buttons' hooks: the menu must run these, not its own copies.
vi.mock('../MiniPlayerButtons', () => ({
  useMiniPlayerFavorite: (args: { source?: string; enabled?: boolean }) => {
    bar.favoriteArgs = args;
    return { isFavorited: bar.isFavorited, toggle: bar.toggleFavorite };
  },
  useMiniPlayerMirrorToggle: () => ({ isMirrored: bar.isMirrored, toggle: bar.toggleMirror }),
  useOpenMiniPlayerQueue: (surface: string) => {
    bar.queueSurface = surface;
    return bar.openQueue;
  },
}));

import {
  MiniPlayerActionsMenu,
  climbViewSettingsHref,
  miniPlayerMenuHiddenButtons,
  type MiniPlayerActionsMenuProps,
} from '../MiniPlayerActionsMenu';

const CLIMB = {
  uuid: 'climb-1',
  name: 'Crimp Line',
  frames: 'p1r12',
  userId: 'setter-9',
} as unknown as Climb;
// Tension can be set on, so Fork shows; it mirrors.
const TENSION = { boardName: 'tension', layoutId: 10, sizeId: 6, setIds: '12,13', angle: 35 };
const everyButton = () => true;

function renderMenu(overrides: Partial<MiniPlayerActionsMenuProps> = {}) {
  return render(
    createElement(MiniPlayerActionsMenu, {
      climb: CLIMB,
      climbBoard: TENSION,
      queueItemUuid: 'slot-1',
      isAuthenticated: true,
      shownButtons: ['previous', 'next'],
      isAvailable: everyButton,
      angleClimbUuid: 'climb-1',
      bluetoothConnected: false,
      size: 44,
      ...overrides,
    }),
  );
}

const labels = (container: HTMLElement) => [...container.querySelectorAll('button')].map((row) => row.textContent);

function tap(container: HTMLElement, label: string) {
  const row = [...container.querySelectorAll('button')].find((button) => button.textContent === label);
  if (!row) throw new Error(`no row labelled ${label}`);
  fireEvent.click(row);
}

beforeEach(() => {
  vi.clearAllMocks();
  menu.props = null;
  bar.isFavorited = false;
  bar.isMirrored = false;
  route.segments = ['(tabs)', 'climbs'];
  profile.id = 'me';
});

describe('MiniPlayerActionsMenu', () => {
  it("offers Music's order, with a row for each bar button the bar is not showing", () => {
    const { container } = renderMenu();
    expect(labels(container)).toEqual([
      'session:playView.actionBar.addFavoriteAria',
      'actions.playlist.popover.title',
      'share.actionLabel',
      'mobile.climbActions.openQueue',
      'session:playView.actionBar.mirrorAria',
      'session:playView.actionBar.changeAngle',
      'mobile.climbActions.addBetaVideo',
      'mobile.climbActions.fork',
      'mobile.settings.climbView.title',
      'mobile.climbActions.openInApp',
      'mobile.climbActions.report',
    ]);
    // A divider opens each group after the first.
    const dividers = [...container.querySelectorAll('button')]
      .filter((row) => row.getAttribute('data-divider') === 'true')
      .map((row) => row.textContent);
    expect(dividers).toEqual([
      'mobile.climbActions.openQueue',
      'session:playView.actionBar.mirrorAria',
      'mobile.climbActions.addBetaVideo',
      'mobile.settings.climbView.title',
      'mobile.climbActions.report',
    ]);
  });

  it("opens the climb in the Kilter or Tension app, as the player's ⋯ does", async () => {
    const { openBrowserAsync } = await import('expo-web-browser');
    tap(renderMenu().container, 'mobile.climbActions.openInApp');
    expect(openBrowserAsync).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(openBrowserAsync).mock.calls[0]?.[0])).toContain('climb-1');
  });

  it('never offers Play next, Play last or Log: the climb is on the wall and ✓ is beside ⋯', () => {
    const text = renderMenu().container.textContent ?? '';
    expect(text).not.toContain('mobile.climbActions.playNext');
    expect(text).not.toContain('mobile.climbActions.playLast');
    expect(text).not.toContain('mobile.climbActions.tick');
  });

  it('leaves out what the bar already shows', () => {
    const shown: MiniPlayerButtonId[] = ['previous', 'next', 'favorite', 'mirror', 'share', 'queue', 'angle'];
    expect(labels(renderMenu({ shownButtons: shown }).container)).toEqual([
      'actions.playlist.popover.title',
      'mobile.climbActions.addBetaVideo',
      'mobile.climbActions.fork',
      'mobile.settings.climbView.title',
      'mobile.climbActions.openInApp',
      'mobile.climbActions.report',
    ]);
    // With the heart on the bar, the menu reads no favourite of its own.
    expect(bar.favoriteArgs?.enabled).toBe(false);
  });

  it('leaves out what the bar could never show here: no heart or queue signed out, no Mirror on Kilter', () => {
    const hidden = miniPlayerMenuHiddenButtons(['next'], (buttonId) => buttonId !== 'mirror');
    expect(hidden).toEqual({ favorite: true, share: true, queue: true, mirror: false, angle: true });
    const signedOut = renderMenu({
      isAuthenticated: false,
      isAvailable: (buttonId) => buttonId !== 'favorite' && buttonId !== 'queue',
    });
    const text = signedOut.container.textContent ?? '';
    expect(text).not.toContain('addFavoriteAria');
    expect(text).not.toContain('mobile.climbActions.openQueue');
    // Beta video and Report need an account.
    expect(text).not.toContain('mobile.climbActions.addBetaVideo');
    expect(text).not.toContain('mobile.climbActions.report');
    expect(text).toContain('share.actionLabel');
  });

  it('offers a draft no Share and no Report, and its setter Edit', () => {
    const draft = { ...CLIMB, is_draft: true, userId: 'me' } as unknown as Climb;
    const text =
      renderMenu({ climb: draft, isAvailable: (buttonId) => buttonId !== 'share' }).container.textContent ?? '';
    expect(text).not.toContain('share.actionLabel');
    expect(text).not.toContain('mobile.climbActions.report');
    expect(text).toContain('mobile.climbActions.edit');
  });

  it("runs the bar's own heart, mirror and queue, tagged as the MiniPlayer's menu", () => {
    const { container } = renderMenu();
    expect(bar.favoriteArgs).toMatchObject({ source: 'mini_player_menu', enabled: true });
    expect(bar.queueSurface).toBe('mini_player_menu');
    tap(container, 'session:playView.actionBar.addFavoriteAria');
    expect(bar.toggleFavorite).toHaveBeenCalledTimes(1);
    tap(container, 'session:playView.actionBar.mirrorAria');
    expect(bar.toggleMirror).toHaveBeenCalledTimes(1);
    tap(container, 'mobile.climbActions.openQueue');
    expect(bar.openQueue).toHaveBeenCalledTimes(1);
  });

  it('says which way the heart and the mirror go', () => {
    bar.isFavorited = true;
    bar.isMirrored = true;
    const text = renderMenu().container.textContent ?? '';
    expect(text).toContain('session:playView.actionBar.removeFavoriteAria');
    expect(text).toContain('session:playView.actionBar.unmirrorAria');
  });

  it("opens every sheet through the root openers, pinned to the climb's own board", () => {
    const { container } = renderMenu();
    tap(container, 'actions.playlist.popover.title');
    expect(rootOpeners.openAddToPlaylist).toHaveBeenCalledWith(CLIMB, TENSION);
    tap(container, 'mobile.climbActions.addBetaVideo');
    expect(rootOpeners.openAddBetaVideo).toHaveBeenCalledWith(CLIMB, TENSION);
    tap(container, 'mobile.climbActions.report');
    expect(rootOpeners.openReportClimb).toHaveBeenCalledWith(CLIMB, TENSION);
    tap(container, 'session:playView.actionBar.changeAngle');
    expect(rootOpeners.openAnglePicker).toHaveBeenCalledWith('climb-1');
  });

  it('opens Climb view settings in the tab the bar sits over', () => {
    route.segments = ['(tabs)', 'home'];
    tap(renderMenu().container, 'mobile.settings.climbView.title');
    expect(route.push).toHaveBeenCalledWith('/(tabs)/home/settings/climb-view');
    expect(climbViewSettingsHref(['(tabs)', 'climbs', 'search'])).toBe('/(tabs)/climbs/settings/climb-view');
    expect(climbViewSettingsHref(['wall-display'])).toBe('/settings/climb-view');
  });

  it('names the climb for a screen reader on a plain ⋯ glyph', () => {
    const { getByLabelText } = renderMenu();
    const anchor = getByLabelText(`playView.actionBar.moreActionsForAria ${JSON.stringify({ name: 'Crimp Line' })}`);
    expect(anchor.getAttribute('data-icon')).toBe('more');
    expect(menu.props).toMatchObject({ iconAppearance: 'plain', anchorSize: 44 });
  });

  it('draws nothing while the /play route is up: its sheets would present behind the player', () => {
    route.segments = ['play'];
    const { container } = renderMenu();
    expect(container.innerHTML).toBe('');
  });
});
