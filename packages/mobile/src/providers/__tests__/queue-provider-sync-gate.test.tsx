// @vitest-environment jsdom
//
// Sync-gate wiring for the queueUpdates subscription (W8): sequence-gap
// detection, stale-event dedup, PlaybackStateChanged bypass, and the 60s
// hash-drift watchdog. Reuses the WS/HTTP/store mock harness pattern from
// queue-provider-session-updates.test.tsx, extended to also capture the
// `queueUpdates` sink (that file only captures `sessionUpdates`).
import { act, render, waitFor } from '@testing-library/react';
import { createElement, useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type { SessionStatus, SessionUser, SubscriptionQueueEvent, UserBoard } from '@boardsesh/shared-schema';

const ws = vi.hoisted(() => {
  type WsEventName = 'connected' | 'closed';
  type QueueUpdatesSink = { next: (payload: { data?: { queueUpdates?: unknown } }) => void };
  type SessionUpdatesSink = { next: (payload: { data?: { sessionUpdates?: unknown } }) => void };
  let queueUpdatesSink: QueueUpdatesSink | null = null;
  let sessionUpdatesSink: SessionUpdatesSink | null = null;
  const listeners: Record<WsEventName, Set<() => void>> = {
    connected: new Set(),
    closed: new Set(),
  };
  return {
    getQueueUpdatesSink: () => queueUpdatesSink,
    getSessionUpdatesSink: () => sessionUpdatesSink,
    emit: (eventName: WsEventName) => {
      for (const listener of listeners[eventName]) listener();
    },
    client: {
      on: vi.fn((eventName: WsEventName, listener: () => void) => {
        listeners[eventName].add(listener);
        return () => {
          listeners[eventName].delete(listener);
        };
      }),
      subscribe: vi.fn((request: { query: string }, sink: { next: (payload: unknown) => void }) => {
        if (request.query.includes('queueUpdates')) {
          queueUpdatesSink = sink as QueueUpdatesSink;
        }
        if (request.query.includes('sessionUpdates')) {
          sessionUpdatesSink = sink as SessionUpdatesSink;
        }
        return vi.fn();
      }),
    },
    reset: () => {
      queueUpdatesSink = null;
      sessionUpdatesSink = null;
      listeners.connected.clear();
      listeners.closed.clear();
    },
  };
});

const graph = vi.hoisted(() => ({
  execute: vi.fn(),
}));

const http = vi.hoisted(() => ({
  request: vi.fn(),
}));

const analytics = vi.hoisted(() => ({
  track: vi.fn(),
}));

const sessionStore = vi.hoisted(() => ({
  getStoredSessionId: vi.fn(async () => 'session-1' as string | null),
  setStoredSessionId: vi.fn(async () => {}),
  clearStoredSessionId: vi.fn(async () => {}),
}));

const queueSnapshotStore = vi.hoisted(() => ({
  getStoredQueueSnapshot: vi.fn(async () => null),
  setStoredQueueSnapshot: vi.fn(async () => {}),
  clearStoredQueueSnapshot: vi.fn(async () => {}),
}));

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
  } satisfies UserBoard,
  getStoredActiveBoard: vi.fn(),
  setActiveBoard: vi.fn(async () => {}),
}));

const toast = vi.hoisted(() => ({
  showToast: vi.fn(),
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
  confirmClimbOnWall: vi.fn(async () => {}),
  reportWallDisconnect: vi.fn(async () => {}),
  setSessionBoardSerial: vi.fn(async () => {}),
  setSessionBoardPath: vi.fn(async () => {}),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default },
  AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
}));

vi.mock('expo-crypto', () => ({
  randomUUID: () => 'test-correlation-id',
}));

vi.mock('@boardsesh/graphql-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/graphql-client')>()),
  execute: graph.execute,
}));

vi.mock('@boardsesh/queue-react', () => ({
  useQueueMutations: () => queueMutations,
}));

vi.mock('@boardsesh/play-view', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/play-view')>()),
  emitWallConfirm: vi.fn(),
}));

vi.mock('../../lib/graphql/ws-client', () => ({
  getWsClient: () => ws.client,
}));

vi.mock('../../lib/session-store', () => sessionStore);

vi.mock('../../lib/queue-snapshot-store', () => queueSnapshotStore);

