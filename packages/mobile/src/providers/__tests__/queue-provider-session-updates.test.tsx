// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react';
import { createElement, useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';
import type { SessionStatus, SessionUser, UserBoard } from '@boardsesh/shared-schema';

const ws = vi.hoisted(() => {
  type WsEventName = 'connected' | 'closed';
  let sessionUpdatesSink: { next: (payload: { data?: { sessionUpdates?: unknown } }) => void } | null = null;
  const listeners: Record<WsEventName, Set<() => void>> = {
    connected: new Set(),
    closed: new Set(),
  };
  return {
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
        if (request.query.includes('sessionUpdates')) {
          sessionUpdatesSink = sink as { next: (payload: { data?: { sessionUpdates?: unknown } }) => void };
        }
        return vi.fn();
      }),
    },
    reset: () => {
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
  } satisfies UserBoard,
  getStoredActiveBoard: vi.fn(),
  setActiveBoard: vi.fn(async () => {}),
}));

const toast = vi.hoisted(() => ({
  showToast: vi.fn(),
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

type Snapshot = {
  state: ReturnType<typeof useQueue>['state'];
  sessionId: string | null;
  users: SessionUser[];
  isSessionWallLit: boolean;
  lastConnectedBoardSerial: string | null;
  playlistSuggestionSource: PlaylistSuggestionSource | null;
  addToQueue: ReturnType<typeof useQueue>['addToQueue'];
  removeFromQueue: ReturnType<typeof useQueue>['removeFromQueue'];
  setCurrentClimb: ReturnType<typeof useQueue>['setCurrentClimb'];
  nextClimb: ReturnType<typeof useQueue>['nextClimb'];
  setPlaylistSuggestionSource: ReturnType<typeof useQueue>['setPlaylistSuggestionSource'];
  joinSession: (sessionId: string, opts: Parameters<ReturnType<typeof useQueue>['joinSession']>[1]) => Promise<void>;
  endSession: () => Promise<unknown>;
  confirmClimbOnWall: ReturnType<typeof useQueue>['confirmClimbOnWall'];
  reportWallDisconnect: ReturnType<typeof useQueue>['reportWallDisconnect'];
  setSessionBoardSerial: ReturnType<typeof useQueue>['setSessionBoardSerial'];
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
      setCurrentClimb: queue.setCurrentClimb,
      nextClimb: queue.nextClimb,
      setPlaylistSuggestionSource: queue.setPlaylistSuggestionSource,
      joinSession: queue.joinSession,
      endSession: queue.endSession,
      confirmClimbOnWall: queue.confirmClimbOnWall,
      reportWallDisconnect: queue.reportWallDisconnect,
      setSessionBoardSerial: queue.setSessionBoardSerial,
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
    queue.setCurrentClimb,
    queue.nextClimb,
    queue.setPlaylistSuggestionSource,
    queue.joinSession,
    queue.endSession,
    queue.confirmClimbOnWall,
    queue.reportWallDisconnect,
    queue.setSessionBoardSerial,
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

function renderProvider(onSnapshot: (snapshot: Snapshot) => void) {
  return render(createElement(QueueProvider, null, createElement(Probe, { onSnapshot })));
}

function renderProviderWithSelectors(
  onSnapshot: (snapshot: Snapshot) => void,
  onSelectorSnapshot: (snapshot: SelectorSnapshot) => void,
) {
  return render(
    createElement(
      QueueProvider,
      null,
      createElement(Probe, { onSnapshot }),
      createElement(SelectorProbe, { onSnapshot: onSelectorSnapshot }),
    ),
  );
}

describe('QueueProvider session update subscription', () => {
  beforeEach(() => {
    ws.reset();
    ws.client.on.mockClear();
    ws.client.subscribe.mockClear();
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
    };
    activeBoard.getStoredActiveBoard.mockReset();
    activeBoard.getStoredActiveBoard.mockResolvedValue(activeBoard.stored);
    activeBoard.setActiveBoard.mockClear();
    toast.showToast.mockClear();
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
