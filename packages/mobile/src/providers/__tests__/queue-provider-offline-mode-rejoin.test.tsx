// @vitest-environment jsdom
//
// Offline mode on → off must leave the crew session usable (found in QA of the
// crew rest clock, #6757). Turning offline mode on makes ConnectivityBridge
// dispose the graphql-ws client; the next `getWsClient()` builds a NEW one. The
// realtime engine kept its listeners and its queue/session subscriptions on the
// disposed client, so nothing re-joined the session on the new one, and every
// session mutation (FIRE, wall confirm, queue edits) went out on a fresh,
// never-joined connection: "Must be in a session to perform this operation
// (connectionId: <a different id each time>)".
//
// A second defect hid behind the first: graphql-ws's lazy mode closed the socket
// the moment JOIN_SESSION completed, before the streams or the mutation that
// follow it were sent, so they landed on a fresh, never-joined connection. On a
// normal launch the notification stream usually held the socket open; this
// harness has no such stream, which is what the first case below pins.
//
// Mocked transports cannot see this, so this suite runs the REAL stack from the
// queue provider down: `createWsClientModule`, `@boardsesh/graphql-client`,
// graphql-ws itself, the connectivity store and ConnectivityBridge. Only the
// socket is fake — a small graphql-transport-ws server that, like the backend,
// binds the session to the CONNECTION on JoinSession and rejects a
// membership-requiring mutation on a connection that never joined. Closes are
// asynchronous, as on a real socket.
vi.mock('../queue/use-board-continuation-feed', () => ({
  useBoardContinuationFeed: () => ({ climbs: [], isSettled: true }),
}));

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { createElement, useEffect, type RefObject } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';

const server = await vi.hoisted(async () =>
  (await import('./helpers/fake-graphql-ws-server')).createFakeGraphqlWsServer(),
);

// The REAL ws-client module, built from the shared core exactly as
// `ws-client.ts` builds it, with the fake socket and the real connectivity
// store's offline-mode switch.
vi.mock('../../lib/graphql/ws-client', async () => {
  const { createWsClientModule } = await import('../../lib/graphql/ws-client-core');
  const { getConnectivitySnapshot } = await import('../../lib/connectivity/connectivity-store');
  return createWsClientModule({
    createSocket: (url) => new server.FakeServerSocket(url) as unknown as WebSocket,
    captureAuthCredentialGeneration: () => 1,
    getAuthToken: async () => 'jwt-token',
    isAuthCredentialGenerationCurrent: () => true,
    ensureFreshToken: async () => true,
    recoverAuthRejection: async () => 'refreshed' as const,
    isOfflineModeOn: () => getConnectivitySnapshot().offlineMode,
    getClientIdentity: () => 'boardsesh-mobile/test',
  });
});

const http = vi.hoisted(() => ({
  request: vi.fn(),
}));

const analytics = vi.hoisted(() => ({
  track: vi.fn(),
  registerRenderSuperProperties: vi.fn(),
}));

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
  getQueueSnapshotGeneration: () => 0,
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

vi.mock('@boardsesh/play-view', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/play-view')>()),
  emitWallConfirm: vi.fn(),
}));

vi.mock('../feature-flags-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../feature-flags-provider')>()),
  useBackendOutageDetectionEnabled: () => true,
  useInteractiveRequestDeadlineEnabled: () => true,
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

vi.mock('../party-profile-provider', () => ({
  usePartyProfile: () => ({ username: undefined, avatarUrl: undefined }),
}));

vi.mock('../../lib/error-reporting', () => ({
  reportError: errorReporter.reportError,
  reportHandledError: errorReporter.reportHandledError,
}));

vi.mock('../queue/use-reachable-board-keys', () => ({
  useReachableBoardKeys: () => new Set<string>(),
}));

import {
  __resetConnectivityStoreForTests,
  bindConnectivityStore,
  setDevForcedUnreachable,
  setOfflineMode,
} from '../../lib/connectivity/connectivity-store';
import { ConnectivityBridge } from '../../components/connectivity-bridge';
import { disposeWsClient } from '../../lib/graphql/ws-client';
import { WS_LAZY_CLOSE_TIMEOUT_MS } from '../../lib/graphql/ws-client-core';
import { __resetWsClientLifecycleForTests } from '../../lib/graphql/ws-client-lifecycle';
import { QueueProvider, useQueue } from '../queue-provider';

