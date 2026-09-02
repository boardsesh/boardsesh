// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react';
import { createElement, useEffect, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';
import type { Climb, UserBoard } from '@boardsesh/shared-schema';

const queue = vi.hoisted(() => ({
  sessionId: 'session-1' as string | null,
  participantId: 'participant-self' as string | null,
  activeClimbUuid: null as string | null,
  setCurrentClimb: vi.fn(),
  addToQueue: vi.fn(),
  setSessionBoardPath: vi.fn(async () => {}),
}));

const analytics = vi.hoisted(() => ({
  track: vi.fn(),
}));

const queueSheet = vi.hoisted(() => ({
  props: null as null | {
    board: {
      boardName: string;
      layoutId: number;
      sizeId: number;
      setIds: string;
      angle: number;
    };
    onClose: () => void;
    onClimbPress: (item: ClimbQueueItem) => void;
    onOpenActions: (item: ClimbQueueItem) => void;
    onSuggestionPress: (climb: ClimbQueueItem['climb'], source: PlaylistSuggestionSource) => void;
  },
  present: vi.fn(),
  dismiss: vi.fn(),
  dismissAndWait: vi.fn(async () => ({ status: 'dismissed' as const })),
}));

const climbActions = vi.hoisted(() => ({
  props: null as null | Record<string, unknown>,
}));

const playlistSheet = vi.hoisted(() => ({
  props: null as null | Record<string, unknown>,
}));

const betaVideoSheet = vi.hoisted(() => ({
  props: null as null | Record<string, unknown>,
}));

const boardSheet = vi.hoisted(() => ({
  props: null as null | Record<string, unknown>,
  present: vi.fn(),
  dismiss: vi.fn(),
  dismissAndWait: vi.fn(async () => ({ status: 'dismissed' as const })),
}));

const activeBoard = vi.hoisted(() => {
  const defaultStored = {
    uuid: 'board-1',
    slug: 'board-1',
    ownerId: 'owner-1',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,2',
    name: 'Test board',
    isPublic: true,
    isUnlisted: false,
    hideLocation: false,
    isOwned: true,
    angle: 40,
    isAngleAdjustable: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    totalAscents: 0,
    uniqueClimbers: 0,
    followerCount: 0,
    commentCount: 0,
    isFollowedByMe: false,
    canEdit: false,
  } satisfies UserBoard;
  return {
    defaultStored,
    stored: { ...defaultStored } as UserBoard | null,
    setActiveBoard: vi.fn(async () => {}),
  };
});

// Owned boards returned by useMyBoards. Empty by default; the switch-board tests
// populate it with a board that loosely-matches an opened climb's override.
const myBoards = vi.hoisted(() => ({
  boards: [] as UserBoard[],
}));

const presence = vi.hoisted(() => ({
  enabled: false,
  boardId: null as number | null,
  resolveAndBindBoard: vi.fn(async () => null),
  resolveAndBindBoardByConfig: vi.fn(async () => null),
  resolveAndBindBoardByUuid: vi.fn(async () => null),
  resetPresence: vi.fn(),
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default },
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
    createElement('button', { onClick: onPress }, children),
  // The host width-budgets pane vs. sheet (resolveDetailPaneSurface). 1024 clears
  // the budget, so the regular-width describe takes the pane path; compact stays sheet.
  useWindowDimensions: () => ({ width: 1024, height: 1366 }),
}));

// The host reads the device layout to decide sheet (compact) vs pane (regular).
// Defaults to compact (the bottom-sheet path most tests exercise); the
// regular-width pane describe flips it.
const layoutCfg = vi.hoisted(() => ({ widthClass: 'compact' as 'compact' | 'regular' }));
vi.mock('../../hooks/use-device-layout', () => ({
  useDeviceLayout: () => ({ widthClass: layoutCfg.widthClass, expanded: false }),
}));

vi.mock('expo-crypto', () => ({
  randomUUID: () => 'test-uuid',
}));

// PlayDrawer is no longer rendered by the host — it's the content of the
// `app/play.tsx` route — so the host only needs the barrel to resolve (it imports
// type-only symbols from it). A no-op keeps the real, native-heavy PlayDrawer out
// of jsdom.
vi.mock('../../components/play-drawer', () => ({
  PlayDrawer: () => null,
}));

vi.mock('../../components/play-drawer/QueueSheet', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return {
    QueueSheet: React.forwardRef(
      (
        props: {
          board: {
            boardName: string;
            layoutId: number;
            sizeId: number;
            setIds: string;
            angle: number;
          };
          onClose: () => void;
          onClimbPress: (item: ClimbQueueItem) => void;
          onOpenActions: (item: ClimbQueueItem) => void;
          onSuggestionPress: (climb: ClimbQueueItem['climb'], source: PlaylistSuggestionSource) => void;
        },
        ref,
      ) => {
        queueSheet.props = props;
        React.useImperativeHandle(ref, () => ({
          present: queueSheet.present,
          dismiss: queueSheet.dismiss,
          dismissAndWait: queueSheet.dismissAndWait,
        }));
        return React.createElement('div', { 'data-queue-sheet': 'true' });
      },
    ),
  };
});

vi.mock('../../components/LogAscentSheet', () => ({
  LogAscentSheet: () => createElement('div', { 'data-log-ascent': 'true' }),
}));
vi.mock('../../components/climb-actions/ClimbReactionMenu', () => ({
  ClimbReactionMenu: (props: Record<string, unknown>) => {
    climbActions.props = props;
    return createElement('div', { 'data-climb-actions': 'true' });
  },
}));
vi.mock('../../hooks/use-reduce-motion', () => ({ useReduceMotion: () => false }));
vi.mock('../../components/AddToPlaylistSheet', () => ({
  AddToPlaylistSheet: (props: Record<string, unknown>) => {
    playlistSheet.props = props;
    return createElement('div', { 'data-add-to-playlist': 'true' });
  },
}));
vi.mock('../../components/AddBetaVideoSheet', () => ({
  AddBetaVideoSheet: (props: Record<string, unknown>) => {
    betaVideoSheet.props = props;
    return createElement('div', { 'data-add-beta-video': 'true' });
  },
}));
vi.mock('../../components/QueueAddedSnackbar', () => ({
  QueueAddedSnackbar: () => createElement('div', { 'data-queue-snackbar': 'true' }),
}));
vi.mock('../../components/board-presence/BoardSheet', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return {
    BoardSheet: React.forwardRef((props: Record<string, unknown>, ref) => {
      boardSheet.props = props;
      React.useImperativeHandle(ref, () => ({
        present: boardSheet.present,
        dismiss: boardSheet.dismiss,
        dismissAndWait: boardSheet.dismissAndWait,
      }));
      return React.createElement('div', { 'data-board-sheet': 'true' });
    }),
  };
});
vi.mock('../../components/board-presence/UndoWallChangeSnackbar', () => ({
  UndoWallChangeSnackbar: () => createElement('div', { 'data-undo-snackbar': 'true' }),
}));

