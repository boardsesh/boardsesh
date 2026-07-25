// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react';
import { createElement, useEffect, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';
import type { SessionStatus, SessionUser, UserBoard } from '@boardsesh/shared-schema';

const ws = vi.hoisted(() => {
  type WsEventName = 'connected' | 'closed';
  type WsEvent = { code: number; reason: string; wasClean: boolean };
  type SubscriptionSink = {
    next: (payload: { data?: Record<string, unknown> }) => void;
    error?: (error: unknown) => void;
  };
  let queueUpdatesSink: SubscriptionSink | null = null;
  let sessionUpdatesSink: SubscriptionSink | null = null;
  const listeners: Record<WsEventName, Set<(event?: WsEvent) => void>> = {
    connected: new Set(),
    closed: new Set(),
  };
  const subscriptionCleanups: Array<ReturnType<typeof vi.fn>> = [];
  return {
    getSessionUpdatesSink: () => sessionUpdatesSink,
    getQueueUpdatesSink: () => queueUpdatesSink,
    getSubscriptionCleanups: () => subscriptionCleanups,
    emit: (eventName: WsEventName, event?: WsEvent) => {
      for (const listener of listeners[eventName]) listener(event);
    },
    client: {
      on: vi.fn((eventName: WsEventName, listener: (event?: WsEvent) => void) => {
        listeners[eventName].add(listener);
        return () => {
          listeners[eventName].delete(listener);
        };
      }),
      subscribe: vi.fn((request: { query: string }, sink: SubscriptionSink) => {
        if (request.query.includes('queueUpdates')) {
          queueUpdatesSink = sink;
        }
        if (request.query.includes('sessionUpdates')) {
          sessionUpdatesSink = sink;
        }
        const cleanup = vi.fn();
        subscriptionCleanups.push(cleanup);
        return cleanup;
      }),
    },
    reset: () => {
      queueUpdatesSink = null;
      sessionUpdatesSink = null;
      subscriptionCleanups.length = 0;
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
    canEdit: false,
  } satisfies UserBoard,
  getStoredActiveBoard: vi.fn(),
  setActiveBoard: vi.fn(async () => {}),
}));

const toast = vi.hoisted(() => ({
  showToast: vi.fn(),
}));

// Mutable so a test can flip identity from "still loading" (undefined) to a
// resolved profile and re-render to exercise the re-announce path.
const partyProfile = vi.hoisted(() => ({
  username: undefined as string | undefined,
  avatarUrl: undefined as string | undefined,
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

const wallConfirm = vi.hoisted(() => ({
  emitWallConfirm: vi.fn(),
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
  emitWallConfirm: wallConfirm.emitWallConfirm,
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

vi.mock('../../lib/analytics', () => ({
  track: vi.fn(),
}));

vi.mock('../toast-provider', () => ({
  useToast: () => ({ showToast: toast.showToast }),
}));

vi.mock('../queue-snackbar-provider', () => ({
  useQueueSnackbar: () => ({ showQueueAddedSnackbar: vi.fn() }),
}));

vi.mock('../party-profile-provider', () => ({
  usePartyProfile: () => ({ username: partyProfile.username, avatarUrl: partyProfile.avatarUrl }),
}));

vi.mock('../../lib/auth-transport-revision', async () => import('../../lib/auth-transport-revision.web'));

import {
  QueueProvider,
  useHasActiveClimb,
  usePlaylistSuggestionSource,
  useQueue,
  useQueueLiveStats,
  useQueueSessionControls,
  useQueueSessionId,
} from '../queue-provider';
import { clearStoredSessionId } from '../../lib/session-store';
import { track } from '../../lib/analytics';
import { bumpAuthTransportRevision } from '../../lib/auth-transport-revision';
import { SHARED_EVENTS } from '@boardsesh/analytics';

type Snapshot = {
  state: ReturnType<typeof useQueue>['state'];
  sessionId: string | null;
  users: SessionUser[];
  isSessionWallLit: boolean;
  lastConnectedBoardSerial: string | null;
  playlistSuggestionSource: PlaylistSuggestionSource | null;
  addToQueue: ReturnType<typeof useQueue>['addToQueue'];
  removeFromQueue: ReturnType<typeof useQueue>['removeFromQueue'];
  setQueue: ReturnType<typeof useQueue>['setQueue'];
  setCurrentClimb: ReturnType<typeof useQueue>['setCurrentClimb'];
  nextClimb: ReturnType<typeof useQueue>['nextClimb'];
  setPlaylistSuggestionSource: ReturnType<typeof useQueue>['setPlaylistSuggestionSource'];
  joinSession: (sessionId: string, opts: Parameters<ReturnType<typeof useQueue>['joinSession']>[1]) => Promise<void>;
  endSession: (options?: { notes?: string }) => Promise<unknown>;
  confirmClimbOnWall: ReturnType<typeof useQueue>['confirmClimbOnWall'];
  reportWallDisconnect: ReturnType<typeof useQueue>['reportWallDisconnect'];
  setSessionBoardSerial: ReturnType<typeof useQueue>['setSessionBoardSerial'];
  setSessionBoardPath: ReturnType<typeof useQueue>['setSessionBoardPath'];
};

type SelectorSnapshot = {
  sessionIdValue: ReturnType<typeof useQueueSessionId>;
  hasActiveClimb: boolean;
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

// Response for the cold-start SESSION_STATUS probe. 'active' means restore the
// session; 'ended' or null (no such session row) means drop the stored id.
const statusResponse = (status: SessionStatus | null = 'active') => ({
  sessionStatus: status,
});

function makeQueueItem(uuid: string, climbUuid = uuid, options: { suggested?: boolean } = {}): ClimbQueueItem {
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
    suggested: options.suggested ?? false,
  };
}

function createDeferred<T>() {
  let resolveDeferred: (value: T | PromiseLike<T>) => void = () => {};
  let rejectDeferred: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    resolveDeferred = resolve;
    rejectDeferred = reject;
  });
  return { promise, resolve: resolveDeferred, reject: rejectDeferred };
}

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

function Probe({ onSnapshot }: { onSnapshot: (snapshot: Snapshot) => void }) {
  const queue = useQueue();
  const playlistSuggestionSource = usePlaylistSuggestionSource();
  // sessionUsers moved out of useQueue() into its own live-stats context so the
  // ≤1/2s party push no longer re-renders every queue consumer; read it here.
  const { sessionUsers } = useQueueLiveStats();
  // isSessionWallLit rides the session-controls context (flips on
  // WallConfirmedClimb / off on WallDisconnected); it's also mirrored onto the
  // full useQueue() value, which is what the snapshot reads.
  const { isSessionWallLit } = useQueueSessionControls();
  useEffect(() => {
    onSnapshot({
      state: queue.state,
      sessionId: queue.sessionId,
      users: sessionUsers,
      isSessionWallLit,
      lastConnectedBoardSerial: queue.lastConnectedBoardSerial,
      playlistSuggestionSource,
      addToQueue: queue.addToQueue,
      removeFromQueue: queue.removeFromQueue,
      setQueue: queue.setQueue,
      setCurrentClimb: queue.setCurrentClimb,
      nextClimb: queue.nextClimb,
      setPlaylistSuggestionSource: queue.setPlaylistSuggestionSource,
      joinSession: queue.joinSession,
      endSession: queue.endSession,
      confirmClimbOnWall: queue.confirmClimbOnWall,
      reportWallDisconnect: queue.reportWallDisconnect,
      setSessionBoardSerial: queue.setSessionBoardSerial,
      setSessionBoardPath: queue.setSessionBoardPath,
    });
  }, [
    queue.sessionId,
    queue.state,
    sessionUsers,
    isSessionWallLit,
    queue.lastConnectedBoardSerial,
    playlistSuggestionSource,
    queue.addToQueue,
    queue.removeFromQueue,
    queue.setQueue,
    queue.setCurrentClimb,
    queue.nextClimb,
    queue.setPlaylistSuggestionSource,
    queue.joinSession,
    queue.endSession,
    queue.confirmClimbOnWall,
    queue.reportWallDisconnect,
    queue.setSessionBoardSerial,
    queue.setSessionBoardPath,
    onSnapshot,
  ]);
  return null;
}

function SelectorProbe({ onSnapshot }: { onSnapshot: (snapshot: SelectorSnapshot) => void }) {
  const sessionIdValue = useQueueSessionId();
  const hasActiveClimb = useHasActiveClimb();
  useEffect(() => {
    onSnapshot({ sessionIdValue, hasActiveClimb });
  }, [hasActiveClimb, onSnapshot, sessionIdValue]);
  return null;
}

// useSessionRealtime reads useContext(QueryClientContext) (to invalidate the session-detail
// cache on SessionNameChanged), so every render needs a QueryClient in context.
const testQueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const invalidateQueriesSpy = vi.spyOn(testQueryClient, 'invalidateQueries');

function withQueryClient(node: ReactNode) {
  return createElement(QueryClientProvider, { client: testQueryClient }, node);
}

function renderProvider(onSnapshot: (snapshot: Snapshot) => void) {
  return render(withQueryClient(createElement(QueueProvider, null, createElement(Probe, { onSnapshot }))));
}

function renderProviderWithSelectors(
  onSnapshot: (snapshot: Snapshot) => void,
  onSelectorSnapshot: (snapshot: SelectorSnapshot) => void,
) {
  return render(
    withQueryClient(
      createElement(
        QueueProvider,
        null,
        createElement(Probe, { onSnapshot }),
        createElement(SelectorProbe, { onSnapshot: onSelectorSnapshot }),
      ),
    ),
  );
}

// Find the variables of the graph.execute call whose GraphQL document contains
// `marker` (e.g. the mutation's field name). mock.calls elements are `any[]`, so
// pull the operation out by index rather than tuple-destructuring.
function executeVariablesFor(marker: string): Record<string, unknown> | undefined {
  const call = graph.execute.mock.calls.find((args) => {
    const operation = args[1] as { query?: string } | undefined;
    return operation?.query?.includes(marker) ?? false;
  });
  return call ? (call[1] as { variables?: Record<string, unknown> }).variables : undefined;
}

describe('QueueProvider session update subscription', () => {
  beforeEach(() => {
    ws.reset();
    ws.client.on.mockClear();
    ws.client.subscribe.mockClear();
    invalidateQueriesSpy.mockClear();
    activeBoard.stored = {
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
      canEdit: false,
    };
    activeBoard.getStoredActiveBoard.mockReset();
    activeBoard.getStoredActiveBoard.mockResolvedValue(activeBoard.stored);
    activeBoard.setActiveBoard.mockClear();
    toast.showToast.mockClear();
    // Default to "profile still loading" so existing JOIN/backoff tests keep
    // their exact graph.execute call counts (undefined identity never triggers
    // the re-announce effect). Identity-carrying tests opt in explicitly.
    partyProfile.username = undefined;
    partyProfile.avatarUrl = undefined;
    for (const mutation of Object.values(queueMutations) as Array<ReturnType<typeof vi.fn>>) {
      mutation.mockReset();
      mutation.mockResolvedValue(undefined);
    }
    wallConfirm.emitWallConfirm.mockClear();
    sessionStore.getStoredSessionId.mockReset();
    sessionStore.getStoredSessionId.mockResolvedValue('session-1');
    sessionStore.setStoredSessionId.mockClear();
    sessionStore.clearStoredSessionId.mockClear();
    graph.execute.mockReset();
    vi.mocked(clearStoredSessionId).mockClear();
    http.request.mockReset();
    // The restore effect verifies the session via SESSION_STATUS before
    // rejoining (#2683). Default to an active session so existing tests still
    // auto-restore into session-1; END_SESSION keeps its endSession shape.
    http.request.mockImplementation((operation: string) =>
      operation.includes('SessionStatus')
        ? Promise.resolve(statusResponse())
        : Promise.resolve({ endSession: { sessionId: 'session-1' } }),
    );
    graph.execute.mockResolvedValue(createJoinSessionResponse());
  });

  it('waits for JOIN_SESSION before opening queue and session subscriptions', async () => {
    const snapshots: Snapshot[] = [];
    const selectorSnapshots: SelectorSnapshot[] = [];
    const joinSessionDeferred = createDeferred<ReturnType<typeof createJoinSessionResponse>>();
    graph.execute.mockReturnValueOnce(joinSessionDeferred.promise);

    renderProviderWithSelectors(
      (snapshot) => snapshots.push(snapshot),
      (selectorSnapshot) => selectorSnapshots.push(selectorSnapshot),
    );

    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
      expect(graph.execute).toHaveBeenCalledTimes(1);
    });
    expect(ws.client.subscribe).not.toHaveBeenCalled();

    await act(async () => {
      joinSessionDeferred.resolve(createJoinSessionResponse());
      await joinSessionDeferred.promise;
    });

    await waitFor(() => {
      expect(ws.client.subscribe).toHaveBeenCalledTimes(2);
    });
  });

  it('reacquires the WebSocket subscriptions after the auth transport revision changes', async () => {
    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => expect(ws.client.subscribe).toHaveBeenCalledTimes(2));
    const firstSubscriptionCleanups = [...ws.getSubscriptionCleanups()];

    act(() => bumpAuthTransportRevision());

    await waitFor(() => expect(ws.client.subscribe).toHaveBeenCalledTimes(4));
    expect(firstSubscriptionCleanups).toHaveLength(2);
    expect(firstSubscriptionCleanups[0]).toHaveBeenCalledOnce();
    expect(firstSubscriptionCleanups[1]).toHaveBeenCalledOnce();
  });

  it('retries a failed JOIN_SESSION before opening subscriptions', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    try {
      const snapshots: Snapshot[] = [];
      const selectorSnapshots: SelectorSnapshot[] = [];
      graph.execute.mockRejectedValueOnce(new Error('temporary join failure'));

      renderProviderWithSelectors(
        (snapshot) => snapshots.push(snapshot),
        (selectorSnapshot) => selectorSnapshots.push(selectorSnapshot),
      );

      await waitFor(() => {
        expect(snapshots.at(-1)?.sessionId).toBe('session-1');
        expect(graph.execute).toHaveBeenCalledTimes(1);
      });
      expect(ws.client.subscribe).not.toHaveBeenCalled();
      expect(toast.showToast).toHaveBeenCalledWith('mobile.queue.syncError', 'error');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });

      await waitFor(() => {
        expect(graph.execute).toHaveBeenCalledTimes(2);
        expect(ws.client.subscribe).toHaveBeenCalledTimes(2);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps retrying JOIN_SESSION with capped backoff while the socket stays live', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    try {
      const snapshots: Snapshot[] = [];
      const selectorSnapshots: SelectorSnapshot[] = [];
      graph.execute.mockRejectedValue(new Error('temporary join failure'));

      renderProviderWithSelectors(
        (snapshot) => snapshots.push(snapshot),
        (selectorSnapshot) => selectorSnapshots.push(selectorSnapshot),
      );

      await waitFor(() => {
        expect(snapshots.at(-1)?.sessionId).toBe('session-1');
        expect(graph.execute).toHaveBeenCalledTimes(1);
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
        await vi.advanceTimersByTimeAsync(2_500);
        await vi.advanceTimersByTimeAsync(5_000);
        await vi.advanceTimersByTimeAsync(5_000);
      });

      await waitFor(() => {
        expect(graph.execute).toHaveBeenCalledTimes(5);
      });
      expect(ws.client.subscribe).not.toHaveBeenCalled();
      expect(toast.showToast).toHaveBeenCalledWith('mobile.queue.syncError', 'error');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejoins before reopening subscriptions after a websocket reconnect', async () => {
    const snapshots: Snapshot[] = [];
    const selectorSnapshots: SelectorSnapshot[] = [];
    renderProviderWithSelectors(
      (snapshot) => snapshots.push(snapshot),
      (selectorSnapshot) => selectorSnapshots.push(selectorSnapshot),
    );

    await waitFor(() => {
      expect(ws.client.subscribe).toHaveBeenCalledTimes(2);
    });

    const reconnectJoinDeferred = createDeferred<ReturnType<typeof createJoinSessionResponse>>();
    graph.execute.mockReturnValueOnce(reconnectJoinDeferred.promise);
    ws.client.subscribe.mockClear();

    act(() => {
      ws.emit('closed');
      ws.emit('connected');
    });

    await waitFor(() => {
      expect(graph.execute).toHaveBeenCalledTimes(2);
    });
    expect(ws.client.subscribe).not.toHaveBeenCalled();

    await act(async () => {
      reconnectJoinDeferred.resolve(createJoinSessionResponse());
      await reconnectJoinDeferred.promise;
    });

    await waitFor(() => {
      expect(ws.client.subscribe).toHaveBeenCalledTimes(2);
    });
  });

  it('replaces retained subscriptions after an auth-refresh rejoin without clearing the session', async () => {
    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(ws.client.subscribe).toHaveBeenCalledTimes(2);
    });
    const establishedSubscriptionCleanups = [...ws.getSubscriptionCleanups()];
    const replayedQueueSink = ws.getQueueUpdatesSink();
    const reconnectJoinDeferred = createDeferred<ReturnType<typeof createJoinSessionResponse>>();
    graph.execute.mockReturnValueOnce(reconnectJoinDeferred.promise);

    act(() => {
      // ws-client remaps an authentication-rejected 4401 to retryable 4403.
      ws.emit('closed', { code: 4403, reason: 'Unauthorized', wasClean: false });
    });

    for (const cleanup of establishedSubscriptionCleanups) {
      expect(cleanup).not.toHaveBeenCalled();
    }

    act(() => {
      ws.emit('connected');
    });

    await waitFor(() => {
      // Initial join plus one rejoin for the fresh connection context.
      expect(graph.execute).toHaveBeenCalledTimes(2);
    });

    act(() => {
      replayedQueueSink?.error?.([
        {
          message: 'Unauthorized: not in any session',
          extensions: { code: 'NOT_SESSION_MEMBER', reason: 'no-session-id' },
        },
      ]);
    });

    expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    expect(ws.client.subscribe).toHaveBeenCalledTimes(2);

    await act(async () => {
      reconnectJoinDeferred.resolve(createJoinSessionResponse());
      await reconnectJoinDeferred.promise;
    });

    await waitFor(() => expect(ws.client.subscribe).toHaveBeenCalledTimes(4));
    for (const cleanup of establishedSubscriptionCleanups) {
      expect(cleanup).toHaveBeenCalledOnce();
    }
    expect(snapshots.at(-1)?.sessionId).toBe('session-1');
  });

  it('sends the signed-in profile identity with JOIN_SESSION', async () => {
    partyProfile.username = 'Marco';
    partyProfile.avatarUrl = 'https://example.com/marco.png';
    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(ws.client.subscribe).toHaveBeenCalled();
    });

    expect(executeVariablesFor('joinSession')).toEqual(
      expect.objectContaining({ username: 'Marco', avatarUrl: 'https://example.com/marco.png' }),
    );
    // JOIN already carried the identity, so the re-announce effect must not
    // fire a redundant UPDATE_USERNAME (announcedIdentityRef is seeded at join).
    expect(executeVariablesFor('updateUsername')).toBeUndefined();
  });

  it('re-announces identity with UPDATE_USERNAME when the profile resolves after joining', async () => {
    // Profile still loading at join time — JOIN carries an empty identity and the
    // roster shows the backend's `User-<id>` fallback.
    const snapshots: Snapshot[] = [];
    // A fresh element each render — passing the same reference makes React bail
    // out of re-rendering QueueProvider, so the updated usePartyProfile mock
    // would never be re-read.
    const makeTree = () =>
      withQueryClient(
        createElement(
          QueueProvider,
          null,
          createElement(Probe, { onSnapshot: (snapshot: Snapshot) => snapshots.push(snapshot) }),
        ),
      );
    const { rerender } = render(makeTree());

    await waitFor(() => {
      expect(ws.client.subscribe).toHaveBeenCalled();
    });
    expect(executeVariablesFor('updateUsername')).toBeUndefined();

    // Profile resolves → provider re-renders → re-announce fires.
    act(() => {
      partyProfile.username = 'Marco';
      partyProfile.avatarUrl = 'https://example.com/marco.png';
      rerender(makeTree());
    });

    await waitFor(() => {
      expect(executeVariablesFor('updateUsername')).toEqual({
        username: 'Marco',
        avatarUrl: 'https://example.com/marco.png',
      });
    });
  });

  it('re-announces identity with UPDATE_USERNAME when the profile is edited mid-session', async () => {
    // Signed in with a real identity from the start — JOIN carries it, so no
    // re-announce fires yet.
    partyProfile.username = 'Marco';
    partyProfile.avatarUrl = 'https://example.com/marco.png';
    const snapshots: Snapshot[] = [];
    const makeTree = () =>
      withQueryClient(
        createElement(
          QueueProvider,
          null,
          createElement(Probe, { onSnapshot: (snapshot: Snapshot) => snapshots.push(snapshot) }),
        ),
      );
    const { rerender } = render(makeTree());

    await waitFor(() => {
      expect(ws.client.subscribe).toHaveBeenCalled();
    });
    expect(executeVariablesFor('updateUsername')).toBeUndefined();

    // User edits their display name + avatar while still in the session.
    act(() => {
      partyProfile.username = 'Marco Polo';
      partyProfile.avatarUrl = 'https://example.com/marco-2.png';
      rerender(makeTree());
    });

    await waitFor(() => {
      expect(executeVariablesFor('updateUsername')).toEqual({
        username: 'Marco Polo',
        avatarUrl: 'https://example.com/marco-2.png',
      });
    });
  });

  it('re-announces when the profile resolves while JOIN is still in flight', async () => {
    // Profile unresolved when JOIN is dispatched, then resolves before JOIN
    // returns. announcedIdentityRef must record what we actually sent (empty),
    // not the newer ref value, or the re-announce would be skipped and the
    // roster would stay on the `User-<id>` fallback.
    partyProfile.username = undefined;
    partyProfile.avatarUrl = undefined;
    const joinDeferred = createDeferred<ReturnType<typeof createJoinSessionResponse>>();
    graph.execute.mockReturnValueOnce(joinDeferred.promise);

    const snapshots: Snapshot[] = [];
    const makeTree = () =>
      withQueryClient(
        createElement(
          QueueProvider,
          null,
          createElement(Probe, { onSnapshot: (snapshot: Snapshot) => snapshots.push(snapshot) }),
        ),
      );
    const { rerender } = render(makeTree());

    await waitFor(() => {
      expect(graph.execute).toHaveBeenCalled();
    });
    expect(executeVariablesFor('joinSession')).toEqual(
      expect.objectContaining({ username: undefined, avatarUrl: undefined }),
    );

    // Profile resolves while JOIN is still awaiting.
    act(() => {
      partyProfile.username = 'Marco';
      partyProfile.avatarUrl = 'https://example.com/marco.png';
      rerender(makeTree());
    });

    await act(async () => {
      joinDeferred.resolve(createJoinSessionResponse());
      await joinDeferred.promise;
    });

    await waitFor(() => {
      expect(executeVariablesFor('updateUsername')).toEqual({
        username: 'Marco',
        avatarUrl: 'https://example.com/marco.png',
      });
    });
  });

  it('retries the re-announce on the next identity change after a failed UPDATE_USERNAME', async () => {
    // Profile unresolved at join; JOIN carries the empty identity.
    partyProfile.username = undefined;
    partyProfile.avatarUrl = undefined;
    const snapshots: Snapshot[] = [];
    const makeTree = () =>
      withQueryClient(
        createElement(
          QueueProvider,
          null,
          createElement(Probe, { onSnapshot: (snapshot: Snapshot) => snapshots.push(snapshot) }),
        ),
      );
    const { rerender } = render(makeTree());

    await waitFor(() => {
      expect(ws.client.subscribe).toHaveBeenCalled();
    });

    // Profile resolves — the re-announce fires but the mutation fails, so the
    // ref must NOT advance (otherwise the next change wouldn't retry).
    graph.execute.mockRejectedValueOnce(new Error('transient network error'));
    act(() => {
      partyProfile.username = 'Marco';
      partyProfile.avatarUrl = 'https://example.com/marco.png';
      rerender(makeTree());
    });
    await waitFor(() => {
      const attempted = graph.execute.mock.calls.some((args) => {
        const operation = args[1] as { query?: string; variables?: Record<string, unknown> } | undefined;
        return operation?.query?.includes('updateUsername') && operation.variables?.username === 'Marco';
      });
      expect(attempted).toBe(true);
    });

    // Identity changes again — because the failure left the ref untouched, the
    // re-announce retries with the new identity.
    act(() => {
      partyProfile.username = 'Marco Polo';
      partyProfile.avatarUrl = 'https://example.com/marco-2.png';
      rerender(makeTree());
    });
    await waitFor(() => {
      const retried = graph.execute.mock.calls.some((args) => {
        const operation = args[1] as { query?: string; variables?: Record<string, unknown> } | undefined;
        return operation?.query?.includes('updateUsername') && operation.variables?.username === 'Marco Polo';
      });
      expect(retried).toBe(true);
    });
  });

  it('keeps the session-id selector value stable across queue mutations', async () => {
    const snapshots: Snapshot[] = [];
    const selectorSnapshots: SelectorSnapshot[] = [];
    renderProviderWithSelectors(
      (snapshot) => snapshots.push(snapshot),
      (snapshot) => selectorSnapshots.push(snapshot),
    );

    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
      expect(selectorSnapshots.at(-1)?.sessionIdValue.sessionId).toBe('session-1');
    });

    const selectorSnapshotCount = selectorSnapshots.length;
    const sessionIdValue = selectorSnapshots.at(-1)?.sessionIdValue;
    const snapshot = snapshots.at(-1);
    if (!snapshot || !sessionIdValue) throw new Error('queue selector snapshot was not captured');

    act(() => {
      snapshot.addToQueue(makeQueueItem('queue-extra', 'climb-extra'));
    });

    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue.map((item) => item.uuid)).toContain('queue-extra');
    });
    expect(selectorSnapshots).toHaveLength(selectorSnapshotCount);
    expect(selectorSnapshots.at(-1)?.sessionIdValue).toBe(sessionIdValue);
  });

  it('keeps the active-climb presence selector stable when switching between climbs', async () => {
    const snapshots: Snapshot[] = [];
    const selectorSnapshots: SelectorSnapshot[] = [];
    renderProviderWithSelectors(
      (snapshot) => snapshots.push(snapshot),
      (snapshot) => selectorSnapshots.push(snapshot),
    );

    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    });

    const firstItem = makeQueueItem('queue-first', 'climb-first');
    const initialSnapshot = snapshots.at(-1);
    if (!initialSnapshot) throw new Error('queue snapshot was not captured');

    act(() => {
      initialSnapshot.setCurrentClimb(firstItem);
    });

    await waitFor(() => {
      expect(snapshots.at(-1)?.state.currentClimbQueueItem?.uuid).toBe('queue-first');
      expect(selectorSnapshots.at(-1)?.hasActiveClimb).toBe(true);
    });

    const selectorSnapshotCount = selectorSnapshots.length;
    const secondItem = makeQueueItem('queue-second', 'climb-second');
    const activeSnapshot = snapshots.at(-1);
    if (!activeSnapshot) throw new Error('active queue snapshot was not captured');

    act(() => {
      activeSnapshot.setCurrentClimb(secondItem);
    });

    await waitFor(() => {
      expect(snapshots.at(-1)?.state.currentClimbQueueItem?.uuid).toBe('queue-second');
    });
    expect(selectorSnapshots).toHaveLength(selectorSnapshotCount);
    expect(selectorSnapshots.at(-1)?.hasActiveClimb).toBe(true);
  });

  it('applies roster events to public context state (no driver mechanics)', async () => {
    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(ws.getSessionUpdatesSink()).not.toBeNull();
    });

    const sessionUpdatesSink = ws.getSessionUpdatesSink();
    if (!sessionUpdatesSink) throw new Error('session updates sink was not captured');

    act(() => {
      sessionUpdatesSink.next({
        data: {
          sessionUpdates: {
            __typename: 'UserJoined',
            user: user({ id: 'participant-2', username: 'Bo', userId: 'db-bo' }),
          },
        },
      });
    });

    await waitFor(() => {
      const latestSnapshot = snapshots.at(-1);
      expect(latestSnapshot?.users.map((entry) => entry.id)).toEqual(['participant-self', 'participant-2']);
    });
  });

  it('exposes the shared party wall actions through the mobile queue context', async () => {
    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    });

    const snapshot = snapshots.at(-1);
    if (!snapshot) throw new Error('queue snapshot was not captured');

    await snapshot.confirmClimbOnWall('climb-1');
    await snapshot.reportWallDisconnect();
    await snapshot.setSessionBoardSerial('SERIAL-1');

    expect(queueMutations.confirmClimbOnWall).toHaveBeenCalledWith('climb-1');
    expect(queueMutations.reportWallDisconnect).toHaveBeenCalledOnce();
    expect(queueMutations.setSessionBoardSerial).toHaveBeenCalledWith('SERIAL-1');
  });

  it('lights the lightbulb on WallConfirmedClimb and republishes onto the wall-confirm bus', async () => {
    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(ws.getSessionUpdatesSink()).not.toBeNull();
    });
    // Lightbulb starts off until a member confirms a climb on the wall.
    expect(snapshots.at(-1)?.isSessionWallLit).toBe(false);

    const sessionUpdatesSink = ws.getSessionUpdatesSink();
    if (!sessionUpdatesSink) throw new Error('session updates sink was not captured');

    act(() => {
      sessionUpdatesSink.next({
        data: {
          sessionUpdates: {
            __typename: 'WallConfirmedClimb',
            climbUuid: 'climb-1',
            confirmedAt: '2026-06-05T00:00:00.000Z',
            confirmedByParticipantId: 'participant-2',
            queueItemUuid: 'queue-item-1',
          },
        },
      });
    });

    expect(wallConfirm.emitWallConfirm).toHaveBeenCalledWith('climb-1');
    await waitFor(() => {
      expect(snapshots.at(-1)?.isSessionWallLit).toBe(true);
    });
  });

  it('turns the lightbulb off on WallDisconnected without clearing the current climb', async () => {
    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
      expect(ws.getSessionUpdatesSink()).not.toBeNull();
    });

    const sessionUpdatesSink = ws.getSessionUpdatesSink();
    if (!sessionUpdatesSink) throw new Error('session updates sink was not captured');

    // Set a current climb, then light the wall via a confirm event.
    const currentItem = makeQueueItem('queue-current', 'climb-current');
    act(() => {
      snapshots.at(-1)?.setCurrentClimb(currentItem);
    });
    act(() => {
      sessionUpdatesSink.next({
        data: {
          sessionUpdates: {
            __typename: 'WallConfirmedClimb',
            climbUuid: 'climb-current',
            confirmedAt: '2026-06-05T00:00:00.000Z',
            confirmedByParticipantId: 'participant-2',
            queueItemUuid: 'queue-current',
          },
        },
      });
    });

    await waitFor(() => {
      const latestSnapshot = snapshots.at(-1);
      expect(latestSnapshot?.isSessionWallLit).toBe(true);
      expect(latestSnapshot?.state.currentClimbQueueItem?.uuid).toBe('queue-current');
    });

    // A member's BLE link drops — the lightbulb clears for everyone, but the
    // current climb is preserved (pressing the lightbulb re-asserts it).
    act(() => {
      sessionUpdatesSink.next({
        data: {
          sessionUpdates: {
            __typename: 'WallDisconnected',
            disconnectedByParticipantId: 'participant-2',
          },
        },
      });
    });

    await waitFor(() => {
      const latestSnapshot = snapshots.at(-1);
      expect(latestSnapshot?.isSessionWallLit).toBe(false);
      // Current climb is intentionally NOT cleared by WallDisconnected.
      expect(latestSnapshot?.state.currentClimbQueueItem?.uuid).toBe('queue-current');
    });
  });

  it('invalidates the session-detail cache on SessionNameChanged', async () => {
    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
      expect(ws.getSessionUpdatesSink()).not.toBeNull();
    });

    const sessionUpdatesSink = ws.getSessionUpdatesSink();
    if (!sessionUpdatesSink) throw new Error('session updates sink was not captured');

    // The sessionUpdates document selects the SessionNameChanged fragment.
    const sessionUpdatesCall = ws.client.subscribe.mock.calls.find((args) =>
      (args[0] as { query: string }).query.includes('sessionUpdates'),
    );
    expect(sessionUpdatesCall).toBeDefined();
    expect((sessionUpdatesCall![0] as { query: string }).query).toContain('SessionNameChanged');

    invalidateQueriesSpy.mockClear();
    act(() => {
      sessionUpdatesSink.next({
        data: {
          sessionUpdates: {
            // changedByParticipantId is null (our own renames are HTTP), so the
            // handler can't echo-suppress by participant id — it just invalidates.
            __typename: 'SessionNameChanged',
            name: 'Tuesday Projecting',
            changedByParticipantId: null,
          },
        },
      });
    });

    expect(invalidateQueriesSpy).toHaveBeenCalledWith({ queryKey: ['sessionDetail', 'session-1'] });
  });

  it('clears persisted session state when SessionEnded arrives', async () => {
    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(ws.getSessionUpdatesSink()).not.toBeNull();
    });

    const sessionUpdatesSink = ws.getSessionUpdatesSink();
    if (!sessionUpdatesSink) throw new Error('session updates sink was not captured');

    act(() => {
      sessionUpdatesSink.next({
        data: {
          sessionUpdates: {
            __typename: 'SessionEnded',
            reason: 'manual',
            newPath: null,
          },
        },
      });
    });

    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBeNull();
    });
  });

  it('drops a server-ended stored session on cold start without rejoining (#2683)', async () => {
    sessionStore.getStoredSessionId.mockResolvedValue('session-ended');
    http.request.mockImplementation((operation: string) =>
      operation.includes('SessionStatus')
        ? Promise.resolve(statusResponse('ended'))
        : Promise.resolve({ endSession: { sessionId: 'session-ended' } }),
    );

    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(sessionStore.clearStoredSessionId).toHaveBeenCalled();
    });

    // The dead session is never restored: no sessionId, no join, no subscription.
    expect(snapshots.at(-1)?.sessionId).toBeNull();
    expect(graph.execute).not.toHaveBeenCalled();
    expect(ws.getSessionUpdatesSink()).toBeNull();
  });

  it('drops a stored session whose row no longer exists (#2683)', async () => {
    // sessionStatus returns null for an unknown session id — same outcome as
    // ended: clear the stored id instead of recreating a zombie room.
    sessionStore.getStoredSessionId.mockResolvedValue('session-ended');
    http.request.mockImplementation((operation: string) =>
      operation.includes('SessionStatus')
        ? Promise.resolve(statusResponse(null))
        : Promise.resolve({ endSession: { sessionId: 'session-ended' } }),
    );

    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(sessionStore.clearStoredSessionId).toHaveBeenCalled();
    });
    expect(snapshots.at(-1)?.sessionId).toBeNull();
    expect(graph.execute).not.toHaveBeenCalled();
  });

  it('restores optimistically when the status check fails (offline cold start)', async () => {
    http.request.mockImplementation((operation: string) =>
      operation.includes('SessionStatus')
        ? Promise.reject(new Error('offline'))
        : Promise.resolve({ endSession: { sessionId: 'session-1' } }),
    );

    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));

    // Can't verify the session offline, so the stored id is still applied...
    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    });
    // ...and the session is joined as before, without clearing the stored id.
    await waitFor(() => {
      expect(graph.execute).toHaveBeenCalled();
    });
    expect(sessionStore.clearStoredSessionId).not.toHaveBeenCalled();
  });

  it('applies board serial and follows same-board angle changes', async () => {
    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(ws.getSessionUpdatesSink()).not.toBeNull();
    });

    const sessionUpdatesSink = ws.getSessionUpdatesSink();
    if (!sessionUpdatesSink) throw new Error('session updates sink was not captured');

    act(() => {
      sessionUpdatesSink.next({
        data: {
          sessionUpdates: {
            __typename: 'SessionBoardSerialChanged',
            lastConnectedBoardSerial: 'AURORA-1',
          },
        },
      });
    });
    act(() => {
      sessionUpdatesSink.next({
        data: {
          sessionUpdates: {
            __typename: 'SessionBoardPathChanged',
            boardPath: '/kilter/1/10/1,2/30/list',
            changedByParticipantId: 'participant-2',
          },
        },
      });
    });

    await waitFor(() => {
      expect(snapshots.at(-1)?.lastConnectedBoardSerial).toBe('AURORA-1');
      expect(activeBoard.setActiveBoard).toHaveBeenCalledWith({ ...activeBoard.stored, angle: 30 });
    });
  });

  it('follows the angle carried by a roster snapshot (heals a dropped board-path change)', async () => {
    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(ws.getSessionUpdatesSink()).not.toBeNull();
    });
    const sessionUpdatesSink = ws.getSessionUpdatesSink();
    if (!sessionUpdatesSink) throw new Error('session updates sink was not captured');

    // The seed/reconcile snapshot carries the session's authoritative boardPath;
    // with no local change pending, its angle is applied to the wall.
    act(() => {
      sessionUpdatesSink.next({
        data: {
          sessionUpdates: {
            __typename: 'SessionRosterSnapshot',
            users: [user({ id: 'participant-self' })],
            boardPath: '/kilter/1/10/1,2/30/list',
          },
        },
      });
    });

    await waitFor(() => {
      expect(activeBoard.setActiveBoard).toHaveBeenCalledWith({ ...activeBoard.stored, angle: 30 });
    });
  });

  it('suppresses the snapshot angle-follow while a local board-path change is in flight', async () => {
    // A local angle change whose broadcast never settles keeps the pending ref
    // set, so a snapshot seeded before it landed must NOT revert the wall.
    queueMutations.setSessionBoardPath.mockImplementationOnce(() => new Promise<void>(() => {}));

    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(ws.getSessionUpdatesSink()).not.toBeNull();
    });
    const sessionUpdatesSink = ws.getSessionUpdatesSink();
    if (!sessionUpdatesSink) throw new Error('session updates sink was not captured');

    // Fire the local change (don't await — the hung mutation keeps it in flight).
    act(() => {
      void snapshots.at(-1)?.setSessionBoardPath('/kilter/1/10/1,2/30/list');
    });
    activeBoard.setActiveBoard.mockClear();

    // A reconnect snapshot arrives carrying the session's STALE (pre-change) angle.
    act(() => {
      sessionUpdatesSink.next({
        data: {
          sessionUpdates: {
            __typename: 'SessionRosterSnapshot',
            users: [user({ id: 'participant-self' })],
            boardPath: '/kilter/1/10/1,2/20/list',
          },
        },
      });
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Guard held: the in-flight local change is not clobbered by the stale seed.
    expect(activeBoard.setActiveBoard).not.toHaveBeenCalledWith({ ...activeBoard.stored, angle: 20 });
  });

  it('ignores stale events from a previous session subscription after switching sessions', async () => {
    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(ws.getSessionUpdatesSink()).not.toBeNull();
    });

    const oldSessionUpdatesSink = ws.getSessionUpdatesSink();
    if (!oldSessionUpdatesSink) throw new Error('session updates sink was not captured');

    await act(async () => {
      await snapshots.at(-1)?.joinSession('session-2', {
        boardPath: '/kilter/1/10/1,2/40/list',
        userBoard: activeBoard.stored,
      });
    });

    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-2');
    });

    act(() => {
      oldSessionUpdatesSink.next({
        data: {
          sessionUpdates: {
            __typename: 'WallConfirmedClimb',
            climbUuid: 'stale-climb',
            confirmedAt: '2026-06-05T00:00:00.000Z',
            confirmedByParticipantId: 'participant-2',
            queueItemUuid: 'stale-queue-item',
          },
        },
      });
    });
    act(() => {
      oldSessionUpdatesSink.next({
        data: {
          sessionUpdates: {
            __typename: 'SessionBoardPathChanged',
            boardPath: '/kilter/1/10/1,2/30/list',
            changedByParticipantId: 'participant-2',
          },
        },
      });
    });

    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-2');
    });
    // A stale WallConfirmedClimb from the previous session's sink must not light
    // the new session's lightbulb, and a stale board-path must not be applied.
    expect(snapshots.at(-1)?.isSessionWallLit).toBe(false);
    expect(activeBoard.setActiveBoard).not.toHaveBeenCalledWith({ ...activeBoard.stored, angle: 30 });
  });

  it('does not apply an accepted board-path event after switching sessions before storage resolves', async () => {
    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(ws.getSessionUpdatesSink()).not.toBeNull();
    });

    const sessionUpdatesSink = ws.getSessionUpdatesSink();
    if (!sessionUpdatesSink) throw new Error('session updates sink was not captured');

    let resolveStoredBoard!: (board: UserBoard) => void;
    activeBoard.getStoredActiveBoard.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStoredBoard = resolve;
      }),
    );

    act(() => {
      sessionUpdatesSink.next({
        data: {
          sessionUpdates: {
            __typename: 'SessionBoardPathChanged',
            boardPath: '/kilter/1/10/1,2/30/list',
            changedByParticipantId: 'participant-2',
          },
        },
      });
    });

    await act(async () => {
      await snapshots.at(-1)?.joinSession('session-2', {
        boardPath: '/kilter/1/10/1,2/40/list',
        userBoard: activeBoard.stored,
      });
    });

    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-2');
    });

    await act(async () => {
      resolveStoredBoard(activeBoard.stored);
      await Promise.resolve();
    });

    expect(activeBoard.setActiveBoard).not.toHaveBeenCalledWith({ ...activeBoard.stored, angle: 30 });
  });

  it('ignores SessionEnded echoes while the local end-session mutation is in flight', async () => {
    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(ws.getSessionUpdatesSink()).not.toBeNull();
    });

    const sessionUpdatesSink = ws.getSessionUpdatesSink();
    if (!sessionUpdatesSink) throw new Error('session updates sink was not captured');

    let finishEndSession!: () => void;
    http.request.mockReturnValueOnce(
      new Promise((resolve) => {
        finishEndSession = () => resolve({ endSession: { sessionId: 'session-1' } });
      }),
    );

    const endSessionPromise = snapshots.at(-1)?.endSession();

    await waitFor(() => {
      expect(http.request).toHaveBeenCalled();
    });

    act(() => {
      sessionUpdatesSink.next({
        data: {
          sessionUpdates: {
            __typename: 'SessionEnded',
            reason: 'manual',
            newPath: null,
          },
        },
      });
    });

    expect(snapshots.at(-1)?.sessionId).toBe('session-1');

    await act(async () => {
      finishEndSession();
      await endSessionPromise;
    });

    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBeNull();
    });
  });

  it('clears on a suppressed remote end when the local end-session mutation fails', async () => {
    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(ws.getSessionUpdatesSink()).not.toBeNull();
    });

    const sessionUpdatesSink = ws.getSessionUpdatesSink();
    if (!sessionUpdatesSink) throw new Error('session updates sink was not captured');

    let rejectEndSession!: (error: unknown) => void;
    http.request.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectEndSession = reject;
      }),
    );

    const endSessionPromise = snapshots.at(-1)?.endSession();

    await waitFor(() => {
      expect(http.request).toHaveBeenCalled();
    });

    act(() => {
      sessionUpdatesSink.next({
        data: {
          sessionUpdates: {
            __typename: 'SessionEnded',
            reason: 'manual',
            newPath: null,
          },
        },
      });
    });

    expect(snapshots.at(-1)?.sessionId).toBe('session-1');

    await act(async () => {
      rejectEndSession(new Error('forbidden'));
      await endSessionPromise;
    });

    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBeNull();
    });
    expect(toast.showToast).toHaveBeenCalledWith('mobile.toast.sessionEnded', 'success');
    expect(toast.showToast).not.toHaveBeenCalledWith('mobile.queue.actionFailed', 'error');
  });

  it('clears local persisted session state when an explicit end-session request fails', async () => {
    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    });

    const currentItem = makeQueueItem('queue-current', 'climb-current');
    const suggestedItem = makeQueueItem('queue-suggested', 'climb-suggested', { suggested: true });
    const playlistSuggestionSource: PlaylistSuggestionSource = {
      playlistUuid: 'playlist-1',
      activatedClimbUuid: currentItem.climb.uuid,
      boardKey: 'kilter:1:10:1,2',
      climbs: [currentItem.climb, suggestedItem.climb],
    };
    const preparedSnapshot = snapshots.at(-1);
    if (!preparedSnapshot) throw new Error('queue snapshot was not captured');

    act(() => {
      preparedSnapshot.addToQueue(currentItem);
      preparedSnapshot.setPlaylistSuggestionSource(playlistSuggestionSource);
    });

    await waitFor(() => {
      const latestSnapshot = snapshots.at(-1);
      expect(latestSnapshot?.state.queue.map((item) => item.uuid)).toEqual(['queue-current']);
      expect(latestSnapshot?.playlistSuggestionSource).toEqual(playlistSuggestionSource);
    });

    http.request.mockRejectedValueOnce(new Error('stale session'));

    await act(async () => {
      await snapshots.at(-1)?.endSession();
    });

    await waitFor(() => {
      const latestSnapshot = snapshots.at(-1);
      expect(latestSnapshot?.sessionId).toBeNull();
      expect(latestSnapshot?.state.queue).toEqual([]);
      expect(latestSnapshot?.state.currentClimbQueueItem).toBeNull();
      expect(latestSnapshot?.playlistSuggestionSource).toBeNull();
    });
    expect(clearStoredSessionId).toHaveBeenCalledTimes(1);
    expect(toast.showToast).toHaveBeenCalledWith('mobile.queue.actionFailed', 'error');
    expect(toast.showToast).not.toHaveBeenCalledWith('mobile.toast.sessionEnded', 'success');
  });

  it('forwards a trimmed recap and the device timezone to END_SESSION, and tracks note counts', async () => {
    vi.mocked(track).mockClear();
    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));
    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    });

    await act(async () => {
      await snapshots.at(-1)?.endSession({ notes: '  crushed it  ' });
    });

    const endCall = http.request.mock.calls.find(
      ([operation]) => typeof operation === 'string' && operation.includes('EndSession'),
    );
    expect(endCall).toBeDefined();
    const variables = endCall?.[1] as { sessionId: string; timezone?: string; notes?: string };
    expect(variables.sessionId).toBe('session-1');
    // Trimmed before send.
    expect(variables.notes).toBe('crushed it');
    // Timezone still travels alongside notes (it was silently dropped before).
    expect(typeof variables.timezone).toBe('string');
    expect(variables.timezone).toBeTruthy();

    // Counts only — never the recap text.
    expect(vi.mocked(track)).toHaveBeenCalledWith(
      SHARED_EVENTS.SessionEnded,
      expect.objectContaining({ hasNotes: true, notesLength: 'crushed it'.length }),
    );
  });

  it('omits notes and reports hasNotes:false when the recap is blank', async () => {
    vi.mocked(track).mockClear();
    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));
    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    });

    await act(async () => {
      await snapshots.at(-1)?.endSession({ notes: '   ' });
    });

    const endCall = http.request.mock.calls.find(
      ([operation]) => typeof operation === 'string' && operation.includes('EndSession'),
    );
    const variables = endCall?.[1] as { sessionId: string; timezone?: string; notes?: string };
    expect(variables.sessionId).toBe('session-1');
    // A whitespace-only recap is not sent (server-side "clear" semantics aren't
    // triggered on end).
    expect('notes' in variables).toBe(false);
    expect(typeof variables.timezone).toBe('string');

    expect(vi.mocked(track)).toHaveBeenCalledWith(
      SHARED_EVENTS.SessionEnded,
      expect.objectContaining({ hasNotes: false, notesLength: 0 }),
    );
  });
});

