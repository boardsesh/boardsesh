// @vitest-environment jsdom
//
// Queue-item attribution (#3995). Mobile used to send a bare `{ uuid, climb }`
// for every queue mutation, so a climb queued from a phone reached the crew with
// no name and no avatar — and the phone's next full-queue write stripped the
// attribution off the climbs they had queued from web.
//
// Two halves are under test here, and they pull in opposite directions:
//   1. a climb THIS device introduces must carry this climber's identity;
//   2. an item that came from a PEER must be forwarded untouched — an over-eager
//      identity fallback would re-author the whole crew's queue on the next
//      whole-queue write.
//
// The WS/HTTP/store harness follows queue-provider-sync-gate.test.tsx (it is the
// one that captures the `queueUpdates` sink, needed to deliver a peer item the
// way production does). Unlike the sibling suites, `@boardsesh/queue-react` is
// mocked with `importOriginal` so the REAL wire mapper stays in place — a
// wholesale mock would stub out the very code these tests exist to check.
import { act, render, waitFor } from '@testing-library/react';
import { createElement, useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type { ClimbQueueItemInput, SessionStatus, SessionUser, UserBoard } from '@boardsesh/shared-schema';

const ws = vi.hoisted(() => {
  type WsEventName = 'connected' | 'closed';
  type QueueUpdatesSink = { next: (payload: { data?: { queueUpdates?: unknown } }) => void };
  let queueUpdatesSink: QueueUpdatesSink | null = null;
  const listeners: Record<WsEventName, Set<() => void>> = { connected: new Set(), closed: new Set() };
  return {
    getQueueUpdatesSink: () => queueUpdatesSink,
    client: {
      on: vi.fn((eventName: WsEventName, listener: () => void) => {
        listeners[eventName].add(listener);
        return () => {
          listeners[eventName].delete(listener);
        };
      }),
      subscribe: vi.fn((request: { query: string }, sink: { next: (payload: unknown) => void }) => {
        if (request.query.includes('queueUpdates')) queueUpdatesSink = sink as QueueUpdatesSink;
        return vi.fn();
      }),
    },
    reset: () => {
      queueUpdatesSink = null;
      listeners.connected.clear();
      listeners.closed.clear();
    },
  };
});

const graph = vi.hoisted(() => ({ execute: vi.fn() }));
const http = vi.hoisted(() => ({ request: vi.fn() }));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
const errorReporter = vi.hoisted(() => ({ reportError: vi.fn(), reportHandledError: vi.fn() }));

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

const queueMutations = vi.hoisted(() => ({
  addQueueItem: vi.fn(async (_item: ClimbQueueItem) => {}),
  removeQueueItem: vi.fn(async () => {}),
  reorderQueueItem: vi.fn(async () => {}),
  setCurrentClimb: vi.fn(async (_item: ClimbQueueItem, _shouldAddToQueue: boolean, _correlationId?: string) => {}),
  mirrorCurrentClimb: vi.fn(async () => {}),
  publishPlaybackState: vi.fn(async () => {}),
  setQueue: vi.fn(async (_queue: ClimbQueueItem[], _currentClimbQueueItem?: ClimbQueueItem) => {}),
  replaceQueueItem: vi.fn(async () => {}),
  confirmClimbOnWall: vi.fn(async () => {}),
  reportWallDisconnect: vi.fn(async () => {}),
  setSessionBoardSerial: vi.fn(async () => {}),
  setSessionBoardPath: vi.fn(async () => {}),
}));

// The deps mobile hands the shared hook, so the REAL item->wire mapper can be
// called directly at the end of the chain.
type CapturedMutationDeps = { toQueueItemInput: (item: ClimbQueueItem) => ClimbQueueItemInput };
const capturedMutationDeps = vi.hoisted(() => ({ current: null as CapturedMutationDeps | null }));

const sessionStore = vi.hoisted(() => ({
  getStoredSessionId: vi.fn(async () => 'session-1' as string | null),
  setStoredSessionId: vi.fn(async () => {}),
  clearStoredSessionId: vi.fn(async () => {}),
  getStoredCreatedSessionId: vi.fn(async () => null as string | null),
  setStoredCreatedSessionId: vi.fn(async () => {}),
  clearStoredCreatedSessionId: vi.fn(async () => {}),
}));

const queueSnapshotStore = vi.hoisted(() => ({
  getStoredQueueSnapshot: vi.fn(async () => null),
  setStoredQueueSnapshot: vi.fn(async () => {}),
  clearStoredQueueSnapshot: vi.fn(async () => {}),
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
// importOriginal, NOT a wholesale replacement: the real mapper must survive.
vi.mock('@boardsesh/queue-react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/queue-react')>()),
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
  useSetActiveBoard: () => activeBoard.setActiveBoard,
}));
vi.mock('../../lib/graphql/client', () => ({ getHttpClient: () => ({ request: http.request }) }));
vi.mock('../../lib/analytics', () => ({ track: vi.fn(), registerRenderSuperProperties: vi.fn() }));
vi.mock('../toast-provider', () => ({ useToast: () => ({ showToast: toast.showToast }) }));
vi.mock('../queue-snackbar-provider', () => ({ useQueueSnackbar: () => ({ showQueueAddedSnackbar: vi.fn() }) }));
// A signed-in climber with a resolved party profile — the only state in which
// this device stamps identity at all.
// The cross-board add gate calls useChoose()/useQueryClient()/expo-router, none of
// which this harness mounts. Pass every add straight through — the gate's own
// behaviour is covered by queue-provider-cross-board-add.test.tsx.
vi.mock('../queue/use-cross-board-add-gate', () => ({
  useCrossBoardAddGate: () => async () => ({ outcome: 'add' }),
}));
vi.mock('../party-profile-provider', () => ({
  usePartyProfile: () => ({
    profile: { id: 'party-uuid-1' },
    username: 'Marco',
    avatarUrl: 'https://example.test/marco.png',
  }),
}));
vi.mock('../../lib/error-reporting', () => ({
  reportError: errorReporter.reportError,
  reportHandledError: errorReporter.reportHandledError,
}));

