// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react';
import { createElement, useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';

// Board-render A/B telemetry (issue #2202): `Climb View Opened` must fire once
// per change of the climb drawn on the board, whichever path changed it.
//
// The first cut fired it inside `setCurrentClimb` only, which missed every
// swipe: `nextClimb`/`previousClimb` dispatch to the reducer directly and never
// pass through that callback. These cases pin the event to the CHANGE instead.

const ws = vi.hoisted(() => ({
  client: {
    on: vi.fn(() => vi.fn()),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

const graph = vi.hoisted(() => ({ execute: vi.fn() }));
const http = vi.hoisted(() => ({ request: vi.fn() }));

const activeBoard = vi.hoisted(() => ({
  stored: {
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
  } satisfies UserBoard,
  getStoredActiveBoard: vi.fn(),
}));

const queueMutations = vi.hoisted(() => ({
  addQueueItem: vi.fn(async () => {}),
  removeQueueItem: vi.fn(async () => {}),
  reorderQueueItem: vi.fn(async () => {}),
  setCurrentClimb: vi.fn(async () => {}),
  mirrorCurrentClimb: vi.fn(async () => {}),
  publishPlaybackState: vi.fn(async () => {}),
  setQueue: vi.fn(async () => {}),
  replaceQueueItem: vi.fn(async () => {}),
  reportWallDisconnect: vi.fn(async () => {}),
  confirmClimbOnWall: vi.fn(async () => {}),
  setSessionBoardSerial: vi.fn(async () => {}),
  setSessionBoardPath: vi.fn(async () => {}),
  wasUuidExplicitlyRemoved: vi.fn((_uuid: string) => false),
}));

const sessionStore = vi.hoisted(() => ({
  getStoredSessionId: vi.fn(async (): Promise<string | null> => null),
  setStoredSessionId: vi.fn(async () => {}),
  clearStoredSessionId: vi.fn(async () => {}),
  getStoredCreatedSessionId: vi.fn(async (): Promise<string | null> => null),
  setStoredCreatedSessionId: vi.fn(async () => {}),
  clearStoredCreatedSessionId: vi.fn(async () => {}),
}));

type StoredSnapshot = {
  queue: ClimbQueueItem[];
  currentClimbQueueItem: ClimbQueueItem | null;
  playlistSuggestionSource: PlaylistSuggestionSource | null;
  savedAt: string;
};
const queueSnapshotStore = vi.hoisted(() => ({
  getStoredQueueSnapshot: vi.fn(async (): Promise<StoredSnapshot | null> => null),
  setStoredQueueSnapshot: vi.fn(async () => {}),
  clearStoredQueueSnapshot: vi.fn(async () => {}),
}));

const climbViewSession = vi.hoisted(() => ({
  markClimbViewed: vi.fn(),
  markClimbAction: vi.fn(),
}));

// The board-render rollout flag, swapped per case.
const renderFlags = vi.hoisted(() => ({
  values: {} as Record<string, string | undefined>,
}));

// The climber's stored settings, swapped per case. Since 2.4 retired the
// `board-render-mode-default` flag, a stored `mode` is the ONLY thing that says
// which drawing is asked for — `'default'` now means the Boardsesh drawing, so
// "this climber is on classic" has to be stated here rather than via a flag.
const boardRenderSettingsState = vi.hoisted(() => ({
  loaded: true,
  mode: 'default' as 'default' | 'classic' | 'boardsesh',
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default },
  AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-correlation-id' }));
vi.mock('@boardsesh/graphql-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/graphql-client')>()),
  execute: graph.execute,
}));
vi.mock('@boardsesh/queue-react', () => ({ useQueueMutations: () => queueMutations }));
vi.mock('@boardsesh/play-view', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/play-view')>()),
  emitWallConfirm: vi.fn(),
}));
vi.mock('../../lib/graphql/ws-client', () => ({ getWsClient: () => ws.client }));
vi.mock('../../lib/session-store', () => sessionStore);
vi.mock('../../lib/queue-snapshot-store', () => queueSnapshotStore);
vi.mock('../../lib/active-board-store', () => ({ getStoredActiveBoard: activeBoard.getStoredActiveBoard }));
vi.mock('../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: activeBoard.stored }),
  useSetActiveBoard: () => vi.fn(async () => {}),
}));
vi.mock('../../lib/graphql/client', () => ({ getHttpClient: () => ({ request: http.request }) }));
vi.mock('../../lib/analytics', () => ({ track: vi.fn(), registerRenderSuperProperties: vi.fn() }));
vi.mock('../../lib/climb-view-session', () => climbViewSession);
// Real resolver + real requestedBoardRenderMode; only the AsyncStorage-backed
// hook is replaced, so the "settings not loaded yet" branch is controllable.
vi.mock('../../lib/board-render-settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/board-render-settings')>();
  return {
    ...actual,
    useBoardRenderSettings: () => ({
      settings: { ...actual.DEFAULT_BOARD_RENDER_SETTINGS, mode: boardRenderSettingsState.mode },
      loaded: boardRenderSettingsState.loaded,
      setMode: vi.fn(),
      setBoardseshField: vi.fn(),
      reset: vi.fn(),
    }),
  };
});
vi.mock('../feature-flags-provider', () => ({
  useFeatureFlagVariant: (key: string) => renderFlags.values[key],
}));
vi.mock('../../lib/error-reporting', () => ({ reportError: vi.fn(), reportHandledError: vi.fn() }));
vi.mock('../toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../queue-snackbar-provider', () => ({ useQueueSnackbar: () => ({ showQueueAddedSnackbar: vi.fn() }) }));
vi.mock('../queue/use-cross-board-add-gate', () => ({
  useCrossBoardAddGate: () => async () => ({ outcome: 'add' }),
}));
vi.mock('../party-profile-provider', () => ({
  usePartyProfile: () => ({ username: undefined, avatarUrl: undefined }),
}));