type QueueHandle = ReturnType<typeof useQueue>;

function Probe({ queueRef }: { queueRef: RefObject<QueueHandle | null> }) {
  const queue = useQueue();
  useEffect(() => {
    queueRef.current = queue;
  }, [queue, queueRef]);
  return null;
}

function renderApp() {
  const queueRef: RefObject<QueueHandle | null> = { current: null };
  render(
    createElement(
      'div',
      null,
      createElement(ConnectivityBridge),
      createElement(QueueProvider, null, createElement(Probe, { queueRef })),
    ),
  );
  return queueRef;
}

function currentQueue(queueRef: RefObject<QueueHandle | null>): QueueHandle {
  if (!queueRef.current) throw new Error('queue context not mounted');
  return queueRef.current;
}

/** Server-side records of membership-requiring mutations from `fromIndex` on. */
function sessionMutationsSince(fromIndex: number) {
  return server.operations
    .slice(fromIndex)
    .filter((operation) => operation.operationName !== 'JoinSession' && operation.outcome !== 'subscribed');
}

async function waitForLiveSession() {
  await waitFor(() => {
    expect(server.liveSessionSocket()).not.toBeNull();
  });
  const socket = server.liveSessionSocket();
  if (!socket) throw new Error('no live session socket');
  return socket;
}

/** Let a few socket round trips (all setTimeout(0)) play out. */
async function settleNetwork() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