vi.mock('../../lib/active-board-store', () => ({
  getStoredActiveBoard: activeBoard.getStoredActiveBoard,
}));

vi.mock('../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: activeBoard.stored }),
  useSetActiveBoard: () => activeBoard.setActiveBoard,
}));

vi.mock('../../lib/graphql/client', () => ({
  getHttpClient: () => ({ request: http.request }),
}));

vi.mock('../../lib/analytics', () => analytics);

vi.mock('../toast-provider', () => ({
  useToast: () => ({ showToast: toast.showToast }),
}));

vi.mock('../queue-snackbar-provider', () => ({
  useQueueSnackbar: () => ({ showQueueAddedSnackbar: vi.fn() }),
}));

import { QueueProvider, useQueue } from '../queue-provider';

type Snapshot = {
  state: ReturnType<typeof useQueue>['state'];
  sessionId: string | null;
  subscribeToQueueEvents: ReturnType<typeof useQueue>['subscribeToQueueEvents'];
};

const user = (overrides: Partial<SessionUser> = {}): SessionUser => ({
  id: 'participant-1',
  username: 'Alex',
  isLeader: false,
  avatarUrl: undefined,
  userId: 'db-user-1',
  connectionState: 'CONNECTED',
  ...overrides,
});

const statusResponse = (status: SessionStatus | null = 'active') => ({
  sessionStatus: status,
});

function createJoinSessionResponse() {
  return {
    joinSession: {
      participantId: 'participant-self',
      clientId: 'client-self',
      isLeader: false,
      lastConnectedBoardSerial: null,
      boardPath: '/kilter/1/10/1,2/40/list',
      users: [user({ id: 'participant-self', username: 'Self', userId: 'db-self' })],
    },
  };
}

