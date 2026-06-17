// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react';
import { createElement, useEffect, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import type { ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';
import type { Climb, UserBoard } from '@boardsesh/shared-schema';

const queue = vi.hoisted(() => ({
  sessionId: 'session-1' as string | null,
  participantId: 'participant-self' as string | null,
  setCurrentClimb: vi.fn(),
  addToQueue: vi.fn(),
  setSessionBoardPath: vi.fn(async () => {}),
}));

const playDrawer = vi.hoisted(() => ({
  props: null as null | { onSwitchBoard?: () => void },
  open: vi.fn(),
  close: vi.fn(),
}));

const analytics = vi.hoisted(() => ({
  track: vi.fn(),
}));

const queueSheet = vi.hoisted(() => ({
  props: null as null | {
    onClose: () => void;
    onClimbPress: (item: ClimbQueueItem) => void;
    onSuggestionPress: (climb: ClimbQueueItem['climb'], source: PlaylistSuggestionSource) => void;
  },
  present: vi.fn(),
  dismiss: vi.fn(),
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
}));

// The host reads the device layout to decide sheet (compact) vs pane (regular).
// Defaults to compact (the bottom-sheet path most tests exercise); the
// regular-width pane describe flips it.
const layoutCfg = vi.hoisted(() => ({ widthClass: 'compact' as 'compact' | 'regular' }));
vi.mock('../../hooks/use-device-layout', () => ({
  useDeviceLayout: () => ({ widthClass: layoutCfg.widthClass, expanded: false }),
}));

vi.mock('react-native-screens', () => ({
  FullWindowOverlay: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

vi.mock('expo-crypto', () => ({
  randomUUID: () => 'test-uuid',
}));

vi.mock('../../components/play-drawer', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return {
    PlayDrawer: React.forwardRef((props: { onSwitchBoard?: () => void }, ref) => {
      playDrawer.props = props;
      React.useImperativeHandle(ref, () => ({
        open: playDrawer.open,
        close: playDrawer.close,
      }));
      return React.createElement('div', { 'data-play-drawer': 'true' });
    }),
  };
});

vi.mock('../../components/play-drawer/QueueSheet', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return {
    QueueSheet: React.forwardRef(
      (
        props: {
          onClose: () => void;
          onClimbPress: (item: ClimbQueueItem) => void;
          onSuggestionPress: (climb: ClimbQueueItem['climb'], source: PlaylistSuggestionSource) => void;
        },
        ref,
      ) => {
        queueSheet.props = props;
        React.useImperativeHandle(ref, () => ({
          present: queueSheet.present,
          dismiss: queueSheet.dismiss,
        }));
        return React.createElement('div', { 'data-queue-sheet': 'true' });
      },
    ),
  };
});

vi.mock('../../components/LogAscentSheet', () => ({
  LogAscentSheet: () => createElement('div', { 'data-log-ascent': 'true' }),
}));
vi.mock('../../components/ClimbActionsSheet', () => ({
  ClimbActionsSheet: (props: Record<string, unknown>) => {
    climbActions.props = props;
    return createElement('div', { 'data-climb-actions': 'true' });
  },
}));
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
      React.useImperativeHandle(ref, () => ({ present: boardSheet.present, dismiss: boardSheet.dismiss }));
      return React.createElement('div', { 'data-board-sheet': 'true' });
    }),
  };
});
vi.mock('../../components/board-presence/UndoWallChangeSnackbar', () => ({
  UndoWallChangeSnackbar: () => createElement('div', { 'data-undo-snackbar': 'true' }),
}));