import { QueueProvider, useQueue } from '../queue-provider';

const SELF_ATTRIBUTION = {
  id: 'party-uuid-1',
  username: 'Marco',
  avatarUrl: 'https://example.test/marco.png',
};
const PEER_ATTRIBUTION = { id: 'web-peer', username: 'Ana', avatarUrl: 'https://example.test/ana.png' };

type Snapshot = {
  state: ReturnType<typeof useQueue>['state'];
  sessionId: string | null;
  addToQueue: ReturnType<typeof useQueue>['addToQueue'];
  setQueue: ReturnType<typeof useQueue>['setQueue'];
  setCurrentClimb: ReturnType<typeof useQueue>['setCurrentClimb'];
};

function Probe({ onSnapshot }: { onSnapshot: (snapshot: Snapshot) => void }) {
  const queue = useQueue();
  useEffect(() => {
    onSnapshot({
      state: queue.state,
      sessionId: queue.sessionId,
      addToQueue: queue.addToQueue,
      setQueue: queue.setQueue,
      setCurrentClimb: queue.setCurrentClimb,
    });
  }, [queue.state, queue.sessionId, queue.addToQueue, queue.setQueue, queue.setCurrentClimb, onSnapshot]);
  return null;
}

function renderProvider(onSnapshot: (snapshot: Snapshot) => void) {
  return render(createElement(QueueProvider, null, createElement(Probe, { onSnapshot })));
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
      isLeader: false,
      lastConnectedBoardSerial: null,
      boardPath: '/kilter/1/10/1,2/40/list',
      users: [user({ id: 'participant-self', username: 'Marco', userId: 'db-self' })],
    },
  };
}

const statusResponse = (status: SessionStatus | null = 'active') => ({ sessionStatus: status });

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

