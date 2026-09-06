// @vitest-environment jsdom
//
// Offline-join hygiene (#4862): while the backend was down, the party-session
// rejoin kept firing JOIN_SESSION on a backoff clamped at 5s — forever — and
// toasted `mobile.queue.syncError` once per retry cycle, so an outage read as
// a broken app and burned battery doing it. The session realtime effect now
// defers the join whenever the connectivity store says we're effectively
// offline (the offline banner owns that message) and re-runs it exactly once
// on the edge back to reachable. Same harness as
// queue-provider-backgrounded-join.test.tsx, with the AppState gate swapped
// for a controllable connectivity store.
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

// Controllable connectivity store. `effectiveOffline` is read synchronously by
// the join gate; `emit` changes the snapshot AND notifies the subscriber the
// realtime effect registers, exactly like a real snapshot change does.
const connectivity = vi.hoisted(() => {
  let effectiveOffline = false;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => ({
      effectiveOffline,
      reason: effectiveOffline ? 'backend_unreachable' : null,
      backend: effectiveOffline ? 'unreachable' : 'reachable',
      device: 'online',
    }),
    /** Change the snapshot without notifying — models an outage that starts
     *  between two reads, e.g. while a backoff timer is already armed. */
    setOffline: (next: boolean) => {
      effectiveOffline = next;
    },
    emit: (next: boolean) => {
      effectiveOffline = next;
      for (const listener of listeners) listener();
    },
    subscribe: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
    listenerCount: () => listeners.size,
    reset: () => {
      effectiveOffline = false;
      listeners.clear();
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

// The app stays foregrounded here — the background gate has its own coverage in
// queue-provider-backgrounded-join.test.tsx.
const appState = vi.hoisted(() => ({
  addEventListener: vi.fn(() => ({ remove: vi.fn() })),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default },
  AppState: {
    currentState: 'active',
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

vi.mock('../../lib/connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: connectivity.getSnapshot,
  subscribeConnectivity: connectivity.subscribe,
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

describe('QueueProvider offline JoinSession hygiene', () => {
  beforeEach(() => {
    ws.reset();
    ws.client.on.mockClear();
    ws.client.subscribe.mockClear();
    connectivity.reset();
    connectivity.subscribe.mockClear();
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
    appState.addEventListener.mockClear();
  });

  it('defers the join while effectively offline — no join, no toast, no error report', async () => {
    connectivity.setOffline(true);

    const { sessionIds } = renderProvider();
    await waitFor(() => {
      expect(sessionIds.at(-1)).toBe('session-1');
    });
    // Let any (incorrectly fired) join settle before asserting the negative.
    await act(async () => {
      await Promise.resolve();
    });

    expect(joinExecuteCalls()).toHaveLength(0);
    // The banner already tells the user the backend is down; a second voice
    // saying "sync error" is what made an outage read as a broken app.
    expect(toast.showToast).not.toHaveBeenCalled();
    expect(errorReporter.reportHandledError).not.toHaveBeenCalled();
  });

  it('re-joins exactly once when the backend comes back', async () => {
    connectivity.setOffline(true);

    const { sessionIds } = renderProvider();
    await waitFor(() => {
      expect(sessionIds.at(-1)).toBe('session-1');
    });
    await waitFor(() => {
      expect(connectivity.listenerCount()).toBeGreaterThan(0);
    });
    expect(joinExecuteCalls()).toHaveLength(0);

    await act(async () => {
      connectivity.emit(false);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(joinExecuteCalls()).toHaveLength(1);
    });
    // The join tracker caches a successful join, so counting JOIN_SESSION
    // alone can't tell one restart from two. The (re)subscribe count can:
    // every startJoinedSubscriptions run opens queueUpdates + sessionUpdates.
    const subscribeCallsAfterRestart = ws.client.subscribe.mock.calls.length;
    // Exactly one restart: one queueUpdates + one sessionUpdates subscription.
    expect(subscribeCallsAfterRestart).toBe(2);

    // The store fires on every snapshot change (probe result, device
    // reachability, offline-mode toggle). With nothing deferred, another one
    // must not re-enter the join path and stack a second pair of streams.
    await act(async () => {
      connectivity.emit(false);
      await Promise.resolve();
    });
    expect(ws.client.subscribe.mock.calls.length).toBe(subscribeCallsAfterRestart);
    expect(joinExecuteCalls()).toHaveLength(1);
    expect(toast.showToast).not.toHaveBeenCalled();
  });

  it('drops the store subscription on teardown, so a later flip cannot re-join', async () => {
    connectivity.setOffline(true);

    const { result, sessionIds } = renderProvider();
    await waitFor(() => {
      expect(sessionIds.at(-1)).toBe('session-1');
    });
    await waitFor(() => {
      expect(connectivity.listenerCount()).toBeGreaterThan(0);
    });

    result.unmount();
    expect(connectivity.listenerCount()).toBe(0);

    await act(async () => {
      connectivity.emit(false);
      await Promise.resolve();
    });

    expect(joinExecuteCalls()).toHaveLength(0);
  });

  it('parks a retry armed before the outage instead of firing it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      graph.execute.mockImplementation((_client: unknown, operation: { query: string }) => {
        if (operation.query.includes('JoinSession')) {
          return Promise.reject(new Error("GraphQL mutation 'JoinSession' timed out after 30000ms"));
        }
        return Promise.resolve({});
      });

      renderProvider();

      // Still online, so the first failure surfaces normally AND arms the 1s
      // backoff retry — unchanged pre-#4862 behaviour while the backend is up.
      await waitFor(() => {
        expect(toast.showToast).toHaveBeenCalledWith('mobile.queue.syncError', 'error');
      });
      expect(joinExecuteCalls()).toHaveLength(1);

      // The backend goes down while that timer is already ticking.
      connectivity.setOffline(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });

      // The retry ran, saw the outage, and parked — no second JOIN_SESSION over
      // 30s where the clamped backoff would have fired six.
      expect(joinExecuteCalls()).toHaveLength(1);
      expect(toast.showToast).toHaveBeenCalledTimes(1);
      expect(errorReporter.reportHandledError).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
