// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react';
import { createElement, useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';

// Self-contained QueueProvider harness for the LOCAL solo queue model: no
// session is ever created lazily (mutations are local-only no-ops without a
// session), the solo queue persists via queue-snapshot-store, and the explicit
// Start path seeds the freshly created session with the locally-built queue.

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
  reportWallDisconnect: vi.fn(async () => {}),
  confirmClimbOnWall: vi.fn(async () => {}),
  setSessionBoardSerial: vi.fn(async () => {}),
  setSessionBoardPath: vi.fn(async () => {}),
}));

// Capture the deps mobile passes into the shared useQueueMutations so the
// REAL ensureReady seam (the no-lazy-create contract) is testable directly.
type CapturedMutationDeps = {
  getSessionId: () => string | null;
  ensureReady?: (capturedSessionId: string | null) => Promise<string | null>;
};
const capturedMutationDeps = vi.hoisted(() => ({ current: null as CapturedMutationDeps | null }));

const sessionStore = vi.hoisted(() => ({
  getStoredSessionId: vi.fn(async (): Promise<string | null> => null),
  setStoredSessionId: vi.fn(async () => {}),
  clearStoredSessionId: vi.fn(async () => {}),
}));

type StoredSnapshot = {
  queue: ClimbQueueItem[];
  currentClimbQueueItem: ClimbQueueItem | null;
  playlistSuggestionSource: PlaylistSuggestionSource | null;
  savedAt: string;
};
const queueSnapshotStore = vi.hoisted(() => ({
  getStoredQueueSnapshot: vi.fn(async (): Promise<StoredSnapshot | null> => null),
  setStoredQueueSnapshot: vi.fn(async () => {}),
  clearStoredQueueSnapshot: vi.fn(async () => {}),
}));

const errorReporter = vi.hoisted(() => ({
  reportError: vi.fn(),
  reportHandledError: vi.fn(),
}));

const toast = vi.hoisted(() => ({
  showToast: vi.fn(),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default },
  AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-correlation-id' }));
vi.mock('@boardsesh/graphql-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/graphql-client')>()),
  execute: graph.execute,
}));
vi.mock('@boardsesh/queue-react', () => ({
  useQueueMutations: (deps: CapturedMutationDeps) => {
    capturedMutationDeps.current = deps;
    return queueMutations;
  },
}));
vi.mock('@boardsesh/play-view', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/play-view')>()),
  emitWallConfirm: vi.fn(),
}));
vi.mock('../../lib/graphql/ws-client', () => ({ getWsClient: () => ws.client }));
vi.mock('../../lib/session-store', () => sessionStore);
vi.mock('../../lib/queue-snapshot-store', () => queueSnapshotStore);
vi.mock('../../lib/active-board-store', () => ({ getStoredActiveBoard: activeBoard.getStoredActiveBoard }));
vi.mock('../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: activeBoard.stored }),
  useSetActiveBoard: () => vi.fn(async () => {}),
}));
vi.mock('../../lib/graphql/client', () => ({ getHttpClient: () => ({ request: http.request }) }));
vi.mock('../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../lib/error-reporting', () => ({
  reportError: errorReporter.reportError,
  reportHandledError: errorReporter.reportHandledError,
}));
vi.mock('../toast-provider', () => ({ useToast: () => ({ showToast: toast.showToast }) }));
vi.mock('../queue-snackbar-provider', () => ({ useQueueSnackbar: () => ({ showQueueAddedSnackbar: vi.fn() }) }));

import { QueueProvider, usePlaylistSuggestionSource, useQueue } from '../queue-provider';

type Snapshot = {
  state: ReturnType<typeof useQueue>['state'];
  sessionId: string | null;
  playlistSuggestionSource: PlaylistSuggestionSource | null;
  addToQueue: ReturnType<typeof useQueue>['addToQueue'];
  setCurrentClimb: ReturnType<typeof useQueue>['setCurrentClimb'];
  startSession: ReturnType<typeof useQueue>['startSession'];
  joinSession: ReturnType<typeof useQueue>['joinSession'];
};

function Probe({ onSnapshot }: { onSnapshot: (snapshot: Snapshot) => void }) {
  const queue = useQueue();
  const playlistSuggestionSource = usePlaylistSuggestionSource();
  useEffect(() => {
    onSnapshot({
      state: queue.state,
      sessionId: queue.sessionId,
      playlistSuggestionSource,
      addToQueue: queue.addToQueue,
      setCurrentClimb: queue.setCurrentClimb,
      startSession: queue.startSession,
      joinSession: queue.joinSession,
    });
  }, [
    queue.state,
    queue.sessionId,
    playlistSuggestionSource,
    queue.addToQueue,
    queue.setCurrentClimb,
    queue.startSession,
    queue.joinSession,
    onSnapshot,
  ]);
  return null;
}

