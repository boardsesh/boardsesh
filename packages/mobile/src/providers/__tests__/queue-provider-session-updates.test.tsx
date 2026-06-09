// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react';
import { createElement, useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';
import type { SessionUser, UserBoard } from '@boardsesh/shared-schema';

const ws = vi.hoisted(() => {
  let sessionUpdatesSink: { next: (payload: { data?: { sessionUpdates?: unknown } }) => void } | null = null;
  return {
    getSessionUpdatesSink: () => sessionUpdatesSink,
    client: {
      on: vi.fn(() => vi.fn()),
      subscribe: vi.fn((request: { query: string }, sink: { next: (payload: unknown) => void }) => {
        if (request.query.includes('sessionUpdates')) {
          sessionUpdatesSink = sink as { next: (payload: { data?: { sessionUpdates?: unknown } }) => void };
        }
        return vi.fn();
      }),
    },
    reset: () => {
      sessionUpdatesSink = null;
    },
  };
});

const graph = vi.hoisted(() => ({
  execute: vi.fn(),
}));

const http = vi.hoisted(() => ({
  request: vi.fn(),
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
  takeControl: vi.fn(async () => {}),
  releaseControl: vi.fn(async () => {}),
  confirmClimbOnWall: vi.fn(async () => {}),
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

vi.mock('@boardsesh/graphql-client', () => ({
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

vi.mock('../../lib/session-store', () => ({
  getStoredSessionId: vi.fn(async () => 'session-1'),
  setStoredSessionId: vi.fn(async () => {}),
  clearStoredSessionId: vi.fn(async () => {}),
}));

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

import { QueueProvider, usePlaylistSuggestionSource, useQueue, useQueueLiveStats } from '../queue-provider';

type Snapshot = {
  state: ReturnType<typeof useQueue>['state'];
  sessionId: string | null;
  users: SessionUser[];
  driverParticipantId: string | null;
  lastConnectedBoardSerial: string | null;
  playlistSuggestionSource: PlaylistSuggestionSource | null;
  addToQueue: ReturnType<typeof useQueue>['addToQueue'];
  setCurrentClimb: ReturnType<typeof useQueue>['setCurrentClimb'];
  nextClimb: ReturnType<typeof useQueue>['nextClimb'];
  setPlaylistSuggestionSource: ReturnType<typeof useQueue>['setPlaylistSuggestionSource'];
  joinSession: (sessionId: string, opts: Parameters<ReturnType<typeof useQueue>['joinSession']>[1]) => Promise<void>;
  endSession: () => Promise<unknown>;
  takeControl: ReturnType<typeof useQueue>['takeControl'];
  releaseControl: ReturnType<typeof useQueue>['releaseControl'];
  confirmClimbOnWall: ReturnType<typeof useQueue>['confirmClimbOnWall'];
  setSessionBoardSerial: ReturnType<typeof useQueue>['setSessionBoardSerial'];
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

function Probe({ onSnapshot }: { onSnapshot: (snapshot: Snapshot) => void }) {
  const queue = useQueue();
  const playlistSuggestionSource = usePlaylistSuggestionSource();
  // sessionUsers moved out of useQueue() into its own live-stats context so the
  // ≤1/2s party push no longer re-renders every queue consumer; read it here.
  const { sessionUsers } = useQueueLiveStats();
  useEffect(() => {
    onSnapshot({
      state: queue.state,
      sessionId: queue.sessionId,
      users: sessionUsers,
      driverParticipantId: queue.driverParticipantId,
      lastConnectedBoardSerial: queue.lastConnectedBoardSerial,
      playlistSuggestionSource,
      addToQueue: queue.addToQueue,
      setCurrentClimb: queue.setCurrentClimb,
      nextClimb: queue.nextClimb,
      setPlaylistSuggestionSource: queue.setPlaylistSuggestionSource,
      joinSession: queue.joinSession,
      endSession: queue.endSession,
      takeControl: queue.takeControl,
      releaseControl: queue.releaseControl,
      confirmClimbOnWall: queue.confirmClimbOnWall,
      setSessionBoardSerial: queue.setSessionBoardSerial,
    });
  }, [
    queue.sessionId,
    queue.state,
    sessionUsers,
    queue.driverParticipantId,
    queue.lastConnectedBoardSerial,
    playlistSuggestionSource,
    queue.addToQueue,
    queue.setCurrentClimb,
    queue.nextClimb,
    queue.setPlaylistSuggestionSource,
    queue.joinSession,
    queue.endSession,
    queue.takeControl,
    queue.releaseControl,
    queue.confirmClimbOnWall,
    queue.setSessionBoardSerial,
    onSnapshot,
  ]);
  return null;
}

function renderProvider(onSnapshot: (snapshot: Snapshot) => void) {
  return render(createElement(QueueProvider, null, createElement(Probe, { onSnapshot })));
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
    graph.execute.mockReset();
    http.request.mockReset();
    http.request.mockResolvedValue({
      endSession: {
        sessionId: 'session-1',
      },
    });
    graph.execute.mockResolvedValue({
      joinSession: {
        participantId: 'participant-self',
        clientId: 'client-self',
        isLeader: false,
        driverParticipantId: null,
        lastConnectedBoardSerial: null,
        boardPath: '/kilter/1/10/1,2/40/list',
        users: [user({ id: 'participant-self', username: 'Self', userId: 'db-self' })],
      },
    });
  });

  it('applies roster and driver events to public context state', async () => {
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
    act(() => {
      sessionUpdatesSink.next({
        data: {
          sessionUpdates: {
            __typename: 'DriverChanged',
            driverParticipantId: 'participant-2',
            previousDriverParticipantId: null,
          },
        },
      });
    });

    await waitFor(() => {
      const latestSnapshot = snapshots.at(-1);
      expect(latestSnapshot?.users.map((entry) => entry.id)).toEqual(['participant-self', 'participant-2']);
      expect(latestSnapshot?.driverParticipantId).toBe('participant-2');
    });
  });

  it('exposes shared party wall-control actions through the mobile queue context', async () => {
    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    });

    const snapshot = snapshots.at(-1);
    if (!snapshot) throw new Error('queue snapshot was not captured');

    await snapshot.takeControl(null);
    await snapshot.releaseControl();
    await snapshot.confirmClimbOnWall('climb-1');
    await snapshot.setSessionBoardSerial('SERIAL-1');

    expect(queueMutations.takeControl).toHaveBeenCalledWith(null);
    expect(queueMutations.releaseControl).toHaveBeenCalledOnce();
    expect(queueMutations.confirmClimbOnWall).toHaveBeenCalledWith('climb-1');
    expect(queueMutations.setSessionBoardSerial).toHaveBeenCalledWith('SERIAL-1');
  });

  it('optimistically sets the driver and current climb while takeControl is in flight', async () => {
    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    });

    queueMutations.takeControl.mockImplementationOnce(() => new Promise<void>(() => {}));
    const queueItem = makeQueueItem('queue-new', 'climb-new');
    const snapshot = snapshots.at(-1);
    if (!snapshot) throw new Error('queue snapshot was not captured');

    act(() => {
      void snapshot.takeControl(queueItem).catch(() => {});
    });

    await waitFor(() => {
      const latestSnapshot = snapshots.at(-1);
      expect(latestSnapshot?.driverParticipantId).toBe('participant-self');
      expect(latestSnapshot?.state.currentClimbQueueItem?.uuid).toBe('queue-new');
      expect(latestSnapshot?.state.queue.map((item) => item.uuid)).toContain('queue-new');
    });
    expect(queueMutations.takeControl).toHaveBeenCalledWith(queueItem);
  });

  it('rolls back optimistic takeControl state when the mutation fails', async () => {
    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    });

    const queueItem = makeQueueItem('queue-fail', 'climb-fail');
    const failure = new Error('take failed');
    queueMutations.takeControl.mockRejectedValueOnce(failure);
    const snapshot = snapshots.at(-1);
    if (!snapshot) throw new Error('queue snapshot was not captured');

    await expect(snapshot.takeControl(queueItem)).rejects.toThrow('take failed');

    await waitFor(() => {
      const latestSnapshot = snapshots.at(-1);
      expect(latestSnapshot?.driverParticipantId).toBeNull();
      expect(latestSnapshot?.state.currentClimbQueueItem).toBeNull();
      expect(latestSnapshot?.state.queue.map((item) => item.uuid)).not.toContain('queue-fail');
    });
    expect(toast.showToast).toHaveBeenCalledWith('mobile.queue.actionFailed', 'error');
  });

  it('preserves suggested playlist items when takeControl rollback restores the queue', async () => {
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
      preparedSnapshot.setCurrentClimb(currentItem, { playlistSuggestionSource: null });
      preparedSnapshot.addToQueue(suggestedItem);
      preparedSnapshot.setPlaylistSuggestionSource(playlistSuggestionSource);
    });

    await waitFor(() => {
      const latestSnapshot = snapshots.at(-1);
      expect(latestSnapshot?.state.currentClimbQueueItem?.uuid).toBe('queue-current');
      expect(latestSnapshot?.state.queue.map((item) => item.uuid)).toEqual(['queue-current', 'queue-suggested']);
      expect(latestSnapshot?.playlistSuggestionSource).toEqual(playlistSuggestionSource);
    });

    const failingItem = makeQueueItem('queue-fail', 'climb-fail');
    queueMutations.takeControl.mockRejectedValueOnce(new Error('take failed'));
    const snapshotBeforeTake = snapshots.at(-1);
    if (!snapshotBeforeTake) throw new Error('prepared queue snapshot was not captured');

    await expect(snapshotBeforeTake.takeControl(failingItem)).rejects.toThrow('take failed');

    await waitFor(() => {
      const latestSnapshot = snapshots.at(-1);
      expect(latestSnapshot?.driverParticipantId).toBeNull();
      expect(latestSnapshot?.state.currentClimbQueueItem?.uuid).toBe('queue-current');
      expect(latestSnapshot?.state.queue.map((item) => item.uuid)).toEqual(['queue-current', 'queue-suggested']);
      expect(latestSnapshot?.playlistSuggestionSource).toEqual(playlistSuggestionSource);
    });
    expect(toast.showToast).toHaveBeenCalledWith('mobile.queue.actionFailed', 'error');
  });

  it('preserves playlist continuation when takeControl claims a suggested item', async () => {
    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    });

    const currentItem = makeQueueItem('queue-current', 'climb-current');
    const suggestedItem = makeQueueItem('queue-suggested', 'climb-suggested', { suggested: true });
    const followingItem = makeQueueItem('queue-following-source', 'climb-following', { suggested: true });
    const playlistSuggestionSource: PlaylistSuggestionSource = {
      playlistUuid: 'playlist-1',
      activatedClimbUuid: currentItem.climb.uuid,
      boardKey: 'kilter:1:10:1,2',
      climbs: [currentItem.climb, suggestedItem.climb, followingItem.climb],
    };
    const preparedSnapshot = snapshots.at(-1);
    if (!preparedSnapshot) throw new Error('queue snapshot was not captured');

    act(() => {
      preparedSnapshot.setCurrentClimb(currentItem, { playlistSuggestionSource: null });
      preparedSnapshot.setPlaylistSuggestionSource(playlistSuggestionSource);
    });

    await waitFor(() => {
      expect(snapshots.at(-1)?.playlistSuggestionSource).toEqual(playlistSuggestionSource);
    });

    const snapshotBeforeTake = snapshots.at(-1);
    if (!snapshotBeforeTake) throw new Error('prepared queue snapshot was not captured');
    await act(async () => {
      await snapshotBeforeTake.takeControl(suggestedItem);
    });

    await waitFor(() => {
      const latestSnapshot = snapshots.at(-1);
      expect(latestSnapshot?.state.currentClimbQueueItem?.uuid).toBe('queue-suggested');
      expect(latestSnapshot?.playlistSuggestionSource).toEqual(playlistSuggestionSource);
    });

    const driverSnapshot = snapshots.at(-1);
    if (!driverSnapshot) throw new Error('driver snapshot was not captured');
    act(() => {
      driverSnapshot.nextClimb();
    });

    await waitFor(() => {
      const latestSnapshot = snapshots.at(-1);
      expect(latestSnapshot?.state.currentClimbQueueItem?.climb.uuid).toBe('climb-following');
      expect(latestSnapshot?.state.currentClimbQueueItem?.uuid).not.toBe('playlist-peek:climb-following');
      expect(latestSnapshot?.playlistSuggestionSource).toEqual(playlistSuggestionSource);
    });
  });

  it('rolls back optimistic releaseControl state when the mutation fails', async () => {
    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    });

    const queueItem = makeQueueItem('queue-current', 'climb-current');
    const snapshot = snapshots.at(-1);
    if (!snapshot) throw new Error('queue snapshot was not captured');
    await act(async () => {
      await snapshot.takeControl(queueItem);
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.driverParticipantId).toBe('participant-self');
    });

    const failure = new Error('release failed');
    queueMutations.releaseControl.mockRejectedValueOnce(failure);
    const driverSnapshot = snapshots.at(-1);
    if (!driverSnapshot) throw new Error('driver snapshot was not captured');

    await expect(driverSnapshot.releaseControl()).rejects.toThrow('release failed');

    await waitFor(() => {
      expect(snapshots.at(-1)?.driverParticipantId).toBe('participant-self');
    });
    expect(toast.showToast).toHaveBeenCalledWith('mobile.queue.actionFailed', 'error');
  });

  it('does not optimistically clear a remote driver when a non-driver release resolves', async () => {
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
            __typename: 'DriverChanged',
            driverParticipantId: 'participant-2',
            previousDriverParticipantId: null,
          },
        },
      });
    });

    await waitFor(() => {
      expect(snapshots.at(-1)?.driverParticipantId).toBe('participant-2');
    });

    const nonDriverSnapshot = snapshots.at(-1);
    if (!nonDriverSnapshot) throw new Error('non-driver snapshot was not captured');

    await act(async () => {
      await nonDriverSnapshot.releaseControl();
    });

    expect(queueMutations.releaseControl).toHaveBeenCalledOnce();
    expect(snapshots.at(-1)?.driverParticipantId).toBe('participant-2');
    expect(toast.showToast).not.toHaveBeenCalled();
  });

  it('does not let a stale takeControl failure roll back a newer local claim', async () => {
    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    });

    const firstTake = createDeferred<void>();
    queueMutations.takeControl.mockImplementationOnce(() => firstTake.promise).mockResolvedValueOnce(undefined);

    const firstItem = makeQueueItem('queue-first', 'climb-first');
    const secondItem = makeQueueItem('queue-second', 'climb-second');
    const initialSnapshot = snapshots.at(-1);
    if (!initialSnapshot) throw new Error('queue snapshot was not captured');

    let firstTakePromise: Promise<void> | null = null;
    act(() => {
      firstTakePromise = initialSnapshot.takeControl(firstItem).catch(() => {});
    });

    await waitFor(() => {
      expect(snapshots.at(-1)?.state.currentClimbQueueItem?.uuid).toBe('queue-first');
    });

    const firstOptimisticSnapshot = snapshots.at(-1);
    if (!firstOptimisticSnapshot) throw new Error('first optimistic snapshot was not captured');
    await act(async () => {
      await firstOptimisticSnapshot.takeControl(secondItem);
    });

    await waitFor(() => {
      const latestSnapshot = snapshots.at(-1);
      expect(latestSnapshot?.driverParticipantId).toBe('participant-self');
      expect(latestSnapshot?.state.currentClimbQueueItem?.uuid).toBe('queue-second');
    });

    act(() => {
      firstTake.reject(new Error('first take failed'));
    });
    if (!firstTakePromise) throw new Error('first take promise was not captured');
    await act(async () => {
      await firstTakePromise;
    });

    const latestSnapshot = snapshots.at(-1);
    expect(latestSnapshot?.driverParticipantId).toBe('participant-self');
    expect(latestSnapshot?.state.currentClimbQueueItem?.uuid).toBe('queue-second');
    expect(toast.showToast).not.toHaveBeenCalled();
  });

  it('republishes WallConfirmedClimb events onto the shared wall-confirm bus', async () => {
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
            __typename: 'DriverChanged',
            driverParticipantId: 'stale-driver',
            previousDriverParticipantId: null,
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
    expect(snapshots.at(-1)?.driverParticipantId).not.toBe('stale-driver');
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
});