import { _resetBoardseshSupportForTests, setBoardseshRendererSupport } from '../../hooks/boardsesh-renderer-support';
import { QueueProvider, useQueue } from '../queue-provider';

type Snapshot = {
  state: ReturnType<typeof useQueue>['state'];
  setCurrentClimb: ReturnType<typeof useQueue>['setCurrentClimb'];
  nextClimb: ReturnType<typeof useQueue>['nextClimb'];
  previousClimb: ReturnType<typeof useQueue>['previousClimb'];
  noteClimbViewed: ReturnType<typeof useQueue>['noteClimbViewed'];
  addToQueue: ReturnType<typeof useQueue>['addToQueue'];
};

function Probe({ onSnapshot }: { onSnapshot: (snapshot: Snapshot) => void }) {
  const queue = useQueue();
  useEffect(() => {
    onSnapshot({
      state: queue.state,
      setCurrentClimb: queue.setCurrentClimb,
      nextClimb: queue.nextClimb,
      previousClimb: queue.previousClimb,
      noteClimbViewed: queue.noteClimbViewed,
      addToQueue: queue.addToQueue,
    });
  }, [
    queue.state,
    queue.setCurrentClimb,
    queue.nextClimb,
    queue.previousClimb,
    queue.noteClimbViewed,
    queue.addToQueue,
    onSnapshot,
  ]);
  return null;
}

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
    suggested: false,
  };
}

const THREE_ITEM_QUEUE = [
  makeQueueItem('item-1', 'climb-1'),
  makeQueueItem('item-2', 'climb-2'),
  makeQueueItem('item-3', 'climb-3'),
];

function viewedClimbUuids(): string[] {
  return climbViewSession.markClimbViewed.mock.calls.map((call) => String(call[0]));
}