describe('QueueProvider — crew session after Offline mode on → off', () => {
  beforeEach(() => {
    server.reset();
    __resetConnectivityStoreForTests();
    bindConnectivityStore({
      probe: async () => 'healthy',
      readDeviceState: async () => ({ device: 'online', deviceReachability: 'reachable' }),
      onOnlineChange: () => {},
    });
    activeBoard.getStoredActiveBoard.mockReset();
    activeBoard.getStoredActiveBoard.mockResolvedValue(activeBoard.stored);
    toast.showToast.mockClear();
    errorReporter.reportHandledError.mockClear();
    sessionStore.getStoredSessionId.mockReset();
    sessionStore.getStoredSessionId.mockResolvedValue('session-1');
    http.request.mockReset();
    // Cold-start restore verifies the stored session over HTTP before joining.
    http.request.mockImplementation(async (operation: string) => {
      if (operation.includes('SessionStatus')) return { sessionStatus: 'active' };
      if (operation.includes('GetSessionQueueState')) return { session: { queueState: null } };
      return {};
    });
  });

  afterEach(() => {
    cleanup();
    // The ws-client module is one per file, like the app's: drop this test's
    // client so the next test cannot inherit a socket the fake server reset.
    disposeWsClient();
    // A test that failed before its own teardown must not leave listeners on
    // the module-level buses for the next one.
    __resetWsClientLifecycleForTests();
    __resetConnectivityStoreForTests();
    vi.useRealTimers();
  });

  // Nothing but the session holds the socket here, so the join's own
  // completion must not close it under the streams and mutations that follow.
  it('joins and confirms a climb on the wall over one connection on a normal launch', async () => {
    const queueRef = renderApp();
    const socket = await waitForLiveSession();

    const mark = server.operations.length;
    await act(async () => {
      await currentQueue(queueRef).confirmClimbOnWall('climb-a');
    });

    expect(sessionMutationsSince(mark)).toEqual([
      { connectionId: socket.connectionId, operationName: 'ConfirmClimbOnWall', outcome: 'ok' },
    ]);
  });

  it('re-joins on the new connection after Offline mode on → off, so session mutations land', async () => {
    const queueRef = renderApp();
    const firstSocket = await waitForLiveSession();

    await act(async () => {
      setOfflineMode(true, 'more');
    });
    // Offline mode really talks to no server: the bridge cut the socket.
    await waitFor(() => {
      expect(server.openSockets()).toHaveLength(0);
    });

    await act(async () => {
      setOfflineMode(false, 'more');
    });

    // The session comes back by itself: a fresh connection joins and carries
    // the live queue + session streams again.
    const rejoinedSocket = await waitForLiveSession();
    expect(rejoinedSocket.connectionId).not.toBe(firstSocket.connectionId);

    // FIRE twice, a moment apart, like a climber resting between goes. Both land
    // on the joined connection: no "Must be in a session" from a fresh socket.
    const mark = server.operations.length;
    await act(async () => {
      await currentQueue(queueRef).confirmClimbOnWall('climb-b');
    });
    await settleNetwork();
    await act(async () => {
      await currentQueue(queueRef).confirmClimbOnWall('climb-c');
    });

    expect(sessionMutationsSince(mark)).toEqual([
      { connectionId: rejoinedSocket.connectionId, operationName: 'ConfirmClimbOnWall', outcome: 'ok' },
      { connectionId: rejoinedSocket.connectionId, operationName: 'ConfirmClimbOnWall', outcome: 'ok' },
    ]);
    expect(toast.showToast).not.toHaveBeenCalledWith('mobile.queue.syncError', 'error');
  });

  it('lands a mutation fired straight after Offline mode goes off on the joined connection', async () => {
    const queueRef = renderApp();
    await waitForLiveSession();

    await act(async () => {
      setOfflineMode(true, 'more');
    });
    await waitFor(() => {
      expect(server.openSockets()).toHaveLength(0);
    });

    // No wait for the re-join: the tap races it and must queue behind it.
    const mark = server.operations.length;
    await act(async () => {
      setOfflineMode(false, 'more');
      await currentQueue(queueRef).confirmClimbOnWall('climb-d');
    });

    const rejoinedSocket = await waitForLiveSession();
    expect(sessionMutationsSince(mark)).toEqual([
      { connectionId: rejoinedSocket.connectionId, operationName: 'ConfirmClimbOnWall', outcome: 'ok' },
    ]);
  });

  it('joins on the real connection when the app launched with Offline mode already on', async () => {
    // Restored from the setting before anything mounted: no socket was ever
    // opened, so the bridge has nothing to dispose and the engine starts parked.
    setOfflineMode(true, 'more');
    const queueRef = renderApp();
    await waitFor(() => {
      expect(queueRef.current?.sessionId).toBe('session-1');
    });
    await settleNetwork();
    expect(server.openSockets()).toHaveLength(0);

    await act(async () => {
      setOfflineMode(false, 'more');
    });

    const socket = await waitForLiveSession();
    const mark = server.operations.length;
    await act(async () => {
      await currentQueue(queueRef).confirmClimbOnWall('climb-e');
    });

    expect(sessionMutationsSince(mark)).toEqual([
      { connectionId: socket.connectionId, operationName: 'ConfirmClimbOnWall', outcome: 'ok' },
    ]);
    expect(toast.showToast).not.toHaveBeenCalledWith('mobile.queue.syncError', 'error');
  });

  // The engine parks before it binds a client during a backend outage, so it
  // never sees that socket close. A tap still joins on its way out; once that
  // socket idles out, the cached join must not be trusted on the next one.
  it('re-joins when a join made while the engine was parked has idled out', async () => {
    // Fake timers so the 3 s idle hold costs no wall-clock time; they still
    // advance with real time, which the socket round trips and waitFor need.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setDevForcedUnreachable(true);
    const queueRef = renderApp();
    await waitFor(() => {
      expect(queueRef.current?.sessionId).toBe('session-1');
    });
    await settleNetwork();
    expect(server.openSockets()).toHaveLength(0);

    await act(async () => {
      await currentQueue(queueRef).confirmClimbOnWall('climb-f');
    });
    const [tapSocket] = server.openSockets();
    expect(tapSocket?.joinedSessionId).toBe('session-1');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WS_LAZY_CLOSE_TIMEOUT_MS + 200);
    });
    expect(server.openSockets()).toHaveLength(0);

    await act(async () => {
      setDevForcedUnreachable(false);
    });

    const socket = await waitForLiveSession();
    expect(socket.connectionId).not.toBe(tapSocket?.connectionId);
    const mark = server.operations.length;
    await act(async () => {
      await currentQueue(queueRef).confirmClimbOnWall('climb-g');
    });
    expect(sessionMutationsSince(mark)).toEqual([
      { connectionId: socket.connectionId, operationName: 'ConfirmClimbOnWall', outcome: 'ok' },
    ]);
  });
});