vi.mock('expo-router', () => ({
  router: { push: vi.fn() },
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
import { DrawerHostProvider, useDrawerHost, type BoardConfig } from '../drawer-host-provider';
import type { BoardSheetClimbAction } from '../../components/board-presence/BoardSheet';

const routerPush = router.push as unknown as ReturnType<typeof vi.fn>;

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

function Probe({ onHost }: { onHost: (host: ReturnType<typeof useDrawerHost>) => void }) {
  const host = useDrawerHost();
  useEffect(() => {
    onHost(host);
  }, [host, onHost]);
  return null;
}

function renderHost(onHost: (host: ReturnType<typeof useDrawerHost>) => void) {
  return render(createElement(DrawerHostProvider, null, createElement(Probe, { onHost })));
}

beforeEach(() => {
  activeBoard.stored = { ...activeBoard.defaultStored };
  activeBoard.setActiveBoard.mockClear();
  myBoards.boards = [];
  analytics.track.mockClear();
  playDrawer.props = null;
  playDrawer.open.mockClear();
  playDrawer.close.mockClear();
  presence.enabled = false;
  presence.boardId = null;
  presence.resolveAndBindBoard.mockClear();
  presence.resolveAndBindBoardByConfig.mockClear();
  presence.resolveAndBindBoardByUuid.mockClear();
  presence.resetPresence.mockClear();
  queue.setCurrentClimb.mockClear();
  layoutCfg.widthClass = 'compact';
});

describe('DrawerHostProvider board presence binding', () => {
  it('resolves board presence from the selected active board without Bluetooth', async () => {
    presence.enabled = true;
    const hosts: Array<ReturnType<typeof useDrawerHost>> = [];
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
    const hosts: Array<ReturnType<typeof useDrawerHost>> = [];
    renderHost((host) => hosts.push(host));
    await waitFor(() => expect(hosts.at(-1)).toBeDefined());

    await waitFor(() => {
      expect(presence.resetPresence).toHaveBeenCalledTimes(1);
    });
    expect(presence.resolveAndBindBoardByUuid).not.toHaveBeenCalled();
  });

  it('resets board presence when the selected active board is cleared', async () => {
    presence.enabled = true;
    const hosts: Array<ReturnType<typeof useDrawerHost>> = [];
    const onHost = (host: ReturnType<typeof useDrawerHost>) => hosts.push(host);
    const { rerender } = renderHost(onHost);
    await waitFor(() => {
      expect(presence.resolveAndBindBoardByUuid).toHaveBeenCalledWith({ boardUuid: 'board-1' });
    });

    presence.resolveAndBindBoardByUuid.mockClear();
    presence.resetPresence.mockClear();
    activeBoard.stored = null;
    rerender(createElement(DrawerHostProvider, null, createElement(Probe, { onHost })));

    await waitFor(() => {
      expect(presence.resetPresence).toHaveBeenCalledTimes(1);
    });
    expect(presence.resolveAndBindBoardByUuid).not.toHaveBeenCalled();
  });

  it('rebinds board presence when the selected active board changes', async () => {
    presence.enabled = true;
    const hosts: Array<ReturnType<typeof useDrawerHost>> = [];
    const onHost = (host: ReturnType<typeof useDrawerHost>) => hosts.push(host);
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
    rerender(createElement(DrawerHostProvider, null, createElement(Probe, { onHost })));

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
    playDrawer.open.mockClear();
    playDrawer.close.mockClear();
    queueSheet.props = null;
    queueSheet.present.mockClear();
    queueSheet.dismiss.mockClear();
    climbActions.props = null;
    playlistSheet.props = null;
    boardSheet.props = null;
    boardSheet.present.mockClear();
    boardSheet.dismiss.mockClear();
  });

  it('broadcasts queued climb selection for every session member', async () => {
    const hosts: Array<ReturnType<typeof useDrawerHost>> = [];
    renderHost((host) => hosts.push(host));
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
    expect(playDrawer.open).toHaveBeenCalledWith(item.climb, { committedExternally: true });
  });

  it('broadcasts suggestion selection for every session member while anchoring drawer navigation to that item', async () => {
    const hosts: Array<ReturnType<typeof useDrawerHost>> = [];
    renderHost((host) => hosts.push(host));
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
    expect(playDrawer.open).toHaveBeenCalledWith(suggestion, {
      committedExternally: true,
    });
  });
});

describe('DrawerHostProvider board sheet climb actions', () => {
  beforeEach(() => {
    queue.sessionId = 'session-1';
    queue.participantId = 'participant-self';
    queue.setCurrentClimb.mockClear();
    queue.addToQueue.mockClear();
    playDrawer.open.mockClear();
    climbActions.props = null;
    playlistSheet.props = null;
    boardSheet.props = null;
    boardSheet.present.mockClear();
    boardSheet.dismiss.mockClear();
  });

  it('sets current and opens the drawer when any session member taps a board-sheet climb', async () => {
    const hosts: Array<ReturnType<typeof useDrawerHost>> = [];
    renderHost((host) => hosts.push(host));
    await waitFor(() => expect(boardSheet.props).not.toBeNull());

    const climb = makeQueueItem('queue-x', 'climb-x').climb as unknown as Climb;
    const action = makeBoardSheetAction(climb);
    act(() => {
      getBoardSheetProps().onClimbPress(action);
    });

    expect(queue.setCurrentClimb).toHaveBeenCalledWith(expect.objectContaining({ uuid: 'wall-queue-x', climb }));
    await waitFor(() =>
      expect(playDrawer.open).toHaveBeenCalledWith(climb, {
        committedExternally: true,
      }),
    );
    await waitFor(() =>
      expect(hosts.at(-1)?.boardConfig).toMatchObject({
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '1,2',
        angle: 30,
      }),
    );
  });

  it('reuses queue, playlist, and climb-actions handlers for board-sheet climbs', async () => {
    const hosts: Array<ReturnType<typeof useDrawerHost>> = [];
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
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
      angle: 30,
    });
  });
});

describe('DrawerHostProvider queue sheet open / re-open', () => {
  beforeEach(() => {
    queue.sessionId = 'session-1';
    queue.participantId = 'participant-self';
    queueSheet.props = null;
    queueSheet.present.mockClear();
    queueSheet.dismiss.mockClear();
    climbActions.props = null;
    playlistSheet.props = null;
    boardSheet.props = null;
    boardSheet.present.mockClear();
    boardSheet.dismiss.mockClear();
  });

  it('stays mounted and presents via the imperative handle on open', async () => {
    const hosts: Array<ReturnType<typeof useDrawerHost>> = [];
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
    const hosts: Array<ReturnType<typeof useDrawerHost>> = [];
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

  it('opens the climb actions sheet for a climb against the active board, then closes it', async () => {
    const hosts: Array<ReturnType<typeof useDrawerHost>> = [];
    const { container } = renderHost((host) => hosts.push(host));
    await waitFor(() => expect(hosts.at(-1)).toBeDefined());

    expect(container.querySelector('[data-climb-actions]')).toBeNull();

    const climb = makeQueueItem('queue-x', 'climb-x').climb as unknown as Climb;
    act(() => {
      hosts.at(-1)?.openClimbActions(climb);
    });

    await waitFor(() => expect(container.querySelector('[data-climb-actions]')).not.toBeNull());
    // Snapshots the active board config (kilter / 1 / 10 / 1,2 / 40) at open time
    // and forwards it to the sheet so the preview thumbnail + actions resolve.
    expect(climbActions.props).toMatchObject({
      visible: true,
      climb,
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
      angle: 40,
    });

    act(() => {
      hosts.at(-1)?.closeClimbActions();
    });
    await waitFor(() => expect(container.querySelector('[data-climb-actions]')).toBeNull());
  });

  it('opens add-to-playlist from climb actions with the same climb and board snapshot', async () => {
    const hosts: Array<ReturnType<typeof useDrawerHost>> = [];
    const { container } = renderHost((host) => hosts.push(host));
    await waitFor(() => expect(hosts.at(-1)).toBeDefined());

    const climb = makeQueueItem('queue-x', 'climb-x').climb as unknown as Climb;
    act(() => {
      hosts.at(-1)?.openClimbActions(climb);
    });
    await waitFor(() => expect(climbActions.props).not.toBeNull());

    act(() => {
      (climbActions.props?.onOpenPlaylist as (() => void) | undefined)?.();
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

  it('opens add beta video from climb actions, snapshotting the climb even as the actions sheet closes', async () => {
    const hosts: Array<ReturnType<typeof useDrawerHost>> = [];
    const { container } = renderHost((host) => hosts.push(host));
    await waitFor(() => expect(hosts.at(-1)).toBeDefined());

    const climb = makeQueueItem('queue-x', 'climb-x').climb as unknown as Climb;
    act(() => {
      hosts.at(-1)?.openClimbActions(climb);
    });
    await waitFor(() => expect(climbActions.props).not.toBeNull());

    // Mirror ClimbActionsSheet.handleAddBetaVideo: fire onAddBetaVideo, then
    // onClose (which clears climbActions). The beta-video sheet must still receive
    // the snapshotted climb + board config — the ordering must not be load-bearing.
    act(() => {
      (climbActions.props?.onAddBetaVideo as (() => void) | undefined)?.();
      (climbActions.props?.onClose as (() => void) | undefined)?.();
    });

    await waitFor(() => expect(container.querySelector('[data-add-beta-video]')).not.toBeNull());
    expect(container.querySelector('[data-climb-actions]')).toBeNull();
    expect(betaVideoSheet.props).toMatchObject({
      visible: true,
      climb,
      boardName: 'kilter',
      layoutId: 1,
      angle: 40,
    });
  });
});

describe('DrawerHostProvider play drawer open analytics source', () => {
  it('tags a climb-view open with source:climb_view', async () => {
    const hosts: Array<ReturnType<typeof useDrawerHost>> = [];
    renderHost((host) => hosts.push(host));
    await waitFor(() => expect(hosts.at(-1)).toBeDefined());

    const climb = makeQueueItem('queue-x', 'climb-view-1').climb as unknown as Climb;
    const previewItem = makeQueueItem('queue-preview-1', 'climb-view-1');
    act(() => {
      hosts.at(-1)?.openPlayDrawer(climb, { previewQueueItem: previewItem, source: 'climb_view' });
    });

    expect(analytics.track).toHaveBeenCalledWith(
      SHARED_EVENTS.PlayDrawerOpened,
      expect.objectContaining({ climbUuid: 'climb-view-1', source: 'climb_view' }),
    );
  });

  it('defaults a queue-nav open (committedExternally, no source) to current_queue_item', async () => {
    const hosts: Array<ReturnType<typeof useDrawerHost>> = [];
    renderHost((host) => hosts.push(host));
    await waitFor(() => expect(hosts.at(-1)).toBeDefined());

    const climb = makeQueueItem('queue-x', 'queue-nav-1').climb as unknown as Climb;
    act(() => {
      hosts.at(-1)?.openPlayDrawer(climb, { committedExternally: true });
    });

    expect(analytics.track).toHaveBeenCalledWith(
      SHARED_EVENTS.PlayDrawerOpened,
      expect.objectContaining({ climbUuid: 'queue-nav-1', source: 'current_queue_item' }),
    );
  });

  it('does not leak source into PlayDrawer.open', async () => {
    const hosts: Array<ReturnType<typeof useDrawerHost>> = [];
    renderHost((host) => hosts.push(host));
    await waitFor(() => expect(hosts.at(-1)).toBeDefined());

    const climb = makeQueueItem('queue-x', 'climb-view-2').climb as unknown as Climb;
    act(() => {
      hosts.at(-1)?.openPlayDrawer(climb, { committedExternally: true, source: 'climb_view' });
    });

    // No board override → the drawer opens synchronously with only the queue
    // options; `source` was pulled out and must not reach PlayDrawer.open.
    expect(playDrawer.open).toHaveBeenCalledWith(climb, { committedExternally: true });
  });
});

describe('DrawerHostProvider switch board keeps the climb angle', () => {
  beforeEach(() => {
    activeBoard.setActiveBoard.mockClear();
    playDrawer.open.mockClear();
    playDrawer.close.mockClear();
    routerPush.mockClear();
  });

  function getOnSwitchBoard(): () => void {
    const onSwitchBoard = playDrawer.props?.onSwitchBoard;
    if (!onSwitchBoard) throw new Error('PlayDrawer.onSwitchBoard was not provided');
    return onSwitchBoard;
  }

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

  it('switches to the owned board carrying the climb override angle, not the board stored angle', async () => {
    myBoards.boards = [ownedAdjustable];
    const hosts: Array<ReturnType<typeof useDrawerHost>> = [];
    renderHost((host) => hosts.push(host));
    await waitFor(() => expect(hosts.at(-1)).toBeDefined());

    const climb = makeQueueItem('queue-x', 'climb-switch-1').climb as unknown as Climb;
    const override: BoardConfig = {
      boardName: 'tension',
      layoutId: 8,
      sizeId: 7,
      setIds: '5,6',
      angle: 55,
    };
    act(() => {
      hosts.at(-1)?.openPlayDrawer(climb, { boardConfig: override });
    });
    await waitFor(() => expect(playDrawer.props?.onSwitchBoard).toBeDefined());

    act(() => {
      getOnSwitchBoard()();
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
    const hosts: Array<ReturnType<typeof useDrawerHost>> = [];
    renderHost((host) => hosts.push(host));
    await waitFor(() => expect(hosts.at(-1)).toBeDefined());

    const climb = makeQueueItem('queue-x', 'climb-switch-2').climb as unknown as Climb;
    const override: BoardConfig = {
      boardName: 'tension',
      layoutId: 8,
      sizeId: 7,
      setIds: '5,6',
      angle: 55,
    };
    act(() => {
      hosts.at(-1)?.openPlayDrawer(climb, { boardConfig: override });
    });
    await waitFor(() => expect(playDrawer.props?.onSwitchBoard).toBeDefined());

    act(() => {
      getOnSwitchBoard()();
    });

    expect(activeBoard.setActiveBoard).toHaveBeenCalledWith(
      expect.objectContaining({ uuid: 'board-tension-fixed', angle: 25 }),
    );
  });

  it('routes to the board picker when the user owns no board matching the climb override', async () => {
    // Owned board is a genuinely different model (board name + layout) than the
    // climb's override, so boardLooselyMatches finds nothing to switch to.
    myBoards.boards = [ownedAdjustable];
    const hosts: Array<ReturnType<typeof useDrawerHost>> = [];
    renderHost((host) => hosts.push(host));
    await waitFor(() => expect(hosts.at(-1)).toBeDefined());

    const climb = makeQueueItem('queue-x', 'climb-switch-unowned').climb as unknown as Climb;
    const override: BoardConfig = {
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
      angle: 55,
    };
    act(() => {
      hosts.at(-1)?.openPlayDrawer(climb, { boardConfig: override });
    });
    await waitFor(() => expect(playDrawer.props?.onSwitchBoard).toBeDefined());

    act(() => {
      getOnSwitchBoard()();
    });

    // No owned match → close the drawer and send the user to the board picker.
    expect(playDrawer.close).toHaveBeenCalledTimes(1);
    expect(routerPush).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/boards' }));
    expect(activeBoard.setActiveBoard).not.toHaveBeenCalled();
  });
});

describe('DrawerHostProvider iPad pane open (regular width)', () => {
  beforeEach(() => {
    // Regular width takes the pane path: no bottom sheet to present.
    layoutCfg.widthClass = 'regular';
  });

  it('commits the climb as current (no sheet) when opened without a preview', async () => {
    const hosts: Array<ReturnType<typeof useDrawerHost>> = [];
    renderHost((host) => hosts.push(host));
    await waitFor(() => expect(hosts.at(-1)).toBeDefined());

    const climb = makeQueueItem('queue-x', 'commit-1').climb as unknown as Climb;
    act(() => {
      hosts.at(-1)?.openPlayDrawer(climb);
    });

    expect(queue.setCurrentClimb).toHaveBeenCalledWith(
      expect.objectContaining({ climb: expect.objectContaining({ uuid: 'commit-1' }) }),
      expect.anything(),
    );
    // The pane never presents the bottom sheet, and a commit clears any preview.
    expect(playDrawer.open).not.toHaveBeenCalled();
    expect(hosts.at(-1)?.playDrawerPaneProps?.previewItem).toBeNull();
  });

  it('previews a view-only open in the pane without committing it as current', async () => {
    const hosts: Array<ReturnType<typeof useDrawerHost>> = [];
    renderHost((host) => hosts.push(host));
    await waitFor(() => expect(hosts.at(-1)).toBeDefined());

    const climb = makeQueueItem('queue-x', 'preview-1').climb as unknown as Climb;
    const previewItem = makeQueueItem('queue-preview-1', 'preview-1');
    act(() => {
      // The feed / beta / climb-view preview path: show it in the pane, don't
      // change the queue's current climb (would otherwise broadcast in a session).
      hosts.at(-1)?.openPlayDrawer(climb, { previewQueueItem: previewItem, source: 'climb_view' });
    });

    expect(queue.setCurrentClimb).not.toHaveBeenCalled();
    expect(playDrawer.open).not.toHaveBeenCalled();
    expect(hosts.at(-1)?.playDrawerPaneProps?.previewItem?.climb.uuid).toBe('preview-1');
  });
});
