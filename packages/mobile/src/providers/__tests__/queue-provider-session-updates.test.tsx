// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react';
import { createElement, useEffect, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { isPlaylistPeekQueueItemUuid } from '@boardsesh/queue';
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
  // Typed args so a test can model the shared factory's removal ledger, where an
  // add retracts an earlier drop of the same uuid (#4009).
  addQueueItem: vi.fn(async (_item: { uuid: string }, _position?: number) => {}),
  // Typed arg so a test can model the shared factory's removal ledger, which
  // records here before any session guard (#4009).
  removeQueueItem: vi.fn(async (_uuid: string) => {}),
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
  // Read-only classification of a LOCAL absence, backed in production by the
  // shared factory's removal ledger (#4009). These tests verify how the
  // provider BRANCHES on the verdict; the ledger that produces it is covered in
  // packages/shared/queue-react/src/__tests__/create-queue-mutations.test.ts.
  // Default false = "the climber didn't drop it", so an absence reads as a
  // wholesale server sync; tests that model a removal override it.
  wasUuidExplicitlyRemoved: vi.fn((_uuid: string) => false),
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
  registerRenderSuperProperties: vi.fn(),
}));

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
import { GraphQLOperationError } from '@boardsesh/graphql-client';

/** The error `execute()` rejects with when the backend's rate-limit gate fires. */
function makeRateLimitedError(retryAfterSeconds = 4): GraphQLOperationError {
  return new GraphQLOperationError([
    {
      message: `Rate limit exceeded. Try again in ${retryAfterSeconds} seconds.`,
      extensions: { code: 'RATE_LIMITED', retryAfterSeconds },
    },
  ]);
}

