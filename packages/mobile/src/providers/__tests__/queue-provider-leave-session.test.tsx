// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react';
import { createElement, useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { ClimbQueueItem } from '@boardsesh/queue';

// Self-contained QueueProvider harness scoped to clearSession's notifyServer
// option: an intentional session switch must emit LEAVE_SESSION so peers see
// the departure immediately (web parity with sendLeaveOnCleanup).

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
  takeControl: vi.fn(async () => {}),
  releaseControl: vi.fn(async () => {}),
  confirmClimbOnWall: vi.fn(async () => {}),
  setSessionBoardSerial: vi.fn(async () => {}),
  setSessionBoardPath: vi.fn(async () => {}),
}));

const sessionStore = vi.hoisted(() => ({
  getStoredSessionId: vi.fn(async () => 'session-1'),
  setStoredSessionId: vi.fn(async () => {}),
  clearStoredSessionId: vi.fn(async () => {}),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default },
  AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-correlation-id' }));
vi.mock('@boardsesh/graphql-client', () => ({ execute: graph.execute }));
vi.mock('@boardsesh/queue-react', () => ({ useQueueMutations: () => queueMutations }));
vi.mock('@boardsesh/play-view', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/play-view')>()),
  emitWallConfirm: vi.fn(),
}));
vi.mock('../../lib/graphql/ws-client', () => ({ getWsClient: () => ws.client }));
vi.mock('../../lib/session-store', () => sessionStore);
vi.mock('../../lib/queue-snapshot-store', () => ({
  getStoredQueueSnapshot: vi.fn(async () => null),
  setStoredQueueSnapshot: vi.fn(async () => {}),
  clearStoredQueueSnapshot: vi.fn(async () => {}),
}));
vi.mock('../../lib/active-board-store', () => ({ getStoredActiveBoard: activeBoard.getStoredActiveBoard }));
vi.mock('../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: activeBoard.stored }),
  useSetActiveBoard: () => vi.fn(async () => {}),
}));
vi.mock('../../lib/graphql/client', () => ({ getHttpClient: () => ({ request: http.request }) }));
vi.mock('../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../queue-snackbar-provider', () => ({ useQueueSnackbar: () => ({ showQueueAddedSnackbar: vi.fn() }) }));

import { QueueProvider, useQueue, useQueueSessionId } from '../queue-provider';

type Snapshot = {
  sessionId: string | null;
  clearSession: ReturnType<typeof useQueue>['clearSession'];
  joinSession: ReturnType<typeof useQueue>['joinSession'];
  addToQueue: ReturnType<typeof useQueue>['addToQueue'];
};

function Probe({ onSnapshot }: { onSnapshot: (snapshot: Snapshot) => void }) {
  const queue = useQueue();
  const { sessionId } = useQueueSessionId();
  useEffect(() => {
    onSnapshot({
      sessionId,
      clearSession: queue.clearSession,
      joinSession: queue.joinSession,
      addToQueue: queue.addToQueue,
    });
  }, [sessionId, queue.clearSession, queue.joinSession, queue.addToQueue, onSnapshot]);
  return null;
}

function leaveSessionCalls() {
  return graph.execute.mock.calls.filter((call) => {
    const operation = call[1] as { query?: string } | undefined;
    return typeof operation?.query === 'string' && operation.query.includes('leaveSession');
  });
}

function operationText(operation: unknown): string {
  if (typeof operation === 'string') return operation;
  if (operation == null || typeof operation !== 'object') return '';
  const operationRecord = operation as Record<string, unknown>;
  if (typeof operationRecord.query === 'string') return operationRecord.query;
  const loc = operationRecord.loc;
  if (loc == null || typeof loc !== 'object') return '';
  const source = (loc as Record<string, unknown>).source;
  if (source == null || typeof source !== 'object') return '';
  const body = (source as Record<string, unknown>).body;
  return typeof body === 'string' ? body : '';
}

// resyncQueueFromServer is the only thing that fires GET_SESSION_QUEUE_STATE, so
// counting these calls tracks how many mutation-failure resyncs actually ran.
function queueStateCalls() {
  return http.request.mock.calls.filter((call) => {
    return operationText(call[0]).includes('GetSessionQueueState');
  });
}

