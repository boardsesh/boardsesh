// @vitest-environment jsdom
// The player's ⋯ runs the REAL `useClimbActions` and the real row builder; only
// the menu's native shell, the root openers and the I/O behind them are doubles.
// The root openers are spies so a row that reaches one fails here: from `/play`
// a root sheet presents under the modal and flashes closed (#3505, #3294).
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { createElement, useEffect } from 'react';
import type { Climb } from '@boardsesh/shared-schema';
import type { AppMenuProps } from '../../AppMenu.types';

const menu = vi.hoisted(() => ({ mounts: 0, props: [] as AppMenuProps[] }));
const rootOpeners = vi.hoisted(() => ({
  openPlayDrawer: vi.fn(),
  openAddToPlaylist: vi.fn(),
  openLogAscent: vi.fn(),
  openAddBetaVideo: vi.fn(),
  openReportClimb: vi.fn(),
}));
const queue = vi.hoisted(() => ({
  activeClimbUuid: null as string | null,
  addToQueue: vi.fn(),
  playNext: vi.fn(),
}));
const toggleFavoriteMutate = vi.hoisted(() => vi.fn());
// The app-wide profile cache: who is looking.
const profile = vi.hoisted(() => ({ id: 'me' as string | undefined, reads: [] as { enabled?: boolean }[] }));
const favoriteStatusReads = vi.hoisted(() => [] as { enabled?: boolean }[]);

// A plain double for the native menu that counts mounts and, unlike every real
// platform menu, reports a tap on a disabled row too — so the component's own
// guard is the one under test.
vi.mock('../../AppMenu', () => ({
  AppMenu: (props: AppMenuProps) => {
    useEffect(() => {
      menu.mounts += 1;
    }, []);
    menu.props.push(props);
    return createElement(
      'div',
      { 'aria-label': props.accessibilityLabel, 'data-icon': props.iconName },
      props.actions.map((action, index) =>
        createElement(
          'button',
          { key: `${index}-${action.label}`, onClick: () => props.onSelectIndex(index) },
          action.label,
        ),
      ),
    );
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'queue-uuid' }));
vi.mock('expo-web-browser', () => ({ openBrowserAsync: vi.fn(async () => {}) }));
vi.mock('@boardsesh/analytics', () => ({ SHARED_EVENTS: {} }));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../../lib/spray/use-spray-wall-archive', () => ({ useSprayWallIsArchived: () => false }));
vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ ...rootOpeners, boardConfig: null }),
  boardConfigsMatch: () => false,
}));
vi.mock('../../../providers/feature-flags-provider', () => ({ useClimbModerationEnabled: () => true }));
vi.mock('../../../providers/queue-provider', () => ({
  useQueueActions: () => ({ addToQueue: queue.addToQueue, playNext: queue.playNext }),
  useQueueSessionId: () => ({ sessionId: null }),
  useActiveClimbUuid: () => queue.activeClimbUuid,
}));
vi.mock('../../../lib/climb-to-queue-item', () => ({ climbToQueueItem: (climb: unknown) => ({ uuid: 'qi', climb }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ actionColors: { success: '#0a0', favorite: '#f00', accent: '#00f' } }),
}));
vi.mock('../../../lib/graphql/hooks', () => ({
  useProfile: (options?: { enabled?: boolean }) => {
    profile.reads.push(options ?? {});
    return { data: profile.id ? { id: profile.id } : undefined };
  },
  useToggleFavorite: () => ({ mutate: toggleFavoriteMutate }),
  useFavoriteStatus: (_board: string, _uuid: string | null, _angle: number, options?: { enabled?: boolean }) => {
    favoriteStatusReads.push(options ?? {});
    return { data: false };
  },
}));
vi.mock('../../../hooks/use-share-climb', () => ({ useShareClimb: () => vi.fn(async () => {}) }));
vi.mock('../../climb-actions/use-delete-climb-action', () => ({ useDeleteClimbAction: () => vi.fn() }));
vi.mock('../../create-climb/use-create-climb-navigation', () => ({
  useCreateClimbNavigation: () => ({ openRemix: vi.fn(), openEdit: vi.fn(), resetActionGuard: vi.fn() }),
}));

import { PlayDrawerActionsMenu, type PlayDrawerActionsMenuProps } from '../PlayDrawerActionsMenu';

const CLIMB = { uuid: 'climb-1', name: 'Crimp Line', frames: 'p1r12', userId: 'setter-9' } as unknown as Climb;
// The board the climb is DRAWN on, which here is not the selected one.
const TENSION = { boardName: 'tension', layoutId: 10, sizeId: 6, setIds: '12,13', angle: 35 };
const EVERYTHING_HIDDEN = { favorite: true, share: true, queue: true, mirror: true, angle: true };