describe('QueueProvider board-render view telemetry', () => {
  let snapshots: Snapshot[] = [];

  function latest(): Snapshot {
    const snapshot = snapshots.at(-1);
    if (!snapshot) throw new Error('provider never rendered');
    return snapshot;
  }

  function renderProvider() {
    snapshots = [];
    return render(
      createElement(QueueProvider, null, createElement(Probe, { onSnapshot: (s: Snapshot) => snapshots.push(s) })),
    );
  }

  /** Mount with a three-climb queue already current on the middle item. */
  async function renderWithQueue() {
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue({
      queue: THREE_ITEM_QUEUE,
      currentClimbQueueItem: THREE_ITEM_QUEUE[1],
      playlistSuggestionSource: null,
      savedAt: '2026-08-27T00:00:00.000Z',
    });
    renderProvider();
    await waitFor(() => {
      expect(latest().state.currentClimbQueueItem?.uuid).toBe('item-2');
    });
    // The hydrated climb is itself a view — the climber opens the app and it is
    // what the board draws. Clear it so each case counts only its own action.
    climbViewSession.markClimbViewed.mockClear();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    _resetBoardseshSupportForTests();
    boardRenderSettingsState.loaded = true;
    // Default: this climber has explicitly chosen the classic drawing, so the
    // capability probe is irrelevant and views fire immediately. (A stored
    // `'default'` would now ask for the Boardsesh drawing and have to wait.)
    boardRenderSettingsState.mode = 'classic';
    renderFlags.values = { 'board-glow-falloff': 'soft' };
    activeBoard.getStoredActiveBoard.mockResolvedValue(activeBoard.stored);
    for (const mutation of Object.values(queueMutations) as Array<ReturnType<typeof vi.fn>>) {
      mutation.mockReset();
      mutation.mockResolvedValue(undefined);
    }
    queueMutations.wasUuidExplicitlyRemoved.mockReset();
    queueMutations.wasUuidExplicitlyRemoved.mockReturnValue(false);
    sessionStore.getStoredSessionId.mockResolvedValue(null);
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue(null);
    graph.execute.mockResolvedValue({});
    http.request.mockResolvedValue({ createSession: { id: 'session-new' } });
  });

  it('fires exactly one Climb View Opened when setCurrentClimb activates a climb', async () => {
    await renderWithQueue();

    act(() => {
      latest().setCurrentClimb(makeQueueItem('item-tapped', 'climb-tapped'), { playlistSuggestionSource: null });
    });

    await waitFor(() => {
      expect(viewedClimbUuids()).toEqual(['climb-tapped']);
    });
  });

  it('fires exactly one Climb View Opened when nextClimb swipes forward', async () => {
    await renderWithQueue();

    act(() => {
      latest().nextClimb();
    });

    await waitFor(() => {
      expect(viewedClimbUuids()).toEqual(['climb-3']);
    });
  });

  it('fires exactly one Climb View Opened when previousClimb swipes back', async () => {
    await renderWithQueue();

    act(() => {
      latest().previousClimb();
    });

    await waitFor(() => {
      expect(viewedClimbUuids()).toEqual(['climb-1']);
    });
  });

  it('fires nothing when the provider re-renders without the climb changing', async () => {
    await renderWithQueue();

    // A queue mutation that leaves the current climb alone: the reducer spreads
    // fresh state through every consumer, so the provider re-renders and the
    // effect re-evaluates — but nothing new is drawn on the board.
    await act(async () => {
      await latest().addToQueue(makeQueueItem('item-4', 'climb-4'));
    });
    await waitFor(() => {
      expect(latest().state.queue.map((entry) => entry.uuid)).toContain('item-4');
    });
    expect(latest().state.currentClimbQueueItem?.uuid).toBe('item-2');
    expect(climbViewSession.markClimbViewed).not.toHaveBeenCalled();

    // Same for a navigation that finds nowhere to go: previousClimb at the head
    // dispatches nothing, so there is no change to report.
    act(() => {
      latest().previousClimb();
    });
    act(() => {
      latest().previousClimb();
    });
    await waitFor(() => {
      expect(latest().state.currentClimbQueueItem?.uuid).toBe('item-1');
    });
    expect(viewedClimbUuids()).toEqual(['climb-1']);
  });

  it('reports the board identity and the resolved render settings with the view', async () => {
    await renderWithQueue();

    act(() => {
      latest().nextClimb();
    });

    await waitFor(() => {
      expect(climbViewSession.markClimbViewed).toHaveBeenCalledOnce();
    });
    expect(climbViewSession.markClimbViewed).toHaveBeenCalledWith(
      'climb-3',
      expect.objectContaining({
        board_name: 'kilter',
        layout_id: 1,
        size_id: 10,
        render_mode: 'classic',
        glow_falloff: 'soft',
        glow_falloff_source: 'flag',
      }),
    );
  });

  it('fires a view for a previewed climb the queue never sees (the drawer latch)', async () => {
    await renderWithQueue();

    act(() => {
      latest().noteClimbViewed('climb-previewed');
    });

    expect(climbViewSession.markClimbViewed).toHaveBeenCalledExactlyOnceWith(
      'climb-previewed',
      expect.objectContaining({ board_name: 'kilter' }),
    );
  });

  describe('cold start, before the renderer capability probe answers', () => {
    beforeEach(() => {
      // This climber has never chosen a mode, so they get the app default — the
      // Boardsesh drawing — and the resolved mode genuinely depends on whether
      // the installed library can draw it.
      boardRenderSettingsState.mode = 'default';
      renderFlags.values = { 'board-glow-falloff': 'plateau' };
    });

    it('defers the view rather than labelling it classic', async () => {
      await renderWithQueue();

      act(() => {
        latest().nextClimb();
      });

      await waitFor(() => {
        expect(latest().state.currentClimbQueueItem?.uuid).toBe('item-3');
      });
      expect(climbViewSession.markClimbViewed).not.toHaveBeenCalled();
    });

    it('fires the deferred view once, with the resolved mode, when the probe answers', async () => {
      await renderWithQueue();

      act(() => {
        latest().nextClimb();
      });
      await waitFor(() => {
        expect(latest().state.currentClimbQueueItem?.uuid).toBe('item-3');
      });

      act(() => {
        setBoardseshRendererSupport(true);
      });

      await waitFor(() => {
        expect(climbViewSession.markClimbViewed).toHaveBeenCalledOnce();
      });
      expect(climbViewSession.markClimbViewed).toHaveBeenCalledWith(
        'climb-3',
        expect.objectContaining({ render_mode: 'boardsesh', glow_falloff: 'plateau' }),
      );
    });

    it('resolves to classic — once — when the installed library cannot draw the mode', async () => {
      await renderWithQueue();

      act(() => {
        latest().nextClimb();
      });
      await waitFor(() => {
        expect(latest().state.currentClimbQueueItem?.uuid).toBe('item-3');
      });

      act(() => {
        setBoardseshRendererSupport(false);
      });

      await waitFor(() => {
        expect(climbViewSession.markClimbViewed).toHaveBeenCalledOnce();
      });
      expect(climbViewSession.markClimbViewed).toHaveBeenCalledWith(
        'climb-3',
        expect.objectContaining({ render_mode: 'classic' }),
      );
    });

    it('also waits on the climber own stored settings loading', async () => {
      // Settings still in flight: a stored `boardsesh` would read as `default`
      // and mislabel the view exactly the same way an unanswered probe does.
      boardRenderSettingsState.loaded = false;
      boardRenderSettingsState.mode = 'classic';
      renderFlags.values = { 'board-glow-falloff': 'soft' };
      setBoardseshRendererSupport(true);

      queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue({
        queue: THREE_ITEM_QUEUE,
        currentClimbQueueItem: THREE_ITEM_QUEUE[1],
        playlistSuggestionSource: null,
        savedAt: '2026-08-27T00:00:00.000Z',
      });
      renderProvider();
      await waitFor(() => {
        expect(latest().state.currentClimbQueueItem?.uuid).toBe('item-2');
      });
      expect(climbViewSession.markClimbViewed).not.toHaveBeenCalled();
    });

    it('fires the deferred view once, with the resolved mode, once the climber settings finish loading', async () => {
      // Same setup as above: support already resolved, only the climber's
      // stored settings are still pending.
      boardRenderSettingsState.loaded = false;
      boardRenderSettingsState.mode = 'classic';
      renderFlags.values = { 'board-glow-falloff': 'soft' };
      setBoardseshRendererSupport(true);

      queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue({
        queue: THREE_ITEM_QUEUE,
        currentClimbQueueItem: THREE_ITEM_QUEUE[1],
        playlistSuggestionSource: null,
        savedAt: '2026-08-27T00:00:00.000Z',
      });
      const { rerender } = renderProvider();
      await waitFor(() => {
        expect(latest().state.currentClimbQueueItem?.uuid).toBe('item-2');
      });
      expect(climbViewSession.markClimbViewed).not.toHaveBeenCalled();

      // The settings store answers. Nothing subscribes queue-provider to this
      // mock the way `setBoardseshRendererSupport` does for the probe, so a
      // rerender is what stands in for the real hook re-evaluating.
      act(() => {
        boardRenderSettingsState.loaded = true;
        rerender(
          createElement(QueueProvider, null, createElement(Probe, { onSnapshot: (s: Snapshot) => snapshots.push(s) })),
        );
      });

      await waitFor(() => {
        expect(climbViewSession.markClimbViewed).toHaveBeenCalledOnce();
      });
      expect(climbViewSession.markClimbViewed).toHaveBeenCalledWith(
        'climb-2',
        expect.objectContaining({ render_mode: 'classic', glow_falloff: 'soft' }),
      );
    });
  });
});