describe('QueueProvider clearSession notifyServer', () => {
  beforeEach(() => {
    ws.client.on.mockClear();
    ws.client.subscribe.mockClear();
    activeBoard.getStoredActiveBoard.mockReset();
    activeBoard.getStoredActiveBoard.mockResolvedValue(activeBoard.stored);
    for (const mutation of Object.values(queueMutations) as Array<ReturnType<typeof vi.fn>>) {
      mutation.mockReset();
      mutation.mockResolvedValue(undefined);
    }
    sessionStore.getStoredSessionId.mockResolvedValue('session-1');
    sessionStore.clearStoredSessionId.mockClear();
    http.request.mockReset();
    // Cold-start restore verifies the session via SESSION_STATUS (#2683);
    // keep the stored session active so these tests land in-session before
    // clearSession.
    http.request.mockImplementation(async (operation: unknown) =>
      operationText(operation).includes('SessionStatus') ? { sessionStatus: 'active' } : {},
    );
    graph.execute.mockReset();
    // joinSession resolves the active session; leaveSession resolves true.
    graph.execute.mockResolvedValue({
      joinSession: {
        participantId: 'participant-self',
        clientId: 'client-self',
        isLeader: false,
        driverParticipantId: null,
        lastConnectedBoardSerial: null,
        boardPath: '/kilter/1/10/1,2/40/list',
        users: [],
      },
      leaveSession: true,
    });
  });

  it('emits LEAVE_SESSION when clearSession is called with notifyServer:true (session switch)', async () => {
    const snapshots: Snapshot[] = [];
    render(createElement(QueueProvider, null, createElement(Probe, { onSnapshot: (snap) => snapshots.push(snap) })));

    // Wait for the stored session to load + JOIN_SESSION to resolve.
    await waitFor(() => expect(snapshots.at(-1)?.sessionId).toBe('session-1'));

    await act(async () => {
      await snapshots.at(-1)?.clearSession({ notifyServer: true });
    });

    // The backend was told we left, BEFORE local state reset cleared the id.
    expect(leaveSessionCalls()).toHaveLength(1);
    await waitFor(() => expect(snapshots.at(-1)?.sessionId).toBeNull());
  });

  it('does NOT emit LEAVE_SESSION for a plain clearSession (remote end / endSession callers)', async () => {
    const snapshots: Snapshot[] = [];
    render(createElement(QueueProvider, null, createElement(Probe, { onSnapshot: (snap) => snapshots.push(snap) })));

    await waitFor(() => expect(snapshots.at(-1)?.sessionId).toBe('session-1'));

    await act(async () => {
      await snapshots.at(-1)?.clearSession();
    });

    expect(leaveSessionCalls()).toHaveLength(0);
    await waitFor(() => expect(snapshots.at(-1)?.sessionId).toBeNull());
  });

  it('still clears local state when the leave mutation rejects (degrades to disconnect grace)', async () => {
    const snapshots: Snapshot[] = [];
    render(createElement(QueueProvider, null, createElement(Probe, { onSnapshot: (snap) => snapshots.push(snap) })));

    await waitFor(() => expect(snapshots.at(-1)?.sessionId).toBe('session-1'));

    graph.execute.mockRejectedValueOnce(new Error('ws wedged'));
    await act(async () => {
      await snapshots.at(-1)?.clearSession({ notifyServer: true });
    });

    // A failed leave must not block the local reset — the switch still proceeds.
    await waitFor(() => expect(snapshots.at(-1)?.sessionId).toBeNull());
  });

  it('resets the resync single-flight guard so the next session can still resync', async () => {
    // A resync fetch that never settles (hung connection) leaves the single-flight
    // guard set. clearSession must reset it — otherwise the guard, carried across a
    // session switch on a still-mounted provider, blocks every future resync.
    let hangNextQueueState = false;
    http.request.mockImplementation((operation: unknown) => {
      const queryText = operationText(operation);
      // Match GetSessionQueueState before the generic GetSession branch — its name
      // contains 'GetSession' too.
      if (queryText.includes('GetSessionQueueState')) {
        // The first resync hangs (pins the guard true); later resyncs resolve.
        if (hangNextQueueState) return new Promise<never>(() => {});
        return Promise.resolve({ session: { queueState: { queue: [], currentClimbQueueItem: null } } });
      }
      // Cold-start status check keeps the stored session alive (#2683). This
      // replaces the beforeEach mock wholesale, so it must answer SessionStatus
      // itself — otherwise the restore guard sees no status and clears the
      // stored session before the test gets in-session.
      if (queryText.includes('SessionStatus')) {
        return Promise.resolve({ sessionStatus: 'active' });
      }
      if (queryText.includes('GetSession')) {
        return Promise.resolve({ session: { id: 'session-1', endedAt: null } });
      }
      return Promise.resolve({});
    });

    const queueItem: ClimbQueueItem = {
      uuid: 'queue-item-resync',
      // angle matches the active board (40) so the re-grade effect leaves it alone.
      climb: { uuid: 'climb-resync', name: 'Test', mirrored: false, angle: 40 } as ClimbQueueItem['climb'],
    };

    const snapshots: Snapshot[] = [];
    render(createElement(QueueProvider, null, createElement(Probe, { onSnapshot: (snap) => snapshots.push(snap) })));
    await waitFor(() => expect(snapshots.at(-1)?.sessionId).toBe('session-1'));

    // First mutation fails → resync fires and hangs, pinning the guard true.
    hangNextQueueState = true;
    queueMutations.addQueueItem.mockRejectedValueOnce(new Error('ws down'));
    await act(async () => {
      snapshots.at(-1)?.addToQueue(queueItem);
    });
    await waitFor(() => expect(queueStateCalls()).toHaveLength(1));

    // Switch sessions: clearSession (must reset the guard) then rejoin the same id.
    hangNextQueueState = false;
    await act(async () => {
      await snapshots.at(-1)?.clearSession();
    });
    await act(async () => {
      await snapshots.at(-1)?.joinSession('session-1', {
        boardPath: '/kilter/1/10/1,2/40/list',
        userBoard: activeBoard.stored,
      });
    });
    await waitFor(() => expect(snapshots.at(-1)?.sessionId).toBe('session-1'));

    // Second mutation fails → the resync must run again. Without the reset the
    // stale guard early-returns and this stays at 1 (the regression).
    queueMutations.addQueueItem.mockRejectedValueOnce(new Error('ws down again'));
    await act(async () => {
      snapshots.at(-1)?.addToQueue(queueItem);
    });
    await waitFor(() => expect(queueStateCalls()).toHaveLength(2));
  });
});
