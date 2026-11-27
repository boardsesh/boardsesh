// @vitest-environment jsdom
//
// A signed-out climber can start a crew (createSession allows a public,
// non-discoverable session without an account) and can come back to one on a
// cold start. Every ordinary join first reads the session's board through
// `sessionRestoreBoardPath`, which needs an account: the server answers the
// public `sessionStatus` and refuses the board, graphql-request rejects the
// whole read, and the JOIN was never sent. These tests pin the signed-out join:
// it goes out on the phone's own board without `expectedBoardPath`, as every
// join did before the guard. Reuses the harness from
// queue-provider-join-session-ended.test.tsx.
import { act, render, waitFor } from '@testing-library/react';
import { createElement, useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';

const ws = vi.hoisted(() => {
  type WsEventName = 'connected' | 'closed';
  const listeners: Record<WsEventName, Set<() => void>> = {
    connected: new Set(),
    closed: new Set(),
  };
  return {
    client: {
      on: vi.fn((eventName: WsEventName, listener: () => void) => {
        listeners[eventName].add(listener);
        return () => {
          listeners[eventName].delete(listener);
        };
      }),
      subscribe: vi.fn(() => vi.fn()),
    },
    reset: () => {
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
  getStoredCreatedSessionId: vi.fn(async () => null as string | null),
  setStoredCreatedSessionId: vi.fn(async () => {}),
  clearStoredCreatedSessionId: vi.fn(async () => {}),
  setStoredSessionVisibility: vi.fn(async () => {}),
}));

const queueSnapshotStore = vi.hoisted(() => ({
  getStoredQueueSnapshot: vi.fn(async () => null),
  getQueueSnapshotGeneration: () => 0,
  setStoredQueueSnapshot: vi.fn(async () => {}),
  clearStoredQueueSnapshot: vi.fn(async () => {}),
}));

const activeBoard = vi.hoisted(() => {
  const base: UserBoard = {
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
    isOwned: false,
    angle: 40,
    isAngleAdjustable: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    totalAscents: 0,
    uniqueClimbers: 0,
    followerCount: 0,
    commentCount: 0,
    isFollowedByMe: false,
  };
  return {
    base,
    stored: base,
    getStoredActiveBoard: vi.fn(),
    setActiveBoard: vi.fn(async () => {}),
  };
});

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
  AppState: {
    currentState: 'active',
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
  },
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
  getActiveBoardWriteGeneration: () => 0,
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

vi.mock('../queue/use-cross-board-add-gate', () => ({
  useCrossBoardAddGate: () => async () => ({ outcome: 'add' }),
}));

// Signed out: no account and no profile.
vi.mock('../party-profile-provider', () => ({
  usePartyProfile: () => ({
    username: undefined,
    avatarUrl: undefined,
    authenticatedUserId: null,
    isAuthenticated: false,
  }),
}));

vi.mock('../../lib/error-reporting', () => ({
  reportError: errorReporter.reportError,
  reportHandledError: errorReporter.reportHandledError,
}));

vi.mock('../queue/use-board-continuation-feed', () => ({ useBoardContinuationFeed: () => ({ climbs: [] }) }));

vi.mock('../queue/use-reachable-board-keys', () => ({
  useReachableBoardKeys: () => new Set<string>(),
}));

import { QueueProvider, useQueue } from '../queue-provider';

/**
 * What the backend sends a signed-out phone for SESSION_STATUS: the public
 * status, and `requireAuthenticated`'s refusal on the board. graphql-request
 * rejects with this ClientError shape.
 */
function signedOutBoardRefusal(sessionStatus: 'active' | 'ended' | null) {
  return Object.assign(new Error('Authentication required to perform this operation'), {
    response: {
      status: 200,
      data: { sessionStatus, sessionRestoreBoardPath: null },
      errors: [
        {
          message: 'Authentication required to perform this operation',
          path: ['sessionRestoreBoardPath'],
        },
      ],
    },
  });
}

type Snapshot = {
  sessionId: string | null;
  startSession: ReturnType<typeof useQueue>['startSession'];
};

function Probe({ onSnapshot }: { onSnapshot: (snapshot: Snapshot) => void }) {
  const { sessionId, startSession } = useQueue();
  useEffect(() => {
    onSnapshot({ sessionId, startSession });
  }, [sessionId, startSession, onSnapshot]);
  return null;
}

function renderProvider() {
  const snapshots: Snapshot[] = [];
  render(createElement(QueueProvider, null, createElement(Probe, { onSnapshot: (next) => snapshots.push(next) })));
  return snapshots;
}

type JoinVariables = { sessionId?: string; boardPath?: string; expectedBoardPath?: string };

function joinCalls() {
  return (graph.execute.mock.calls as unknown as Array<[unknown, { query: string; variables?: JoinVariables }]>)
    .map(([, operation]) => operation)
    .filter((operation) => operation.query.includes('JoinSession'));
}

const joinFailureReport = expect.objectContaining({ tags: { source: 'queue-sync', op: 'join' } });
const restoreFailureReport = expect.objectContaining({ tags: { source: 'sessionRestore' } });

describe('QueueProvider signed-out join', () => {
  beforeEach(() => {
    ws.reset();
    ws.client.on.mockClear();
    ws.client.subscribe.mockClear();
    activeBoard.stored = activeBoard.base;
    activeBoard.getStoredActiveBoard.mockReset();
    activeBoard.getStoredActiveBoard.mockImplementation(async () => activeBoard.stored);
    toast.showToast.mockClear();
    analytics.track.mockClear();
    errorReporter.reportError.mockClear();
    errorReporter.reportHandledError.mockClear();
    for (const mutation of Object.values(queueMutations) as Array<ReturnType<typeof vi.fn>>) {
      mutation.mockReset();
      mutation.mockResolvedValue(undefined);
    }
    sessionStore.getStoredSessionId.mockReset();
    sessionStore.getStoredSessionId.mockResolvedValue(null);
    sessionStore.setStoredSessionId.mockClear();
    sessionStore.clearStoredSessionId.mockClear();
    graph.execute.mockReset();
    graph.execute.mockImplementation((_client: unknown, operation: { query: string }) =>
      Promise.resolve(
        operation.query.includes('JoinSession')
          ? { joinSession: { participantId: 'anonymous-connection', clientId: 'anonymous-connection', users: [] } }
          : {},
      ),
    );
    http.request.mockReset();
    http.request.mockImplementation(async (operation: string) => {
      if (operation.includes('CreateSession')) return { createSession: { id: 'session-new' } };
      if (operation.includes('SessionStatus')) throw signedOutBoardRefusal('active');
      if (operation.includes('GetSessionQueueState')) return { session: { queueState: null } };
      return {};
    });
  });

  it('joins the crew a signed-out climber just started, on their own board and unguarded', async () => {
    const snapshots = renderProvider();
    await waitFor(() => expect(snapshots.length).toBeGreaterThan(0));

    await act(async () => {
      await expect(snapshots.at(-1)?.startSession()).resolves.toBe('session-new');
    });

    await waitFor(() => expect(joinCalls()).toHaveLength(1));
    const [join] = joinCalls();
    expect(join?.variables).toMatchObject({ sessionId: 'session-new', boardPath: 'kilter/1/10/1,2/40' });
    expect(join?.variables?.expectedBoardPath).toBeUndefined();
    expect(snapshots.at(-1)?.sessionId).toBe('session-new');
    expect(toast.showToast).not.toHaveBeenCalledWith('mobile.queue.syncError', 'error');
    expect(errorReporter.reportHandledError).not.toHaveBeenCalledWith(expect.anything(), joinFailureReport);
  });

  it("keeps a gym wall's shared path when a signed-out climber starts a crew there", async () => {
    activeBoard.stored = { ...activeBoard.base, gymId: 7 };
    const snapshots = renderProvider();
    await waitFor(() => expect(snapshots.length).toBeGreaterThan(0));

    await act(async () => {
      await snapshots.at(-1)?.startSession();
    });

    await waitFor(() => expect(joinCalls()).toHaveLength(1));
    expect(joinCalls()[0]?.variables).toMatchObject({ sessionId: 'session-new', boardPath: '/b/board-1/40' });
  });

  it('rejoins the saved crew on a signed-out cold start', async () => {
    sessionStore.getStoredSessionId.mockResolvedValue('session-1');
    const snapshots = renderProvider();

    await waitFor(() => expect(joinCalls()).toHaveLength(1));
    const [join] = joinCalls();
    expect(join?.variables).toMatchObject({ sessionId: 'session-1', boardPath: 'kilter/1/10/1,2/40' });
    expect(join?.variables?.expectedBoardPath).toBeUndefined();
    expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    expect(sessionStore.clearStoredSessionId).not.toHaveBeenCalled();
    expect(errorReporter.reportError).not.toHaveBeenCalledWith(expect.anything(), restoreFailureReport);
  });

  it('still drops a saved crew the server reports as ended', async () => {
    sessionStore.getStoredSessionId.mockResolvedValue('session-1');
    http.request.mockImplementation(async (operation: string) => {
      if (operation.includes('SessionStatus')) throw signedOutBoardRefusal('ended');
      return {};
    });
    renderProvider();

    await waitFor(() => expect(sessionStore.clearStoredSessionId).toHaveBeenCalled());
    expect(joinCalls()).toHaveLength(0);
  });
});