// Wire-shaped queue item matching SUBSCRIPTION_CLIMB_FIELDS — what a real
// queueUpdates payload carries per climb (see queue-conversion.ts's
// SubscriptionQueueItem).
function wireItem(uuid: string, climbUuid = uuid) {
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

// FullSync's `stateHash` is nested under `state` on the real wire response
// (QUEUE_UPDATES_SUBSCRIPTION selects `state { sequence stateHash ... }`,
// no top-level `stateHash` for this variant) — mirror that shape exactly so
// these tests exercise the same flatten path (`toSyncQueueEvent`) production
// traffic does.
function wireFullSync(
  sequence: number,
  stateHash: string,
  queue: ReturnType<typeof wireItem>[] = [],
  currentClimbQueueItem: ReturnType<typeof wireItem> | null = null,
) {
  return {
    __typename: 'FullSync',
    sequence,
    state: { sequence, stateHash, queue, currentClimbQueueItem },
  };
}

function wireQueueItemAdded(sequence: number, stateHash: string, item: ReturnType<typeof wireItem>) {
  return {
    __typename: 'QueueItemAdded',
    sequence,
    stateHash,
    addedItem: item,
    position: null,
  };
}

function queueStateResponse(
  items: ClimbQueueItem[],
  current: ClimbQueueItem | null = null,
  sequence = 1,
  stateHash = 'resync-hash',
) {
  return {
    session: {
      queueState: {
        sequence,
        stateHash,
        queue: items.map((item) => ({ uuid: item.uuid, climb: item.climb })),
        currentClimbQueueItem: current ? { uuid: current.uuid, climb: current.climb } : null,
      },
    },
  };
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

function Probe({ onSnapshot }: { onSnapshot: (snapshot: Snapshot) => void }) {
  const queue = useQueue();
  useEffect(() => {
    onSnapshot({
      state: queue.state,
      sessionId: queue.sessionId,
      subscribeToQueueEvents: queue.subscribeToQueueEvents,
    });
  }, [queue.state, queue.sessionId, queue.subscribeToQueueEvents, onSnapshot]);
  return null;
}

function renderProvider(onSnapshot: (snapshot: Snapshot) => void) {
  return render(createElement(QueueProvider, null, createElement(Probe, { onSnapshot })));
}

function routeHttpRequest(queueStateResponsePayload: unknown, options: { onQueueStateCall?: () => void } = {}) {
  http.request.mockImplementation(async (operation: string) => {
    if (operation.includes('GetSessionQueueState')) {
      options.onQueueStateCall?.();
      return queueStateResponsePayload;
    }
    if (operation.includes('SessionStatus')) {
      return statusResponse();
    }
    return { endSession: { sessionId: 'session-1' } };
  });
}

describe('QueueProvider queue sync gate', () => {
  beforeEach(() => {
    ws.reset();
    ws.client.on.mockClear();
    ws.client.subscribe.mockClear();
    activeBoard.stored = { ...activeBoard.stored };
    activeBoard.getStoredActiveBoard.mockReset();
    activeBoard.getStoredActiveBoard.mockResolvedValue(activeBoard.stored);
    activeBoard.setActiveBoard.mockClear();
    toast.showToast.mockClear();
    analytics.track.mockClear();
    for (const mutation of Object.values(queueMutations) as Array<ReturnType<typeof vi.fn>>) {
      mutation.mockReset();
      mutation.mockResolvedValue(undefined);
    }
    sessionStore.getStoredSessionId.mockReset();
    sessionStore.getStoredSessionId.mockResolvedValue('session-1');
    sessionStore.setStoredSessionId.mockClear();
    sessionStore.clearStoredSessionId.mockClear();
    graph.execute.mockReset();
    graph.execute.mockResolvedValue(createJoinSessionResponse());
    http.request.mockReset();
    routeHttpRequest(queueStateResponse([]));
  });

  it('ignores an out-of-order stale event (no dispatch, no state change)', async () => {
    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(ws.getQueueUpdatesSink()).not.toBeNull();
    });
    const queueUpdatesSink = ws.getQueueUpdatesSink();
    if (!queueUpdatesSink) throw new Error('queue updates sink was not captured');

    // Baseline via FullSync (sequence 1), then a genuine delta at sequence 2.
    act(() => {
      queueUpdatesSink.next({ data: { queueUpdates: wireFullSync(1, 'hash-1') } });
    });
    act(() => {
      queueUpdatesSink.next({ data: { queueUpdates: wireQueueItemAdded(2, 'hash-2', wireItem('q1', 'c1')) } });
    });

    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue.map((item) => item.uuid)).toEqual(['q1']);
    });

    // A duplicate/older event (same sequence 2 again) must be ignored: the
    // reducer never sees it, so the queue stays exactly ['q1'].
    act(() => {
      queueUpdatesSink.next({
        data: { queueUpdates: wireQueueItemAdded(2, 'hash-2-stale', wireItem('q-stale', 'c-stale')) },
      });
    });

    // Give any (incorrectly scheduled) dispatch a chance to land before asserting.
    await act(async () => {
      await Promise.resolve();
    });

    expect(snapshots.at(-1)?.state.queue.map((item) => item.uuid)).toEqual(['q1']);
    expect(analytics.track).toHaveBeenCalledWith(
      'Queue Sync Stale Event Ignored',
      expect.objectContaining({ eventType: 'QueueItemAdded' }),
    );
  });

  it('resyncs exactly once from a burst of sequence-gap events (single-flight)', async () => {
    const snapshots: Snapshot[] = [];
    let queueStateCalls = 0;
    const serverItem = makeQueueItem('server-item', 'climb-server');
    routeHttpRequest(queueStateResponse([serverItem], null, 99, 'post-resync-hash'), {
      onQueueStateCall: () => (queueStateCalls += 1),
    });

    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(ws.getQueueUpdatesSink()).not.toBeNull();
    });
    const queueUpdatesSink = ws.getQueueUpdatesSink();
    if (!queueUpdatesSink) throw new Error('queue updates sink was not captured');

    act(() => {
      queueUpdatesSink.next({ data: { queueUpdates: wireFullSync(1, 'hash-1') } });
    });

    // Two events land back-to-back, both far ahead of the tracked sequence
    // (1) — a gap. Firing them in one `act` keeps both calls to
    // resyncQueueFromServerRef inside the same synchronous tick, so the
    // single-flight guard (resyncInFlightRef) coalesces them into one fetch.
    act(() => {
      queueUpdatesSink.next({ data: { queueUpdates: wireQueueItemAdded(5, 'hash-5', wireItem('q-gap-1')) } });
      queueUpdatesSink.next({ data: { queueUpdates: wireQueueItemAdded(6, 'hash-6', wireItem('q-gap-2')) } });
    });

    await waitFor(() => {
      // The resync's INITIAL_QUEUE_DATA replaced local state with the
      // server's authoritative snapshot — neither gap event's item made it
      // in; only the server's item did.
      expect(snapshots.at(-1)?.state.queue.map((item) => item.uuid)).toEqual(['server-item']);
    });
    expect(queueStateCalls).toBe(1);
    expect(analytics.track).toHaveBeenCalledWith(
      'Queue Sync Gap Resync',
      expect.objectContaining({ eventType: 'QueueItemAdded' }),
    );
  });

  it('lets PlaybackStateChanged bypass the gate and still reach transient listeners', async () => {
    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(ws.getQueueUpdatesSink()).not.toBeNull();
      expect(snapshots.at(-1)?.subscribeToQueueEvents).toBeDefined();
    });
    const queueUpdatesSink = ws.getQueueUpdatesSink();
    if (!queueUpdatesSink) throw new Error('queue updates sink was not captured');

    const received: SubscriptionQueueEvent[] = [];
    const unsubscribe = snapshots.at(-1)?.subscribeToQueueEvents((event) => received.push(event));

    act(() => {
      queueUpdatesSink.next({ data: { queueUpdates: wireFullSync(1, 'hash-1') } });
    });

    // The real wire payload for PlaybackStateChanged carries only
    // `__typename` — QUEUE_UPDATES_SUBSCRIPTION has no `... on
    // PlaybackStateChanged` fragment, so no sequence/stateHash is selected.
    act(() => {
      queueUpdatesSink.next({ data: { queueUpdates: { __typename: 'PlaybackStateChanged' } } });
    });

    await waitFor(() => {
      expect(received.map((event) => event.__typename)).toContain('PlaybackStateChanged');
    });
    // It must not have touched the reducer or the gate's tracking: the very
    // next real delta at sequence 2 (contiguous with the FullSync's 1) still
    // applies cleanly — proving PlaybackStateChanged never occupied a
    // sequence slot or otherwise got gated.
    act(() => {
      queueUpdatesSink.next({ data: { queueUpdates: wireQueueItemAdded(2, 'hash-2', wireItem('q1', 'c1')) } });
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue.map((item) => item.uuid)).toEqual(['q1']);
    });

    unsubscribe?.();
  });

  it('resyncs on hash drift and backs off after 3 consecutive strikes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const snapshots: Snapshot[] = [];
      let queueStateCalls = 0;
      // The resync snapshot always reports the SAME server hash the local
      // (empty) queue can never independently reproduce via
      // computeQueueStateHash — so every watchdog tick keeps disagreeing
      // with the same tracked server hash, letting the 3-strike counter
      // accumulate deterministically instead of resolving after one resync.
      routeHttpRequest(queueStateResponse([], null, 1, 'server-hash-locked'), {
        onQueueStateCall: () => (queueStateCalls += 1),
      });

      renderProvider((snapshot) => snapshots.push(snapshot));

      await waitFor(() => {
        expect(ws.getQueueUpdatesSink()).not.toBeNull();
      });
      const queueUpdatesSink = ws.getQueueUpdatesSink();
      if (!queueUpdatesSink) throw new Error('queue updates sink was not captured');

      act(() => {
        queueUpdatesSink.next({ data: { queueUpdates: wireFullSync(1, 'server-hash-locked') } });
      });
      await waitFor(() => {
        expect(snapshots.at(-1)?.sessionId).toBe('session-1');
      });

      // Ticks 1-3: local hash (of an empty queue) never equals
      // 'server-hash-locked' — each resync-drift verdict triggers exactly
      // one more resync.
      for (let strike = 0; strike < 3; strike++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(60_000);
        });
      }
      await waitFor(() => expect(queueStateCalls).toBe(3));
      expect(analytics.track).toHaveBeenCalledWith(
        'Queue Sync Hash Drift',
        expect.objectContaining({ verdict: 'resync-drift' }),
      );

      // Tick 4: the loop-protection threshold trips — backoff reports but
      // does NOT fire a 4th resync.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(queueStateCalls).toBe(3);
      expect(analytics.track).toHaveBeenCalledWith(
        'Queue Sync Hash Drift',
        expect.objectContaining({ verdict: 'backoff', consecutiveResyncs: 4 }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