vi.mock('expo-router', () => ({
  router: { push: vi.fn(), navigate: vi.fn(), dismiss: vi.fn() },
  useSegments: () => ['(tabs)', 'climbs'],
}));

vi.mock('@boardsesh/board-presence-react', () => ({
  useBoardPresenceCurrent: () => ({ currentClimb: null, previousClimb: null, undoTarget: null, isLive: false }),
  useBoardPresenceFeed: () => ({ history: [], stats: null }),
}));

vi.mock('../board-presence-provider', () => ({
  useBoardPresenceControls: () => ({
    enabled: presence.enabled,
    boardId: presence.boardId,
    resolveAndBindBoard: presence.resolveAndBindBoard,
    resolveAndBindBoardByConfig: presence.resolveAndBindBoardByConfig,
    resolveAndBindBoardByUuid: presence.resolveAndBindBoardByUuid,
    resetPresence: presence.resetPresence,
  }),
}));

vi.mock('../auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: true }),
}));

vi.mock('../bluetooth-provider', () => ({
  useOptionalBluetoothContext: () => ({ undoWallChange: vi.fn(async () => true) }),
}));

vi.mock('../queue-provider', () => ({
  useActiveClimbUuid: () => queue.activeClimbUuid,
  useQueueActions: () => ({
    addToQueue: queue.addToQueue,
    setSessionBoardPath: queue.setSessionBoardPath,
    setCurrentClimb: queue.setCurrentClimb,
  }),
  useQueueSessionControls: () => ({
    sessionId: queue.sessionId,
    participantId: queue.participantId,
  }),
}));

vi.mock('../queue-snackbar-provider', () => ({
  useQueueSnackbar: () => ({
    visible: false,
    nonce: 0,
    dismissSnackbar: vi.fn(),
    undoWallChangeVisible: false,
    undoWallChangeNonce: 0,
    dismissUndoWallChangeSnackbar: vi.fn(),
  }),
}));

vi.mock('../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: activeBoard.stored }),
  useSetActiveBoard: () => activeBoard.setActiveBoard,
}));

vi.mock('../../lib/graphql/hooks', () => ({
  useToggleFavorite: () => ({ mutate: vi.fn() }),
  useProfile: () => ({ data: null }),
  useMyBoards: () => ({ data: { boards: myBoards.boards, totalCount: myBoards.boards.length, hasMore: false } }),
}));

vi.mock('../../lib/analytics', () => ({
  track: analytics.track,
}));

vi.mock('../../lib/climb-to-queue-item', () => ({
  climbToQueueItem: (climb: ClimbQueueItem['climb'], options?: { suggested?: boolean; uuid?: string }) => ({
    uuid: options?.uuid ?? `queue-${climb.uuid}`,
    climb,
    suggested: options?.suggested ?? false,
  }),
}));

import { router } from 'expo-router';
import { DrawerHostProvider, useDrawerHost, usePlayDrawerRoute, type BoardConfig } from '../drawer-host-provider';
import type { BoardSheetClimbAction } from '../../components/board-presence/BoardSheet';

const routerPush = router.push as unknown as ReturnType<typeof vi.fn>;
const routerNavigate = router.navigate as unknown as ReturnType<typeof vi.fn>;
const routerDismiss = router.dismiss as unknown as ReturnType<typeof vi.fn>;

type HostValue = ReturnType<typeof useDrawerHost>;
type RouteValue = ReturnType<typeof usePlayDrawerRoute>;

function makeQueueItem(uuid: string, climbUuid = uuid): ClimbQueueItem {
  return {
    uuid,
    climb: {
      uuid: climbUuid,
      name: `Climb ${climbUuid}`,
      frames: 'p1r12',
      setter_username: 'setter',
      angle: 40,
      ascensionist_count: 0,
      difficulty: 'V3',
      quality_average: '3.0',
      stars: 3,
      difficulty_error: '0.3',
      benchmark_difficulty: null,
    },
  };
}

function Probe({ onHost, onRoute }: { onHost: (host: HostValue) => void; onRoute: (route: RouteValue) => void }) {
  const host = useDrawerHost();
  const route = usePlayDrawerRoute();
  useEffect(() => {
    onHost(host);
  }, [host, onHost]);
  useEffect(() => {
    onRoute(route);
  }, [route, onRoute]);
  return null;
}

function renderHost(onHost: (host: HostValue) => void, onRoute: (route: RouteValue) => void = () => {}) {
  return render(createElement(DrawerHostProvider, null, createElement(Probe, { onHost, onRoute })));
}

beforeEach(() => {
  activeBoard.stored = { ...activeBoard.defaultStored };
  activeBoard.setActiveBoard.mockClear();
  myBoards.boards = [];
  analytics.track.mockClear();
  routerPush.mockClear();
  routerNavigate.mockClear();
  routerDismiss.mockClear();
  presence.enabled = false;
  presence.boardId = null;
  presence.resolveAndBindBoard.mockClear();
  presence.resolveAndBindBoardByConfig.mockClear();
  presence.resolveAndBindBoardByUuid.mockClear();
  presence.resetPresence.mockClear();
  queue.setCurrentClimb.mockClear();
  queue.activeClimbUuid = null;
  layoutCfg.widthClass = 'compact';
});

