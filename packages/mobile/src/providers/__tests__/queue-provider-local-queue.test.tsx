// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react';
import { createElement, useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';
import { MAX_SYNCED_QUEUE_ITEMS } from '@boardsesh/queue';
import type { ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';

// Self-contained QueueProvider harness for the LOCAL solo queue model: no
// session is ever created lazily (mutations are local-only no-ops without a
// session), the solo queue persists via queue-snapshot-store, and the explicit
// Start path seeds the freshly created session with the locally-built queue.

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
  addQueueItem: vi.fn(async (_item: ClimbQueueItem, _position?: number) => {}),
  removeQueueItem: vi.fn(async () => {}),
  reorderQueueItem: vi.fn(async () => {}),
  setCurrentClimb: vi.fn(async () => {}),
  mirrorCurrentClimb: vi.fn(async () => {}),
  publishPlaybackState: vi.fn(async () => {}),
  // Typed args so tests can assert the wire payload (queue + current) directly.
  setQueue: vi.fn(async (_queue: ClimbQueueItem[], _currentClimbQueueItem?: ClimbQueueItem) => {}),
  replaceQueueItem: vi.fn(async () => {}),
  reportWallDisconnect: vi.fn(async () => {}),
  confirmClimbOnWall: vi.fn(async () => {}),
  setSessionBoardSerial: vi.fn(async () => {}),
  setSessionBoardPath: vi.fn(async () => {}),
  // Synchronous read of the shared factory's removal ledger (#4009). Nothing
  // here removes a climb mid-recovery, so the honest default is "not dropped by
  // the climber" — but the member has to exist or the provider's recovery path
  // would call undefined.
  wasUuidExplicitlyRemoved: vi.fn((_uuid: string) => false),
}));

// Capture the deps mobile passes into the shared useQueueMutations so the
// REAL ensureReady seam (the no-lazy-create contract) is testable directly.
type CapturedMutationDeps = {
  getSessionId: () => string | null;
  getQueuePosition: (uuid: string) => number;
  ensureReady?: (capturedSessionId: string | null) => Promise<string | null>;
};
const capturedMutationDeps = vi.hoisted(() => ({ current: null as CapturedMutationDeps | null }));