// ── SEED-1: queue mutations resync on failure (GH #2419) ─────────────────────
//
// addToQueue / removeFromQueue / clearQueue / dispatchSetCurrent apply an
// optimistic reducer delta then fire the server mutation. When that mutation
// rejects in a party session the local queue silently diverges from peers until
// the next reconnect FullSync. These tests pin the recovery: a rejection with an
// active session refetches the authoritative queueState (GET_SESSION_QUEUE_STATE
// over the HTTP client → the mocked http.request) and replaces local state with
// an INITIAL_QUEUE_DATA dispatch, then toasts. A rejection with no session must
// NOT resync or toast.
describe('QueueProvider mutation-failure resync', () => {
  beforeEach(() => {
    toast.showToast.mockClear();
  });

  // The harness routes both endSession and the queueState query through
  // http.request. Branch on the operation text so the resync query returns the
  // authoritative snapshot while everything else keeps the default endSession
  // response.
  function routeHttpRequest(queueStateResponse: unknown, options: { onQueueStateCall?: () => void } = {}) {
    http.request.mockImplementation(async (operation: string) => {
      if (operation.includes('GetSessionQueueState')) {
        options.onQueueStateCall?.();
        return queueStateResponse;
      }
      // Cold-start status check (#2683) — keep the session active so restore
      // lands in-session for these resync tests.
      if (operation.includes('SessionStatus')) {
        return statusResponse();
      }
      return { endSession: { sessionId: 'session-1' } };
    });
  }

  function queueStateResponse(items: ClimbQueueItem[], current: ClimbQueueItem | null = null) {
    return {
      session: {
        queueState: {
          queue: items.map((item) => ({ uuid: item.uuid, climb: item.climb })),
          currentClimbQueueItem: current ? { uuid: current.uuid, climb: current.climb } : null,
        },
      },
    };
  }

  it('resyncs once from the server and replaces state when an add fails in a session', async () => {
    const snapshots: Snapshot[] = [];
    // Server is authoritative: it holds a single climb the failed local add
    // never reached, so a resync must overwrite the optimistic local queue.
    const serverItem = makeQueueItem('server-item', 'climb-server');
    let queueStateCalls = 0;
    routeHttpRequest(queueStateResponse([serverItem]), { onQueueStateCall: () => (queueStateCalls += 1) });
    queueMutations.addQueueItem.mockRejectedValueOnce(new Error('add failed'));

    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    });

    const snapshot = snapshots.at(-1);
    if (!snapshot) throw new Error('queue snapshot was not captured');

    act(() => {
      snapshot.addToQueue(makeQueueItem('local-add', 'climb-local'));
    });

    await waitFor(() => {
      // The reducer's INITIAL_QUEUE_DATA from the resync replaced the optimistic
      // local item with the server's authoritative queue.
      expect(snapshots.at(-1)?.state.queue.map((item) => item.uuid)).toEqual(['server-item']);
    });
    expect(queueStateCalls).toBe(1);
    expect(toast.showToast).toHaveBeenCalledWith('mobile.queue.outOfSyncRefreshed', 'error');
  });

  it('resyncs and replaces state when a remove fails in a session', async () => {
    const snapshots: Snapshot[] = [];
    const serverItem = makeQueueItem('server-kept', 'climb-kept');
    let queueStateCalls = 0;
    routeHttpRequest(queueStateResponse([serverItem]), { onQueueStateCall: () => (queueStateCalls += 1) });
    queueMutations.removeQueueItem.mockRejectedValueOnce(new Error('remove failed'));

    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    });

    const prepared = snapshots.at(-1);
    if (!prepared) throw new Error('queue snapshot was not captured');
    act(() => {
      prepared.addToQueue(makeQueueItem('to-remove', 'climb-remove'));
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue.map((item) => item.uuid)).toContain('to-remove');
    });

    const snapshot = snapshots.at(-1);
    if (!snapshot) throw new Error('queue snapshot was not captured');
    act(() => {
      snapshot.removeFromQueue('to-remove');
    });

    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue.map((item) => item.uuid)).toEqual(['server-kept']);
    });
    expect(queueStateCalls).toBe(1);
    expect(toast.showToast).toHaveBeenCalledWith('mobile.queue.outOfSyncRefreshed', 'error');
  });

  it('resyncs and replaces current climb when setCurrentClimb fails in a session', async () => {
    const snapshots: Snapshot[] = [];
    const serverCurrent = makeQueueItem('server-current', 'climb-server-current');
    let queueStateCalls = 0;
    routeHttpRequest(queueStateResponse([serverCurrent], serverCurrent), {
      onQueueStateCall: () => (queueStateCalls += 1),
    });
    queueMutations.setCurrentClimb.mockRejectedValueOnce(new Error('set current failed'));

    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    });

    const snapshot = snapshots.at(-1);
    if (!snapshot) throw new Error('queue snapshot was not captured');
    act(() => {
      snapshot.setCurrentClimb(makeQueueItem('local-current', 'climb-local-current'));
    });

    await waitFor(() => {
      expect(snapshots.at(-1)?.state.currentClimbQueueItem?.uuid).toBe('server-current');
    });
    expect(queueStateCalls).toBe(1);
    expect(toast.showToast).toHaveBeenCalledWith('mobile.queue.outOfSyncRefreshed', 'error');
    // Solo's "Action failed" toast must NOT fire in a party session.
    expect(toast.showToast).not.toHaveBeenCalledWith('mobile.queue.actionFailed', 'error');
  });

  it('resyncs when setQueue fails in a session', async () => {
    const snapshots: Snapshot[] = [];
    const serverCurrent = makeQueueItem('server-current', 'climb-server-current');
    let queueStateCalls = 0;
    routeHttpRequest(queueStateResponse([serverCurrent], serverCurrent), {
      onQueueStateCall: () => (queueStateCalls += 1),
    });
    queueMutations.setQueue.mockRejectedValueOnce(new Error('set queue failed'));

    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    });

    const snapshot = snapshots.at(-1);
    if (!snapshot) throw new Error('queue snapshot was not captured');
    act(() => {
      const localCurrent = makeQueueItem('local-current', 'climb-local-current');
      snapshot.setQueue([localCurrent], localCurrent);
    });

    await waitFor(() => {
      expect(snapshots.at(-1)?.state.currentClimbQueueItem?.uuid).toBe('server-current');
    });
    expect(queueStateCalls).toBe(1);
    expect(toast.showToast).toHaveBeenCalledWith('mobile.queue.outOfSyncRefreshed', 'error');
  });

  it('does not resync or toast when a mutation fails with no active session', async () => {
    const snapshots: Snapshot[] = [];
    let queueStateCalls = 0;
    routeHttpRequest(queueStateResponse([]), { onQueueStateCall: () => (queueStateCalls += 1) });
    queueMutations.addQueueItem.mockRejectedValueOnce(new Error('add failed'));

    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    });

    // End the session so the next add runs with no active session.
    await act(async () => {
      await snapshots.at(-1)?.endSession();
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBeNull();
    });
    toast.showToast.mockClear();

    const snapshot = snapshots.at(-1);
    if (!snapshot) throw new Error('queue snapshot was not captured');
    act(() => {
      snapshot.addToQueue(makeQueueItem('solo-add', 'climb-solo'));
    });

    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue.map((item) => item.uuid)).toContain('solo-add');
    });
    // Let any (incorrectly scheduled) async resync settle before asserting.
    await act(async () => {
      await Promise.resolve();
    });

    expect(queueStateCalls).toBe(0);
    expect(toast.showToast).not.toHaveBeenCalled();
    // The optimistic local add stays — no server overwrite in solo.
    expect(snapshots.at(-1)?.state.queue.map((item) => item.uuid)).toEqual(['solo-add']);
  });

  it('does not retry-loop when the resync fetch itself fails', async () => {
    const snapshots: Snapshot[] = [];
    let queueStateCalls = 0;
    http.request.mockImplementation(async (operation: string) => {
      if (operation.includes('GetSessionQueueState')) {
        queueStateCalls += 1;
        throw new Error('resync fetch failed');
      }
      // Cold-start status check (#2683) — active so restore lands in-session.
      if (operation.includes('SessionStatus')) {
        return statusResponse();
      }
      return { endSession: { sessionId: 'session-1' } };
    });
    queueMutations.addQueueItem.mockRejectedValueOnce(new Error('add failed'));

    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    });

    const snapshot = snapshots.at(-1);
    if (!snapshot) throw new Error('queue snapshot was not captured');
    act(() => {
      snapshot.addToQueue(makeQueueItem('local-add', 'climb-local'));
    });

    await waitFor(() => {
      // Optimistic add stays; the failed resync swallowed its error.
      expect(snapshots.at(-1)?.state.queue.map((item) => item.uuid)).toContain('local-add');
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Exactly one attempt — the single-flight guard released cleanly and no
    // retry loop fired. No "refreshed" toast since nothing was applied.
    expect(queueStateCalls).toBe(1);
    expect(toast.showToast).not.toHaveBeenCalledWith('mobile.queue.outOfSyncRefreshed', 'error');
  });
});

