// @vitest-environment jsdom
//
// Backgrounded-join hygiene (#3605): iOS suspends the WebSocket while the app
// is backgrounded, so the autonomous party-session rejoin (JOIN_SESSION over
// graphql-ws) can only time out after 30s and used to surface as a noisy
// `queue-sync/join` Sentry error tagged `in_foreground: false`. The session
// realtime effect now gates the join on AppState: defer while backgrounded,
// suppress an in-flight join that times out over the suspended socket, and
// re-run cleanly on foreground. Reuses the WS/HTTP/store mock harness pattern
// from queue-provider-sync-gate.test.tsx, adding a controllable AppState mock.
import { act, render, waitFor } from '@testing-library/react';
import { createElement, useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser, UserBoard } from '@boardsesh/shared-schema';

const ws = vi.hoisted(() => {
  type WsEventName = 'connected' | 'closed';
  const listeners: Record<WsEventName, Set<() => void>> = {
    connected: new Set(),
    closed: new Set(),
  };
  return {
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

// Controllable AppState: `currentState` is read synchronously by the join gate,
// and the captured `change` handler lets a test drive foreground/background
// transitions.
const appState = vi.hoisted(() => {
  let currentState = 'active';
  const changeHandlers = new Set<(state: string) => void>();
  return {
    getCurrentState: () => currentState,
    setState: (next: string) => {
      currentState = next;
    },
    emitChange: (next: string) => {
      currentState = next;
      for (const handler of changeHandlers) handler(next);
    },
    addEventListener: vi.fn((_event: string, handler: (state: string) => void) => {
      changeHandlers.add(handler);
      return { remove: vi.fn(() => changeHandlers.delete(handler)) };
    }),
    reset: () => {
      currentState = 'active';
      changeHandlers.clear();
    },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default },
  AppState: {
    get currentState() {
      return appState.getCurrentState();
    },
    addEventListener: appState.addEventListener,
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

function createJoinSessionResponse() {
  const self: SessionUser = {
    id: 'participant-self',
    username: 'Self',
    isLeader: false,
    avatarUrl: undefined,
    userId: 'db-self',
    connectionState: 'CONNECTED',
  };
  return {
    joinSession: {
      participantId: 'participant-self',
      clientId: 'client-self',
      isLeader: false,
      lastConnectedBoardSerial: null,
      boardPath: '/kilter/1/10/1,2/40/list',
      users: [self],
    },
  };
}

function Probe({ onSessionId }: { onSessionId: (sessionId: string | null) => void }) {
  const { sessionId } = useQueue();
  useEffect(() => {
    onSessionId(sessionId);
  }, [sessionId, onSessionId]);
  return null;
}

function renderProvider() {
  const sessionIds: Array<string | null> = [];
  const result = render(
    createElement(QueueProvider, null, createElement(Probe, { onSessionId: (id) => sessionIds.push(id) })),
  );
  return { result, sessionIds };
}

/** graph.execute calls whose operation is the JOIN_SESSION mutation. */
function joinExecuteCalls() {
  return graph.execute.mock.calls.filter((call) => {
    const operation = call[1] as { query?: string } | undefined;
    return typeof operation?.query === 'string' && operation.query.includes('JoinSession');
  });
}

describe('QueueProvider backgrounded JoinSession hygiene', () => {
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
    // Cold-start restore verifies the stored session via SESSION_STATUS before
    // rejoining — it must report 'active' or the session id is dropped and no
    // join ever fires.
    http.request.mockImplementation(async (operation: string) => {
      if (operation.includes('SessionStatus')) return { sessionStatus: 'active' };
      if (operation.includes('GetSessionQueueState')) return { session: { queueState: null } };
      return { endSession: { sessionId: 'session-1' } };
    });
    appState.reset();
    appState.addEventListener.mockClear();
  });

  it('defers the join while backgrounded and re-joins cleanly on foreground', async () => {
    // App is already backgrounded when the session restores at mount.
    appState.setState('background');

    const { sessionIds } = renderProvider();
    await waitFor(() => {
      expect(sessionIds.at(-1)).toBe('session-1');
    });
    // Let any (incorrectly fired) join settle before asserting the negative.
    await act(async () => {
      await Promise.resolve();
    });

    // No JOIN_SESSION fired over the suspended socket — so no timeout, no toast,
    // no error report.
    expect(joinExecuteCalls()).toHaveLength(0);
    expect(errorReporter.reportHandledError).not.toHaveBeenCalled();
    expect(toast.showToast).not.toHaveBeenCalled();

    // Returning to the foreground re-runs the deferred join.
    await act(async () => {
      appState.emitChange('active');
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(joinExecuteCalls().length).toBeGreaterThan(0);
    });
    expect(errorReporter.reportHandledError).not.toHaveBeenCalled();
  });

  it('suppresses a join that times out after the app backgrounds mid-flight', async () => {
    // Join fires while foregrounded, then hangs (socket suspends on background).
    let rejectJoin: ((error: unknown) => void) | null = null;
    graph.execute.mockImplementation((_client: unknown, operation: { query: string }) => {
      if (operation.query.includes('JoinSession')) {
        return new Promise((_resolve, reject) => {
          rejectJoin = reject;
        });
      }
      return Promise.resolve({});
    });

    renderProvider();
    await waitFor(() => {
      expect(joinExecuteCalls().length).toBeGreaterThan(0);
    });
    expect(rejectJoin).not.toBeNull();

    // App backgrounds, then the in-flight join trips execute()'s 30s timeout.
    appState.setState('background');
    await act(async () => {
      rejectJoin?.(new Error("GraphQL mutation 'JoinSession' timed out after 30000ms"));
      await Promise.resolve();
    });

    // Expected backgrounded timeout: no error report, no toast.
    expect(errorReporter.reportHandledError).not.toHaveBeenCalled();
    expect(toast.showToast).not.toHaveBeenCalled();
  });

  it('still reports a genuine foreground join failure (regression guard)', async () => {
    graph.execute.mockImplementation((_client: unknown, operation: { query: string }) => {
      if (operation.query.includes('JoinSession')) {
        return Promise.reject(new Error("GraphQL mutation 'JoinSession' timed out after 30000ms"));
      }
      return Promise.resolve({});
    });

    renderProvider();

    // App stays foregrounded, so a real failure must still toast + report.
    await waitFor(() => {
      expect(errorReporter.reportHandledError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ tags: { source: 'queue-sync', op: 'join' } }),
      );
    });
    expect(toast.showToast).toHaveBeenCalledWith('mobile.queue.syncError', 'error');
  });

  it('does not defer the join for the transient iOS "inactive" state', async () => {
    // `inactive` (notification center, app switcher, incoming call) leaves the
    // socket usable, so the gate must fire the join normally — only `background`
    // defers.
    appState.setState('inactive');

    renderProvider();

    await waitFor(() => {
      expect(joinExecuteCalls().length).toBeGreaterThan(0);
    });
    expect(errorReporter.reportHandledError).not.toHaveBeenCalled();
  });
});
