// @vitest-environment jsdom
//
// #3087: a party session that already ended server-side (leader ended it, or
// it was reaped) while a peer is joining/rejoining used to be treated as a
// generic sync failure — the JOIN_SESSION catch in `startJoinedSubscriptions`
// unconditionally showed `mobile.queue.syncError` and reported a handled
// error, even though `ensureJoined` rejecting with a `SESSION_ENDED`-coded
// `GraphQLOperationError` is expected teardown, not a defect. Web already
// special-cases this exact code (session-connection-ports.ts); this file
// covers the analogous mobile guard: silently clear the stored session and
// show the calm `mobile.toast.sessionEnded` toast instead, while a genuine
// (non-coded) join failure still surfaces the noisy syncError path unchanged.
// Reuses the WS/HTTP/store mock harness pattern from
// queue-provider-backgrounded-join.test.tsx.
import { render, waitFor } from '@testing-library/react';
import { createElement, useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';
import { GraphQLOperationError } from '@boardsesh/graphql-client';

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

import { QueueProvider, useQueue } from '../queue-provider';

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

describe('QueueProvider JOIN_SESSION SESSION_ENDED guard (#3087)', () => {
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
    http.request.mockReset();
    http.request.mockImplementation(async (operation: string) => {
      if (operation.includes('SessionStatus')) return { sessionStatus: 'active' };
      if (operation.includes('GetSessionQueueState')) return { session: { queueState: null } };
      return { endSession: { sessionId: 'session-1' } };
    });
    appState.reset();
    appState.addEventListener.mockClear();
  });

  it('silently clears the session and toasts sessionEnded when JOIN_SESSION rejects with SESSION_ENDED', async () => {
    graph.execute.mockImplementation((_client: unknown, operation: { query: string }) => {
      if (operation.query.includes('JoinSession')) {
        return Promise.reject(
          new GraphQLOperationError([{ message: 'This session has ended', extensions: { code: 'SESSION_ENDED' } }]),
        );
      }
      return Promise.resolve({});
    });

    const { sessionIds } = renderProvider();

    await waitFor(() => {
      expect(toast.showToast).toHaveBeenCalledWith('mobile.toast.sessionEnded', 'success');
    });

    // The session is cleared locally — the probe's sessionId settles to null.
    await waitFor(() => {
      expect(sessionIds.at(-1)).toBeNull();
    });

    expect(sessionStore.clearStoredSessionId).toHaveBeenCalled();
    expect(errorReporter.reportHandledError).not.toHaveBeenCalled();
    // Only the sessionEnded toast fired — never the generic sync-error one.
    expect(toast.showToast).not.toHaveBeenCalledWith('mobile.queue.syncError', 'error');
  });

  it('still reports a genuine (non-coded) join failure as a sync error (regression guard)', async () => {
    graph.execute.mockImplementation((_client: unknown, operation: { query: string }) => {
      if (operation.query.includes('JoinSession')) {
        return Promise.reject(new Error("GraphQL mutation 'JoinSession' timed out after 30000ms"));
      }
      return Promise.resolve({});
    });

    renderProvider();

    await waitFor(() => {
      expect(errorReporter.reportHandledError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ tags: { source: 'queue-sync', op: 'join' } }),
      );
    });
    expect(toast.showToast).toHaveBeenCalledWith('mobile.queue.syncError', 'error');
    expect(toast.showToast).not.toHaveBeenCalledWith('mobile.toast.sessionEnded', 'success');
  });
});