function makeProps(overrides: Partial<PlayDrawerActionsMenuProps> = {}): PlayDrawerActionsMenuProps {
  return {
    climb: CLIMB,
    boardConfig: TENSION,
    isAuthenticated: true,
    hidden: EVERYTHING_HIDDEN,
    boardMismatch: false,
    isFavorited: false,
    isMirrored: false,
    onToggleFavorite: vi.fn(),
    onToggleMirror: vi.fn(),
    onOpenAngle: vi.fn(),
    onTick: vi.fn(),
    onAddBetaVideo: vi.fn(),
    onReportClimb: vi.fn(),
    onSelectPlaylist: vi.fn(),
    onOpenQueue: vi.fn(),
    onOpenViewOptions: vi.fn(),
    ...overrides,
  };
}

function tap(container: HTMLElement, label: string) {
  const row = [...container.querySelectorAll('button')].find((button) => button.textContent === label);
  if (!row) throw new Error(`no row labelled ${label}`);
  fireEvent.click(row);
}

function expectNoRootOpener() {
  for (const opener of Object.values(rootOpeners)) expect(opener).not.toHaveBeenCalled();
}

beforeEach(() => {
  menu.mounts = 0;
  menu.props = [];
  queue.activeClimbUuid = null;
  favoriteStatusReads.length = 0;
  profile.id = 'me';
  profile.reads = [];
  vi.clearAllMocks();
});