describe('DrawerHostProvider board presence binding', () => {
  it('resolves board presence from the selected active board without Bluetooth', async () => {
    presence.enabled = true;
    const hosts: Array<HostValue> = [];
    renderHost((host) => hosts.push(host));
    await waitFor(() => expect(hosts.at(-1)).toBeDefined());

    await waitFor(() => {
      expect(presence.resolveAndBindBoardByUuid).toHaveBeenCalledWith({ boardUuid: 'board-1' });
    });
    expect(presence.resolveAndBindBoard).not.toHaveBeenCalled();
    expect(presence.resolveAndBindBoardByConfig).not.toHaveBeenCalled();
  });

  it('resets board presence when no active board is selected', async () => {
    presence.enabled = true;
    activeBoard.stored = null;
    const hosts: Array<HostValue> = [];
    renderHost((host) => hosts.push(host));
    await waitFor(() => expect(hosts.at(-1)).toBeDefined());

    await waitFor(() => {
      expect(presence.resetPresence).toHaveBeenCalledTimes(1);
    });
    expect(presence.resolveAndBindBoardByUuid).not.toHaveBeenCalled();
  });

  it('resets board presence when the selected active board is cleared', async () => {
    presence.enabled = true;
    const hosts: Array<HostValue> = [];
    const onHost = (host: HostValue) => hosts.push(host);
    const { rerender } = renderHost(onHost);
    await waitFor(() => {
      expect(presence.resolveAndBindBoardByUuid).toHaveBeenCalledWith({ boardUuid: 'board-1' });
    });

    presence.resolveAndBindBoardByUuid.mockClear();
    presence.resetPresence.mockClear();
    activeBoard.stored = null;
    rerender(createElement(DrawerHostProvider, null, createElement(Probe, { onHost, onRoute: () => {} })));

    await waitFor(() => {
      expect(presence.resetPresence).toHaveBeenCalledTimes(1);
    });
    expect(presence.resolveAndBindBoardByUuid).not.toHaveBeenCalled();
  });

  it('rebinds board presence when the selected active board changes', async () => {
    presence.enabled = true;
    const hosts: Array<HostValue> = [];
    const onHost = (host: HostValue) => hosts.push(host);
    const { rerender } = renderHost(onHost);
    await waitFor(() => {
      expect(presence.resolveAndBindBoardByUuid).toHaveBeenCalledWith({ boardUuid: 'board-1' });
    });

    presence.resolveAndBindBoardByUuid.mockClear();
    activeBoard.stored = {
      ...activeBoard.defaultStored,
      uuid: 'board-2',
      slug: 'board-2',
      name: 'Second board',
    };
    rerender(createElement(DrawerHostProvider, null, createElement(Probe, { onHost, onRoute: () => {} })));

    await waitFor(() => {
      expect(presence.resolveAndBindBoardByUuid).toHaveBeenCalledWith({ boardUuid: 'board-2' });
    });
  });
});

type BoardSheetTestProps = {
  onClimbPress: (action: BoardSheetClimbAction) => void;
  onAddToQueue: (action: BoardSheetClimbAction) => void;
  onOpenPlaylist: (action: BoardSheetClimbAction) => void;
  onOpenActions: (action: BoardSheetClimbAction) => void;
};

function getBoardSheetProps(): BoardSheetTestProps {
  return boardSheet.props as unknown as BoardSheetTestProps;
}

const boardSheetActionBoardConfig: BoardConfig = {
  boardName: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '1,2',
  angle: 30,
};

function makeBoardSheetAction(climb: Climb, overrides: Partial<BoardSheetClimbAction> = {}): BoardSheetClimbAction {
  return {
    climb,
    queueItemUuid: 'wall-queue-x',
    boardConfig: boardSheetActionBoardConfig,
    ...overrides,
  };
}

describe('DrawerHostProvider queue sheet (always-live, no driver gate)', () => {
  beforeEach(() => {
    queue.sessionId = 'session-1';
    queue.participantId = 'participant-self';
    queue.setCurrentClimb.mockClear();
    queue.addToQueue.mockClear();
    queue.setSessionBoardPath.mockClear();
    activeBoard.setActiveBoard.mockClear();
    queueSheet.props = null;
    queueSheet.present.mockClear();
    queueSheet.dismiss.mockClear();
    queueSheet.dismissAndWait.mockClear();
    climbActions.props = null;
    playlistSheet.props = null;
    boardSheet.props = null;
    boardSheet.present.mockClear();
    boardSheet.dismiss.mockClear();
    boardSheet.dismissAndWait.mockClear();
  });

  it('broadcasts queued climb selection for every session member', async () => {
    const hosts: Array<HostValue> = [];
    const routes: Array<RouteValue> = [];
    renderHost(
      (host) => hosts.push(host),
      (route) => routes.push(route),
    );
    await waitFor(() => expect(hosts.at(-1)).toBeDefined());

    act(() => {
      hosts.at(-1)?.openQueueSheet();
    });
    await waitFor(() => expect(queueSheet.props).not.toBeNull());

    const item = makeQueueItem('queue-1', 'climb-1');
    act(() => {
      queueSheet.props?.onClimbPress(item);
    });

    expect(queue.setCurrentClimb).toHaveBeenCalledWith(item);
    // Tapping a queue item navigates to the player route with the climb as the
    // open target (committedExternally — the queue already set it current).
    expect(routerNavigate).toHaveBeenCalledWith('/play');
    await waitFor(() => {
      expect(routes.at(-1)?.playTarget?.climb).toBe(item.climb);
    });
    expect(routes.at(-1)?.playTarget?.options).toEqual({ committedExternally: true });
    // The queue sheet that was tapped dismisses behind the player.
    expect(queueSheet.dismiss).toHaveBeenCalledTimes(1);
  });

  it('broadcasts suggestion selection for every session member while anchoring drawer navigation to that item', async () => {
    const hosts: Array<HostValue> = [];
    const routes: Array<RouteValue> = [];
    renderHost(
      (host) => hosts.push(host),
      (route) => routes.push(route),
    );
    await waitFor(() => expect(hosts.at(-1)).toBeDefined());

    act(() => {
      hosts.at(-1)?.openQueueSheet();
    });
    await waitFor(() => expect(queueSheet.props).not.toBeNull());

    const sourceItem = makeQueueItem('queue-source', 'climb-source');
    const suggestion = makeQueueItem('queue-suggestion', 'climb-suggestion').climb;
    const playlistSuggestionSource: PlaylistSuggestionSource = {
      playlistUuid: 'playlist-1',
      activatedClimbUuid: sourceItem.climb.uuid,
      boardKey: 'kilter:1:10:1,2',
      climbs: [sourceItem.climb, suggestion],
    };

    act(() => {
      queueSheet.props?.onSuggestionPress(suggestion, playlistSuggestionSource);
    });

    const suggestedItem = {
      uuid: `queue-${suggestion.uuid}`,
      climb: suggestion,
      suggested: true,
    };
    expect(queue.setCurrentClimb).toHaveBeenCalledWith(suggestedItem, {
      playlistSuggestionSource,
    });
    expect(routerNavigate).toHaveBeenCalledWith('/play');
    await waitFor(() => {
      expect(routes.at(-1)?.playTarget?.climb).toBe(suggestion);
    });
    expect(routes.at(-1)?.playTarget?.options).toEqual({ committedExternally: true });
  });

  it('threads the exact queue-sheet settle callback into climb actions', async () => {
    const hosts: Array<HostValue> = [];
    renderHost((host) => hosts.push(host));
    await waitFor(() => expect(queueSheet.props).not.toBeNull());

    const item = makeQueueItem('queue-actions', 'climb-actions');
    act(() => queueSheet.props?.onOpenActions(item));
    await waitFor(() => expect(climbActions.props).not.toBeNull());

    const dismissSourceSheet = climbActions.props?.dismissSourceSheet as (() => Promise<unknown>) | undefined;
    if (!dismissSourceSheet) throw new Error('queue dismiss callback was not forwarded');
    await expect(dismissSourceSheet()).resolves.toEqual({ status: 'dismissed' });
    expect(queueSheet.dismissAndWait).toHaveBeenCalledTimes(1);
  });
});

