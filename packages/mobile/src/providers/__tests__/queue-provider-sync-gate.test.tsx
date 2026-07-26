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
  // Device provenance for the leave-vs-end emphasis (#3502).
  getStoredCreatedSessionId: vi.fn(async () => null as string | null),
  setStoredCreatedSessionId: vi.fn(async () => {}),
  clearStoredCreatedSessionId: vi.fn(async () => {}),
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

const errorReporter = vi.hoisted(() => ({
  reportError: vi.fn(),
  reportHandledError: vi.fn(),
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

vi.mock('../party-profile-provider', () => ({
  usePartyProfile: () => ({ username: undefined, avatarUrl: undefined }),
}));

vi.mock('../../lib/error-reporting', () => ({
  reportError: errorReporter.reportError,
  reportHandledError: errorReporter.reportHandledError,
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

// Wire-shaped PlaybackStateChanged matching QUEUE_UPDATES_SUBSCRIPTION's `...
// on PlaybackStateChanged` fragment (issue #3358) — no top-level `stateHash`,
// since this event doesn't mutate queue state.
function wirePlaybackStateChanged(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    __typename: 'PlaybackStateChanged',
    sequence: 1,
    climbUuid: 'c1',
    frameIndex: 3,
    isPlaying: true,
    speed: 1.5,
    paceMs: 250,
    anchorTimestamp: '1700000000000',
    clientId: 'peer-client',
    ...overrides,
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
    errorReporter.reportError.mockClear();
    errorReporter.reportHandledError.mockClear();
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

  it('coalesces a burst of sequence-gap events into one in-flight fetch plus one trailing rerun', async () => {
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
    // (1) — a gap. Firing them in one `act` keeps both resync requests in the
    // same synchronous tick: the first starts the fetch, the second arrives
    // mid-flight. It must NOT be dropped outright (its mutation may postdate
    // the in-flight snapshot — e.g. the tail of a clearQueue burst), so the
    // single-flight guard coalesces it into exactly one trailing rerun after
    // the first fetch settles: 2 fetches total for the burst, not 1, not one
    // per event.
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
    await waitFor(() => {
      expect(queueStateCalls).toBe(2);
    });
    // Settled: the trailing rerun must not chain into a third fetch.
    await act(async () => {
      await Promise.resolve();
    });
    expect(queueStateCalls).toBe(2);
    expect(analytics.track).toHaveBeenCalledWith(
      'Queue Sync Gap Resync',
      expect.objectContaining({ eventType: 'QueueItemAdded' }),
    );
  });

  it('re-baselines the gate to the snapshot sequence after a gap resync', async () => {
    const snapshots: Snapshot[] = [];
    const serverItem = makeQueueItem('server-item', 'climb-server');
    // The resync snapshot reports sequence 99 — the gate must track it.
    routeHttpRequest(queueStateResponse([serverItem], null, 99, 'post-resync-hash'));

    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(ws.getQueueUpdatesSink()).not.toBeNull();
    });
    const queueUpdatesSink = ws.getQueueUpdatesSink();
    if (!queueUpdatesSink) throw new Error('queue updates sink was not captured');

    act(() => {
      queueUpdatesSink.next({ data: { queueUpdates: wireFullSync(1, 'hash-1') } });
    });
    // Single gap event (sequence 5 ≫ 1) → one resync, no coalesced rerun.
    act(() => {
      queueUpdatesSink.next({ data: { queueUpdates: wireQueueItemAdded(5, 'hash-5', wireItem('q-gap')) } });
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue.map((item) => item.uuid)).toEqual(['server-item']);
    });

    // A stale delta at (or below) the snapshot's sequence must be dropped —
    // the re-baseline set lastSequence to 99, not back to null (which would
    // blindly apply whatever came next).
    act(() => {
      queueUpdatesSink.next({ data: { queueUpdates: wireQueueItemAdded(99, 'hash-99', wireItem('q-stale')) } });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(snapshots.at(-1)?.state.queue.map((item) => item.uuid)).toEqual(['server-item']);
    expect(analytics.track).toHaveBeenCalledWith(
      'Queue Sync Stale Event Ignored',
      expect.objectContaining({ eventType: 'QueueItemAdded', sequence: 99 }),
    );

    // The next contiguous delta (snapshot.sequence + 1) applies cleanly.
    act(() => {
      queueUpdatesSink.next({ data: { queueUpdates: wireQueueItemAdded(100, 'hash-100', wireItem('q-next')) } });
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue.map((item) => item.uuid)).toEqual(['server-item', 'q-next']);
    });
  });

  it('falls back to restarting the WS subscriptions when the resync snapshot is unavailable', async () => {
    const snapshots: Snapshot[] = [];
    let queueStateCalls = 0;
    // The backend returns queueState: null when the HTTP caller fails the
    // session-membership check — permanently true for anonymous HTTP callers
    // (membership lives on the WS connection; see PR #3341). The provider
    // must restart the joined subscriptions instead (their initial FullSync
    // heals state), and must not loop back into more doomed fetches.
    http.request.mockImplementation(async (operation: string) => {
      if (operation.includes('GetSessionQueueState')) {
        queueStateCalls += 1;
        return { session: { queueState: null } };
      }
      if (operation.includes('SessionStatus')) {
        return statusResponse();
      }
      return { endSession: { sessionId: 'session-1' } };
    });

    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(ws.getQueueUpdatesSink()).not.toBeNull();
    });
    // Initial mount: queueUpdates + sessionUpdates.
    expect(ws.client.subscribe).toHaveBeenCalledTimes(2);
    const queueUpdatesSink = ws.getQueueUpdatesSink();
    if (!queueUpdatesSink) throw new Error('queue updates sink was not captured');

    act(() => {
      queueUpdatesSink.next({ data: { queueUpdates: wireFullSync(1, 'hash-1') } });
    });
    act(() => {
      queueUpdatesSink.next({ data: { queueUpdates: wireQueueItemAdded(5, 'hash-5', wireItem('q-gap')) } });
    });

    // The gap resync fetched once, got no queueState, and restarted the
    // joined subscriptions — both re-subscribed (2 + 2 = 4).
    await waitFor(() => {
      expect(ws.client.subscribe).toHaveBeenCalledTimes(4);
    });
    await act(async () => {
      await Promise.resolve();
    });
    // Exactly one fetch: the restart never chains into another HTTP resync.
    expect(queueStateCalls).toBe(1);
  });

  it('restarts the WS subscriptions when the resync request itself throws', async () => {
    const snapshots: Snapshot[] = [];
    let queueStateCalls = 0;
    // A rejected resync fetch (transport failure, 5xx, etc.) can't reconcile
    // anything on its own — but a resubscribe's guaranteed initial FullSync
    // can. The catch block must take the same restart path as the null-snapshot
    // case and must not silently give up, leaving gap/drift recovery stuck.
    http.request.mockImplementation(async (operation: string) => {
      if (operation.includes('GetSessionQueueState')) {
        queueStateCalls += 1;
        throw new Error('resync boom');
      }
      if (operation.includes('SessionStatus')) {
        return statusResponse();
      }
      return { endSession: { sessionId: 'session-1' } };
    });

    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(ws.getQueueUpdatesSink()).not.toBeNull();
    });
    // Initial mount: queueUpdates + sessionUpdates.
    expect(ws.client.subscribe).toHaveBeenCalledTimes(2);
    const queueUpdatesSink = ws.getQueueUpdatesSink();
    if (!queueUpdatesSink) throw new Error('queue updates sink was not captured');

    act(() => {
      queueUpdatesSink.next({ data: { queueUpdates: wireFullSync(1, 'hash-1') } });
    });
    act(() => {
      queueUpdatesSink.next({ data: { queueUpdates: wireQueueItemAdded(5, 'hash-5', wireItem('q-gap')) } });
    });

    // The gap resync fetched once, the request threw, and the catch restarted
    // the joined subscriptions — both re-subscribed (2 + 2 = 4).
    await waitFor(() => {
      expect(ws.client.subscribe).toHaveBeenCalledTimes(4);
    });
    await act(async () => {
      await Promise.resolve();
    });
    // Exactly one fetch: the errored restart never chains into another resync.
    expect(queueStateCalls).toBe(1);
    // The failure was reported as a handled error tagged to the resync op, not
    // swallowed — and via the handled reporter only. A regression that also
    // escalated to the unhandled `reportError` must fail this test.
    expect(errorReporter.reportHandledError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { source: 'queue-sync', op: 'resync' } }),
    );
    expect(errorReporter.reportError).not.toHaveBeenCalled();
  });

  it('skips a stale resync snapshot that resolves after a mid-flight FullSync re-baselined the gate', async () => {
    const snapshots: Snapshot[] = [];
    let queueStateCalls = 0;
    // Hold the resync fetch open so a rejoin FullSync can land while it is in
    // flight. The snapshot it eventually resolves to reports sequence 5 — older
    // than the sequence the FullSync re-baselines the gate to (100) — so
    // applying it would regress both the queue and the gate backwards.
    // Definite-assignment assertion: the Promise executor runs synchronously, so
    // resolveFetch is always set before use (TS can't see that through the
    // closure).
    let resolveFetch!: (payload: unknown) => void;
    const pendingFetch = new Promise<unknown>((resolve) => {
      resolveFetch = resolve;
    });
    http.request.mockImplementation(async (operation: string) => {
      if (operation.includes('GetSessionQueueState')) {
        queueStateCalls += 1;
        return pendingFetch;
      }
      if (operation.includes('SessionStatus')) {
        return statusResponse();
      }
      return { endSession: { sessionId: 'session-1' } };
    });

    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(ws.getQueueUpdatesSink()).not.toBeNull();
    });
    const queueUpdatesSink = ws.getQueueUpdatesSink();
    if (!queueUpdatesSink) throw new Error('queue updates sink was not captured');

    // Baseline at sequence 1, then a gap event (sequence 5 ≫ 1) starts the
    // resync fetch — which now suspends on `pendingFetch`.
    act(() => {
      queueUpdatesSink.next({ data: { queueUpdates: wireFullSync(1, 'hash-1') } });
    });
    act(() => {
      queueUpdatesSink.next({ data: { queueUpdates: wireQueueItemAdded(5, 'hash-5', wireItem('q-gap')) } });
    });
    await waitFor(() => {
      expect(queueStateCalls).toBe(1);
    });

    // A rejoin FullSync lands mid-flight, replacing the queue with its own
    // authoritative state and re-baselining the gate's lastSequence to 100.
    act(() => {
      queueUpdatesSink.next({
        data: { queueUpdates: wireFullSync(100, 'hash-100', [wireItem('fullsync-item')]) },
      });
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue.map((item) => item.uuid)).toEqual(['fullsync-item']);
    });

    // Now the slow fetch resolves to the OLDER snapshot (sequence 5). The guard
    // must skip it: the queue keeps the FullSync's state, not the stale server
    // snapshot's `server-item`.
    await act(async () => {
      resolveFetch(queueStateResponse([makeQueueItem('server-item')], null, 5, 'resync-hash-5'));
      await Promise.resolve();
    });
    expect(snapshots.at(-1)?.state.queue.map((item) => item.uuid)).toEqual(['fullsync-item']);

    // The re-baseline was left intact at 100 (not regressed to 5): a stale delta
    // at 100 is dropped, and the next contiguous delta at 101 applies cleanly.
    act(() => {
      queueUpdatesSink.next({ data: { queueUpdates: wireQueueItemAdded(100, 'hash-100b', wireItem('q-stale')) } });
    });
    act(() => {
      queueUpdatesSink.next({ data: { queueUpdates: wireQueueItemAdded(101, 'hash-101', wireItem('q-101')) } });
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue.map((item) => item.uuid)).toEqual(['fullsync-item', 'q-101']);
    });
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

    // Defensive case: a `__typename`-only payload (e.g. a stale client bundle
    // still missing the `... on PlaybackStateChanged` fragment, or a future
    // union member this listener doesn't recognise) must still be forwarded
    // and must not throw or otherwise disrupt the gate.
    act(() => {
      queueUpdatesSink.next({ data: { queueUpdates: { __typename: 'PlaybackStateChanged' } } });
    });

    // Realistic case (issue #3358): QUEUE_UPDATES_SUBSCRIPTION now selects the
    // full `... on PlaybackStateChanged` fragment, so the real wire payload
    // carries all 8 fields — assert they reach the listener unchanged, since
    // `use-mobile-playback.ts` reads `climbUuid`/`frameIndex`/etc directly off
    // the forwarded event.
    act(() => {
      queueUpdatesSink.next({ data: { queueUpdates: wirePlaybackStateChanged() } });
    });

    await waitFor(() => {
      expect(received.filter((event) => event.__typename === 'PlaybackStateChanged')).toHaveLength(2);
    });
    const [minimalEvent, fullEvent] = received.filter((event) => event.__typename === 'PlaybackStateChanged');
    expect(minimalEvent).toEqual({ __typename: 'PlaybackStateChanged' });
    expect(fullEvent).toEqual(wirePlaybackStateChanged());

    // It must not have touched the reducer or the gate's tracking: the very
    // next real delta at sequence 2 (contiguous with the FullSync's 1) still
    // applies cleanly — proving neither PlaybackStateChanged event occupied a
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

      // Tick 5 (and beyond): still no resync, and no FURTHER backoff
      // analytics — a stuck-drift session must report once per streak, not
      // every 60s forever.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(queueStateCalls).toBe(3);
      const backoffTrackCalls = analytics.track.mock.calls.filter(
        ([eventName, properties]) =>
          eventName === 'Queue Sync Hash Drift' && (properties as { verdict?: string }).verdict === 'backoff',
      );
      expect(backoffTrackCalls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