type Snapshot = {
  state: ReturnType<typeof useQueue>['state'];
  sessionId: string | null;
  users: SessionUser[];
  isSessionWallLit: boolean;
  lastConnectedBoardSerial: string | null;
  playlistSuggestionSource: PlaylistSuggestionSource | null;
  addToQueue: ReturnType<typeof useQueue>['addToQueue'];
  removeFromQueue: ReturnType<typeof useQueue>['removeFromQueue'];
  clearQueue: ReturnType<typeof useQueue>['clearQueue'];
  reorderQueue: ReturnType<typeof useQueue>['reorderQueue'];
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
      clearQueue: queue.clearQueue,
      reorderQueue: queue.reorderQueue,
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
    queue.clearQueue,
    queue.reorderQueue,
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
    // The blanket reset above hands every action a resolved promise. For a
    // SYNCHRONOUS boolean action that is a truthy Promise, which would read as
    // "the climber removed it" everywhere. Restore the real default.
    queueMutations.wasUuidExplicitlyRemoved.mockReset();
    queueMutations.wasUuidExplicitlyRemoved.mockReturnValue(false);
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
    // A failed end drops us out locally and notifies the server we left (#3502),
    // so the copy is specific about that rather than the old generic failure.
    expect(toast.showToast).toHaveBeenCalledWith('mobile.queue.endSessionFailedLeft', 'error');
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
    installRemovalLedger();
  });

  // This harness swaps the shared mutations factory for hand-rolled mocks, so
  // the removal ledger those actions maintain has to be modelled here: the real
  // `removeQueueItem` records the uuid before any session guard, and
  // `wasUuidExplicitlyRemoved` reads that ledger back (#4009). The ledger itself
  // is covered against the real factory in
  // packages/shared/queue-react/src/__tests__/create-queue-mutations.test.ts;
  // what these tests pin is how the provider BRANCHES on its verdict. Absence
  // with no ledger hit means a wholesale server sync, not climber intent.
  // It tracks the climber's LATEST intent, so `addQueueItem` retracts an earlier
  // drop just as the real factory does. A test that stubs `addQueueItem` with
  // `mockReturnValueOnce` bypasses this, which is fine — none of them assert on
  // the retraction, and the retraction itself is covered against the real
  // factory in the file above.
  function installRemovalLedger() {
    const explicitlyRemoved = new Set<string>();
    queueMutations.removeQueueItem.mockImplementation(async (uuid: string) => {
      explicitlyRemoved.add(uuid);
    });
    queueMutations.addQueueItem.mockImplementation(async (queueItem: { uuid: string }) => {
      explicitlyRemoved.delete(queueItem.uuid);
    });
    queueMutations.wasUuidExplicitlyRemoved.mockImplementation((uuid: string) => explicitlyRemoved.has(uuid));
  }

  // A server FullSync — the event whose INITIAL_QUEUE_DATA mapping REPLACES the
  // local queue wholesale, wiping any not-yet-synced optimistic slot (#4009).
  function pushFullSync(items: ClimbQueueItem[], current: ClimbQueueItem | null, sequence: number) {
    const sink = ws.getQueueUpdatesSink();
    if (!sink) throw new Error('queueUpdates subscription was not opened');
    const toWire = (item: ClimbQueueItem) => ({ uuid: item.uuid, climb: item.climb });
    sink.next({
      data: {
        queueUpdates: {
          __typename: 'FullSync',
          sequence,
          state: {
            sequence,
            stateHash: `hash-${sequence}`,
            queue: items.map(toWire),
            currentClimbQueueItem: current ? toWire(current) : null,
          },
        },
      },
    });
  }

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

  it('toasts "slow down" and keeps the local climb when setCurrentClimb is rate-limited in a session', async () => {
    const snapshots: Snapshot[] = [];
    const serverCurrent = makeQueueItem('server-current', 'climb-server-current');
    let queueStateCalls = 0;
    routeHttpRequest(queueStateResponse([serverCurrent], serverCurrent), {
      onQueueStateCall: () => (queueStateCalls += 1),
    });
    queueMutations.setCurrentClimb.mockRejectedValueOnce(makeRateLimitedError());

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
      expect(toast.showToast).toHaveBeenCalledWith('mobile.queue.rateLimited', 'error');
    });
    // The rate-limit gate throws before the resolver runs, so there is nothing
    // to reconcile — the local pointer stays put and no refetch is fired into
    // the limiter that just throttled us.
    expect(queueStateCalls).toBe(0);
    expect(snapshots.at(-1)?.state.currentClimbQueueItem?.uuid).toBe('local-current');
    expect(toast.showToast).not.toHaveBeenCalledWith('mobile.queue.outOfSyncRefreshed', 'error');
    expect(toast.showToast).not.toHaveBeenCalledWith('mobile.queue.actionFailed', 'error');
  });

  it('re-sends the queue add when a rate-limited setCurrentClimb also queued the climb', async () => {
    const snapshots: Snapshot[] = [];
    const alreadyQueued = makeQueueItem('item-1', 'climb-1');
    let queueStateCalls = 0;
    routeHttpRequest(queueStateResponse([alreadyQueued], alreadyQueued), {
      onQueueStateCall: () => (queueStateCalls += 1),
    });

    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    });

    // Seed one queued climb and make it current, so the activation below has a
    // current climb to slot in behind.
    act(() => {
      snapshots.at(-1)?.setQueue([alreadyQueued], alreadyQueued);
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue).toHaveLength(1);
    });
    queueMutations.addQueueItem.mockClear();
    queueMutations.setCurrentClimb.mockRejectedValueOnce(makeRateLimitedError());

    const snapshot = snapshots.at(-1);
    if (!snapshot) throw new Error('queue snapshot was not captured');
    act(() => {
      snapshot.setCurrentClimb(makeQueueItem('local-current', 'climb-local-current'));
    });

    // Activating a fresh climb moves the pointer AND adds a queue slot. The
    // throttled mutation carried both, so the slot has to be re-sent on its own
    // or it stays in this climber's queue and nobody else's.
    await waitFor(() => {
      expect(queueMutations.addQueueItem).toHaveBeenCalledTimes(1);
    });
    const [recoveredItem, recoveredPosition] = queueMutations.addQueueItem.mock.calls[0] as unknown as [
      ClimbQueueItem,
      number,
    ];
    expect(recoveredItem.uuid).toBe('local-current');
    // Insert-after-current (#2217): index 1, right behind the climb that was
    // current when the activation landed.
    expect(recoveredPosition).toBe(1);
    // Recovering the content must not drag the pointer back to the previous
    // boulder, and must not fire a query into the limiter that throttled us.
    expect(snapshots.at(-1)?.state.currentClimbQueueItem?.uuid).toBe('local-current');
    expect(queueStateCalls).toBe(0);
    // Recovering the slot doesn't hide the pacing: the climber still gets the
    // "slow down" toast, just not a queue-refreshed one.
    expect(toast.showToast).toHaveBeenCalledWith('mobile.queue.rateLimited', 'error');
    expect(toast.showToast).not.toHaveBeenCalledWith('mobile.queue.outOfSyncRefreshed', 'error');
  });

  it('does not re-send a queue add when a rate-limited setCurrentClimb only moved the pointer', async () => {
    const snapshots: Snapshot[] = [];
    const first = makeQueueItem('item-1', 'climb-1');
    const second = makeQueueItem('item-2', 'climb-2');
    let queueStateCalls = 0;
    routeHttpRequest(queueStateResponse([first, second], first), {
      onQueueStateCall: () => (queueStateCalls += 1),
    });

    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    });

    act(() => {
      snapshots.at(-1)?.setQueue([first, second], first);
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue).toHaveLength(2);
    });
    queueMutations.addQueueItem.mockClear();
    toast.showToast.mockClear();
    queueMutations.setCurrentClimb.mockRejectedValueOnce(makeRateLimitedError());

    act(() => {
      snapshots.at(-1)?.nextClimb();
    });

    await waitFor(() => {
      expect(toast.showToast).toHaveBeenCalledWith('mobile.queue.rateLimited', 'error');
    });
    // Swiping to the next queued climb changes no content — both slots are
    // already on the server, so there is nothing to re-send and nothing to
    // reconcile.
    expect(queueMutations.addQueueItem).not.toHaveBeenCalled();
    expect(queueStateCalls).toBe(0);
    expect(snapshots.at(-1)?.state.currentClimbQueueItem?.uuid).toBe('item-2');
  });

  it('re-sends the queue add when a rate-limited nextClimb promoted a playlist peek', async () => {
    const snapshots: Snapshot[] = [];
    const activated = makeQueueItem('item-1', 'climb-1');
    // Second playlist climb, deliberately NOT in the queue: at the queue tail
    // nextClimb falls through to the playlist and offers it as a transient peek.
    const peekClimb = makeQueueItem('peek-source', 'climb-2').climb;
    let queueStateCalls = 0;
    routeHttpRequest(queueStateResponse([activated], activated), {
      onQueueStateCall: () => (queueStateCalls += 1),
    });

    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    });

    act(() => {
      snapshots.at(-1)?.setQueue([activated], activated);
      snapshots.at(-1)?.setPlaylistSuggestionSource({
        playlistUuid: 'playlist-1',
        activatedClimbUuid: activated.climb.uuid,
        boardKey: 'kilter:1:10:1,2',
        climbs: [activated.climb, peekClimb],
      });
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue).toHaveLength(1);
      expect(snapshots.at(-1)?.playlistSuggestionSource?.climbs).toHaveLength(2);
    });
    queueMutations.addQueueItem.mockClear();
    toast.showToast.mockClear();
    queueMutations.setCurrentClimb.mockRejectedValueOnce(makeRateLimitedError());

    act(() => {
      snapshots.at(-1)?.nextClimb();
    });

    // Swiping past the queue tail commits the peek: nextClimb turns it into a
    // real queue item and passes shouldAddToQueue: true, so this pointer move
    // carries a content change just like an activation from search does. It has
    // to be recovered the same way — the promoted slot exists nowhere but here.
    await waitFor(() => {
      expect(queueMutations.addQueueItem).toHaveBeenCalledTimes(1);
    });
    const [recoveredItem, recoveredPosition] = queueMutations.addQueueItem.mock.calls[0] as unknown as [
      ClimbQueueItem,
      number,
    ];
    expect(recoveredItem.climb.uuid).toBe('climb-2');
    // The synthetic `playlist-peek:` uuid must never reach the wire (#2217's
    // sibling constraint) — the committed item carries a fresh one.
    expect(isPlaylistPeekQueueItemUuid(recoveredItem.uuid)).toBe(false);
    // suggestion-origin is preserved so pruning still treats it as suggested.
    expect(recoveredItem.suggested).toBe(true);
    expect(recoveredPosition).toBe(1);
    expect(snapshots.at(-1)?.state.currentClimbQueueItem?.climb.uuid).toBe('climb-2');
    expect(queueStateCalls).toBe(0);
    expect(toast.showToast).toHaveBeenCalledWith('mobile.queue.rateLimited', 'error');
    expect(toast.showToast).not.toHaveBeenCalledWith('mobile.queue.outOfSyncRefreshed', 'error');
  });

  it('reconciles when the re-sent queue add is throttled too', async () => {
    const snapshots: Snapshot[] = [];
    const serverCurrent = makeQueueItem('server-current', 'climb-server-current');
    let queueStateCalls = 0;
    routeHttpRequest(queueStateResponse([serverCurrent], serverCurrent), {
      onQueueStateCall: () => (queueStateCalls += 1),
    });
    queueMutations.setCurrentClimb.mockRejectedValueOnce(makeRateLimitedError());
    queueMutations.addQueueItem.mockRejectedValueOnce(makeRateLimitedError());

    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    });

    const snapshot = snapshots.at(-1);
    if (!snapshot) throw new Error('queue snapshot was not captured');
    act(() => {
      snapshot.setCurrentClimb(makeQueueItem('local-current', 'climb-local-current'));
    });

    // Both halves failed even with their own back-off budgets, so the climb
    // really is local-only. A refreshed queue beats a permanently diverged one.
    await waitFor(() => {
      expect(queueStateCalls).toBe(1);
    });
    expect(toast.showToast).toHaveBeenCalledWith('mobile.queue.outOfSyncRefreshed', 'error');
    expect(snapshots.at(-1)?.state.queue.map((item) => item.uuid)).toEqual(['server-current']);
    // Two toasts, deliberately: "slow down" lands immediately on the throttle,
    // and the refresh notice follows only once reconciliation has actually
    // replaced the queue. Collapsing them would either delay the pacing hint or
    // leave the queue silently swapped underneath the climber.
    //
    // What this assertion guarantees: the toast identities, the count, and the
    // observed order. Break any of the three and it goes red.
    //
    // What it does NOT pin is WHERE the first toast is emitted from. Rewriting
    // dispatchSetCurrent's catch to toast from a .then() after the recovery
    // still passes, because the competing toast sits behind the fallback
    // resync's un-awaited HTTP round-trip and lands second either way. So the
    // order here is real but structurally incidental — it falls out of the
    // async shape rather than being enforced. If reconciliation ever becomes
    // synchronous, re-derive this rather than assuming it still holds.
    expect(toast.showToast.mock.calls.map(([message]) => message)).toEqual([
      'mobile.queue.rateLimited',
      'mobile.queue.outOfSyncRefreshed',
    ]);
  });

  it('skips the re-send when the throttled climb left the queue while the mutation was in flight', async () => {
    const snapshots: Snapshot[] = [];
    const alreadyQueued = makeQueueItem('item-1', 'climb-1');
    let queueStateCalls = 0;
    routeHttpRequest(queueStateResponse([alreadyQueued], alreadyQueued), {
      onQueueStateCall: () => (queueStateCalls += 1),
    });
    // Hold the mutation open so the removal below lands before it settles.
    const inFlightSetCurrent = createDeferred<void>();
    // The provider attaches its handler a tick later; keep node from flagging an
    // unhandled rejection in the meantime.
    inFlightSetCurrent.promise.catch(() => {});
    queueMutations.setCurrentClimb.mockReturnValueOnce(inFlightSetCurrent.promise);

    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    });

    act(() => {
      snapshots.at(-1)?.setQueue([alreadyQueued], alreadyQueued);
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue).toHaveLength(1);
    });
    queueMutations.addQueueItem.mockClear();

    act(() => {
      snapshots.at(-1)?.setCurrentClimb(makeQueueItem('local-current', 'climb-local-current'));
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue).toHaveLength(2);
    });

    // Climber changes their mind and drops the climb before the throttle lands.
    act(() => {
      snapshots.at(-1)?.removeFromQueue('local-current');
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue.map((item) => item.uuid)).toEqual(['item-1']);
    });

    await act(async () => {
      inFlightSetCurrent.reject(makeRateLimitedError());
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(toast.showToast).toHaveBeenCalledWith('mobile.queue.rateLimited', 'error');
    });
    // Recovering the slot now would resurrect a climb the user just deleted.
    // Absence alone no longer decides that (#4009) — the removal ledger does,
    // and the swipe above put this uuid in it.
    expect(queueMutations.wasUuidExplicitlyRemoved).toHaveBeenCalledWith('local-current');
    expect(queueMutations.addQueueItem).not.toHaveBeenCalled();
    expect(queueStateCalls).toBe(0);
  });

  it('undoes the re-sent queue add when the climb is removed while that add is in flight', async () => {
    const snapshots: Snapshot[] = [];
    const alreadyQueued = makeQueueItem('item-1', 'climb-1');
    let queueStateCalls = 0;
    routeHttpRequest(queueStateResponse([alreadyQueued], alreadyQueued), {
      onQueueStateCall: () => (queueStateCalls += 1),
    });
    queueMutations.setCurrentClimb.mockRejectedValueOnce(makeRateLimitedError());
    // Hold the recovery add open — this is the rate-limit back-off window where
    // `execute` can sit for seconds before the add actually lands.
    const inFlightAdd = createDeferred<void>();
    queueMutations.addQueueItem.mockReturnValueOnce(inFlightAdd.promise);

    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    });

    act(() => {
      snapshots.at(-1)?.setQueue([alreadyQueued], alreadyQueued);
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue).toHaveLength(1);
    });
    queueMutations.removeQueueItem.mockClear();

    act(() => {
      snapshots.at(-1)?.setCurrentClimb(makeQueueItem('local-current', 'climb-local-current'));
    });
    await waitFor(() => {
      expect(queueMutations.addQueueItem).toHaveBeenCalledTimes(1);
    });

    // Climber drops the climb while the recovery add is still backing off, so
    // their remove reaches the server first.
    act(() => {
      snapshots.at(-1)?.removeFromQueue('local-current');
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue.map((item) => item.uuid)).toEqual(['item-1']);
    });
    expect(queueMutations.removeQueueItem).toHaveBeenCalledTimes(1);

    await act(async () => {
      inFlightAdd.resolve();
      await Promise.resolve();
    });

    // The add landed after the remove, so it put the climb back on every peer's
    // queue. Undo it instead of leaving a climb nobody asked for. The removal
    // ledger is what licenses that undo (#4009) — the swipe above wrote this
    // uuid into it, so absence here reads as intent rather than as a sync.
    await waitFor(() => {
      expect(queueMutations.removeQueueItem).toHaveBeenCalledTimes(2);
    });
    expect(queueMutations.removeQueueItem.mock.calls.at(-1)).toEqual(['local-current']);
    expect(queueStateCalls).toBe(0);
  });

  it('does not undo the re-sent queue add once the climber has left that session', async () => {
    const snapshots: Snapshot[] = [];
    const alreadyQueued = makeQueueItem('item-1', 'climb-1');
    let queueStateCalls = 0;
    routeHttpRequest(queueStateResponse([alreadyQueued], alreadyQueued), {
      onQueueStateCall: () => (queueStateCalls += 1),
    });
    queueMutations.setCurrentClimb.mockRejectedValueOnce(makeRateLimitedError());
    const inFlightAdd = createDeferred<void>();
    queueMutations.addQueueItem.mockReturnValueOnce(inFlightAdd.promise);

    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    });

    act(() => {
      snapshots.at(-1)?.setQueue([alreadyQueued], alreadyQueued);
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue).toHaveLength(1);
    });
    queueMutations.removeQueueItem.mockClear();

    act(() => {
      snapshots.at(-1)?.setCurrentClimb(makeQueueItem('local-current', 'climb-local-current'));
    });
    await waitFor(() => {
      expect(queueMutations.addQueueItem).toHaveBeenCalledTimes(1);
    });

    // The climber leaves while the recovery add is still backing off. Ending a
    // session clears the local queue, so the membership check on its own would
    // read that as "they dropped the climb" and fire a compensating remove —
    // against whatever session they are in by then, not the one that got the add.
    await act(async () => {
      await snapshots.at(-1)?.endSession();
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBeNull();
    });

    await act(async () => {
      inFlightAdd.resolve();
      await Promise.resolve();
    });

    expect(queueMutations.removeQueueItem).not.toHaveBeenCalled();
    expect(queueStateCalls).toBe(0);
  });

  it('does not undo the re-sent queue add into a DIFFERENT session joined mid-flight', async () => {
    const snapshots: Snapshot[] = [];
    // Uuids unique to this test: providers rendered by earlier cases in this
    // file can still land in-flight mutations while this one runs, so identity
    // beats call counts here.
    const seeded = makeQueueItem('swap-seed', 'climb-swap-seed');
    const activated = makeQueueItem('swap-current', 'climb-swap-current');
    routeHttpRequest(queueStateResponse([seeded], seeded));

    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    });

    act(() => {
      snapshots.at(-1)?.setQueue([seeded], seeded);
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue).toHaveLength(1);
    });

    // Arm both mocks immediately before the activation so a straggler from an
    // earlier test can't consume the one-shot deferred ahead of this provider.
    const inFlightAdd = createDeferred<void>();
    queueMutations.addQueueItem.mockReturnValueOnce(inFlightAdd.promise);
    queueMutations.setCurrentClimb.mockRejectedValueOnce(makeRateLimitedError());

    act(() => {
      snapshots.at(-1)?.setCurrentClimb(activated);
    });
    await waitFor(() => {
      const addedUuids = (queueMutations.addQueueItem.mock.calls as unknown as Array<[ClimbQueueItem, number]>).map(
        ([item]) => item?.uuid,
      );
      expect(addedUuids).toContain('swap-current');
    });

    // The climber leaves for ANOTHER room while the recovery add is still
    // backing off. This is the case a presence-only (`!sessionIdRef.current`)
    // guard misses: the session id is non-null throughout, it just points
    // somewhere else. session-2 has never held this climb, so the membership
    // check reads "they dropped it" and the undo would fire REMOVE_QUEUE_ITEM
    // at a crew that never saw the add.
    await act(async () => {
      await snapshots.at(-1)?.joinSession('session-2', {
        boardPath: '/kilter/1/10/1,2/40/list',
        userBoard: activeBoard.stored,
      });
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-2');
    });
    // The new room's queue lands and does not contain the climb — exactly what
    // the membership check below would otherwise read as "the climber dropped
    // it". Without this the old queue lingers, the item is still found, and the
    // early return happens for the wrong reason.
    act(() => {
      snapshots.at(-1)?.setQueue([], null);
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue).toHaveLength(0);
    });

    await act(async () => {
      inFlightAdd.resolve();
      await Promise.resolve();
    });

    const removedUuids = (queueMutations.removeQueueItem.mock.calls as unknown as Array<[string]>).map(
      ([uuid]) => uuid,
    );
    expect(removedUuids).not.toContain('swap-current');
  });

  // The #4009 regression. The burst's HEAD activation is itself an add, so the
  // server answers it with a FullSync — which INITIAL_QUEUE_DATA applies by
  // REPLACING the queue, wiping the optimistic slot seconds before the throttled
  // mutation rejects. A bare "gone locally -> skip" reads that as intent and the
  // climb reaches nobody.
  it('still re-sends the queue add when a wholesale server sync wiped the local slot (#4009)', async () => {
    const snapshots: Snapshot[] = [];
    const alreadyQueued = makeQueueItem('item-1', 'climb-1');
    let queueStateCalls = 0;
    routeHttpRequest(queueStateResponse([alreadyQueued], alreadyQueued), {
      onQueueStateCall: () => (queueStateCalls += 1),
    });
    // Hold the mutation open so the sync below lands before it settles.
    const inFlightSetCurrent = createDeferred<void>();
    inFlightSetCurrent.promise.catch(() => {});
    queueMutations.setCurrentClimb.mockReturnValueOnce(inFlightSetCurrent.promise);

    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    });

    act(() => {
      snapshots.at(-1)?.setQueue([alreadyQueued], alreadyQueued);
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue).toHaveLength(1);
    });
    queueMutations.addQueueItem.mockClear();

    act(() => {
      snapshots.at(-1)?.setCurrentClimb(makeQueueItem('local-current', 'climb-local-current'));
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue).toHaveLength(2);
    });

    // The server's own answer to the burst head lands: a full snapshot that has
    // never heard of the pending slot. Nobody removed anything.
    act(() => {
      pushFullSync([alreadyQueued], alreadyQueued, 1);
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue.map((item) => item.uuid)).toEqual(['item-1']);
    });

    await act(async () => {
      inFlightSetCurrent.reject(makeRateLimitedError());
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(queueMutations.addQueueItem).toHaveBeenCalledTimes(1);
    });
    const [recoveredItem, recoveredPosition] = queueMutations.addQueueItem.mock.calls[0] as unknown as [
      ClimbQueueItem,
      number | undefined,
    ];
    expect(recoveredItem.uuid).toBe('local-current');
    // No local slot left to mirror, so no position is claimed — the server
    // appends. Worse order than insert-after-current, far better than the climb
    // existing nowhere.
    expect(recoveredPosition).toBeUndefined();
    // Recovering is not reconciling: no queue refetch, and the pacing hint still
    // reaches the climber.
    expect(queueStateCalls).toBe(0);
    expect(toast.showToast).toHaveBeenCalledWith('mobile.queue.rateLimited', 'error');
  });

  // The second-order half of #4009: the add DID land, and the only reason the
  // slot is missing locally is the same wholesale sync. Undoing here deletes the
  // picker's own pick off the whole crew's queue AND writes the uuid into the
  // shared removal ledger, which then suppresses every later deferred add for it.
  it('does not undo the re-sent queue add when a wholesale sync wiped the slot with no removal (#4009)', async () => {
    const snapshots: Snapshot[] = [];
    const alreadyQueued = makeQueueItem('sync-seed', 'climb-sync-seed');
    let queueStateCalls = 0;
    routeHttpRequest(queueStateResponse([alreadyQueued], alreadyQueued), {
      onQueueStateCall: () => (queueStateCalls += 1),
    });
    queueMutations.setCurrentClimb.mockRejectedValueOnce(makeRateLimitedError());
    // Hold the recovery add open — this is `execute`'s back-off window.
    const inFlightAdd = createDeferred<void>();
    queueMutations.addQueueItem.mockReturnValueOnce(inFlightAdd.promise);

    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    });

    act(() => {
      snapshots.at(-1)?.setQueue([alreadyQueued], alreadyQueued);
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue).toHaveLength(1);
    });
    queueMutations.removeQueueItem.mockClear();

    act(() => {
      snapshots.at(-1)?.setCurrentClimb(makeQueueItem('sync-current', 'climb-sync-current'));
    });
    await waitFor(() => {
      const addedUuids = (queueMutations.addQueueItem.mock.calls as unknown as Array<[ClimbQueueItem, number]>).map(
        ([item]) => item?.uuid,
      );
      expect(addedUuids).toContain('sync-current');
    });

    // A peer's activation lands a FullSync while our add is still backing off.
    act(() => {
      pushFullSync([alreadyQueued], alreadyQueued, 1);
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue.map((item) => item.uuid)).toEqual(['sync-seed']);
    });

    await act(async () => {
      inFlightAdd.resolve();
      await Promise.resolve();
    });

    const removedUuids = (queueMutations.removeQueueItem.mock.calls as unknown as Array<[string]>).map(
      ([uuid]) => uuid,
    );
    expect(removedUuids).not.toContain('sync-current');
    expect(queueStateCalls).toBe(0);
  });

  // The unpositioned re-send resolves the LIVE session, so without a captured
  // room the recovery would append the old room's climb to the new crew's queue.
  it('does not re-send the queue add into a session joined while the activation was backing off (#4009)', async () => {
    const snapshots: Snapshot[] = [];
    const seeded = makeQueueItem('flip-seed', 'climb-flip-seed');
    const activated = makeQueueItem('flip-current', 'climb-flip-current');
    routeHttpRequest(queueStateResponse([seeded], seeded));
    const inFlightSetCurrent = createDeferred<void>();
    inFlightSetCurrent.promise.catch(() => {});
    queueMutations.setCurrentClimb.mockReturnValueOnce(inFlightSetCurrent.promise);

    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    });

    act(() => {
      snapshots.at(-1)?.setQueue([seeded], seeded);
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue).toHaveLength(1);
    });

    act(() => {
      snapshots.at(-1)?.setCurrentClimb(activated);
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue).toHaveLength(2);
    });

    // The climber walks to another board's room while the activation is still
    // throttled. session-2 never saw this climb and must not receive it.
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
      inFlightSetCurrent.reject(makeRateLimitedError());
      await Promise.resolve();
    });

    const addedUuids = (queueMutations.addQueueItem.mock.calls as unknown as Array<[ClimbQueueItem, number]>).map(
      ([item]) => item?.uuid,
    );
    expect(addedUuids).not.toContain('flip-current');
  });

  it('toasts "slow down" rather than the generic failure when reorderQueue is rate-limited', async () => {
    const snapshots: Snapshot[] = [];
    const first = makeQueueItem('item-1', 'climb-1');
    const second = makeQueueItem('item-2', 'climb-2');
    let queueStateCalls = 0;
    routeHttpRequest(queueStateResponse([first, second], first), {
      onQueueStateCall: () => (queueStateCalls += 1),
    });
    queueMutations.reorderQueueItem.mockRejectedValueOnce(makeRateLimitedError());

    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    });

    // Seed a two-item queue locally so there is something to reorder.
    act(() => {
      snapshots.at(-1)?.setQueue([first, second], first);
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue).toHaveLength(2);
    });
    toast.showToast.mockClear();

    const snapshot = snapshots.at(-1);
    if (!snapshot) throw new Error('queue snapshot was not captured');
    act(() => {
      snapshot.reorderQueue('item-1', 0, 1);
    });

    await waitFor(() => {
      expect(toast.showToast).toHaveBeenCalledWith('mobile.queue.rateLimited', 'error');
    });
    expect(toast.showToast).not.toHaveBeenCalledWith('mobile.queue.actionFailed', 'error');
    // reorderQueue rolls back locally and never reaches
    // resyncQueueAfterMutationFailure — assert the refetch stays at zero so
    // that stays true if the handler is ever rewritten.
    expect(queueStateCalls).toBe(0);
  });

  it('toasts "slow down" when a solo setCurrentClimb is rate-limited', async () => {
    const snapshots: Snapshot[] = [];
    let queueStateCalls = 0;
    routeHttpRequest(queueStateResponse([]), { onQueueStateCall: () => (queueStateCalls += 1) });
    queueMutations.setCurrentClimb.mockRejectedValueOnce(makeRateLimitedError());

    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    });

    // End the session so the next activation runs with no active session.
    await act(async () => {
      await snapshots.at(-1)?.endSession();
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBeNull();
    });
    toast.showToast.mockClear();
    queueMutations.addQueueItem.mockClear();

    const snapshot = snapshots.at(-1);
    if (!snapshot) throw new Error('queue snapshot was not captured');
    act(() => {
      snapshot.setCurrentClimb(makeQueueItem('solo-current', 'climb-solo-current'));
    });

    // Solo used to get a blanket "Action failed" here; a throttled solo call is
    // still a rate limit, so it gets the same gentle wording as a party one.
    await waitFor(() => {
      expect(toast.showToast).toHaveBeenCalledWith('mobile.queue.rateLimited', 'error');
    });
    expect(queueStateCalls).toBe(0);
    expect(toast.showToast).not.toHaveBeenCalledWith('mobile.queue.actionFailed', 'error');
    // Solo has no server to fall behind — the local queue is authoritative, so
    // there is no lost slot to re-send even though this activation queued one.
    expect(queueMutations.addQueueItem).not.toHaveBeenCalled();
  });

  it('still shows the generic failure when a solo setCurrentClimb fails for any other reason', async () => {
    const snapshots: Snapshot[] = [];
    let queueStateCalls = 0;
    routeHttpRequest(queueStateResponse([]), { onQueueStateCall: () => (queueStateCalls += 1) });
    queueMutations.setCurrentClimb.mockRejectedValueOnce(new Error('set current failed'));

    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    });

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
      snapshot.setCurrentClimb(makeQueueItem('solo-current', 'climb-solo-current'));
    });

    // Routing solo through showQueueMutationErrorToast must not change what a
    // plain failure looks like — only the rate-limited case gets new wording.
    await waitFor(() => {
      expect(toast.showToast).toHaveBeenCalledWith('mobile.queue.actionFailed', 'error');
    });
    expect(queueStateCalls).toBe(0);
    expect(toast.showToast).not.toHaveBeenCalledWith('mobile.queue.rateLimited', 'error');
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

  // #3929: a throttled queue-CONTENT mutation used to be completely silent
  // about pacing — the climber only ever saw the delayed "Queue was out of
  // sync" notice, which reads as a bug rather than "ease off". These four cover
  // add / remove / setQueue / clearQueue. The pacing hint lands first and the
  // refresh notice still follows, exactly like the setCurrentClimb path above.
  it('surfaces the pacing hint when a throttled add fails in a session', async () => {
    const snapshots: Snapshot[] = [];
    const serverItem = makeQueueItem('server-item', 'climb-server');
    let queueStateCalls = 0;
    routeHttpRequest(queueStateResponse([serverItem]), { onQueueStateCall: () => (queueStateCalls += 1) });
    queueMutations.addQueueItem.mockRejectedValueOnce(makeRateLimitedError());

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
      expect(snapshots.at(-1)?.state.queue.map((item) => item.uuid)).toEqual(['server-item']);
    });
    // The divergence is real, so reconciliation still runs on top of the toast.
    expect(queueStateCalls).toBe(1);
    expect(toast.showToast.mock.calls.map(([message]) => message)).toEqual([
      'mobile.queue.rateLimited',
      'mobile.queue.outOfSyncRefreshed',
    ]);
  });

  it('surfaces the pacing hint when a throttled remove fails in a session', async () => {
    const snapshots: Snapshot[] = [];
    const serverItem = makeQueueItem('server-kept', 'climb-kept');
    let queueStateCalls = 0;
    routeHttpRequest(queueStateResponse([serverItem]), { onQueueStateCall: () => (queueStateCalls += 1) });
    queueMutations.removeQueueItem.mockRejectedValueOnce(makeRateLimitedError());

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
    expect(toast.showToast.mock.calls.map(([message]) => message)).toEqual([
      'mobile.queue.rateLimited',
      'mobile.queue.outOfSyncRefreshed',
    ]);
  });

  it('surfaces the pacing hint when a throttled setQueue fails in a session', async () => {
    const snapshots: Snapshot[] = [];
    const serverItem = makeQueueItem('server-item', 'climb-server');
    let queueStateCalls = 0;
    routeHttpRequest(queueStateResponse([serverItem]), { onQueueStateCall: () => (queueStateCalls += 1) });
    queueMutations.setQueue.mockRejectedValueOnce(makeRateLimitedError());

    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    });

    const snapshot = snapshots.at(-1);
    if (!snapshot) throw new Error('queue snapshot was not captured');
    act(() => {
      snapshot.setQueue([makeQueueItem('replaced-one', 'climb-replaced-one')]);
    });

    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue.map((item) => item.uuid)).toEqual(['server-item']);
    });
    expect(queueStateCalls).toBe(1);
    expect(toast.showToast.mock.calls.map(([message]) => message)).toEqual([
      'mobile.queue.rateLimited',
      'mobile.queue.outOfSyncRefreshed',
    ]);
  });

  it('prefers the throttled rejection when clearing a queue partly fails', async () => {
    const snapshots: Snapshot[] = [];
    const serverItem = makeQueueItem('server-kept', 'climb-kept');
    routeHttpRequest(queueStateResponse([serverItem]));
    // The limiter typically rejects the TAIL of a clear's per-item removes, so
    // the plain failure comes first: an implementation that classifies
    // rejectedRemovals[0] would miss the pacing hint entirely.
    queueMutations.removeQueueItem.mockRejectedValueOnce(new Error('network'));
    queueMutations.removeQueueItem.mockRejectedValueOnce(makeRateLimitedError());

    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    });

    const prepared = snapshots.at(-1);
    if (!prepared) throw new Error('queue snapshot was not captured');
    act(() => {
      prepared.addToQueue(makeQueueItem('clear-one', 'climb-clear-one'));
      prepared.addToQueue(makeQueueItem('clear-two', 'climb-clear-two'));
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue.map((item) => item.uuid)).toEqual(['clear-one', 'clear-two']);
    });

    const snapshot = snapshots.at(-1);
    if (!snapshot) throw new Error('queue snapshot was not captured');
    act(() => {
      snapshot.clearQueue();
    });

    await waitFor(() => {
      expect(toast.showToast.mock.calls.map(([message]) => message)).toEqual([
        'mobile.queue.rateLimited',
        'mobile.queue.outOfSyncRefreshed',
      ]);
    });
    expect(toast.showToast).not.toHaveBeenCalledWith('mobile.queue.actionFailed', 'error');
  });

  it('keeps a non-throttled clear failure silent about pacing', async () => {
    const snapshots: Snapshot[] = [];
    const serverItem = makeQueueItem('server-kept', 'climb-kept');
    routeHttpRequest(queueStateResponse([serverItem]));
    queueMutations.removeQueueItem.mockRejectedValueOnce(new Error('network'));

    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    });

    const prepared = snapshots.at(-1);
    if (!prepared) throw new Error('queue snapshot was not captured');
    act(() => {
      prepared.addToQueue(makeQueueItem('clear-one', 'climb-clear-one'));
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue.map((item) => item.uuid)).toEqual(['clear-one']);
    });

    const snapshot = snapshots.at(-1);
    if (!snapshot) throw new Error('queue snapshot was not captured');
    act(() => {
      snapshot.clearQueue();
    });

    await waitFor(() => {
      expect(toast.showToast).toHaveBeenCalledWith('mobile.queue.outOfSyncRefreshed', 'error');
    });
    expect(toast.showToast).not.toHaveBeenCalledWith('mobile.queue.rateLimited', 'error');
    expect(toast.showToast).not.toHaveBeenCalledWith('mobile.queue.actionFailed', 'error');
  });

  it('keeps a non-throttled add failure silent about pacing', async () => {
    const snapshots: Snapshot[] = [];
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
      expect(snapshots.at(-1)?.state.queue.map((item) => item.uuid)).toEqual(['server-item']);
    });
    expect(queueStateCalls).toBe(1);
    // Guard test: a best-effort add that fails offline/transiently must stay
    // quiet apart from the refresh notice. Reaching for
    // showQueueMutationErrorToast here would fire "Action failed" on every
    // dropped connection — the #2763 complaint all over again.
    expect(toast.showToast.mock.calls.map(([message]) => message)).toEqual(['mobile.queue.outOfSyncRefreshed']);
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
    // Same correction the other two harnesses make: the blanket loop above hands
    // this SYNCHRONOUS boolean action a resolved Promise, which is truthy and so
    // reads as "the climber removed it" for every uuid (#4009).
    queueMutations.wasUuidExplicitlyRemoved.mockReset();
    queueMutations.wasUuidExplicitlyRemoved.mockReturnValue(false);
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