describe('DrawerHostProvider board sheet climb actions', () => {
  beforeEach(() => {
    queue.sessionId = 'session-1';
    queue.participantId = 'participant-self';
    queue.setCurrentClimb.mockClear();
    queue.addToQueue.mockClear();
    climbActions.props = null;
    playlistSheet.props = null;
    boardSheet.props = null;
    boardSheet.present.mockClear();
    boardSheet.dismiss.mockClear();
    boardSheet.dismissAndWait.mockClear();
  });

  it('sets current and opens the drawer when any session member taps a board-sheet climb', async () => {
    const hosts: Array<HostValue> = [];
    const routes: Array<RouteValue> = [];
    renderHost(
      (host) => hosts.push(host),
      (route) => routes.push(route),
    );
    await waitFor(() => expect(boardSheet.props).not.toBeNull());

    const climb = makeQueueItem('queue-x', 'climb-x').climb as unknown as Climb;
    const action = makeBoardSheetAction(climb);
    act(() => {
      getBoardSheetProps().onClimbPress(action);
    });

    expect(queue.setCurrentClimb).toHaveBeenCalledWith(expect.objectContaining({ uuid: 'wall-queue-x', climb }));
    expect(routerNavigate).toHaveBeenCalledWith('/play');
    await waitFor(() => {
      expect(routes.at(-1)?.playTarget?.climb).toBe(climb);
    });
    expect(routes.at(-1)?.playTarget?.options).toEqual({ committedExternally: true });
    // The board-sheet climb is on the stored active board (no override), so both
    // the host's stored boardConfig and the queue sheet's board stay on it.
    await waitFor(() => {
      expect(hosts.at(-1)?.boardConfig).toMatchObject({
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '1,2',
        angle: 40,
      });
      expect(queueSheet.props?.board).toMatchObject({
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '1,2',
        angle: 40,
      });
      expect(boardSheet.props).toMatchObject({
        boardConfig: expect.objectContaining({
          boardName: 'kilter',
          layoutId: 1,
          sizeId: 10,
          setIds: '1,2',
          angle: 40,
        }),
      });
    });
  });

  it('reuses queue, playlist, and climb-actions handlers for board-sheet climbs', async () => {
    const hosts: Array<HostValue> = [];
    const { container } = renderHost((host) => hosts.push(host));
    await waitFor(() => expect(boardSheet.props).not.toBeNull());

    const climb = makeQueueItem('queue-x', 'climb-x').climb as unknown as Climb;
    const action = makeBoardSheetAction(climb);
    act(() => {
      getBoardSheetProps().onAddToQueue(action);
    });
    expect(queue.addToQueue).toHaveBeenCalledWith(expect.objectContaining({ uuid: 'queue-climb-x', climb }));

    act(() => {
      getBoardSheetProps().onOpenPlaylist(action);
    });
    await waitFor(() => expect(container.querySelector('[data-add-to-playlist]')).not.toBeNull());
    expect(playlistSheet.props).toMatchObject({
      climb,
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
      angle: 30,
    });

    act(() => {
      getBoardSheetProps().onOpenActions(action);
    });
    await waitFor(() => expect(container.querySelector('[data-climb-actions]')).not.toBeNull());
    expect(climbActions.props).toMatchObject({
      climb,
      boardConfig: { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 30 },
    });
    const dismissSourceSheet = climbActions.props?.dismissSourceSheet as (() => Promise<unknown>) | undefined;
    if (!dismissSourceSheet) throw new Error('board dismiss callback was not forwarded');
    await expect(dismissSourceSheet()).resolves.toEqual({ status: 'dismissed' });
    expect(boardSheet.dismissAndWait).toHaveBeenCalledTimes(1);
  });
});

