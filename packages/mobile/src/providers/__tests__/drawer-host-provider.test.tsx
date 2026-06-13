// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react';
import { createElement, useEffect, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';
import type { Climb, UserBoard } from '@boardsesh/shared-schema';

const queue = vi.hoisted(() => ({
  sessionId: 'session-1' as string | null,
  driverParticipantId: 'participant-other' as string | null,
  participantId: 'participant-self' as string | null,
  // Two live participants: preview-only is roster-aware (derivePreviewOnly),
  // so a solo occupant is never gated — these fixtures model a real party.
  sessionUserCount: 2,
  setCurrentClimb: vi.fn(),
  addToQueue: vi.fn(),
  setSessionBoardPath: vi.fn(async () => {}),
}));

const playDrawer = vi.hoisted(() => ({
  open: vi.fn(),
  close: vi.fn(),
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

const boardSheet = vi.hoisted(() => ({
  props: null as null | Record<string, unknown>,
  present: vi.fn(),
  dismiss: vi.fn(),
}));

const activeBoard = vi.hoisted(() => {
  const defaultStored = {
    id: 1,
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

vi.mock('react-native-screens', () => ({
  FullWindowOverlay: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

vi.mock('expo-crypto', () => ({
  randomUUID: () => 'test-uuid',
}));

vi.mock('../../components/play-drawer', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return {
    PlayDrawer: React.forwardRef((_props: unknown, ref) => {
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

vi.mock('../bluetooth-provider', () => ({
  useOptionalBluetoothContext: () => ({ undoWallChange: vi.fn(async () => true) }),
}));

vi.mock('../queue-provider', async () => {
  const { derivePreviewOnly } =
    await vi.importActual<typeof import('@boardsesh/queue-runtime')>('@boardsesh/queue-runtime');
  return {
    useQueueActions: () => ({
      addToQueue: queue.addToQueue,
      setSessionBoardPath: queue.setSessionBoardPath,
      setCurrentClimb: queue.setCurrentClimb,
    }),
    useQueueSessionControls: () => ({
      sessionId: queue.sessionId,
      driverParticipantId: queue.driverParticipantId,
      participantId: queue.participantId,
    }),
    // Mirror the provider's real selector so the driver/participant/roster
    // fixtures keep driving the preview-only branch after the handlers moved
    // to the useIsPartyPreviewOnly hook.
    useIsPartyPreviewOnly: () =>
      derivePreviewOnly({
        isSessionActive: queue.sessionId !== null,
        participantId: queue.participantId,
        driverParticipantId: queue.driverParticipantId,
        sessionUserCount: queue.sessionUserCount,
      }),
  };
});

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
}));

vi.mock('../../lib/analytics', () => ({
  track: vi.fn(),
}));

vi.mock('../../lib/climb-to-queue-item', () => ({
  climbToQueueItem: (climb: ClimbQueueItem['climb'], options?: { suggested?: boolean; uuid?: string }) => ({
    uuid: options?.uuid ?? `queue-${climb.uuid}`,
    climb,
    suggested: options?.suggested ?? false,
  }),
}));

import { DrawerHostProvider, useDrawerHost, type BoardConfig } from '../drawer-host-provider';
import type { BoardSheetClimbAction } from '../../components/board-presence/BoardSheet';

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
  presence.enabled = false;
  presence.boardId = null;
  presence.resolveAndBindBoard.mockClear();
  presence.resolveAndBindBoardByConfig.mockClear();
  presence.resolveAndBindBoardByUuid.mockClear();
  presence.resetPresence.mockClear();
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

describe('DrawerHostProvider queue sheet wall-control gating', () => {
  beforeEach(() => {
    queue.sessionId = 'session-1';
    queue.driverParticipantId = 'participant-other';
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

  it('opens a preview without broadcasting when a party non-driver taps a queued climb', async () => {
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

    expect(queue.setCurrentClimb).not.toHaveBeenCalled();
    expect(playDrawer.open).toHaveBeenCalledWith(item.climb, { setAsCurrent: false, previewQueueItem: item });
  });

  it('opens a playlist preview without broadcasting when a party non-driver taps a suggestion', async () => {
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

    expect(queue.setCurrentClimb).not.toHaveBeenCalled();
    expect(playDrawer.open).toHaveBeenCalledWith(
      suggestion,
      expect.objectContaining({
        setAsCurrent: false,
        previewPlaylistSuggestionSource: playlistSuggestionSource,
        previewQueueItem: expect.objectContaining({
          climb: suggestion,
          suggested: true,
        }),
      }),
    );
  });

  it('broadcasts queued climb selection for the current party driver', async () => {
    queue.driverParticipantId = 'participant-self';
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
    expect(playDrawer.open).toHaveBeenCalledWith(item.climb, { setAsCurrent: false, previewQueueItem: item });
  });

  it('broadcasts suggestion selection for the current party driver while anchoring drawer navigation to that item', async () => {
    queue.driverParticipantId = 'participant-self';
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
      setAsCurrent: false,
      previewQueueItem: suggestedItem,
    });
  });
});

describe('DrawerHostProvider board sheet climb actions', () => {
  beforeEach(() => {
    queue.sessionId = 'session-1';
    queue.driverParticipantId = 'participant-other';
    queue.participantId = 'participant-self';
    queue.sessionUserCount = 2;
    queue.setCurrentClimb.mockClear();
    queue.addToQueue.mockClear();
    playDrawer.open.mockClear();
    climbActions.props = null;
    playlistSheet.props = null;
    boardSheet.props = null;
    boardSheet.present.mockClear();
    boardSheet.dismiss.mockClear();
  });

  it('opens a preview without broadcasting when a party non-driver taps a board-sheet climb', async () => {
    const hosts: Array<ReturnType<typeof useDrawerHost>> = [];
    renderHost((host) => hosts.push(host));
    await waitFor(() => expect(boardSheet.props).not.toBeNull());

    const climb = makeQueueItem('queue-x', 'climb-x').climb as unknown as Climb;
    const action = makeBoardSheetAction(climb);
    act(() => {
      getBoardSheetProps().onClimbPress(action);
    });

    expect(queue.setCurrentClimb).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(playDrawer.open).toHaveBeenCalledWith(climb, {
        setAsCurrent: false,
        previewQueueItem: expect.objectContaining({ uuid: 'wall-queue-x', climb }),
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

  it('sets current and opens the drawer when the party driver taps a board-sheet climb', async () => {
    queue.driverParticipantId = 'participant-self';
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
        setAsCurrent: false,
        previewQueueItem: expect.objectContaining({ uuid: 'wall-queue-x', climb }),
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
    queue.driverParticipantId = 'participant-other';
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
});
