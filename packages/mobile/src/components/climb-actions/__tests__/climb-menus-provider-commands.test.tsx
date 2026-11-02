// @vitest-environment jsdom
// A selection from a row's menu, through the real command host: the provider,
// `useClimbActions` and the player presenters. Only the platform I/O is stubbed.
import { createElement, useState, type ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Climb } from '@boardsesh/shared-schema';
import type { ClimbActionsTarget } from '../../../providers/drawer-host-provider';

const openers = vi.hoisted(() => ({
  openPlayDrawer: vi.fn(),
  openAddToPlaylist: vi.fn(),
  openLogAscent: vi.fn(),
  openAddBetaVideo: vi.fn(),
  openReportClimb: vi.fn(),
  addToQueue: vi.fn(),
  playNext: vi.fn(),
  setCurrentClimb: vi.fn(),
}));

vi.mock('../../AppMenu', () => ({
  AppMenu: (props: { actions: { label: string }[]; children?: ReactNode; onSelectIndex: (index: number) => void }) =>
    createElement(
      'div',
      null,
      props.children,
      props.actions.map((action, index) =>
        createElement('button', { key: action.label, onClick: () => props.onSelectIndex(index) }, action.label),
      ),
    ),
}));
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const original = await importOriginal<typeof import('@tanstack/react-query')>();
  const client = new original.QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { ...original, useQueryClient: () => client };
});
vi.mock('../../../lib/graphql/offline-request', () => ({
  offlineAwareRequest: vi.fn(async () => ({ favorites: [] })),
}));
vi.mock('../../../db', () => ({ getDatabaseHandle: () => null }));
vi.mock('../../../db/queries/get-favorite-status-local', () => ({
  getPendingFavoriteOverridesLocal: vi.fn(async () => new Map<string, boolean>()),
}));
vi.mock('../../../lib/privacy/privacy-cache', () => ({ getCredentialGeneration: () => 0 }));
vi.mock('../../../hooks/use-privacy-scoped-state', () => ({ usePrivacyScopedState: useState }));
vi.mock('../../../hooks/use-is-climb-favorited', () => ({ useIsClimbFavorited: () => false }));
vi.mock('../../../lib/error-reporting', () => ({ reportHandledError: vi.fn() }));
vi.mock('../../play-drawer/use-climb-change-lights', () => ({ isDrivingWall: () => false }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'queue-uuid' }));
vi.mock('expo-web-browser', () => ({ openBrowserAsync: vi.fn(async () => {}) }));
vi.mock('../../../lib/spray/use-spray-wall-archive', () => ({ useSprayWallIsArchived: () => false }));
vi.mock('@boardsesh/analytics', () => ({ SHARED_EVENTS: {} }));
vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ ...openers, boardConfig: null }),
  boardConfigsMatch: () => false,
}));
vi.mock('../../../providers/feature-flags-provider', () => ({ useClimbModerationEnabled: () => true }));
vi.mock('../../../providers/queue-provider', () => ({
  useQueueActions: () => ({
    addToQueue: openers.addToQueue,
    playNext: openers.playNext,
    setCurrentClimb: openers.setCurrentClimb,
    findReplayFromHereItem: () => null,
    getQueueSnapshot: () => ({ currentClimbQueueItem: null, queue: [] }),
  }),
  useQueueData: () => ({ queue: [], currentClimbQueueItem: null }),
  useQueueSessionId: () => ({ sessionId: null }),
  useActiveClimbUuid: () => null,
  useIsSharedSession: () => false,
}));
vi.mock('../../../lib/climb-to-queue-item', () => ({ climbToQueueItem: (climb: unknown) => ({ uuid: 'qi', climb }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ actionColors: { success: '#0a0', favorite: '#f00', accent: '#00f' } }),
}));
vi.mock('../../../lib/graphql/hooks', () => ({
  useToggleFavorite: () => ({ mutate: vi.fn() }),
  useFavoriteStatus: () => ({ data: false }),
}));
vi.mock('../../../hooks/use-share-climb', () => ({ useShareClimb: () => vi.fn(async () => {}) }));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../../lib/ble/bluetooth-status-store', () => ({ useBluetoothConnectedStatus: () => false }));
vi.mock('../../../lib/sentry', () => ({ captureToSentry: vi.fn() }));
vi.mock('../use-delete-climb-action', () => ({ useDeleteClimbAction: () => vi.fn(async () => {}) }));