describe('DrawerHostProvider queue sheet open / re-open', () => {
  beforeEach(() => {
    queue.sessionId = 'session-1';
    queue.participantId = 'participant-self';
    queueSheet.props = null;
    queueSheet.present.mockClear();
    queueSheet.dismiss.mockClear();
    queueSheet.dismissAndWait.mockClear();
    climbActions.props = null;
    playlistSheet.props = null;
    boardSheet.props = null;
    boardSheet.present.mockClear();
    boardSheet.dismiss.mockClear();
    boardSheet.dismissAndWait.mockClear();
  });

  it('stays mounted and presents via the imperative handle on open', async () => {
    const hosts: Array<HostValue> = [];
    const { container } = renderHost((host) => hosts.push(host));
    await waitFor(() => expect(hosts.at(-1)).toBeDefined());

    // The sheet is always mounted (gorhom present() from a visible-prop effect
    // was a confirmed no-op), so it's in the tree before any open.
    expect(container.querySelector('[data-queue-sheet]')).not.toBeNull();
    expect(queueSheet.present).not.toHaveBeenCalled();

    act(() => {
      hosts.at(-1)?.openQueueSheet();
    });

    await waitFor(() => expect(queueSheet.present).toHaveBeenCalledTimes(1));
  });

  it('dismisses via the imperative handle on close, then re-presents on re-open without remounting', async () => {
    const hosts: Array<HostValue> = [];
    const { container } = renderHost((host) => hosts.push(host));
    await waitFor(() => expect(hosts.at(-1)).toBeDefined());

    const sheetNode = container.querySelector('[data-queue-sheet]');
    expect(sheetNode).not.toBeNull();

    act(() => {
      hosts.at(-1)?.openQueueSheet();
    });
    await waitFor(() => expect(queueSheet.present).toHaveBeenCalledTimes(1));

    // Animated close request goes through the handle's dismiss().
    act(() => {
      queueSheet.props?.onClose();
    });
    await waitFor(() => expect(queueSheet.dismiss).toHaveBeenCalledTimes(1));

    // Re-open: the always-mounted sheet is presented again (no remount, so the
    // same DOM node persists).
    act(() => {
      hosts.at(-1)?.openQueueSheet();
    });
    await waitFor(() => expect(queueSheet.present).toHaveBeenCalledTimes(2));
    expect(container.querySelector('[data-queue-sheet]')).toBe(sheetNode);
  });
});

describe('DrawerHostProvider climb actions', () => {
  beforeEach(() => {
    queue.sessionId = 'session-1';
    queueSheet.props = null;
    climbActions.props = null;
    playlistSheet.props = null;
    betaVideoSheet.props = null;
    boardSheet.props = null;
    boardSheet.present.mockClear();
    boardSheet.dismiss.mockClear();
  });

  it('opens the climb reaction menu for a climb against the active board, then closes it', async () => {
    const hosts: Array<HostValue> = [];
    const { container } = renderHost((host) => hosts.push(host));
    await waitFor(() => expect(hosts.at(-1)).toBeDefined());

    expect(container.querySelector('[data-climb-actions]')).toBeNull();

    const climb = makeQueueItem('queue-x', 'climb-x').climb as unknown as Climb;
    act(() => {
      hosts.at(-1)?.openClimbActions(climb);
    });

    await waitFor(() => expect(container.querySelector('[data-climb-actions]')).not.toBeNull());
    // Snapshots the active board config (kilter / 1 / 10 / 1,2 / 40) at open time and
    // forwards it to the reaction menu so the preview + actions resolve.
    expect(climbActions.props).toMatchObject({
      climb,
      boardConfig: { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 },
    });

    act(() => {
      hosts.at(-1)?.closeClimbActions();
    });
    await waitFor(() => expect(container.querySelector('[data-climb-actions]')).toBeNull());
  });

  it('opens add-to-playlist against the active board snapshot', async () => {
    // The reaction menu opens the playlist picker via the provider's openAddToPlaylist;
    // assert that opener directly.
    const hosts: Array<HostValue> = [];
    const { container } = renderHost((host) => hosts.push(host));
    await waitFor(() => expect(hosts.at(-1)).toBeDefined());

    const climb = makeQueueItem('queue-x', 'climb-x').climb as unknown as Climb;
    act(() => {
      hosts.at(-1)?.openAddToPlaylist(climb);
    });

    await waitFor(() => expect(container.querySelector('[data-add-to-playlist]')).not.toBeNull());
    expect(playlistSheet.props).toMatchObject({
      visible: true,
      climb,
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
      angle: 40,
    });
  });

  it('opens add beta video against the active board snapshot', async () => {
    // The reaction menu opens the share-your-beta sheet via openAddBetaVideo; assert
    // that opener snapshots the active board config onto the sheet.
    const hosts: Array<HostValue> = [];
    const { container } = renderHost((host) => hosts.push(host));
    await waitFor(() => expect(hosts.at(-1)).toBeDefined());

    const climb = makeQueueItem('queue-x', 'climb-x').climb as unknown as Climb;
    act(() => {
      hosts.at(-1)?.openAddBetaVideo(climb);
    });

    await waitFor(() => expect(container.querySelector('[data-add-beta-video]')).not.toBeNull());
    expect(betaVideoSheet.props).toMatchObject({
      visible: true,
      climb,
      boardName: 'kilter',
      layoutId: 1,
      angle: 40,
    });
  });
});

describe('DrawerHostProvider play drawer open target', () => {
  it('does not leak boardConfig into the open target', async () => {
    const hosts: Array<HostValue> = [];
    const routes: Array<RouteValue> = [];
    renderHost(
      (host) => hosts.push(host),
      (route) => routes.push(route),
    );
    await waitFor(() => expect(hosts.at(-1)).toBeDefined());

    const climb = makeQueueItem('queue-x', 'climb-view-2').climb as unknown as Climb;
    act(() => {
      hosts.at(-1)?.openPlayDrawer(climb, { committedExternally: true });
    });

    // No board override → no override set, and `boardConfig` must not reach the
    // open target the route applies.
    await waitFor(() => expect(routes.at(-1)?.playTarget?.climb).toBe(climb));
    expect(routes.at(-1)?.playTarget?.options).toEqual({ committedExternally: true });
  });
});