describe('PlayDrawerActionsMenu', () => {
  it('moves the displayed queue slot on Play next, not the first copy of the climb', () => {
    const { container } = render(createElement(PlayDrawerActionsMenu, makeProps({ queueItemUuid: 'slot-2' })));
    tap(container, 'mobile.climbActions.playNext');
    expect(queue.playNext).toHaveBeenCalledWith(expect.objectContaining({ queueItemUuid: 'slot-2' }));
  });

  it('lets Play next match by climb when the displayed climb has no queued slot', () => {
    const { container } = render(createElement(PlayDrawerActionsMenu, makeProps()));
    tap(container, 'mobile.climbActions.playNext');
    expect(queue.playNext).toHaveBeenCalledWith(expect.objectContaining({ queueItemUuid: undefined }));
  });

  it('is the climb-actions ⋯, named for a screen reader and the web smoke test', () => {
    const { getByLabelText } = render(createElement(PlayDrawerActionsMenu, makeProps()));
    expect(getByLabelText('playView.actionBar.climbActionsAria').getAttribute('data-icon')).toBe('more');
  });

  it("opens every sheet row through the player's own openers, pinned to the drawn climb and board", () => {
    const props = makeProps();
    const { container } = render(createElement(PlayDrawerActionsMenu, props));

    tap(container, 'mobile.climbActions.addBetaVideo');
    expect(props.onAddBetaVideo).toHaveBeenCalledWith(CLIMB, TENSION);
    tap(container, 'mobile.climbActions.report');
    expect(props.onReportClimb).toHaveBeenCalledWith(CLIMB, TENSION);
    tap(container, 'actions.playlist.popover.title');
    expect(props.onSelectPlaylist).toHaveBeenCalledWith(CLIMB, TENSION);
    tap(container, 'mobile.climbActions.openQueue');
    expect(props.onOpenQueue).toHaveBeenCalledTimes(1);
    tap(container, 'common:mobile.settings.climbDrawer.sheetTitle');
    expect(props.onOpenViewOptions).toHaveBeenCalledTimes(1);

    expectNoRootOpener();
  });

  // The bar heart keeps an optimistic override; the row must read and flip THAT,
  // or the two disagree for a beat after every tap.
  it("toggles the bar heart's favourite, and says which way the tap goes", () => {
    const onToggleFavorite = vi.fn();
    const { container, rerender } = render(createElement(PlayDrawerActionsMenu, makeProps({ onToggleFavorite })));

    tap(container, 'session:playView.actionBar.addFavoriteAria');
    expect(onToggleFavorite).toHaveBeenCalledTimes(1);
    expect(toggleFavoriteMutate).not.toHaveBeenCalled();
    // The player already reads the favourite; the menu must not read it again.
    expect(favoriteStatusReads.every((read) => read.enabled === false)).toBe(true);

    rerender(createElement(PlayDrawerActionsMenu, makeProps({ onToggleFavorite, isFavorited: true })));
    expect(container.textContent).toContain('session:playView.actionBar.removeFavoriteAria');
  });

  // Switched off in View options, Mirror and the angle pill live on in ⋯ and
  // run exactly what their bar buttons run.
  it("mirrors through the bar's own toggle and opens the player's angle sheet", () => {
    const props = makeProps();
    const { container, rerender } = render(createElement(PlayDrawerActionsMenu, props));

    tap(container, 'session:playView.actionBar.mirrorAria');
    expect(props.onToggleMirror).toHaveBeenCalledTimes(1);
    tap(container, 'session:playView.actionBar.changeAngle');
    expect(props.onOpenAngle).toHaveBeenCalledTimes(1);
    expectNoRootOpener();

    rerender(createElement(PlayDrawerActionsMenu, { ...props, isMirrored: true }));
    expect(container.textContent).toContain('session:playView.actionBar.unmirrorAria');
  });

  it('leaves Mirror and Change angle out while their buttons are in the bar', () => {
    const { container } = render(
      createElement(
        PlayDrawerActionsMenu,
        makeProps({ hidden: { ...EVERYTHING_HIDDEN, mirror: false, angle: false } }),
      ),
    );
    expect(container.textContent).not.toContain('session:playView.actionBar.mirrorAria');
    expect(container.textContent).not.toContain('session:playView.actionBar.changeAngle');
  });

  it('refuses Mirror and Change angle on another board', () => {
    const props = makeProps({ boardMismatch: true });
    const { container } = render(createElement(PlayDrawerActionsMenu, props));
    tap(container, 'session:playView.actionBar.mirrorAria');
    tap(container, 'session:playView.actionBar.changeAngle');
    expect(props.onToggleMirror).not.toHaveBeenCalled();
    expect(props.onOpenAngle).not.toHaveBeenCalled();
  });

  it('offers no tick row: the hero button is always there', () => {
    const props = makeProps();
    const { container } = render(createElement(PlayDrawerActionsMenu, props));
    expect(container.textContent).not.toContain('mobile.climbActions.tick');
    expect(props.onTick).not.toHaveBeenCalled();
  });

  it('refuses a tap on a write row while the climb belongs to another board, and still shares', () => {
    const props = makeProps({ boardMismatch: true });
    const { container } = render(createElement(PlayDrawerActionsMenu, props));

    tap(container, 'mobile.climbActions.addBetaVideo');
    tap(container, 'mobile.climbActions.report');
    tap(container, 'actions.playlist.popover.title');
    tap(container, 'mobile.climbActions.playLast');
    tap(container, 'session:playView.actionBar.addFavoriteAria');
    expect(props.onAddBetaVideo).not.toHaveBeenCalled();
    expect(props.onReportClimb).not.toHaveBeenCalled();
    expect(props.onSelectPlaylist).not.toHaveBeenCalled();
    expect(props.onToggleFavorite).not.toHaveBeenCalled();
    expect(queue.addToQueue).not.toHaveBeenCalled();

    tap(container, 'common:mobile.settings.climbDrawer.sheetTitle');
    expect(props.onOpenViewOptions).toHaveBeenCalledTimes(1);
    expect(menu.props.at(-1)?.actions.find((action) => action.label === 'share.actionLabel')?.disabled).toBe(false);
  });

  // A tap reports a position. A row set that changes under an open menu would
  // land it on whatever row slid into that slot, so the menu remounts (and so
  // closes) instead.
  it('remounts when the climb or its row set changes, and only then', () => {
    const { rerender } = render(createElement(PlayDrawerActionsMenu, makeProps()));
    expect(menu.mounts).toBe(1);

    // A label change moves no row.
    rerender(createElement(PlayDrawerActionsMenu, makeProps({ isFavorited: true })));
    expect(menu.mounts).toBe(1);

    // Commit mode ends: the heart is back in the bar, so its row goes.
    rerender(createElement(PlayDrawerActionsMenu, makeProps({ hidden: { ...EVERYTHING_HIDDEN, favorite: false } })));
    expect(menu.mounts).toBe(2);

    rerender(
      createElement(
        PlayDrawerActionsMenu,
        makeProps({ hidden: { ...EVERYTHING_HIDDEN, favorite: false }, boardMismatch: true }),
      ),
    );
    expect(menu.mounts).toBe(3);

    rerender(
      createElement(
        PlayDrawerActionsMenu,
        makeProps({
          hidden: { ...EVERYTHING_HIDDEN, favorite: false },
          boardMismatch: true,
          climb: { ...CLIMB, uuid: 'climb-2' } as Climb,
        }),
      ),
    );
    expect(menu.mounts).toBe(4);
  });

  // Edit, Delete and Report hang on who is looking. The answer comes from the
  // profile the whole app reads, so it is there from the first frame the menu
  // is, and holds still when a crew member moves the wall's angle.
  it('reads who is looking from the profile, so a setter never sees Report on their own climb', () => {
    profile.id = 'setter-9';
    const setter = render(createElement(PlayDrawerActionsMenu, makeProps()));
    expect(setter.container.textContent).not.toContain('mobile.climbActions.report');
    setter.unmount();

    profile.id = 'someone-else';
    const { container } = render(createElement(PlayDrawerActionsMenu, makeProps()));
    expect(container.textContent).toContain('mobile.climbActions.report');
  });

  it('keeps the same menu across an angle change', () => {
    const { rerender } = render(createElement(PlayDrawerActionsMenu, makeProps()));
    rerender(createElement(PlayDrawerActionsMenu, makeProps({ boardConfig: { ...TENSION, angle: 45 } })));
    expect(menu.mounts).toBe(1);
  });

  it('asks for no profile without a session', () => {
    render(createElement(PlayDrawerActionsMenu, makeProps({ isAuthenticated: false })));
    expect(profile.reads.every((read) => read.enabled === false)).toBe(true);
  });

  it('drops Play next once the climb is the one on the wall', () => {
    queue.activeClimbUuid = CLIMB.uuid;
    const { container } = render(createElement(PlayDrawerActionsMenu, makeProps()));
    expect(container.textContent).not.toContain('mobile.climbActions.playNext');
  });
});