// Wire-shaped item as SUBSCRIPTION_QUEUE_ITEM_FIELDS now selects it: climb plus
// the four item-level fields.
type WirePeerItem = {
  uuid: string;
  climb: ClimbQueueItem['climb'];
  addedBy: string | null;
  addedByUser: { id: string; username: string; avatarUrl: string } | null;
  tickedBy: string[] | null;
  suggested: boolean | null;
};

function wirePeerItem(uuid: string): WirePeerItem {
  const { climb } = makeQueueItem(uuid);
  return {
    uuid,
    climb,
    addedBy: 'client-web-1',
    addedByUser: PEER_ATTRIBUTION,
    tickedBy: null,
    suggested: null,
  };
}

function wireFullSync(sequence: number, stateHash: string, queue: WirePeerItem[]) {
  return {
    __typename: 'FullSync',
    sequence,
    state: { sequence, stateHash, queue, currentClimbQueueItem: null },
  };
}

/** Render, join, and push a FullSync carrying the given peer items. */
async function renderWithPeerQueue(snapshots: Snapshot[], peerItems: WirePeerItem[]) {
  renderProvider((snapshot) => snapshots.push(snapshot));
  await waitFor(() => {
    expect(ws.getQueueUpdatesSink()).not.toBeNull();
    expect(snapshots.at(-1)?.sessionId).toBe('session-1');
  });
  const queueUpdatesSink = ws.getQueueUpdatesSink();
  if (!queueUpdatesSink) throw new Error('queue updates sink was not captured');
  act(() => {
    queueUpdatesSink.next({ data: { queueUpdates: wireFullSync(1, 'hash-1', peerItems) } });
  });
  await waitFor(() => {
    expect(snapshots.at(-1)?.state.queue.map((item) => item.uuid)).toEqual(peerItems.map((item) => item.uuid));
  });
}