describe('DrawerHostProvider play drawer board overrides', () => {
  it('applies the override board and updates the open target on each open', async () => {
    const hosts: Array<HostValue> = [];
    const routes: Array<RouteValue> = [];
    renderHost(
      (host) => hosts.push(host),
      (route) => routes.push(route),
    );
    await waitFor(() => expect(hosts.at(-1)).toBeDefined());

    const override: BoardConfig = {
      boardName: 'tension',
      layoutId: 8,
      sizeId: 7,
      setIds: '5,6',
      angle: 35,
    };
    const firstClimb = makeQueueItem('queue-x', 'same-override-1').climb as unknown as Climb;
    const secondClimb = makeQueueItem('queue-y', 'same-override-2').climb as unknown as Climb;

    act(() => {
      hosts.at(-1)?.openPlayDrawer(firstClimb, {
        previewQueueItem: makeQueueItem('preview-x', 'same-override-1'),
        boardConfig: override,
      });
    });
    // The override differs from the stored board → the route's drawer board
    // becomes the override, and the open target carries the first climb.
    await waitFor(() => {
      expect(routes.at(-1)?.activeBoardConfig).toMatchObject(override);
      expect(routes.at(-1)?.playTarget?.climb).toBe(firstClimb);
    });
    expect(routerNavigate).toHaveBeenCalledWith('/play');
    const firstNonce = routes.at(-1)?.playTarget?.nonce;

    act(() => {
      hosts.at(-1)?.openPlayDrawer(secondClimb, {
        previewQueueItem: makeQueueItem('preview-y', 'same-override-2'),
        boardConfig: override,
      });
    });

    // Second open in place: a bumped nonce re-applies the new climb (navigate is
    // a no-op when /play is already up — the nonce is what re-runs the route).
    await waitFor(() => {
      expect(routes.at(-1)?.playTarget?.climb).toBe(secondClimb);
    });
    expect(routes.at(-1)?.playTarget?.nonce).not.toBe(firstNonce);
    expect(routes.at(-1)?.activeBoardConfig).toMatchObject(override);
  });
});

