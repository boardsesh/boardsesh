// @vitest-environment jsdom
//
// Regression coverage for #3878: a failed session-queue seed must not let the
// empty room's initial FullSync wipe the live in-memory queue.
//
// createSessionWithConfig seeds a brand-new party session with the user's
// locally-built queue (setQueue) BEFORE setSessionId mounts the queueUpdates
// subscription. If that seed throws (network blip, rate limit, validation
// reject, timeout), the room stays empty server-side; the subscription's
// FullSync for that empty room would otherwise overwrite the local queue via
// INITIAL_QUEUE_DATA. The guard in useSessionRealtime skips that FullSync
// (dispatch AND sync-gate tracking) and re-pushes the whole queue instead.
//
// Reuses the WS/HTTP/store/mutations mock harness from
// queue-provider-sync-gate.test.tsx, extended to drive createSessionWithConfig
// (startSession) and addToQueue from the probe.
import { act, render, waitFor } from '@testing-library/react';
import { createElement, useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type { SessionUser, SubscriptionQueueEvent, UserBoard } from '@boardsesh/shared-schema';

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
  registerRenderSuperProperties: vi.fn(),
}));

const sessionStore = vi.hoisted(() => ({
  getStoredSessionId: vi.fn(async () => null as string | null),
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

// The cross-board add gate calls useChoose()/useQueryClient()/expo-router, none of
// which this harness mounts. Pass every add straight through — the gate's own
// behaviour is covered by queue-provider-cross-board-add.test.tsx.
vi.mock('../queue/use-cross-board-add-gate', () => ({
  useCrossBoardAddGate: () => async () => ({ outcome: 'add' }),
}));
vi.mock('../party-profile-provider', () => ({
  usePartyProfile: () => ({ username: undefined, avatarUrl: undefined }),
}));

vi.mock('../../lib/error-reporting', () => ({
  reportError: errorReporter.reportError,
  reportHandledError: errorReporter.reportHandledError,
}));

// The board continuation feed (the re-anchor after a board switch) is a React
// Query hook and this harness mounts no QueryClient. Its own behaviour is covered
// by queue-provider-board-switch.test.tsx.
vi.mock('../queue/use-board-continuation-feed', () => ({ useBoardContinuationFeed: () => ({ climbs: [] }) }));

import { QueueProvider, useQueue } from '../queue-provider';

type Snapshot = {
  state: ReturnType<typeof useQueue>['state'];
  sessionId: string | null;
  startSession: ReturnType<typeof useQueue>['startSession'];
  addToQueue: ReturnType<typeof useQueue>['addToQueue'];
};

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

// Wire-shaped queue item matching SUBSCRIPTION_CLIMB_FIELDS.
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

// FullSync nests stateHash under `state` on the real wire response — mirror it.
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

const user = (overrides: Partial<SessionUser> = {}): SessionUser => ({
  id: 'participant-1',
  username: 'Alex',
  isLeader: false,
  avatarUrl: undefined,
  userId: 'db-user-1',
  connectionState: 'CONNECTED',
  ...overrides,
});

function createJoinSessionResponse() {
  return {
    joinSession: {
      participantId: 'participant-self',
      clientId: 'client-self',
      isLeader: true,
      lastConnectedBoardSerial: null,
      boardPath: '/kilter/1/10/1,2/40/list',
      users: [user({ id: 'participant-self', username: 'Self', userId: 'db-self', isLeader: true })],
    },
  };
}

// The new session's server id. createSession resolves to this; the seed then
// targets it (and, in these tests, rejects).
const NEW_SESSION_ID = 'new-session-1';

function routeHttpRequest() {
  http.request.mockImplementation(async (operation: string) => {
    if (operation.includes('CreateSession')) {
      return { createSession: { id: NEW_SESSION_ID } };
    }
    if (operation.includes('GetSessionQueueState')) {
      // The empty room: if this ever drives an INITIAL_QUEUE_DATA the queue
      // would be wiped — the guard exists precisely so it never does here.
      return { session: { queueState: { sequence: 0, stateHash: 'empty', queue: [], currentClimbQueueItem: null } } };
    }
    if (operation.includes('SessionStatus')) {
      return { sessionStatus: 'active' };
    }
    return {};
  });
}

function Probe({ onSnapshot }: { onSnapshot: (snapshot: Snapshot) => void }) {
  const queue = useQueue();
  useEffect(() => {
    onSnapshot({
      state: queue.state,
      sessionId: queue.sessionId,
      startSession: queue.startSession,
      addToQueue: queue.addToQueue,
    });
  }, [queue.state, queue.sessionId, queue.startSession, queue.addToQueue, onSnapshot]);
  return null;
}

function renderProvider(onSnapshot: (snapshot: Snapshot) => void) {
  return render(createElement(QueueProvider, null, createElement(Probe, { onSnapshot })));
}

describe('QueueProvider session-seed failure guard (#3878)', () => {
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
    // No stored session — we start solo, build a local queue, then start a
    // fresh party session whose seed fails.
    sessionStore.getStoredSessionId.mockReset();
    sessionStore.getStoredSessionId.mockResolvedValue(null);
    sessionStore.setStoredSessionId.mockClear();
    sessionStore.clearStoredSessionId.mockClear();
    queueSnapshotStore.getStoredQueueSnapshot.mockReset();
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue(null);
    queueSnapshotStore.clearStoredQueueSnapshot.mockClear();
    graph.execute.mockReset();
    graph.execute.mockResolvedValue(createJoinSessionResponse());
    http.request.mockReset();
    routeHttpRequest();
  });

  async function renderWithLocalQueue(itemUuids: string[]) {
    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));
    // Solo, no session, empty queue to start.
    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBeNull();
    });
    if (itemUuids.length > 0) {
      await act(async () => {
        for (const uuid of itemUuids) snapshots.at(-1)?.addToQueue(makeQueueItem(uuid));
      });
      await waitFor(() => {
        expect(snapshots.at(-1)?.state.queue.map((item) => item.uuid)).toEqual(itemUuids);
      });
    }
    return snapshots;
  }

  // Every `Queue Seed FullSync Guarded` emitted so far. The event is meant to
  // count guarded empty FullSyncs one-for-one, so the re-seed tests assert an
  // exact count rather than "was called" — a bare toHaveBeenCalledWith passes
  // just as happily at 2 events as at 1 and hides both overcount regressions.
  function guardedTrackCalls(): unknown[][] {
    return (analytics.track.mock.calls as unknown as unknown[][]).filter(
      (call) => call[0] === 'Queue Seed FullSync Guarded',
    );
  }

  it('keeps the live queue and re-seeds when the seed rejects and an empty FullSync arrives', async () => {
    // Seed (setQueue call #1) rejects; the re-seed (call #2) succeeds.
    queueMutations.setQueue.mockReset();
    queueMutations.setQueue.mockRejectedValueOnce(new Error('seed failed'));
    queueMutations.setQueue.mockResolvedValue(undefined);

    const snapshots = await renderWithLocalQueue(['q1', 'q2']);

    await act(async () => {
      await snapshots.at(-1)?.startSession();
    });

    // The session mounted (seed failure is swallowed, session still starts).
    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe(NEW_SESSION_ID);
    });
    await waitFor(() => {
      expect(ws.getQueueUpdatesSink()).not.toBeNull();
    });
    const queueUpdatesSink = ws.getQueueUpdatesSink();
    if (!queueUpdatesSink) throw new Error('queue updates sink was not captured');

    // The empty room's initial FullSync lands.
    act(() => {
      queueUpdatesSink.next({ data: { queueUpdates: wireFullSync(1, 'empty-hash') } });
    });
    // Let the re-seed promise + any (incorrectly scheduled) dispatch settle.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // The live queue survived — NOT wiped to [].
    expect(snapshots.at(-1)?.state.queue.map((item) => item.uuid)).toEqual(['q1', 'q2']);
    // The whole local queue was re-pushed so the server catches up.
    expect(queueMutations.setQueue).toHaveBeenCalledTimes(2);
    const setQueueCalls = queueMutations.setQueue.mock.calls as unknown as Array<
      [ClimbQueueItem[], ClimbQueueItem | null | undefined]
    >;
    const reSeedQueueArg = setQueueCalls[1][0];
    expect(reSeedQueueArg.map((item) => item.uuid)).toEqual(['q1', 'q2']);
    // Telemetry fired so the degraded seed lifecycle is visible in the field.
    expect(analytics.track).toHaveBeenCalledWith(
      'Queue Seed FullSync Guarded',
      expect.objectContaining({ localQueueLength: 2 }),
    );
    // Queue ownership moved to the session once the re-seed landed, so the solo
    // snapshot is dropped — mirroring the happy-path seed — so a later cold start
    // can't resurrect the pre-session queue.
    expect(queueSnapshotStore.clearStoredQueueSnapshot).toHaveBeenCalled();
  });

  it('applies an empty FullSync normally when the seed failed but the local queue is empty', async () => {
    // Local queue is empty, so createSessionWithConfig never runs the seed
    // block (nothing to seed) and never sets the guard flag. An empty FullSync
    // must apply as usual — there is nothing to protect and no re-seed to fire.
    const snapshots = await renderWithLocalQueue([]);

    await act(async () => {
      await snapshots.at(-1)?.startSession();
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe(NEW_SESSION_ID);
    });
    await waitFor(() => {
      expect(ws.getQueueUpdatesSink()).not.toBeNull();
    });
    const queueUpdatesSink = ws.getQueueUpdatesSink();
    if (!queueUpdatesSink) throw new Error('queue updates sink was not captured');

    act(() => {
      queueUpdatesSink.next({ data: { queueUpdates: wireFullSync(1, 'empty-hash') } });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(snapshots.at(-1)?.state.queue).toEqual([]);
    // Never a seed (empty local queue), never a re-seed, never the guard event.
    expect(queueMutations.setQueue).not.toHaveBeenCalled();
    expect(analytics.track).not.toHaveBeenCalledWith('Queue Seed FullSync Guarded', expect.anything());
  });

  it('skips gate tracking on the guarded FullSync so later real events still apply', async () => {
    // The subtle half of the fix: the guarded empty FullSync must NOT advance
    // the sync gate. If it did, the gate would baseline to the empty room's
    // sequence (1) and hash, and (a) the 60s watchdog would resync-to-empty and
    // (b) a genuine delta at sequence 1 would be dropped as stale. We prove the
    // gate stayed unbaselined without a 60s timer: a QueueItemAdded at sequence
    // 1 lands (evaluateIncoming(null, 1) → 'apply'), which would be
    // 'ignore-stale' had the empty FullSync been tracked.
    queueMutations.setQueue.mockReset();
    queueMutations.setQueue.mockRejectedValueOnce(new Error('seed failed'));
    queueMutations.setQueue.mockResolvedValue(undefined);

    const snapshots = await renderWithLocalQueue(['q1', 'q2']);

    await act(async () => {
      await snapshots.at(-1)?.startSession();
    });
    await waitFor(() => {
      expect(ws.getQueueUpdatesSink()).not.toBeNull();
    });
    const queueUpdatesSink = ws.getQueueUpdatesSink();
    if (!queueUpdatesSink) throw new Error('queue updates sink was not captured');

    // Guarded empty FullSync (sequence 1).
    act(() => {
      queueUpdatesSink.next({ data: { queueUpdates: wireFullSync(1, 'empty-hash') } });
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(snapshots.at(-1)?.state.queue.map((item) => item.uuid)).toEqual(['q1', 'q2']);

    // A genuine delta at sequence 1 — applies only because the gate was NOT
    // baselined to the skipped FullSync's sequence.
    act(() => {
      queueUpdatesSink.next({ data: { queueUpdates: wireQueueItemAdded(1, 'hash-add', wireItem('q3')) } });
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue.map((item) => item.uuid)).toEqual(['q1', 'q2', 'q3']);
    });

    // And a subsequent real, non-empty FullSync applies normally (the guard is
    // only for the empty room — the flag is cleared once the re-seed lands).
    act(() => {
      queueUpdatesSink.next({
        data: {
          queueUpdates: wireFullSync(2, 'full-hash', [wireItem('q1'), wireItem('q2'), wireItem('q3'), wireItem('q4')]),
        },
      });
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue.map((item) => item.uuid)).toEqual(['q1', 'q2', 'q3', 'q4']);
    });
  });

  it('applies a later empty FullSync normally once the successful re-seed cleared the flag', async () => {
    // The guard must not outlive its purpose. Once the re-seed lands, the .then
    // clears the flag, so a SUBSEQUENT empty FullSync (the room really was
    // emptied) is applied as usual instead of being skipped forever.
    queueMutations.setQueue.mockReset();
    queueMutations.setQueue.mockRejectedValueOnce(new Error('seed failed'));
    queueMutations.setQueue.mockResolvedValue(undefined);

    const snapshots = await renderWithLocalQueue(['q1', 'q2']);

    await act(async () => {
      await snapshots.at(-1)?.startSession();
    });
    await waitFor(() => {
      expect(ws.getQueueUpdatesSink()).not.toBeNull();
    });
    const queueUpdatesSink = ws.getQueueUpdatesSink();
    if (!queueUpdatesSink) throw new Error('queue updates sink was not captured');

    // First empty FullSync: guarded, re-seed resolves, flag cleared in the .then.
    act(() => {
      queueUpdatesSink.next({ data: { queueUpdates: wireFullSync(1, 'empty-hash') } });
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(snapshots.at(-1)?.state.queue.map((item) => item.uuid)).toEqual(['q1', 'q2']);
    expect(queueMutations.setQueue).toHaveBeenCalledTimes(2);

    // Second empty FullSync: the flag is gone, so it applies normally — the queue
    // is now legitimately cleared, and no extra re-seed fires.
    act(() => {
      queueUpdatesSink.next({ data: { queueUpdates: wireFullSync(2, 'empty-hash-2') } });
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue).toEqual([]);
    });
    expect(queueMutations.setQueue).toHaveBeenCalledTimes(2);
  });

  it('applies a non-empty FullSync (no skip, no re-seed) while the seed-failed flag is still set', async () => {
    // isEmptyRoom narrowing: the guard fires ONLY for the empty room. With the
    // flag set but the FullSync NON-empty, that FullSync is authoritative server
    // state and must apply — dropping the isEmptyRoom check would wrongly skip it
    // and re-seed on top of real server state.
    queueMutations.setQueue.mockReset();
    queueMutations.setQueue.mockRejectedValueOnce(new Error('seed failed'));
    queueMutations.setQueue.mockResolvedValue(undefined);

    const snapshots = await renderWithLocalQueue(['q1', 'q2']);

    await act(async () => {
      await snapshots.at(-1)?.startSession();
    });
    await waitFor(() => {
      expect(ws.getQueueUpdatesSink()).not.toBeNull();
    });
    const queueUpdatesSink = ws.getQueueUpdatesSink();
    if (!queueUpdatesSink) throw new Error('queue updates sink was not captured');

    // No empty FullSync was delivered, so the seed-failed flag is still set when
    // this non-empty FullSync lands.
    act(() => {
      queueUpdatesSink.next({
        data: { queueUpdates: wireFullSync(1, 'server-hash', [wireItem('s1'), wireItem('s2'), wireItem('s3')]) },
      });
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue.map((item) => item.uuid)).toEqual(['s1', 's2', 's3']);
    });
    // The FullSync won (server state applied) — the guard neither skipped it nor
    // re-seeded. setQueue was called once only: the original failed seed.
    expect(queueMutations.setQueue).toHaveBeenCalledTimes(1);
    expect(analytics.track).not.toHaveBeenCalledWith('Queue Seed FullSync Guarded', expect.anything());
  });

  it('serialises the re-seed: a second empty FullSync mid-flight does not fire a duplicate write', async () => {
    // Single-flight recovery. A second empty FullSync (e.g. a reconnect) arriving
    // while a re-seed is still in flight must NOT start a second whole-queue
    // write — two racing setQueue snapshots could let an older one land last.
    let resolveReSeed: (() => void) | undefined;
    queueMutations.setQueue.mockReset();
    queueMutations.setQueue.mockRejectedValueOnce(new Error('seed failed')); // the seed
    queueMutations.setQueue.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveReSeed = resolve;
        }),
    ); // the re-seed — held open
    queueMutations.setQueue.mockResolvedValue(undefined);

    const snapshots = await renderWithLocalQueue(['q1', 'q2']);
    await act(async () => {
      await snapshots.at(-1)?.startSession();
    });
    await waitFor(() => {
      expect(ws.getQueueUpdatesSink()).not.toBeNull();
    });
    const queueUpdatesSink = ws.getQueueUpdatesSink();
    if (!queueUpdatesSink) throw new Error('queue updates sink was not captured');

    // First empty FullSync starts the (held-open) re-seed.
    act(() => {
      queueUpdatesSink.next({ data: { queueUpdates: wireFullSync(1, 'empty-hash') } });
    });
    await act(async () => {
      await Promise.resolve();
    });
    // Second empty FullSync while the re-seed is in flight — must be a no-op push.
    act(() => {
      queueUpdatesSink.next({ data: { queueUpdates: wireFullSync(2, 'empty-hash-2') } });
    });
    await act(async () => {
      await Promise.resolve();
    });

    // seed (1) + exactly one re-seed (1) = 2. The second empty FullSync did NOT
    // add a third write.
    expect(queueMutations.setQueue).toHaveBeenCalledTimes(2);
    expect(snapshots.at(-1)?.state.queue.map((item) => item.uuid)).toEqual(['q1', 'q2']);
    // ...and it did not add a second analytics event either. Two empty FullSyncs
    // arrived but only one became a write, so only one is counted. Tracking at
    // the FullSync call site (before the single-flight guard) counts both and
    // overstates re-seeds in production.
    expect(guardedTrackCalls()).toHaveLength(1);

    // Let the held re-seed resolve: local still matches, so it converges.
    await act(async () => {
      resolveReSeed?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(queueMutations.setQueue).toHaveBeenCalledTimes(2);
    expect(guardedTrackCalls()).toHaveLength(1);
    expect(queueSnapshotStore.clearStoredQueueSnapshot).toHaveBeenCalled();
  });

  it('re-pushes the latest queue when a live edit lands while the re-seed is in flight', async () => {
    // Snapshot check. If the user edits the queue while the re-seed is in flight,
    // clearing the guard on the stale snapshot's success would let a later
    // FullSync drop the new edit. The re-seed must re-push the latest state and
    // keep the guard armed until a push reflects the current queue.
    let resolveReSeed: (() => void) | undefined;
    queueMutations.setQueue.mockReset();
    queueMutations.setQueue.mockRejectedValueOnce(new Error('seed failed')); // the seed
    queueMutations.setQueue.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveReSeed = resolve;
        }),
    ); // re-seed #1 (snapshot [q1, q2]) — held open
    queueMutations.setQueue.mockResolvedValue(undefined); // re-seed #2 (latest) resolves

    const snapshots = await renderWithLocalQueue(['q1', 'q2']);
    await act(async () => {
      await snapshots.at(-1)?.startSession();
    });
    await waitFor(() => {
      expect(ws.getQueueUpdatesSink()).not.toBeNull();
    });
    const queueUpdatesSink = ws.getQueueUpdatesSink();
    if (!queueUpdatesSink) throw new Error('queue updates sink was not captured');

    // Empty FullSync starts re-seed #1, capturing snapshot [q1, q2].
    act(() => {
      queueUpdatesSink.next({ data: { queueUpdates: wireFullSync(1, 'empty-hash') } });
    });
    await act(async () => {
      await Promise.resolve();
    });

    // The user adds a climb while re-seed #1 is still in flight.
    await act(async () => {
      snapshots.at(-1)?.addToQueue(makeQueueItem('q3'));
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue.map((item) => item.uuid)).toEqual(['q1', 'q2', 'q3']);
    });

    // Resolve re-seed #1: local has drifted, so it re-pushes the latest instead
    // of clearing the guard on the stale snapshot.
    await act(async () => {
      resolveReSeed?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    // seed (1) + re-seed #1 (stale) + re-seed #2 (latest) = 3, and the last push
    // carried the edited queue.
    expect(queueMutations.setQueue).toHaveBeenCalledTimes(3);
    const setQueueCalls = queueMutations.setQueue.mock.calls as unknown as Array<
      [ClimbQueueItem[], ClimbQueueItem | null | undefined]
    >;
    expect(setQueueCalls[2][0].map((item) => item.uuid)).toEqual(['q1', 'q2', 'q3']);
    // Still exactly ONE analytics event across all three writes. Only one empty
    // FullSync ever arrived; the convergence re-push (#2) was driven by a local
    // queue edit, not by a FullSync. Firing the event unconditionally inside
    // reSeedQueueAfterFailedSeed counts it too, so a user adding climbs while
    // the session starts inflates the metric by one per mid-flight edit.
    expect(guardedTrackCalls()).toHaveLength(1);
    // Converged on the latest snapshot — snapshot dropped, queue intact.
    expect(snapshots.at(-1)?.state.queue.map((item) => item.uuid)).toEqual(['q1', 'q2', 'q3']);
    expect(queueSnapshotStore.clearStoredQueueSnapshot).toHaveBeenCalled();
  });

  it('keeps the guard armed and reports the error when the re-seed itself rejects', async () => {
    // The .catch path: reSeedQueueRef.current rejecting must not clear the
    // seed-failed flag — the guard stays armed so the NEXT reconnect's empty
    // FullSync retries the whole-queue push instead of silently giving up.
    queueMutations.setQueue.mockReset();
    queueMutations.setQueue.mockRejectedValueOnce(new Error('seed failed')); // the seed
    queueMutations.setQueue.mockRejectedValueOnce(new Error('re-seed failed')); // re-seed attempt #1
    queueMutations.setQueue.mockResolvedValue(undefined); // re-seed attempt #2 (retry) succeeds

    const snapshots = await renderWithLocalQueue(['q1', 'q2']);
    await act(async () => {
      await snapshots.at(-1)?.startSession();
    });
    await waitFor(() => {
      expect(ws.getQueueUpdatesSink()).not.toBeNull();
    });
    const queueUpdatesSink = ws.getQueueUpdatesSink();
    if (!queueUpdatesSink) throw new Error('queue updates sink was not captured');

    // First empty FullSync: guarded, re-seed attempt #1 rejects.
    act(() => {
      queueUpdatesSink.next({ data: { queueUpdates: wireFullSync(1, 'empty-hash') } });
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // The rejection is reported, not swallowed silently.
    expect(errorReporter.reportHandledError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { source: 'startSessionSeed', op: 'reseed' } }),
    );
    // The queue was never wiped, and the flag was never cleared on failure —
    // no clearStoredQueueSnapshot call yet.
    expect(snapshots.at(-1)?.state.queue.map((item) => item.uuid)).toEqual(['q1', 'q2']);
    expect(queueMutations.setQueue).toHaveBeenCalledTimes(2);
    expect(queueSnapshotStore.clearStoredQueueSnapshot).not.toHaveBeenCalled();
    // One guarded FullSync so far, so one event — a re-seed that goes on to
    // reject still counts, since the FullSync really was guarded into a write.
    expect(guardedTrackCalls()).toHaveLength(1);

    // A later reconnect's empty FullSync retries the push, since the guard is
    // still armed for this session.
    act(() => {
      queueUpdatesSink.next({ data: { queueUpdates: wireFullSync(2, 'empty-hash-2') } });
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(queueMutations.setQueue).toHaveBeenCalledTimes(3);
    expect(snapshots.at(-1)?.state.queue.map((item) => item.uuid)).toEqual(['q1', 'q2']);
    expect(queueSnapshotStore.clearStoredQueueSnapshot).toHaveBeenCalled();
    // Two genuine empty FullSyncs were guarded into two writes, so two events.
    // This is the one re-seed path where the count legitimately climbs — pinning
    // it stops a future "just count once per session" shortcut from silently
    // undercounting the retry that a rejected re-seed depends on.
    expect(guardedTrackCalls()).toHaveLength(2);
  });
});