describe('QueueProvider queue-item attribution (#3995)', () => {
  beforeEach(() => {
    ws.reset();
    ws.client.on.mockClear();
    ws.client.subscribe.mockClear();
    capturedMutationDeps.current = null;
    activeBoard.getStoredActiveBoard.mockReset();
    activeBoard.getStoredActiveBoard.mockResolvedValue(activeBoard.stored);
    toast.showToast.mockClear();
    errorReporter.reportError.mockClear();
    errorReporter.reportHandledError.mockClear();
    for (const mutation of Object.values(queueMutations) as Array<ReturnType<typeof vi.fn>>) {
      mutation.mockReset();
      mutation.mockResolvedValue(undefined);
    }
    sessionStore.getStoredSessionId.mockReset();
    sessionStore.getStoredSessionId.mockResolvedValue('session-1');
    graph.execute.mockReset();
    graph.execute.mockResolvedValue(createJoinSessionResponse());
    http.request.mockReset();
    http.request.mockImplementation(async (operation: string) => {
      if (operation.includes('SessionStatus')) return statusResponse();
      return { endSession: { sessionId: 'session-1' } };
    });
  });

  it('stamps the local climber onto a climb queued from this phone', async () => {
    const snapshots: Snapshot[] = [];
    await renderWithPeerQueue(snapshots, []);

    act(() => {
      snapshots.at(-1)?.addToQueue(makeQueueItem('mine-1'));
    });

    await waitFor(() => expect(queueMutations.addQueueItem).toHaveBeenCalledTimes(1));
    const broadcastItem = queueMutations.addQueueItem.mock.calls[0]?.[0];
    expect(broadcastItem?.addedByUser).toEqual(SELF_ATTRIBUTION);
    expect(broadcastItem?.addedBy).toBe('client-self');
    // Local state and broadcast must agree — a phone that shows no author on its
    // own row while peers see one is the same bug from the other side.
    expect(snapshots.at(-1)?.state.queue.find((item) => item.uuid === 'mine-1')?.addedByUser).toEqual(SELF_ATTRIBUTION);
  });

  it('does not claim a climb a peer added, on a whole-queue write', async () => {
    const snapshots: Snapshot[] = [];
    // The peer item arrives the way production delivers it: over the queueUpdates
    // subscription, rebuilt by toClimbQueueItem.
    await renderWithPeerQueue(snapshots, [wirePeerItem('peer-1')]);
    expect(snapshots.at(-1)?.state.queue[0]?.addedByUser).toEqual(PEER_ATTRIBUTION);

    // Now this phone rewrites the whole queue (playlist activation, generated
    // session, reorder) — the vector that used to anonymise the crew's climbs.
    const peerItem = snapshots.at(-1)?.state.queue[0];
    if (!peerItem) throw new Error('peer item was not applied to local state');
    act(() => {
      snapshots.at(-1)?.setQueue([peerItem, makeQueueItem('mine-1')]);
    });

    await waitFor(() => expect(queueMutations.setQueue).toHaveBeenCalledTimes(1));
    const [broadcastQueue] = queueMutations.setQueue.mock.calls[0] ?? [];
    expect(broadcastQueue?.[0]?.addedByUser).toEqual(PEER_ATTRIBUTION);
    expect(broadcastQueue?.[0]?.addedBy).toBe('client-web-1');
    // The climb this phone contributed in the same write does get stamped.
    expect(broadcastQueue?.[1]?.addedByUser).toEqual(SELF_ATTRIBUTION);
  });

  it('forwards an already-attributed item handed straight to setQueue', async () => {
    const snapshots: Snapshot[] = [];
    await renderWithPeerQueue(snapshots, []);

    const peerItem: ClimbQueueItem = {
      ...makeQueueItem('peer-2'),
      addedBy: 'client-web-1',
      addedByUser: PEER_ATTRIBUTION,
    };
    act(() => {
      snapshots.at(-1)?.setQueue([peerItem]);
    });

    await waitFor(() => expect(queueMutations.setQueue).toHaveBeenCalledTimes(1));
    const [broadcastQueue] = queueMutations.setQueue.mock.calls[0] ?? [];
    expect(broadcastQueue?.[0]?.addedByUser).toEqual(PEER_ATTRIBUTION);
  });

  it("does not re-author an unattributed item already in this device's queue", async () => {
    const snapshots: Snapshot[] = [];
    // A peer running an older client sends an item with no attribution at all.
    const unattributed = { ...wirePeerItem('peer-3'), addedBy: null, addedByUser: null };
    await renderWithPeerQueue(snapshots, [unattributed]);

    const queuedItem = snapshots.at(-1)?.state.queue[0];
    if (!queuedItem) throw new Error('peer item was not applied to local state');
    act(() => {
      snapshots.at(-1)?.setCurrentClimb(queuedItem);
    });

    await waitFor(() => expect(queueMutations.setCurrentClimb).toHaveBeenCalledTimes(1));
    const broadcastItem = queueMutations.setCurrentClimb.mock.calls[0]?.[0];
    expect(broadcastItem?.addedByUser).toBeUndefined();
    expect(broadcastItem?.addedBy).toBeFalsy();
  });

  it('serialises the stamped fields through the wire mapper mobile injects', async () => {
    const snapshots: Snapshot[] = [];
    await renderWithPeerQueue(snapshots, []);

    act(() => {
      snapshots.at(-1)?.addToQueue({ ...makeQueueItem('mine-2'), suggested: true });
    });
    await waitFor(() => expect(queueMutations.addQueueItem).toHaveBeenCalledTimes(1));

    const stampedItem = queueMutations.addQueueItem.mock.calls[0]?.[0];
    const toQueueItemInput = capturedMutationDeps.current?.toQueueItemInput;
    if (!stampedItem || !toQueueItemInput) throw new Error('mutation deps were not captured');

    const wireInput = toQueueItemInput(stampedItem);
    expect(wireInput.addedByUser).toEqual(SELF_ATTRIBUTION);
    expect(wireInput.addedBy).toBe('client-self');
    expect(wireInput.suggested).toBe(true);
    expect(wireInput.climb.name).toBe('Climb mine-2');
  });
});