import { ClimbMenu, ClimbMenusProvider, useClimbMenu } from '../ClimbActionsMenu';
import { registerClimbActionPresenters, type ClimbActionPresenters } from '../climb-action-presenters';

const climb = { uuid: 'climb-1', name: 'Crimp Line', userId: 'setter', frames: 'p1r12' } as Climb;
const board = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 };

function Row({ target }: { target: ClimbActionsTarget }) {
  const menu = useClimbMenu(target);
  return <ClimbMenu rows={menu.rows} menuKey={menu.menuKey} />;
}
function renderRow(target: ClimbActionsTarget) {
  return render(
    <ClimbMenusProvider currentUserId="viewer" isAuthenticated activeBoardConfig={board}>
      <Row target={target} />
    </ClimbMenusProvider>,
  );
}
function playerPresenters(): ClimbActionPresenters {
  return { tick: vi.fn(), beta: vi.fn(), report: vi.fn(), playlist: vi.fn() };
}

let unregister: (() => void) | undefined;
beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  unregister?.();
  unregister = undefined;
  cleanup();
});

describe('climb menu commands through the root command host', () => {
  it("sends a /play queue row's Tick to the player's sheet for that slot, after the queue sheet closes", async () => {
    const presenters = playerPresenters();
    unregister = registerClimbActionPresenters(presenters);
    const order: string[] = [];
    const dismissSourceSheet = vi.fn(async () => {
      order.push('dismiss');
      return { status: 'dismissed' as const };
    });
    vi.mocked(presenters.tick).mockImplementation(() => order.push('tick'));
    renderRow({
      climb,
      boardConfig: board,
      queueItemUuid: 'slot-2',
      dismissSourceSheet,
      dismissPlayerAndWait: vi.fn(async () => ({ status: 'dismissed' as const })),
    });

    fireEvent.click(screen.getByText('mobile.climbActions.tick'));
    await waitFor(() => expect(presenters.tick).toHaveBeenCalledOnce());
    expect(presenters.tick).toHaveBeenCalledWith(climb, board, { queueItemUuid: 'slot-2' });
    expect(order).toEqual(['dismiss', 'tick']);
    expect(openers.openLogAscent).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('actions.playlist.popover.title'));
    await waitFor(() => expect(presenters.playlist).toHaveBeenCalledOnce());
    expect(presenters.playlist).toHaveBeenCalledWith(climb, board);
    expect(openers.openAddToPlaylist).not.toHaveBeenCalled();
  });

  it('presents from the root when no player is mounted', async () => {
    renderRow({ climb, boardConfig: board });
    fireEvent.click(screen.getByText('mobile.climbActions.tick'));
    await waitFor(() => expect(openers.openLogAscent).toHaveBeenCalledOnce());
    expect(openers.openLogAscent).toHaveBeenCalledWith(
      expect.objectContaining({ climbUuid: 'climb-1', boardName: 'kilter', angle: 40 }),
    );
    fireEvent.click(screen.getByText('actions.playlist.popover.title'));
    await waitFor(() => expect(openers.openAddToPlaylist).toHaveBeenCalledWith(climb, board));
  });

  it('keeps a menu from outside the player on the root openers while a player is mounted', async () => {
    // A modal pushed over `/play` (moderation) has a climb menu too. Its sheets
    // must not go to the player's tree underneath.
    const presenters = playerPresenters();
    unregister = registerClimbActionPresenters(presenters);
    renderRow({ climb, boardConfig: board });
    fireEvent.click(screen.getByText('mobile.climbActions.tick'));
    await waitFor(() => expect(openers.openLogAscent).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByText('mobile.climbActions.report'));
    await waitFor(() => expect(openers.openReportClimb).toHaveBeenCalledOnce());
    expect(presenters.tick).not.toHaveBeenCalled();
    expect(presenters.report).not.toHaveBeenCalled();
  });

  it("opens Add to playlist in the modal route's own sheet when the menu names one", async () => {
    // The moderation feed is a root `modal`: the root playlist sheet would
    // present under it and vanish.
    const presenters = playerPresenters();
    unregister = registerClimbActionPresenters(presenters);
    const openPlaylistInRoute = vi.fn();
    renderRow({ climb, boardConfig: board, openPlaylistInRoute });
    fireEvent.click(screen.getByText('actions.playlist.popover.title'));
    await waitFor(() => expect(openPlaylistInRoute).toHaveBeenCalledExactlyOnceWith(climb, board));
    expect(openers.openAddToPlaylist).not.toHaveBeenCalled();
    expect(presenters.playlist).not.toHaveBeenCalled();
  });
});
