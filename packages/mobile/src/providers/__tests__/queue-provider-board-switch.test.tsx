// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react';
import { createElement, useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Climb, ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';

// Issue #5099: after the climber switches boards, the held suggestion source
// still belongs to the board they left. `next` kept walking that board's list —
// drawing nothing, lighting nothing, and (because a committed peek is APPENDED)
// leaving a foreign-board climb in the queue on every swipe.
//
// This harness drives the active board through a real external store so a board
// switch re-renders the provider the way the ['activeBoard'] query does, and
// stubs the continuation feed so the re-anchor is deterministic.

const ws = vi.hoisted(() => ({
  client: {
    on: vi.fn(() => vi.fn()),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

const graph = vi.hoisted(() => ({ execute: vi.fn() }));
const http = vi.hoisted(() => ({ request: vi.fn() }));

const boards = vi.hoisted(() => {
  const base = {
    uuid: 'board-kilter',
    slug: 'board-kilter',
    ownerId: 'owner-1',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,2',
    name: 'Kilter board',
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
  };
  return {
    kilter: base,
    kilterTilted: { ...base, angle: 25 },
    kilterOtherSize: { ...base, uuid: 'board-kilter-big', sizeId: 11 },
    tension: {
      ...base,
      uuid: 'board-tension',
      slug: 'board-tension',
      boardType: 'tension',
      layoutId: 8,
      sizeId: 20,
      setIds: '3',
      name: 'Tension board',
    },
  };
});

// Reactive active board: the provider reads it through useSyncExternalStore so a
// switch re-renders exactly like a React Query cache write would.
const activeBoardStore = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  // One frozen snapshot object, replaced on write, so useSyncExternalStore sees a
  // stable reference between changes.
  const state = { snapshot: { board: null as unknown, isPending: false } };
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => state.snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (board: unknown) => {
      state.snapshot = { ...state.snapshot, board };
      notify();
    },
    setPending: (isPending: boolean) => {
      state.snapshot = { ...state.snapshot, isPending };
      notify();
    },
  };
});

// Stands in for the board-scoped popular feed the provider re-anchors onto.
// Records the `enabled` argument so the "only armed while a source is off-board"
// gate is checked rather than assumed.
const continuationFeed = vi.hoisted(() => ({
  climbs: [] as unknown[],
  /** Mirrors the real hook: false only while an armed query is still in flight. */
  isSettled: true,
  enabledCalls: [] as boolean[],
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

const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
const analytics = vi.hoisted(() => ({ track: vi.fn() }));

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
vi.mock('../../lib/active-board-store', () => ({
  getStoredActiveBoard: async () => activeBoardStore.getSnapshot().board,
}));
vi.mock('../../lib/graphql/use-active-board', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useActiveBoard: () => {
      const { board, isPending } = useSyncExternalStore(activeBoardStore.subscribe, activeBoardStore.getSnapshot);
      return { data: board, isPending };
    },
    useSetActiveBoard: () => async () => {},
  };
});
vi.mock('../../lib/graphql/client', () => ({ getHttpClient: () => ({ request: http.request }) }));
vi.mock('../../lib/analytics', () => ({ track: analytics.track, registerRenderSuperProperties: vi.fn() }));
vi.mock('../../lib/error-reporting', () => ({ reportError: vi.fn(), reportHandledError: vi.fn() }));
vi.mock('../toast-provider', () => ({ useToast: () => ({ showToast: toast.showToast }) }));
vi.mock('../queue-snackbar-provider', () => ({ useQueueSnackbar: () => ({ showQueueAddedSnackbar: vi.fn() }) }));
vi.mock('../queue/use-cross-board-add-gate', () => ({
  useCrossBoardAddGate: () => async () => ({ outcome: 'add' }),
}));
vi.mock('../party-profile-provider', () => ({
  usePartyProfile: () => ({ username: undefined, avatarUrl: undefined }),
}));
vi.mock('../queue/use-board-continuation-feed', () => ({
  useBoardContinuationFeed: (_board: unknown, enabled: boolean) => {
    continuationFeed.enabledCalls.push(enabled);
    return { climbs: enabled ? continuationFeed.climbs : [], isSettled: !enabled || continuationFeed.isSettled };
  },
}));

import { QueueProvider, usePlaylistSuggestionSource, useQueue } from '../queue-provider';

type Snapshot = {
  state: ReturnType<typeof useQueue>['state'];
  playlistSuggestionSource: PlaylistSuggestionSource | null;
  setCurrentClimb: ReturnType<typeof useQueue>['setCurrentClimb'];
  nextClimb: ReturnType<typeof useQueue>['nextClimb'];
  previousClimb: ReturnType<typeof useQueue>['previousClimb'];
};

function Probe({ onSnapshot }: { onSnapshot: (snapshot: Snapshot) => void }) {
  const queue = useQueue();
  const playlistSuggestionSource = usePlaylistSuggestionSource();
  useEffect(() => {
    onSnapshot({
      state: queue.state,
      playlistSuggestionSource,
      setCurrentClimb: queue.setCurrentClimb,
      nextClimb: queue.nextClimb,
      previousClimb: queue.previousClimb,
    });
  }, [queue.state, playlistSuggestionSource, queue.setCurrentClimb, queue.nextClimb, queue.previousClimb, onSnapshot]);
  return null;
}

function makeClimb(uuid: string, boardType: string, layoutId: number): Climb {
  return {
    uuid,
    name: `Climb ${uuid}`,
    frames: 'p1r12',
    setter_username: 'setter',
    angle: 40,
    ascensionist_count: 0,
    difficulty: 'V3',
    quality_average: '3.0',
    stars: 3,
    difficulty_error: '0.3',
    benchmark_difficulty: null,
    boardType,
    layoutId,
  };
}

function makeItem(uuid: string, climb: Climb): ClimbQueueItem {
  return { uuid, climb, suggested: false };
}

const KILTER_BOARD_KEY = 'kilter:1:10:1,2';
const TENSION_BOARD_KEY = 'tension:8:20:3';

function kilterSource(climbs: Climb[], activatedClimb: Climb): PlaylistSuggestionSource {
  return {
    playlistUuid: 'climblist',
    activatedClimbUuid: activatedClimb.uuid,
    boardKey: KILTER_BOARD_KEY,
    climbs,
  };
}

describe('QueueProvider board switch (#5099)', () => {
  let snapshots: Snapshot[];

  const latest = () => {
    const snapshot = snapshots.at(-1);
    if (!snapshot) throw new Error('provider never rendered');
    return snapshot;
  };

  beforeEach(() => {
    snapshots = [];
    activeBoardStore.setPending(false);
    activeBoardStore.set(boards.kilter);
    continuationFeed.climbs = [];
    continuationFeed.isSettled = true;
    continuationFeed.enabledCalls = [];
    ws.client.on.mockClear();
    ws.client.subscribe.mockClear();
    for (const mutation of Object.values(queueMutations) as Array<ReturnType<typeof vi.fn>>) {
      mutation.mockReset();
      mutation.mockResolvedValue(undefined);
    }
    queueMutations.wasUuidExplicitlyRemoved.mockReset();
    queueMutations.wasUuidExplicitlyRemoved.mockReturnValue(false);
    sessionStore.getStoredSessionId.mockReset();
    sessionStore.getStoredSessionId.mockResolvedValue(null);
    queueSnapshotStore.getStoredQueueSnapshot.mockReset();
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue(null);
    queueSnapshotStore.setStoredQueueSnapshot.mockClear();
    toast.showToast.mockClear();
    analytics.track.mockClear();
    graph.execute.mockReset();
    http.request.mockReset();
  });

  function renderProvider() {
    return render(createElement(QueueProvider, null, createElement(Probe, { onSnapshot: (s) => snapshots.push(s) })));
  }

  /** Activate a kilter climb with a kilter-stamped suggestion source. */
  async function activateKilterBrowse() {
    const activatedClimb = makeClimb('kilter-current', 'kilter', 1);
    const nextKilterClimb = makeClimb('kilter-next', 'kilter', 1);
    renderProvider();
    await waitFor(() => expect(snapshots.length).toBeGreaterThan(0));
    act(() => {
      latest().setCurrentClimb(makeItem('item-kilter-current', activatedClimb), {
        playlistSuggestionSource: kilterSource([activatedClimb, nextKilterClimb], activatedClimb),
      });
    });
    await waitFor(() => expect(latest().playlistSuggestionSource?.boardKey).toBe(KILTER_BOARD_KEY));
    return { activatedClimb, nextKilterClimb };
  }

  it('masks a suggestion source stamped with the board the climber left', async () => {
    await activateKilterBrowse();

    act(() => activeBoardStore.set(boards.tension));

    await waitFor(() => expect(latest().playlistSuggestionSource).toBeNull());
  });

  it('restores the browsed list when the climber switches back before the feed lands', async () => {
    await activateKilterBrowse();
    // Feed deliberately empty: this is the window BEFORE the re-anchor replaces
    // the source, which is the only window in which masking restores anything.
    continuationFeed.climbs = [];

    act(() => activeBoardStore.set(boards.tension));
    await waitFor(() => expect(latest().playlistSuggestionSource).toBeNull());

    act(() => activeBoardStore.set(boards.kilter));
    await waitFor(() => expect(latest().playlistSuggestionSource?.playlistUuid).toBe('climblist'));
    expect(latest().playlistSuggestionSource?.boardKey).toBe(KILTER_BOARD_KEY);
  });

  it('comes back to the board feed, not the browsed list, once the re-anchor has run', async () => {
    // The honest limitation of one source slot: the re-anchor REPLACES the
    // climblist source, so a round trip that waits for the feed lands on the
    // board's popular list. Asserted so the trade-off can't drift unnoticed.
    await activateKilterBrowse();
    continuationFeed.climbs = [makeClimb('feed-1', 'tension', 8), makeClimb('feed-2', 'tension', 8)];

    act(() => activeBoardStore.set(boards.tension));
    await waitFor(() => expect(latest().playlistSuggestionSource?.boardKey).toBe(TENSION_BOARD_KEY));

    act(() => activeBoardStore.set(boards.kilter));
    await waitFor(() => expect(latest().playlistSuggestionSource?.boardKey).toBe(KILTER_BOARD_KEY));
    expect(latest().playlistSuggestionSource?.playlistUuid).toBe('board-feed');
  });

  it('holds the solo snapshot save until the active board query settles', async () => {
    // Every source masks out against an unresolved board, so a save that raced
    // the board read would persist a null source for the wrong reason.
    activeBoardStore.setPending(true);
    const kilterClimb = makeClimb('kilter-stored', 'kilter', 1);
    const storedItem = makeItem('item-kilter-stored', kilterClimb);
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue({
      queue: [storedItem],
      currentClimbQueueItem: storedItem,
      playlistSuggestionSource: kilterSource([kilterClimb], kilterClimb),
      savedAt: '2026-06-10T00:00:00.000Z',
    });

    renderProvider();
    await waitFor(() => expect(latest().state.queue).toHaveLength(1));
    // Comfortably past the 500ms save debounce.
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(queueSnapshotStore.setStoredQueueSnapshot).not.toHaveBeenCalled();

    act(() => activeBoardStore.setPending(false));

    await waitFor(() => expect(queueSnapshotStore.setStoredQueueSnapshot).toHaveBeenCalled());
  });

  it('keeps the source across an angle-only change', async () => {
    await activateKilterBrowse();

    act(() => activeBoardStore.set(boards.kilterTilted));

    await waitFor(() => expect(latest().state.queue).toHaveLength(1));
    expect(latest().playlistSuggestionSource?.boardKey).toBe(KILTER_BOARD_KEY);
  });

  it('retires the source when the size changes on the same layout', async () => {
    await activateKilterBrowse();

    act(() => activeBoardStore.set(boards.kilterOtherSize));

    await waitFor(() => expect(latest().playlistSuggestionSource).toBeNull());
  });

  it('arms the continuation feed only while a held source is off-board', async () => {
    await activateKilterBrowse();
    expect(continuationFeed.enabledCalls.every((enabled) => enabled === false)).toBe(true);

    act(() => activeBoardStore.set(boards.tension));

    await waitFor(() => expect(continuationFeed.enabledCalls.at(-1)).toBe(true));
  });

  it('does not append a foreign-board climb to the queue on the swipe after a switch', async () => {
    await activateKilterBrowse();
    act(() => activeBoardStore.set(boards.tension));
    await waitFor(() => expect(latest().playlistSuggestionSource).toBeNull());

    act(() => latest().nextClimb());

    // Before the fix this committed the stale source's next kilter climb and
    // appended it to the queue for good — one foreign item per swipe.
    await waitFor(() => expect(latest().state.queue).toHaveLength(1));
    expect(latest().state.currentClimbQueueItem?.climb.uuid).toBe('kilter-current');
  });

  it('re-anchors onto the new board feed so the next swipe lands on this board', async () => {
    await activateKilterBrowse();
    continuationFeed.climbs = [makeClimb('tension-1', 'tension', 8), makeClimb('tension-2', 'tension', 8)];

    act(() => activeBoardStore.set(boards.tension));
    await waitFor(() => expect(latest().playlistSuggestionSource?.boardKey).toBe(TENSION_BOARD_KEY));
    // The current (kilter) climb anchors the feed, or navigation would find
    // nothing after it and dead-end exactly as before.
    expect(latest().playlistSuggestionSource?.climbs.map((climb) => climb.uuid)).toEqual([
      'kilter-current',
      'tension-1',
      'tension-2',
    ]);

    act(() => latest().nextClimb());

    await waitFor(() => expect(latest().state.currentClimbQueueItem?.climb.uuid).toBe('tension-1'));
    expect(latest().state.queue.map((item) => item.climb.uuid)).toEqual(['kilter-current', 'tension-1']);
  });

  it('yields to a real activation that landed while the feed was in flight', async () => {
    await activateKilterBrowse();
    act(() => activeBoardStore.set(boards.tension));
    await waitFor(() => expect(latest().playlistSuggestionSource).toBeNull());

    const tensionClimb = makeClimb('tension-picked', 'tension', 8);
    act(() => {
      latest().setCurrentClimb(makeItem('item-tension-picked', tensionClimb), {
        playlistSuggestionSource: {
          playlistUuid: 'climblist',
          activatedClimbUuid: tensionClimb.uuid,
          boardKey: TENSION_BOARD_KEY,
          climbs: [tensionClimb],
        },
      });
    });
    await waitFor(() => expect(latest().playlistSuggestionSource?.playlistUuid).toBe('climblist'));

    // The feed resolves a beat later; the deliberate activation must survive it.
    continuationFeed.climbs = [makeClimb('tension-feed', 'tension', 8)];
    act(() => activeBoardStore.set({ ...boards.tension }));

    await waitFor(() => expect(latest().state.queue).toHaveLength(2));
    expect(latest().playlistSuggestionSource?.activatedClimbUuid).toBe('tension-picked');
  });

  it('drops a restored snapshot source that belongs to another board, keeping the queue', async () => {
    const kilterClimb = makeClimb('kilter-stored', 'kilter', 1);
    const storedItem = makeItem('item-kilter-stored', kilterClimb);
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue({
      queue: [storedItem],
      currentClimbQueueItem: storedItem,
      playlistSuggestionSource: kilterSource([kilterClimb], kilterClimb),
      savedAt: '2026-06-10T00:00:00.000Z',
    });
    activeBoardStore.set(boards.tension);

    renderProvider();

    await waitFor(() => expect(latest().state.queue.map((item) => item.uuid)).toEqual(['item-kilter-stored']));
    expect(latest().playlistSuggestionSource).toBeNull();
  });
});

describe('QueueProvider cross-board swipe skip (#5099)', () => {
  let snapshots: Snapshot[];
  const latest = () => {
    const snapshot = snapshots.at(-1);
    if (!snapshot) throw new Error('provider never rendered');
    return snapshot;
  };

  beforeEach(() => {
    snapshots = [];
    activeBoardStore.setPending(false);
    activeBoardStore.set(boards.tension);
    continuationFeed.climbs = [];
    continuationFeed.isSettled = true;
    continuationFeed.enabledCalls = [];
    for (const mutation of Object.values(queueMutations) as Array<ReturnType<typeof vi.fn>>) {
      mutation.mockReset();
      mutation.mockResolvedValue(undefined);
    }
    queueMutations.wasUuidExplicitlyRemoved.mockReset();
    queueMutations.wasUuidExplicitlyRemoved.mockReturnValue(false);
    sessionStore.getStoredSessionId.mockReset();
    sessionStore.getStoredSessionId.mockResolvedValue(null);
    queueSnapshotStore.getStoredQueueSnapshot.mockReset();
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue(null);
    toast.showToast.mockClear();
    analytics.track.mockClear();
    graph.execute.mockReset();
    http.request.mockReset();
  });

  it('walks past queued climbs this board cannot draw and says how many', async () => {
    const tensionCurrent = makeClimb('tension-current', 'tension', 8);
    const tensionLater = makeClimb('tension-later', 'tension', 8);
    const storedQueue = [
      makeItem('item-tension-current', tensionCurrent),
      makeItem('item-kilter-a', makeClimb('kilter-a', 'kilter', 1)),
      makeItem('item-kilter-b', makeClimb('kilter-b', 'kilter', 1)),
      makeItem('item-tension-later', tensionLater),
    ];
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue({
      queue: storedQueue,
      currentClimbQueueItem: storedQueue[0],
      playlistSuggestionSource: null,
      savedAt: '2026-06-10T00:00:00.000Z',
    });

    render(createElement(QueueProvider, null, createElement(Probe, { onSnapshot: (s) => snapshots.push(s) })));
    await waitFor(() => expect(latest().state.queue).toHaveLength(4));

    act(() => latest().nextClimb());

    await waitFor(() => expect(latest().state.currentClimbQueueItem?.uuid).toBe('item-tension-later'));
    // The skipped climbs stay in the queue — they are still reachable by tapping
    // them in the queue sheet, they just stop being swipe targets.
    expect(latest().state.queue).toHaveLength(4);
    expect(toast.showToast).toHaveBeenCalledWith('boardConfigMismatch.skippedOnBoardSwitchToast', 'info');
    expect(analytics.track).toHaveBeenCalledWith(
      'Queue Climb Skipped on Board Switch',
      expect.objectContaining({
        skippedCount: 2,
        skippedClimbUuid: 'kilter-a',
        advancedToClimbUuid: 'tension-later',
        advancedToSuggestion: false,
        inSession: false,
      }),
    );
  });

  it('reports one notice per skip run, not one per repeated swipe', async () => {
    const storedQueue = [
      makeItem('item-tension-current', makeClimb('tension-current', 'tension', 8)),
      makeItem('item-kilter-a', makeClimb('kilter-a', 'kilter', 1)),
      makeItem('item-tension-later', makeClimb('tension-later', 'tension', 8)),
    ];
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue({
      queue: storedQueue,
      currentClimbQueueItem: storedQueue[0],
      playlistSuggestionSource: null,
      savedAt: '2026-06-10T00:00:00.000Z',
    });

    render(createElement(QueueProvider, null, createElement(Probe, { onSnapshot: (s) => snapshots.push(s) })));
    await waitFor(() => expect(latest().state.queue).toHaveLength(3));

    // Both calls read the same pre-dispatch state, exactly like a held swipe.
    act(() => {
      latest().nextClimb();
      latest().nextClimb();
    });

    expect(toast.showToast).toHaveBeenCalledTimes(1);
    expect(toast.showToast).toHaveBeenCalledWith('boardConfigMismatch.skippedOnBoardSwitchToast', 'info');
  });

  it('re-arms the notice after the climber swipes away and back', async () => {
    const storedQueue = [
      makeItem('item-tension-first', makeClimb('tension-first', 'tension', 8)),
      makeItem('item-kilter-a', makeClimb('kilter-a', 'kilter', 1)),
      makeItem('item-tension-later', makeClimb('tension-later', 'tension', 8)),
    ];
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue({
      queue: storedQueue,
      currentClimbQueueItem: storedQueue[0],
      playlistSuggestionSource: null,
      savedAt: '2026-06-10T00:00:00.000Z',
    });

    render(createElement(QueueProvider, null, createElement(Probe, { onSnapshot: (s) => snapshots.push(s) })));
    await waitFor(() => expect(latest().state.queue).toHaveLength(3));

    act(() => latest().nextClimb());
    await waitFor(() => expect(latest().state.currentClimbQueueItem?.uuid).toBe('item-tension-later'));
    act(() => latest().previousClimb());
    await waitFor(() => expect(latest().state.currentClimbQueueItem?.uuid).toBe('item-kilter-a'));
    act(() => latest().previousClimb());
    await waitFor(() => expect(latest().state.currentClimbQueueItem?.uuid).toBe('item-tension-first'));

    act(() => latest().nextClimb());

    // A latch keyed on the item swiped away FROM would have gone silent here.
    await waitFor(() => expect(toast.showToast).toHaveBeenCalledTimes(2));
  });

  it('tells the climber why the swipe is dead when nothing left is on this board', async () => {
    // Every remaining climb is off-board and there is no feed, so canNext is
    // false: the gesture and the Next button are both disabled and no swipe can
    // ever report this. The state notice is the only way the climber hears it.
    const storedQueue = [
      makeItem('item-tension-current', makeClimb('tension-current', 'tension', 8)),
      makeItem('item-kilter-a', makeClimb('kilter-a', 'kilter', 1)),
      makeItem('item-kilter-b', makeClimb('kilter-b', 'kilter', 1)),
    ];
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue({
      queue: storedQueue,
      currentClimbQueueItem: storedQueue[0],
      playlistSuggestionSource: null,
      savedAt: '2026-06-10T00:00:00.000Z',
    });

    render(createElement(QueueProvider, null, createElement(Probe, { onSnapshot: (s) => snapshots.push(s) })));

    await waitFor(() => expect(toast.showToast).toHaveBeenCalledWith('boardConfigMismatch.queueOffBoardToast', 'info'));
    expect(analytics.track).toHaveBeenCalledWith(
      'Queue Climb Skipped on Board Switch',
      expect.objectContaining({ trigger: 'queue_dead_end', skippedCount: 2, advancedToClimbUuid: null }),
    );
    // Said once, not once per render.
    expect(toast.showToast).toHaveBeenCalledTimes(1);
  });

  it('stays quiet about a dead end while the re-anchor feed is still loading', async () => {
    const kilterClimb = makeClimb('kilter-current', 'kilter', 1);
    const storedQueue = [
      makeItem('item-kilter-current', kilterClimb),
      makeItem('item-kilter-a', makeClimb('kilter-a', 'kilter', 1)),
    ];
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue({
      queue: storedQueue,
      currentClimbQueueItem: storedQueue[0],
      playlistSuggestionSource: {
        playlistUuid: 'climblist',
        activatedClimbUuid: kilterClimb.uuid,
        boardKey: KILTER_BOARD_KEY,
        climbs: [kilterClimb],
      },
      savedAt: '2026-06-10T00:00:00.000Z',
    });
    continuationFeed.isSettled = false;

    render(createElement(QueueProvider, null, createElement(Probe, { onSnapshot: (s) => snapshots.push(s) })));
    await waitFor(() => expect(latest().state.queue).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Announcing a dead end mid-fetch would be contradicted the moment the feed
    // lands and re-anchors.
    expect(toast.showToast).not.toHaveBeenCalled();
  });
});