const sessionStore = vi.hoisted(() => ({
  getStoredSessionId: vi.fn(async (): Promise<string | null> => null),
  setStoredSessionId: vi.fn(async () => {}),
  clearStoredSessionId: vi.fn(async () => {}),
  // Device provenance for the leave-vs-end emphasis (#3502).
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

const errorReporter = vi.hoisted(() => ({
  reportError: vi.fn(),
  reportHandledError: vi.fn(),
}));

const toast = vi.hoisted(() => ({
  showToast: vi.fn(),
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
vi.mock('@boardsesh/queue-react', () => ({
  useQueueMutations: (deps: CapturedMutationDeps) => {
    capturedMutationDeps.current = deps;
    return queueMutations;
  },
}));
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
vi.mock('../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../lib/error-reporting', () => ({
  reportError: errorReporter.reportError,
  reportHandledError: errorReporter.reportHandledError,
}));
vi.mock('../toast-provider', () => ({ useToast: () => ({ showToast: toast.showToast }) }));
vi.mock('../queue-snackbar-provider', () => ({ useQueueSnackbar: () => ({ showQueueAddedSnackbar: vi.fn() }) }));
// The cross-board add gate calls useChoose()/useQueryClient()/expo-router, none of
// which this harness mounts. Pass every add straight through — the gate's own
// behaviour is covered by queue-provider-cross-board-add.test.tsx.
vi.mock('../queue/use-cross-board-add-gate', () => ({
  useCrossBoardAddGate: () => async () => ({ outcome: 'add' }),
}));
vi.mock('../party-profile-provider', () => ({
  usePartyProfile: () => ({ username: undefined, avatarUrl: undefined }),
}));

import { QueueProvider, usePlaylistSuggestionSource, useQueue } from '../queue-provider';

type Snapshot = {
  state: ReturnType<typeof useQueue>['state'];
  sessionId: string | null;
  playlistSuggestionSource: PlaylistSuggestionSource | null;
  addToQueue: ReturnType<typeof useQueue>['addToQueue'];
  setCurrentClimb: ReturnType<typeof useQueue>['setCurrentClimb'];
  appendQueueItems: ReturnType<typeof useQueue>['appendQueueItems'];
  startSession: ReturnType<typeof useQueue>['startSession'];
  joinSession: ReturnType<typeof useQueue>['joinSession'];
};

function Probe({ onSnapshot }: { onSnapshot: (snapshot: Snapshot) => void }) {
  const queue = useQueue();
  const playlistSuggestionSource = usePlaylistSuggestionSource();
  useEffect(() => {
    onSnapshot({
      state: queue.state,
      sessionId: queue.sessionId,
      playlistSuggestionSource,
      addToQueue: queue.addToQueue,
      setCurrentClimb: queue.setCurrentClimb,
      appendQueueItems: queue.appendQueueItems,
      startSession: queue.startSession,
      joinSession: queue.joinSession,
    });
  }, [
    queue.state,
    queue.sessionId,
    playlistSuggestionSource,
    queue.addToQueue,
    queue.setCurrentClimb,
    queue.appendQueueItems,
    queue.startSession,
    queue.joinSession,
    onSnapshot,
  ]);
  return null;
}

function renderProvider(onSnapshot: (snapshot: Snapshot) => void) {
  return render(createElement(QueueProvider, null, createElement(Probe, { onSnapshot })));
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

const storedSnapshot = (items: ClimbQueueItem[], current: ClimbQueueItem | null): StoredSnapshot => ({
  queue: items,
  currentClimbQueueItem: current,
  playlistSuggestionSource: null,
  savedAt: '2026-06-10T00:00:00.000Z',
});

describe('QueueProvider local solo queue', () => {
  beforeEach(() => {
    ws.client.on.mockClear();
    ws.client.subscribe.mockClear();
    capturedMutationDeps.current = null;
    activeBoard.getStoredActiveBoard.mockReset();
    activeBoard.getStoredActiveBoard.mockResolvedValue(activeBoard.stored);
    for (const mutation of Object.values(queueMutations) as Array<ReturnType<typeof vi.fn>>) {
      mutation.mockReset();
      mutation.mockResolvedValue(undefined);
    }
    // The blanket reset above hands every action a resolved promise, which for a
    // SYNCHRONOUS boolean action is truthy — i.e. "the climber removed it"
    // everywhere. Restore the real default.
    queueMutations.wasUuidExplicitlyRemoved.mockReset();
    queueMutations.wasUuidExplicitlyRemoved.mockReturnValue(false);
    sessionStore.getStoredSessionId.mockReset();
    sessionStore.getStoredSessionId.mockResolvedValue(null);
    sessionStore.setStoredSessionId.mockClear();
    sessionStore.clearStoredSessionId.mockClear();
    queueSnapshotStore.getStoredQueueSnapshot.mockReset();
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue(null);
    queueSnapshotStore.setStoredQueueSnapshot.mockClear();
    queueSnapshotStore.clearStoredQueueSnapshot.mockClear();
    errorReporter.reportError.mockClear();
    toast.showToast.mockClear();
    graph.execute.mockReset();
    graph.execute.mockResolvedValue({
      joinSession: {
        participantId: 'participant-self',
        clientId: 'client-self',
        isLeader: true,
        lastConnectedBoardSerial: null,
        boardPath: '/kilter/1/10/1,2/40/list',
        users: [],
      },
    });
    http.request.mockReset();
    http.request.mockResolvedValue({ createSession: { id: 'session-new' } });
  });

  it('hydrates the stored solo queue snapshot when no session restores', async () => {
    const item = makeQueueItem('stored-item', 'stored-climb');
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue(storedSnapshot([item], item));

    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue.map((entry) => entry.uuid)).toEqual(['stored-item']);
      expect(snapshots.at(-1)?.state.currentClimbQueueItem?.uuid).toBe('stored-item');
    });
    expect(snapshots.at(-1)?.sessionId).toBeNull();
    // No session restore, no join, no creation — the queue is purely local.
    expect(graph.execute).not.toHaveBeenCalled();
    expect(http.request).not.toHaveBeenCalled();
  });

  it('skips the local snapshot when a stored session restores (server queue wins)', async () => {
    sessionStore.getStoredSessionId.mockResolvedValue('session-1');
    http.request.mockImplementation((operation: string) =>
      operation.includes('SessionStatus')
        ? Promise.resolve({ sessionStatus: 'active' })
        : Promise.resolve({ createSession: { id: 'session-new' } }),
    );
    const item = makeQueueItem('stale-item');
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue(storedSnapshot([item], item));

    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    });
    // The session's FullSync owns the queue; the stale local snapshot must not
    // leak into it.
    expect(snapshots.at(-1)?.state.queue).toEqual([]);
  });

  it('never creates a session from queue mutations (ensureReady contract)', async () => {
    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));
    await waitFor(() => {
      expect(capturedMutationDeps.current).not.toBeNull();
      expect(snapshots.length).toBeGreaterThan(0);
    });

    const deps = capturedMutationDeps.current;
    if (!deps?.ensureReady) throw new Error('mutation deps were not captured');

    // No session: the seam resolves null (silent local-only no-op) without
    // touching the network.
    await expect(deps.ensureReady(null)).resolves.toBeNull();
    expect(http.request).not.toHaveBeenCalled();
    expect(graph.execute).not.toHaveBeenCalled();

    // Local mutations still apply to the reducer.
    act(() => {
      snapshots.at(-1)?.setCurrentClimb(makeQueueItem('local-item'));
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.currentClimbQueueItem?.uuid).toBe('local-item');
    });
    expect(snapshots.at(-1)?.sessionId).toBeNull();
    expect(http.request).not.toHaveBeenCalled();
  });

  it('inserts an activated new climb right after the current climb, not at the end (issue #2217)', async () => {
    const itemA = makeQueueItem('item-a');
    const itemB = makeQueueItem('item-b');
    const itemC = makeQueueItem('item-c');
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue(storedSnapshot([itemA, itemB, itemC], itemA));

    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue.map((entry) => entry.uuid)).toEqual(['item-a', 'item-b', 'item-c']);
      expect(snapshots.at(-1)?.state.currentClimbQueueItem?.uuid).toBe('item-a');
    });

    act(() => {
      snapshots.at(-1)?.setCurrentClimb(makeQueueItem('item-x'));
    });

    // The freshly activated climb slots in right after the current climb (A),
    // pushing A into history — it is NOT appended after C.
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue.map((entry) => entry.uuid)).toEqual([
        'item-a',
        'item-x',
        'item-b',
        'item-c',
      ]);
      expect(snapshots.at(-1)?.state.currentClimbQueueItem?.uuid).toBe('item-x');
    });
  });

  // The wiring typecheck cannot see: wrong ref, wrong field, inverted return.
  // A deferred queue-add (a superseded or throttled-away activation) positions
  // itself with this, so a broken binding silently reverts #3936 to appending.
  it('exposes the live local queue index to the shared mutations (getQueuePosition)', async () => {
    const itemA = makeQueueItem('item-a');
    const itemB = makeQueueItem('item-b');
    const itemC = makeQueueItem('item-c');
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue(storedSnapshot([itemA, itemB, itemC], itemA));

    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(capturedMutationDeps.current).not.toBeNull();
      expect(snapshots.at(-1)?.state.queue.map((entry) => entry.uuid)).toEqual(['item-a', 'item-b', 'item-c']);
    });
    const deps = capturedMutationDeps.current;
    if (!deps) throw new Error('mutation deps were not captured');

    expect(deps.getQueuePosition('item-a')).toBe(0);
    expect(deps.getQueuePosition('item-c')).toBe(2);
    expect(deps.getQueuePosition('never-queued')).toBe(-1);

    // Reads the LIVE reducer state, not a mount-time snapshot: activating a new
    // climb slots it in after the current one, and the index follows.
    act(() => {
      snapshots.at(-1)?.setCurrentClimb(makeQueueItem('item-x'));
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue.map((entry) => entry.uuid)).toEqual([
        'item-a',
        'item-x',
        'item-b',
        'item-c',
      ]);
    });
    expect(deps.getQueuePosition('item-x')).toBe(1);
    expect(deps.getQueuePosition('item-c')).toBe(3);
  });

  it('persists the solo queue after mutations (debounced)', async () => {
    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));
    await waitFor(() => {
      expect(snapshots.length).toBeGreaterThan(0);
    });
    // Let the cold-start hydrate settle so the save gate opens.
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      snapshots.at(-1)?.addToQueue(makeQueueItem('persisted-item'));
    });

    await waitFor(
      () => {
        expect(queueSnapshotStore.setStoredQueueSnapshot).toHaveBeenCalled();
      },
      { timeout: 3000 },
    );
    const lastCall = queueSnapshotStore.setStoredQueueSnapshot.mock.calls.at(-1) as unknown as [
      { queue: ClimbQueueItem[] },
    ];
    expect(lastCall[0].queue.map((entry) => entry.uuid)).toContain('persisted-item');
  });

  it('seeds the freshly started session with the local queue before exposing it', async () => {
    const callOrder: string[] = [];
    http.request.mockImplementation(async (operation: string) => {
      if (operation.includes('CreateSession') || operation.includes('createSession')) {
        callOrder.push('create');
        return { createSession: { id: 'session-new' } };
      }
      return { sessionStatus: null };
    });
    graph.execute.mockImplementation(async () => {
      callOrder.push('join');
      return {
        joinSession: {
          participantId: 'participant-self',
          clientId: 'client-self',
          isLeader: true,
          lastConnectedBoardSerial: null,
          boardPath: '/kilter/1/10/1,2/40/list',
          users: [],
        },
      };
    });
    queueMutations.setQueue.mockImplementation(async () => {
      callOrder.push('setQueue');
    });
    queueSnapshotStore.clearStoredQueueSnapshot.mockImplementation(async () => {
      callOrder.push('clearSnapshot');
    });

    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));
    await waitFor(() => {
      expect(snapshots.length).toBeGreaterThan(0);
    });

    const item = makeQueueItem('pre-session-item');
    act(() => {
      snapshots.at(-1)?.setCurrentClimb(item);
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.currentClimbQueueItem?.uuid).toBe('pre-session-item');
    });

    await act(async () => {
      await expect(snapshots.at(-1)?.startSession()).resolves.toBe('session-new');
    });

    // Create → join → seed → drop the local snapshot, strictly in that order:
    // seeding must complete before the queueUpdates subscription mounts, or the
    // empty room's FullSync would wipe the local queue.
    expect(callOrder.slice(0, 4)).toEqual(['create', 'join', 'setQueue', 'clearSnapshot']);
    const setQueueCall = queueMutations.setQueue.mock.calls.at(-1) as unknown as [ClimbQueueItem[], ClimbQueueItem];
    expect(setQueueCall[0].map((entry) => entry.uuid)).toContain('pre-session-item');
    expect(setQueueCall[1]?.uuid).toBe('pre-session-item');
    expect(sessionStore.setStoredSessionId).toHaveBeenCalledWith('session-new');
    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-new');
    });
  });

  it('starting with an empty queue skips seeding entirely', async () => {
    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));
    await waitFor(() => {
      expect(snapshots.length).toBeGreaterThan(0);
    });

    await act(async () => {
      await expect(snapshots.at(-1)?.startSession()).resolves.toBe('session-new');
    });

    expect(queueMutations.setQueue).not.toHaveBeenCalled();
    expect(sessionStore.setStoredSessionId).toHaveBeenCalledWith('session-new');
  });

  it('does not report createSession rate limits to error reporting', async () => {
    http.request.mockRejectedValueOnce({
      response: {
        status: 200,
        errors: [
          {
            message: 'Rate limit exceeded. Try again in 7 seconds.',
            extensions: { code: 'RATE_LIMITED', operation: 'createSession', retryAfterSeconds: 7 },
          },
        ],
      },
    });

    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));
    await waitFor(() => {
      expect(snapshots.length).toBeGreaterThan(0);
    });

    await act(async () => {
      await expect(snapshots.at(-1)?.startSession()).resolves.toBeNull();
    });

    expect(toast.showToast).toHaveBeenCalledWith('mobile.queue.rateLimited', 'error');
    expect(toast.showToast).not.toHaveBeenCalledWith('mobile.queue.sessionCreateError', 'error');
    expect(errorReporter.reportError).not.toHaveBeenCalled();
    expect(sessionStore.setStoredSessionId).not.toHaveBeenCalled();
    expect(graph.execute).not.toHaveBeenCalled();
  });

  it('joinSession persists the id and drops the solo snapshot', async () => {
    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));
    await waitFor(() => {
      expect(snapshots.length).toBeGreaterThan(0);
    });

    await act(async () => {
      await snapshots.at(-1)?.joinSession('session-2', {
        boardPath: '/kilter/1/10/1,2/40/list',
        userBoard: activeBoard.stored,
      });
    });

    expect(sessionStore.setStoredSessionId).toHaveBeenCalledWith('session-2');
    expect(queueSnapshotStore.clearStoredQueueSnapshot).toHaveBeenCalled();
  });

  it('appendQueueItems keeps the current climb and the hand-queued climbs around it', async () => {
    // Mid-project: working "item-b", with "item-c" queued up next by hand.
    const itemA = makeQueueItem('item-a');
    const itemB = makeQueueItem('item-b');
    const itemC = makeQueueItem('item-c');
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue(storedSnapshot([itemA, itemB, itemC], itemB));

    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.currentClimbQueueItem?.uuid).toBe('item-b');
    });

    act(() => {
      snapshots.at(-1)?.appendQueueItems([makeQueueItem('gen-1'), makeQueueItem('gen-2')]);
    });

    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue.map((entry) => entry.uuid)).toEqual([
        'item-a',
        'item-b',
        'item-c',
        'gen-1',
        'gen-2',
      ]);
    });
    // The pointer never moves, so the BLE auto-sender has nothing to react to and
    // the wall stays on the climb the user is actually projecting.
    expect(snapshots.at(-1)?.state.currentClimbQueueItem?.uuid).toBe('item-b');
    // "item-c" was queued by hand before generating and must survive.
    expect(snapshots.at(-1)?.state.queue.map((entry) => entry.uuid)).toContain('item-c');
  });

  it('appendQueueItems leaves the current pointer null by default when nothing is current', async () => {
    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));
    await waitFor(() => {
      expect(snapshots.length).toBeGreaterThan(0);
    });

    queueMutations.setQueue.mockClear();
    act(() => {
      snapshots.at(-1)?.appendQueueItems([makeQueueItem('gen-1'), makeQueueItem('gen-2')]);
    });

    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue.map((entry) => entry.uuid)).toEqual(['gen-1', 'gen-2']);
    });
    // Default is "don't take the wall": the playlist "Add to queue" row lands
    // here, and an add must never activate a climb the climber didn't tap.
    expect(snapshots.at(-1)?.state.currentClimbQueueItem).toBeNull();
    // And it must not reach the wire as a whole-queue replace — an absent
    // currentClimbQueueItem is how the resolver is told to CLEAR the session's
    // current climb, which would blank every peer's wall.
    expect(queueMutations.setQueue).not.toHaveBeenCalled();
  });

  it('appendQueueItems with activateFirstWhenIdle opens on the first item when nothing is current', async () => {
    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));
    await waitFor(() => {
      expect(snapshots.length).toBeGreaterThan(0);
    });

    act(() => {
      snapshots
        .at(-1)
        ?.appendQueueItems([makeQueueItem('gen-1'), makeQueueItem('gen-2')], { activateFirstWhenIdle: true });
    });

    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue.map((entry) => entry.uuid)).toEqual(['gen-1', 'gen-2']);
    });
    // The workout generator's contract, unchanged: starting a generated session
    // opens on its first climb.
    expect(snapshots.at(-1)?.state.currentClimbQueueItem?.uuid).toBe('gen-1');
  });

  it('appendQueueItems leaves the pointer null when the queue has items but none is current', async () => {
    // Browsed climbs into the queue without activating any of them. An append
    // adds behind them and still activates nothing.
    const itemA = makeQueueItem('item-a');
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue(storedSnapshot([itemA], null));

    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue.map((entry) => entry.uuid)).toEqual(['item-a']);
    });
    expect(snapshots.at(-1)?.state.currentClimbQueueItem).toBeNull();

    act(() => {
      snapshots.at(-1)?.appendQueueItems([makeQueueItem('gen-1'), makeQueueItem('gen-2')]);
    });

    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue.map((entry) => entry.uuid)).toEqual(['item-a', 'gen-1', 'gen-2']);
    });
    expect(snapshots.at(-1)?.state.currentClimbQueueItem).toBeNull();
  });

  it('appendQueueItems with activateFirstWhenIdle opens on the first item when the queue has items but none is current', async () => {
    const itemA = makeQueueItem('item-a');
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue(storedSnapshot([itemA], null));

    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue.map((entry) => entry.uuid)).toEqual(['item-a']);
    });

    act(() => {
      snapshots
        .at(-1)
        ?.appendQueueItems([makeQueueItem('gen-1'), makeQueueItem('gen-2')], { activateFirstWhenIdle: true });
    });

    await waitFor(() => {
      expect(snapshots.at(-1)?.state.currentClimbQueueItem?.uuid).toBe('gen-1');
    });
    expect(snapshots.at(-1)?.state.queue.map((entry) => entry.uuid)).toEqual(['item-a', 'gen-1', 'gen-2']);
  });

  it('appendQueueItems broadcasts per-item adds (never a pointer-clearing setQueue) when nothing is current', async () => {
    // The whole reason the no-pointer branch exists: `Mutation.setQueue` reads an
    // absent currentClimbQueueItem as "clear it" and writes null into shared
    // session state, so an ADDITIVE action would wipe the crew's current climb.
    // ADD_QUEUE_ITEM carries no pointer at all.
    sessionStore.getStoredSessionId.mockResolvedValue('session-1');
    http.request.mockImplementation((operation: string) =>
      operation.includes('SessionStatus')
        ? Promise.resolve({ sessionStatus: 'active' })
        : Promise.resolve({ createSession: { id: 'session-new' } }),
    );
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue(null);

    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));
    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    });

    queueMutations.setQueue.mockClear();
    queueMutations.addQueueItem.mockClear();
    act(() => {
      snapshots.at(-1)?.appendQueueItems([makeQueueItem('gen-1'), makeQueueItem('gen-2')]);
    });

    await waitFor(() => {
      expect(queueMutations.addQueueItem).toHaveBeenCalledTimes(2);
    });
    expect(queueMutations.setQueue).not.toHaveBeenCalled();
    expect(queueMutations.addQueueItem.mock.calls.map(([item]) => item.uuid)).toEqual(['gen-1', 'gen-2']);
  });

  it('appendQueueItems drains the per-item adds sequentially and in playlist order', async () => {
    // The backend wraps every addQueueItem in withQueueVersionRetry around a
    // single-key Redis CAS — 3 attempts, no backoff, no jitter. Firing them
    // concurrently means most of a batch exhausts its retries: peers get a
    // fraction of the playlist, in CAS-resolution order rather than playlist
    // order (no `position` is sent), and the ordered-hash watchdog then collapses
    // THIS device's queue to whatever landed. The mock below fails the test if a
    // second send starts before the first resolves, so the concurrent form cannot
    // pass this.
    sessionStore.getStoredSessionId.mockResolvedValue('session-1');
    http.request.mockImplementation((operation: string) =>
      operation.includes('SessionStatus')
        ? Promise.resolve({ sessionStatus: 'active' })
        : Promise.resolve({ createSession: { id: 'session-new' } }),
    );
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue(null);

    let inFlight = 0;
    let sawOverlap = false;
    const releases: Array<() => void> = [];
    queueMutations.addQueueItem.mockImplementation(async () => {
      if (inFlight > 0) sawOverlap = true;
      inFlight += 1;
      await new Promise<void>((resolve) => releases.push(resolve));
      inFlight -= 1;
    });

    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));
    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    });

    queueMutations.addQueueItem.mockClear();
    act(() => {
      snapshots.at(-1)?.appendQueueItems([makeQueueItem('gen-1'), makeQueueItem('gen-2'), makeQueueItem('gen-3')]);
    });

    // Only the first send may be open; the rest wait their turn.
    await waitFor(() => expect(queueMutations.addQueueItem).toHaveBeenCalledTimes(1));
    for (let step = 0; step < 3; step += 1) {
      await act(async () => {
        releases.shift()?.();
      });
    }
    await waitFor(() => expect(queueMutations.addQueueItem).toHaveBeenCalledTimes(3));
    expect(sawOverlap).toBe(false);
    // Sequential sends also fix the order: the server appends, so the wire order
    // IS the playlist order.
    expect(queueMutations.addQueueItem.mock.calls.map(([item]) => item.uuid)).toEqual(['gen-1', 'gen-2', 'gen-3']);
    // Locally the whole batch was already there from the first frame.
    expect(snapshots.at(-1)?.state.queue.map((entry) => entry.uuid)).toEqual(['gen-1', 'gen-2', 'gen-3']);
  });

  it('appendQueueItems reconciles ONCE for a batch of failed adds, preferring the throttled reason', async () => {
    // Each reconcile can toast and kick a resync, so a per-item reconcile would
    // make 3 failed adds 3 toasts and 3 resyncs.
    sessionStore.getStoredSessionId.mockResolvedValue('session-1');
    http.request.mockImplementation((operation: string) =>
      operation.includes('SessionStatus')
        ? Promise.resolve({ sessionStatus: 'active' })
        : Promise.resolve({ createSession: { id: 'session-new' } }),
    );
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue(null);

    const rateLimited = {
      response: {
        status: 200,
        errors: [
          {
            message: 'Rate limit exceeded. Try again in 7 seconds.',
            extensions: { code: 'RATE_LIMITED', operation: 'addQueueItem', retryAfterSeconds: 7 },
          },
        ],
      },
    };
    queueMutations.addQueueItem
      .mockRejectedValueOnce(new Error('transport'))
      .mockRejectedValueOnce(rateLimited)
      .mockRejectedValueOnce(new Error('transport'));

    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));
    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    });

    toast.showToast.mockClear();
    await act(async () => {
      snapshots.at(-1)?.appendQueueItems([makeQueueItem('gen-1'), makeQueueItem('gen-2'), makeQueueItem('gen-3')]);
    });
    await waitFor(() => expect(queueMutations.addQueueItem).toHaveBeenCalledTimes(3));

    // One toast for the batch, and it is the pacing hint — not the unrelated
    // transport error that happened to fail first.
    await waitFor(() => {
      expect(toast.showToast).toHaveBeenCalledWith('mobile.queue.rateLimited', 'error');
    });
    expect(toast.showToast.mock.calls.filter(([message]) => message === 'mobile.queue.rateLimited')).toHaveLength(1);
    // The local queue keeps every climb — the sync is best-effort, the local
    // state is the source of truth.
    expect(snapshots.at(-1)?.state.queue.map((entry) => entry.uuid)).toEqual(['gen-1', 'gen-2', 'gen-3']);
  });

  it('appendQueueItems clamps the batch to MAX_SYNCED_QUEUE_ITEMS and returns what landed', async () => {
    const seeded = Array.from({ length: MAX_SYNCED_QUEUE_ITEMS - 5 }, (_unused, index) =>
      makeQueueItem(`seed-${index}`),
    );
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue(storedSnapshot(seeded, seeded[0]));

    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue.length).toBe(MAX_SYNCED_QUEUE_ITEMS - 5);
    });

    queueMutations.setQueue.mockClear();
    let appendedCount = -1;
    act(() => {
      appendedCount =
        snapshots
          .at(-1)
          ?.appendQueueItems(Array.from({ length: 20 }, (_unused, index) => makeQueueItem(`new-${index}`))) ?? -1;
    });

    // Only the remaining capacity lands — the resolver THROWS on a payload over
    // the cap rather than truncating, so an over-long queue would wedge every
    // later full sync for the session.
    expect(appendedCount).toBe(5);
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue.length).toBe(MAX_SYNCED_QUEUE_ITEMS);
    });
    expect(snapshots.at(-1)?.state.queue.at(-1)?.uuid).toBe('new-4');
    const [wireQueue = []] = queueMutations.setQueue.mock.calls.at(-1) ?? [];
    expect(wireQueue.length).toBe(MAX_SYNCED_QUEUE_ITEMS);
  });

  it('appendQueueItems returns 0 and broadcasts nothing when the queue is already at the cap', async () => {
    const seeded = Array.from({ length: MAX_SYNCED_QUEUE_ITEMS }, (_unused, index) => makeQueueItem(`seed-${index}`));
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue(storedSnapshot(seeded, seeded[0]));

    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue.length).toBe(MAX_SYNCED_QUEUE_ITEMS);
    });

    queueMutations.setQueue.mockClear();
    queueMutations.addQueueItem.mockClear();
    let appendedCount = -1;
    act(() => {
      appendedCount = snapshots.at(-1)?.appendQueueItems([makeQueueItem('overflow')]) ?? -1;
    });

    expect(appendedCount).toBe(0);
    expect(snapshots.at(-1)?.state.queue.length).toBe(MAX_SYNCED_QUEUE_ITEMS);
    expect(queueMutations.setQueue).not.toHaveBeenCalled();
    expect(queueMutations.addQueueItem).not.toHaveBeenCalled();
  });

  it('appendQueueItems leaves an empty batch alone', async () => {
    const itemA = makeQueueItem('item-a');
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue(storedSnapshot([itemA], itemA));

    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.currentClimbQueueItem?.uuid).toBe('item-a');
    });

    queueMutations.setQueue.mockClear();
    act(() => {
      snapshots.at(-1)?.appendQueueItems([]);
    });

    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue.map((entry) => entry.uuid)).toEqual(['item-a']);
    });
    expect(snapshots.at(-1)?.state.currentClimbQueueItem?.uuid).toBe('item-a');
    // A no-op append must not broadcast a SET_QUEUE that changes nothing.
    expect(queueMutations.setQueue).not.toHaveBeenCalled();
  });

  it('appendQueueItems broadcasts the merged queue with the carried current to party peers', async () => {
    sessionStore.getStoredSessionId.mockResolvedValue('session-1');
    http.request.mockImplementation((operation: string) =>
      operation.includes('SessionStatus')
        ? Promise.resolve({ sessionStatus: 'active' })
        : Promise.resolve({ createSession: { id: 'session-new' } }),
    );
    const itemA = makeQueueItem('item-a');
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue(null);

    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));
    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    });

    act(() => {
      snapshots.at(-1)?.setCurrentClimb(itemA);
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.currentClimbQueueItem?.uuid).toBe('item-a');
    });

    const generated = [makeQueueItem('gen-1'), makeQueueItem('gen-2')];
    act(() => {
      snapshots.at(-1)?.appendQueueItems(generated);
    });

    await waitFor(() => {
      expect(queueMutations.setQueue).toHaveBeenCalled();
    });
    const [wireQueue = [], wireCurrent] = queueMutations.setQueue.mock.calls.at(-1) ?? [];
    expect(wireQueue.map((entry) => entry.uuid)).toEqual(['item-a', 'gen-1', 'gen-2']);
    expect(wireCurrent?.uuid).toBe('item-a');
  });

  it('appendQueueItems drops an unresolved current climb from the party payload but keeps it locally', async () => {
    // Documents a pre-existing setQueue contract (#2527): a thin/partially-synced
    // item can't form a valid ClimbInput, so it never goes on the wire. Carrying
    // the current climb forward makes that path easier to hit — peers land on the
    // generated session with no current until the item hydrates and re-syncs.
    sessionStore.getStoredSessionId.mockResolvedValue('session-1');
    http.request.mockImplementation((operation: string) =>
      operation.includes('SessionStatus')
        ? Promise.resolve({ sessionStatus: 'active' })
        : Promise.resolve({ createSession: { id: 'session-new' } }),
    );
    const thin = makeQueueItem('thin-item');
    thin.climb = { ...thin.climb, frames: '' };
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue(null);

    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));
    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    });

    act(() => {
      snapshots.at(-1)?.setCurrentClimb(thin);
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.currentClimbQueueItem?.uuid).toBe('thin-item');
    });

    queueMutations.setQueue.mockClear();
    act(() => {
      snapshots.at(-1)?.appendQueueItems([makeQueueItem('gen-1')]);
    });

    await waitFor(() => {
      expect(queueMutations.setQueue).toHaveBeenCalled();
    });
    const [wireQueue = [], wireCurrent] = queueMutations.setQueue.mock.calls.at(-1) ?? [];
    expect(wireQueue.map((entry) => entry.uuid)).toEqual(['gen-1']);
    expect(wireCurrent).toBeUndefined();
    // Locally the thin item is still the current climb and still in the queue.
    expect(snapshots.at(-1)?.state.queue.map((entry) => entry.uuid)).toEqual(['thin-item', 'gen-1']);
    expect(snapshots.at(-1)?.state.currentClimbQueueItem?.uuid).toBe('thin-item');
  });
});