function renderProvider(onSnapshot: (snapshot: Snapshot) => void) {
  return render(createElement(QueueProvider, null, createElement(Probe, { onSnapshot })));
}

function makeQueueItem(uuid: string, climbUuid = uuid): ClimbQueueItem {
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
    suggested: false,
  };
}

const storedSnapshot = (items: ClimbQueueItem[], current: ClimbQueueItem | null): StoredSnapshot => ({
  queue: items,
  currentClimbQueueItem: current,
  playlistSuggestionSource: null,
  savedAt: '2026-06-10T00:00:00.000Z',
});

describe('QueueProvider local solo queue', () => {
  beforeEach(() => {
    ws.client.on.mockClear();
    ws.client.subscribe.mockClear();
    capturedMutationDeps.current = null;
    activeBoard.getStoredActiveBoard.mockReset();
    activeBoard.getStoredActiveBoard.mockResolvedValue(activeBoard.stored);
    for (const mutation of Object.values(queueMutations) as Array<ReturnType<typeof vi.fn>>) {
      mutation.mockReset();
      mutation.mockResolvedValue(undefined);
    }
    sessionStore.getStoredSessionId.mockReset();
    sessionStore.getStoredSessionId.mockResolvedValue(null);
    sessionStore.setStoredSessionId.mockClear();
    sessionStore.clearStoredSessionId.mockClear();
    queueSnapshotStore.getStoredQueueSnapshot.mockReset();
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue(null);
    queueSnapshotStore.setStoredQueueSnapshot.mockClear();
    queueSnapshotStore.clearStoredQueueSnapshot.mockClear();
    errorReporter.reportError.mockClear();
    toast.showToast.mockClear();
    graph.execute.mockReset();
    graph.execute.mockResolvedValue({
      joinSession: {
        participantId: 'participant-self',
        clientId: 'client-self',
        isLeader: true,
        lastConnectedBoardSerial: null,
        boardPath: '/kilter/1/10/1,2/40/list',
        users: [],
      },
    });
    http.request.mockReset();
    http.request.mockResolvedValue({ createSession: { id: 'session-new' } });
  });

  it('hydrates the stored solo queue snapshot when no session restores', async () => {
    const item = makeQueueItem('stored-item', 'stored-climb');
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue(storedSnapshot([item], item));

    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(snapshots.at(-1)?.state.queue.map((entry) => entry.uuid)).toEqual(['stored-item']);
      expect(snapshots.at(-1)?.state.currentClimbQueueItem?.uuid).toBe('stored-item');
    });
    expect(snapshots.at(-1)?.sessionId).toBeNull();
    // No session restore, no join, no creation — the queue is purely local.
    expect(graph.execute).not.toHaveBeenCalled();
    expect(http.request).not.toHaveBeenCalled();
  });

  it('skips the local snapshot when a stored session restores (server queue wins)', async () => {
    sessionStore.getStoredSessionId.mockResolvedValue('session-1');
    http.request.mockImplementation((operation: string) =>
      operation.includes('SessionStatus')
        ? Promise.resolve({ sessionStatus: 'active' })
        : Promise.resolve({ createSession: { id: 'session-new' } }),
    );
    const item = makeQueueItem('stale-item');
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue(storedSnapshot([item], item));

    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));

    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-1');
    });
    // The session's FullSync owns the queue; the stale local snapshot must not
    // leak into it.
    expect(snapshots.at(-1)?.state.queue).toEqual([]);
  });

  it('never creates a session from queue mutations (ensureReady contract)', async () => {
    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));
    await waitFor(() => {
      expect(capturedMutationDeps.current).not.toBeNull();
      expect(snapshots.length).toBeGreaterThan(0);
    });

    const deps = capturedMutationDeps.current;
    if (!deps?.ensureReady) throw new Error('mutation deps were not captured');

    // No session: the seam resolves null (silent local-only no-op) without
    // touching the network.
    await expect(deps.ensureReady(null)).resolves.toBeNull();
    expect(http.request).not.toHaveBeenCalled();
    expect(graph.execute).not.toHaveBeenCalled();

    // Local mutations still apply to the reducer.
    act(() => {
      snapshots.at(-1)?.setCurrentClimb(makeQueueItem('local-item'));
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.currentClimbQueueItem?.uuid).toBe('local-item');
    });
    expect(snapshots.at(-1)?.sessionId).toBeNull();
    expect(http.request).not.toHaveBeenCalled();
  });

  it('persists the solo queue after mutations (debounced)', async () => {
    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));
    await waitFor(() => {
      expect(snapshots.length).toBeGreaterThan(0);
    });
    // Let the cold-start hydrate settle so the save gate opens.
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      snapshots.at(-1)?.addToQueue(makeQueueItem('persisted-item'));
    });

    await waitFor(
      () => {
        expect(queueSnapshotStore.setStoredQueueSnapshot).toHaveBeenCalled();
      },
      { timeout: 3000 },
    );
    const lastCall = queueSnapshotStore.setStoredQueueSnapshot.mock.calls.at(-1) as unknown as [
      { queue: ClimbQueueItem[] },
    ];
    expect(lastCall[0].queue.map((entry) => entry.uuid)).toContain('persisted-item');
  });

  it('seeds the freshly started session with the local queue before exposing it', async () => {
    const callOrder: string[] = [];
    http.request.mockImplementation(async (operation: string) => {
      if (operation.includes('CreateSession') || operation.includes('createSession')) {
        callOrder.push('create');
        return { createSession: { id: 'session-new' } };
      }
      return { sessionStatus: null };
    });
    graph.execute.mockImplementation(async () => {
      callOrder.push('join');
      return {
        joinSession: {
          participantId: 'participant-self',
          clientId: 'client-self',
          isLeader: true,
          lastConnectedBoardSerial: null,
          boardPath: '/kilter/1/10/1,2/40/list',
          users: [],
        },
      };
    });
    queueMutations.setQueue.mockImplementation(async () => {
      callOrder.push('setQueue');
    });
    queueSnapshotStore.clearStoredQueueSnapshot.mockImplementation(async () => {
      callOrder.push('clearSnapshot');
    });

    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));
    await waitFor(() => {
      expect(snapshots.length).toBeGreaterThan(0);
    });

    const item = makeQueueItem('pre-session-item');
    act(() => {
      snapshots.at(-1)?.setCurrentClimb(item);
    });
    await waitFor(() => {
      expect(snapshots.at(-1)?.state.currentClimbQueueItem?.uuid).toBe('pre-session-item');
    });

    await act(async () => {
      await expect(snapshots.at(-1)?.startSession()).resolves.toBe('session-new');
    });

    // Create → join → seed → drop the local snapshot, strictly in that order:
    // seeding must complete before the queueUpdates subscription mounts, or the
    // empty room's FullSync would wipe the local queue.
    expect(callOrder.slice(0, 4)).toEqual(['create', 'join', 'setQueue', 'clearSnapshot']);
    const setQueueCall = queueMutations.setQueue.mock.calls.at(-1) as unknown as [ClimbQueueItem[], ClimbQueueItem];
    expect(setQueueCall[0].map((entry) => entry.uuid)).toContain('pre-session-item');
    expect(setQueueCall[1]?.uuid).toBe('pre-session-item');
    expect(sessionStore.setStoredSessionId).toHaveBeenCalledWith('session-new');
    await waitFor(() => {
      expect(snapshots.at(-1)?.sessionId).toBe('session-new');
    });
  });

  it('starting with an empty queue skips seeding entirely', async () => {
    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));
    await waitFor(() => {
      expect(snapshots.length).toBeGreaterThan(0);
    });

    await act(async () => {
      await expect(snapshots.at(-1)?.startSession()).resolves.toBe('session-new');
    });

    expect(queueMutations.setQueue).not.toHaveBeenCalled();
    expect(sessionStore.setStoredSessionId).toHaveBeenCalledWith('session-new');
  });

  it('does not report createSession rate limits to error reporting', async () => {
    http.request.mockRejectedValueOnce({
      response: {
        status: 200,
        errors: [
          {
            message: 'Rate limit exceeded. Try again in 7 seconds.',
            extensions: { code: 'RATE_LIMITED', operation: 'createSession', retryAfterSeconds: 7 },
          },
        ],
      },
    });

    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));
    await waitFor(() => {
      expect(snapshots.length).toBeGreaterThan(0);
    });

    await act(async () => {
      await expect(snapshots.at(-1)?.startSession()).resolves.toBeNull();
    });

    expect(toast.showToast).toHaveBeenCalledWith('mobile.queue.rateLimited', 'error');
    expect(toast.showToast).not.toHaveBeenCalledWith('mobile.queue.sessionCreateError', 'error');
    expect(errorReporter.reportError).not.toHaveBeenCalled();
    expect(sessionStore.setStoredSessionId).not.toHaveBeenCalled();
    expect(graph.execute).not.toHaveBeenCalled();
  });

  it('joinSession persists the id and drops the solo snapshot', async () => {
    const snapshots: Snapshot[] = [];
    renderProvider((snapshot) => snapshots.push(snapshot));
    await waitFor(() => {
      expect(snapshots.length).toBeGreaterThan(0);
    });

    await act(async () => {
      await snapshots.at(-1)?.joinSession('session-2', {
        boardPath: '/kilter/1/10/1,2/40/list',
        userBoard: activeBoard.stored,
      });
    });

    expect(sessionStore.setStoredSessionId).toHaveBeenCalledWith('session-2');
    expect(queueSnapshotStore.clearStoredQueueSnapshot).toHaveBeenCalled();
  });
});