describe('DrawerHostProvider switch board keeps the climb angle', () => {
  beforeEach(() => {
    activeBoard.setActiveBoard.mockClear();
    routerPush.mockClear();
    routerDismiss.mockClear();
  });

  // Owned board loosely-matches the opened climb (same board name + layout) but
  // boardLooselyMatches IGNORES angle — the owned board sits at a different angle
  // than the climb's override.
  const ownedAdjustable: UserBoard = {
    ...activeBoard.defaultStored,
    uuid: 'board-tension',
    slug: 'board-tension',
    name: 'Tension board',
    boardType: 'tension',
    layoutId: 8,
    sizeId: 7,
    setIds: '5,6',
    angle: 25,
    isAngleAdjustable: true,
  };

  async function openWithOverride(override: BoardConfig, climbUuid: string): Promise<() => void> {
    const hosts: Array<HostValue> = [];
    const routes: Array<RouteValue> = [];
    renderHost(
      (host) => hosts.push(host),
      (route) => routes.push(route),
    );
    await waitFor(() => expect(hosts.at(-1)).toBeDefined());

    const climb = makeQueueItem('queue-x', climbUuid).climb as unknown as Climb;
    act(() => {
      hosts.at(-1)?.openPlayDrawer(climb, { boardConfig: override });
    });
    await waitFor(() => expect(routes.at(-1)?.activeBoardConfig).toMatchObject(override));
    const onSwitchBoard = routes.at(-1)?.onSwitchBoard;
    if (!onSwitchBoard) throw new Error('route onSwitchBoard was not provided');
    return onSwitchBoard;
  }

  it('switches to the owned board carrying the climb override angle, not the board stored angle', async () => {
    myBoards.boards = [ownedAdjustable];
    const override: BoardConfig = {
      boardName: 'tension',
      layoutId: 8,
      sizeId: 7,
      setIds: '5,6',
      angle: 55,
    };
    const onSwitchBoard = await openWithOverride(override, 'climb-switch-1');

    act(() => {
      onSwitchBoard();
    });

    expect(activeBoard.setActiveBoard).toHaveBeenCalledWith(
      expect.objectContaining({ uuid: 'board-tension', angle: 55 }),
    );
    expect(activeBoard.setActiveBoard).not.toHaveBeenCalledWith(expect.objectContaining({ angle: 25 }));
  });

  it('passes a fixed-angle owned board through with its own angle unchanged', async () => {
    const ownedFixed: UserBoard = {
      ...ownedAdjustable,
      uuid: 'board-tension-fixed',
      slug: 'board-tension-fixed',
      name: 'Tension fixed',
      angle: 25,
      isAngleAdjustable: false,
    };
    myBoards.boards = [ownedFixed];
    const override: BoardConfig = {
      boardName: 'tension',
      layoutId: 8,
      sizeId: 7,
      setIds: '5,6',
      angle: 55,
    };
    const onSwitchBoard = await openWithOverride(override, 'climb-switch-2');

    act(() => {
      onSwitchBoard();
    });

    expect(activeBoard.setActiveBoard).toHaveBeenCalledWith(
      expect.objectContaining({ uuid: 'board-tension-fixed', angle: 25 }),
    );
  });

  // #5099: the drawer can discover the mismatch from the climb it is SHOWING —
  // a queue item carried over from a board switch — with nobody having set an
  // override. It then hands the board it resolved to this handler; without that
  // the handler reads its empty override, returns early, and the only button on
  // the switch-board scrim does nothing.
  it('switches to the board the drawer resolved for the climb when no override is set', async () => {
    myBoards.boards = [ownedAdjustable];
    const hosts: Array<HostValue> = [];
    const routes: Array<RouteValue> = [];
    renderHost(
      (host) => hosts.push(host),
      (route) => routes.push(route),
    );
    await waitFor(() => expect(hosts.at(-1)).toBeDefined());

    const climb = makeQueueItem('queue-x', 'climb-switch-no-override').climb as unknown as Climb;
    act(() => {
      hosts.at(-1)?.openPlayDrawer(climb, { committedExternally: true });
    });
    await waitFor(() => expect(routes.at(-1)?.playTarget?.climb).toBe(climb));
    // No override was set by the open, so the gate below is climb-driven only.
    expect(routes.at(-1)?.boardMismatch).toBe(false);

    const climbBoard: BoardConfig = {
      boardName: 'tension',
      layoutId: 8,
      sizeId: 7,
      setIds: '5,6',
      angle: 55,
    };
    act(() => {
      routes.at(-1)?.onSwitchBoard(climbBoard);
    });

    expect(activeBoard.setActiveBoard).toHaveBeenCalledWith(
      expect.objectContaining({ uuid: 'board-tension', angle: 55 }),
    );
  });

  it('does nothing when neither an override nor a climb board is offered', async () => {
    myBoards.boards = [ownedAdjustable];
    const routes: Array<RouteValue> = [];
    renderHost(
      () => {},
      (route) => routes.push(route),
    );
    await waitFor(() => expect(routes.at(-1)).toBeDefined());

    act(() => {
      routes.at(-1)?.onSwitchBoard();
    });

    expect(activeBoard.setActiveBoard).not.toHaveBeenCalled();
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('routes to the board picker when the user owns no board matching the climb override', async () => {
    // Owned board is a genuinely different model (board name + layout) than the
    // climb's override, so boardLooselyMatches finds nothing to switch to.
    myBoards.boards = [ownedAdjustable];
    const override: BoardConfig = {
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
      angle: 55,
    };
    const onSwitchBoard = await openWithOverride(override, 'climb-switch-unowned');

    act(() => {
      onSwitchBoard();
    });

    // No owned match → dismiss the player route and send the user to the board
    // picker.
    expect(routerDismiss).toHaveBeenCalledTimes(1);
    expect(routerPush).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/boards' }));
    expect(activeBoard.setActiveBoard).not.toHaveBeenCalled();
  });
});

describe('DrawerHostProvider iPad pane open (regular width)', () => {
  beforeEach(() => {
    // Regular width (1024 window, 96 sidebar) resolves to the detail pane, so
    // openPlayDrawer drives the right-column PlayDrawer via `openTarget` instead
    // of navigating to the `/play` route. Committing to the queue is now the
    // drawer's job (via openTarget.options), so the host never calls
    // setCurrentClimb on a pane open.
    layoutCfg.widthClass = 'regular';
    climbActions.props = null;
    boardSheet.dismissAndWait.mockClear();
  });

  it('opens wall-column actions without attaching the modal BoardSheet dismiss', async () => {
    const hosts: Array<HostValue> = [];
    renderHost((host) => hosts.push(host));
    await waitFor(() => expect(hosts.at(-1)?.boardPanelProps).not.toBeNull());

    const climb = makeQueueItem('queue-pane-actions', 'climb-pane-actions').climb as unknown as Climb;
    act(() => hosts.at(-1)?.boardPanelProps?.onOpenActions(makeBoardSheetAction(climb)));
    await waitFor(() => expect(climbActions.props).not.toBeNull());

    expect(climbActions.props?.dismissSourceSheet).toBeUndefined();
    expect(boardSheet.dismissAndWait).not.toHaveBeenCalled();
  });

  it('drives the pane open target without navigating to /play', async () => {
    const hosts: Array<HostValue> = [];
    renderHost((host) => hosts.push(host));
    await waitFor(() => expect(hosts.at(-1)).toBeDefined());

    const climb = makeQueueItem('queue-x', 'pane-open-1').climb as unknown as Climb;
    act(() => {
      hosts.at(-1)?.openPlayDrawer(climb);
    });

    // The pane's selected climb is set on playDrawerPaneProps.openTarget.
    await waitFor(() => {
      expect(hosts.at(-1)?.playDrawerPaneProps?.openTarget?.climb.uuid).toBe('pane-open-1');
    });
    // No override, no caller options → the open target carries an empty options bag.
    expect(hosts.at(-1)?.playDrawerPaneProps?.openTarget?.options).toEqual({});
    // The pane hosts the drawer in place — no full-screen /play navigation.
    expect(routerNavigate).not.toHaveBeenCalled();
  });

  it('passes a view-only open through openTarget.options, stripping the analytics source', async () => {
    const hosts: Array<HostValue> = [];
    renderHost((host) => hosts.push(host));
    await waitFor(() => expect(hosts.at(-1)).toBeDefined());

    const climb = makeQueueItem('queue-x', 'pane-view-1').climb as unknown as Climb;
    const previewItem = makeQueueItem('queue-preview-1', 'pane-view-1');
    act(() => {
      // Feed / beta / climb-view preview: show it in the pane; PlayDrawer decides
      // whether to commit from openTarget.options (the host doesn't).
      hosts.at(-1)?.openPlayDrawer(climb, { previewQueueItem: previewItem });
    });

    await waitFor(() => {
      expect(hosts.at(-1)?.playDrawerPaneProps?.openTarget?.climb.uuid).toBe('pane-view-1');
    });
    const openTarget = hosts.at(-1)?.playDrawerPaneProps?.openTarget;
    expect(openTarget?.options?.previewQueueItem).toBe(previewItem);
    // `source` is analytics-only and is stripped before it reaches the open target
    // (toEqual asserts nothing else — no `source`, no `boardConfig` — leaks through).
    expect(openTarget?.options).toEqual({ previewQueueItem: previewItem });
    expect(routerNavigate).not.toHaveBeenCalled();
  });

  it('forwards the playlist suggestion source through openTarget.options', async () => {
    const hosts: Array<HostValue> = [];
    renderHost((host) => hosts.push(host));
    await waitFor(() => expect(hosts.at(-1)).toBeDefined());

    const sourceItem = makeQueueItem('queue-source', 'pane-source-climb');
    const previewItem = makeQueueItem('queue-preview-2', 'pane-preview-2');
    const playlistSuggestionSource: PlaylistSuggestionSource = {
      playlistUuid: 'playlist-pane',
      activatedClimbUuid: sourceItem.climb.uuid,
      boardKey: 'kilter:1:10:1,2',
      climbs: [sourceItem.climb, previewItem.climb],
    };

    act(() => {
      hosts.at(-1)?.openPlayDrawer(previewItem.climb as unknown as Climb, {
        previewQueueItem: previewItem,
        playlistSuggestionSource,
      });
    });

    await waitFor(() => {
      expect(hosts.at(-1)?.playDrawerPaneProps?.openTarget?.climb.uuid).toBe('pane-preview-2');
    });
    const openTarget = hosts.at(-1)?.playDrawerPaneProps?.openTarget;
    expect(openTarget?.options?.playlistSuggestionSource).toBe(playlistSuggestionSource);
    // `source` stripped; previewQueueItem + playlistSuggestionSource pass through.
    expect(openTarget?.options).toEqual({ previewQueueItem: previewItem, playlistSuggestionSource });
    expect(routerNavigate).not.toHaveBeenCalled();
  });

  it('applies a cross-board override to the pane board while the wall column stays on the stored board', async () => {
    const hosts: Array<HostValue> = [];
    renderHost((host) => hosts.push(host));
    await waitFor(() => expect(hosts.at(-1)).toBeDefined());

    const override: BoardConfig = {
      boardName: 'tension',
      layoutId: 8,
      sizeId: 7,
      setIds: '5,6',
      angle: 55,
    };
    const climb = makeQueueItem('queue-x', 'pane-override-1').climb as unknown as Climb;
    act(() => {
      hosts.at(-1)?.openPlayDrawer(climb, { boardConfig: override });
    });

    await waitFor(() => {
      // The override differs from the stored kilter board → the pane's drawer
      // board becomes the override, and it carries the opened climb.
      expect(hosts.at(-1)?.playDrawerPaneProps?.boardConfig).toMatchObject(override);
      expect(hosts.at(-1)?.playDrawerPaneProps?.openTarget?.climb.uuid).toBe('pane-override-1');
    });
    // The persistent "Now on the wall" column stays bound to the stored board.
    expect(hosts.at(-1)?.boardPanelProps?.boardConfig).toMatchObject({
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
      angle: 40,
    });
    // The board is applied via the override state, not the open target — boardConfig
    // is stripped from options like the /play route path.
    expect(hosts.at(-1)?.playDrawerPaneProps?.openTarget?.options).toEqual({});
    expect(routerNavigate).not.toHaveBeenCalled();
  });

  it('applies onAngleChange to the pane override board, leaving the wall column board unchanged', async () => {
    const hosts: Array<HostValue> = [];
    renderHost((host) => hosts.push(host));
    await waitFor(() => expect(hosts.at(-1)).toBeDefined());

    const override: BoardConfig = {
      boardName: 'tension',
      layoutId: 8,
      sizeId: 7,
      setIds: '5,6',
      angle: 55,
    };
    const climb = makeQueueItem('queue-x', 'pane-angle-1').climb as unknown as Climb;
    act(() => {
      hosts.at(-1)?.openPlayDrawer(climb, { boardConfig: override });
    });
    await waitFor(() => {
      expect(hosts.at(-1)?.playDrawerPaneProps?.boardConfig).toMatchObject(override);
    });

    act(() => {
      hosts.at(-1)?.playDrawerPaneProps?.onAngleChange(30);
    });

    // The angle write targets the override board the pane is showing…
    await waitFor(() => {
      expect(hosts.at(-1)?.playDrawerPaneProps?.boardConfig).toMatchObject({ ...override, angle: 30 });
    });
    // …not the stored active board the wall column renders against.
    expect(hosts.at(-1)?.boardPanelProps?.boardConfig).toMatchObject({
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
      angle: 40,
    });
  });

  it('bumps openTarget.nonce when the same climb is re-opened so the pane re-applies', async () => {
    const hosts: Array<HostValue> = [];
    renderHost((host) => hosts.push(host));
    await waitFor(() => expect(hosts.at(-1)).toBeDefined());

    const climb = makeQueueItem('queue-x', 'pane-renonce-1').climb as unknown as Climb;
    act(() => {
      hosts.at(-1)?.openPlayDrawer(climb);
    });
    await waitFor(() => {
      expect(hosts.at(-1)?.playDrawerPaneProps?.openTarget?.climb.uuid).toBe('pane-renonce-1');
    });
    const firstNonce = hosts.at(-1)?.playDrawerPaneProps?.openTarget?.nonce;
    expect(firstNonce).toBeDefined();

    // Re-tap the same climb: a new open target (bumped nonce) so the pane re-applies
    // even though the shown climb is unchanged.
    act(() => {
      hosts.at(-1)?.openPlayDrawer(climb);
    });
    await waitFor(() => {
      expect(hosts.at(-1)?.playDrawerPaneProps?.openTarget?.nonce).not.toBe(firstNonce);
    });
    expect(hosts.at(-1)?.playDrawerPaneProps?.openTarget?.climb.uuid).toBe('pane-renonce-1');
    expect(routerNavigate).not.toHaveBeenCalled();
  });

  it('navigates to /play and leaves the pane open target null on compact width', async () => {
    // Compact width has no persistent pane — the open falls back to the /play route.
    layoutCfg.widthClass = 'compact';
    const hosts: Array<HostValue> = [];
    renderHost((host) => hosts.push(host));
    await waitFor(() => expect(hosts.at(-1)).toBeDefined());

    const climb = makeQueueItem('queue-x', 'pane-compact-1').climb as unknown as Climb;
    act(() => {
      hosts.at(-1)?.openPlayDrawer(climb);
    });

    expect(routerNavigate).toHaveBeenCalledWith('/play');
    // The pane props still resolve (a board is loaded) but the pane never receives
    // an open target on compact — that path drives the route's playTarget instead.
    expect(hosts.at(-1)?.playDrawerPaneProps?.openTarget).toBeNull();
  });

  it('clears the pane open target when a resize drops out of pane width', async () => {
    // Open a climb in the pane at regular width, then resize to compact (Stage
    // Manager / Split View shrink). The pane goes away, so its stale selection must
    // be dropped — otherwise returning to pane width would flash the old climb.
    const hosts: Array<HostValue> = [];
    const onHost = (host: HostValue) => hosts.push(host);
    const { rerender } = renderHost(onHost);
    await waitFor(() => expect(hosts.at(-1)).toBeDefined());

    const climb = makeQueueItem('queue-x', 'pane-resize-1').climb as unknown as Climb;
    act(() => {
      hosts.at(-1)?.openPlayDrawer(climb);
    });
    await waitFor(() => {
      expect(hosts.at(-1)?.playDrawerPaneProps?.openTarget?.climb.uuid).toBe('pane-resize-1');
    });

    // Resize below the pane budget: usesDetailPane flips false and the reset effect
    // fires, clearing the target (not merely that compact starts null — it was set).
    layoutCfg.widthClass = 'compact';
    rerender(createElement(DrawerHostProvider, null, createElement(Probe, { onHost, onRoute: () => {} })));

    await waitFor(() => {
      expect(hosts.at(-1)?.playDrawerPaneProps?.openTarget).toBeNull();
    });
  });
});