describe('QueueProvider always-live wall control', () => {
  beforeEach(() => {
    ws.reset();
    ws.client.on.mockClear();
    ws.client.subscribe.mockClear();
    activeBoard.getStoredActiveBoard.mockReset();
    activeBoard.getStoredActiveBoard.mockResolvedValue(activeBoard.stored);
    for (const mutation of Object.values(queueMutations) as Array<ReturnType<typeof vi.fn>>) {
      mutation.mockReset();
      mutation.mockResolvedValue(undefined);
    }
    sessionStore.getStoredSessionId.mockReset();
    sessionStore.getStoredSessionId.mockResolvedValue('session-1');
    sessionStore.clearStoredSessionId.mockClear();
    queueSnapshotStore.getStoredQueueSnapshot.mockReset();
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue(null);
    graph.execute.mockReset();
    http.request.mockReset();
    http.request.mockImplementation((operation: string) =>
      operation.includes('SessionStatus')
        ? Promise.resolve(statusResponse())
        : Promise.resolve({ endSession: { sessionId: 'session-1' } }),
    );
    graph.execute.mockResolvedValue({
      joinSession: {
        participantId: 'participant-self',
        clientId: 'client-self',
        isLeader: false,
        lastConnectedBoardSerial: null,
        boardPath: '/kilter/1/10/1,2/40/list',
        users: [user({ id: 'participant-self', username: 'Self', userId: 'db-self' })],
      },
    });
  });

  it('lets any participant drive the shared current climb after a second member joins (no driver gate)', async () => {
    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(ws.getSessionUpdatesSink()).not.toBeNull();
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    });

    const sessionUpdatesSink = ws.getSessionUpdatesSink();
    if (!sessionUpdatesSink) throw new Error('session updates sink was not captured');

    // A second participant joins — making this a true multi-member party. With
    // the driver/preview mechanics removed, every member (including us) keeps
    // full control: setCurrentClimb still applies locally AND fires the server
    // mutation that broadcasts to peers.
    act(() => {
      sessionUpdatesSink.next({
        data: {
          sessionUpdates: {
            __typename: 'UserJoined',
            user: user({ id: 'participant-2', username: 'Bo', userId: 'db-bo' }),
          },
        },
      });
    });

    const item = makeQueueItem('queue-shared', 'climb-shared');
    act(() => {
      snapshots.at(-1)?.setCurrentClimb(item);
    });

    await waitFor(() => {
      expect(snapshots.at(-1)?.state.currentClimbQueueItem?.uuid).toBe('queue-shared');
    });
    // The shared current-climb mutation broadcasts to peers — no member is gated.
    expect(queueMutations.setCurrentClimb).toHaveBeenCalled();
  });

  it('does not restore or clear the stored session when the status check fails with a server response', async () => {
    // A GraphQL-level failure (older backend without sessionStatus, masked
    // 500) is not "offline" — restoring optimistically would resurrect a
    // zombie session on every launch. Keep the id for a retry next launch.
    http.request.mockImplementation((operation: string) =>
      operation.includes('SessionStatus')
        ? Promise.reject(Object.assign(new Error('Cannot query field "sessionStatus"'), { response: { status: 400 } }))
        : Promise.resolve({ endSession: { sessionId: 'session-1' } }),
    );

    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));

    // The failed check must hydrate the local solo snapshot instead.
    await waitFor(() => {
      expect(queueSnapshotStore.getStoredQueueSnapshot).toHaveBeenCalled();
    });
    expect(snapshots.at(-1)?.sessionId).toBeNull();
    expect(sessionStore.clearStoredSessionId).not.toHaveBeenCalled();
    expect(graph.execute).not.toHaveBeenCalled();
  });
});
