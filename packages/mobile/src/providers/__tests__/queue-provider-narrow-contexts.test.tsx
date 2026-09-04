// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react';
import { createElement, useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';

// Focused harness for the queue-data narrow context (useQueueData). It asserts
// the referential contract the play drawer + always-mounted queue sheets rely
// on: the { queue, currentClimbQueueItem } value keeps its identity across an
// unrelated reducer/session dispatch (so a hidden sheet's frozen snapshot and a
// memoized consumer bail out), and changes on a real queue mutation.

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
    canEdit: false,
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

type CapturedMutationDeps = {
  getSessionId: () => string | null;
  ensureReady?: (capturedSessionId: string | null) => Promise<string | null>;
};
const capturedMutationDeps = vi.hoisted(() => ({ current: null as CapturedMutationDeps | null }));

const sessionStore = vi.hoisted(() => ({
  getStoredSessionId: vi.fn(async (): Promise<string | null> => null),
  setStoredSessionId: vi.fn(async () => {}),
  clearStoredSessionId: vi.fn(async () => {}),
  // Device provenance for the leave-vs-end emphasis (#3502).
  getStoredCreatedSessionId: vi.fn(async (): Promise<string | null> => null),
  setStoredCreatedSessionId: vi.fn(async () => {}),
  clearStoredCreatedSessionId: vi.fn(async () => {}),
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
vi.mock('../../lib/analytics', () => ({ track: vi.fn(), registerRenderSuperProperties: vi.fn() }));
vi.mock('../../lib/error-reporting', () => ({
  reportError: errorReporter.reportError,
  reportHandledError: errorReporter.reportHandledError,
}));
vi.mock('../toast-provider', () => ({ useToast: () => ({ showToast: toast.showToast }) }));
vi.mock('../queue-snackbar-provider', () => ({ useQueueSnackbar: () => ({ showQueueAddedSnackbar: vi.fn() }) }));
// The cross-board add gate calls useChoose()/useQueryClient()/expo-router, none of
// which this harness mounts. Pass every add straight through — the gate's own
// behaviour is covered by queue-provider-cross-board-add.test.tsx.
vi.mock('../queue/use-cross-board-add-gate', () => ({
  useCrossBoardAddGate: () => async () => ({ outcome: 'add' }),
}));
vi.mock('../party-profile-provider', () => ({
  usePartyProfile: () => ({ username: undefined, avatarUrl: undefined }),
}));

// The board continuation feed (the re-anchor after a board switch) is a React
// Query hook and this harness mounts no QueryClient. Its own behaviour is covered
// by queue-provider-board-switch.test.tsx.
vi.mock('../queue/use-board-continuation-feed', () => ({ useBoardContinuationFeed: () => ({ climbs: [] }) }));

import { QueueProvider, useQueue, useQueueData } from '../queue-provider';

type QueueData = ReturnType<typeof useQueueData>;

type Handle = {
  dispatch: ReturnType<typeof useQueue>['dispatch'];
  addToQueue: ReturnType<typeof useQueue>['addToQueue'];
  setCurrentClimb: ReturnType<typeof useQueue>['setCurrentClimb'];
  hasDoneFirstFetch: boolean;
};

// Records every commit's useQueueData() identity so a test can assert whether
// an unrelated dispatch left it untouched. The handle ref always points at the
// latest actions/state.
function Probe({ commits, handle }: { commits: QueueData[]; handle: { current: Handle | null } }) {
  const queueData = useQueueData();
  const queue = useQueue();
  // No dep array: fires on every commit, so a provider re-render that leaves
  // useQueueData() referentially stable still records a (repeated) entry, and
  // the handle always mirrors the latest actions/state.
  useEffect(() => {
    commits.push(queueData);
    handle.current = {
      dispatch: queue.dispatch,
      addToQueue: queue.addToQueue,
      setCurrentClimb: queue.setCurrentClimb,
      hasDoneFirstFetch: queue.state.hasDoneFirstFetch,
    };
  });
  return null;
}

function renderProvider() {
  const commits: QueueData[] = [];
  const handle = { current: null as Handle | null };
  render(createElement(QueueProvider, null, createElement(Probe, { commits, handle })));
  return { commits, handle };
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

describe('QueueProvider narrow contexts — useQueueData', () => {
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
    queueSnapshotStore.getStoredQueueSnapshot.mockReset();
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue(null);
    errorReporter.reportError.mockClear();
    toast.showToast.mockClear();
    graph.execute.mockReset();
    http.request.mockReset();
    http.request.mockResolvedValue({ createSession: { id: 'session-new' } });
  });

  it('keeps a stable useQueueData() identity across an unrelated state dispatch', async () => {
    const { commits, handle } = renderProvider();
    await waitFor(() => {
      expect(handle.current).not.toBeNull();
      expect(commits.length).toBeGreaterThan(0);
    });

    const before = commits.at(-1);
    const committedBefore = commits.length;

    // A non-queue reducer change (spreads state, touches only hasDoneFirstFetch)
    // stands in for the session/wall-lit bookkeeping churn the drawer must ignore.
    act(() => {
      handle.current?.dispatch({ type: 'SET_FIRST_FETCH', payload: true });
    });

    await waitFor(() => {
      expect(handle.current?.hasDoneFirstFetch).toBe(true);
      // The provider re-rendered (a new commit landed) …
      expect(commits.length).toBeGreaterThan(committedBefore);
    });
    // … but the queue-data value kept its identity: state.queue and
    // state.currentClimbQueueItem survived the state spread, so the memo held.
    expect(commits.at(-1)).toBe(before);
  });

  it('changes useQueueData() identity when a climb is added to the queue', async () => {
    const { commits, handle } = renderProvider();
    await waitFor(() => {
      expect(handle.current).not.toBeNull();
      expect(commits.length).toBeGreaterThan(0);
    });

    const before = commits.at(-1);
    act(() => {
      handle.current?.addToQueue(makeQueueItem('added-item'));
    });

    await waitFor(() => {
      expect(commits.at(-1)?.queue.map((entry) => entry.uuid)).toContain('added-item');
    });
    expect(commits.at(-1)).not.toBe(before);
  });

  it('changes useQueueData() identity when the current climb is set', async () => {
    const { commits, handle } = renderProvider();
    await waitFor(() => {
      expect(handle.current).not.toBeNull();
      expect(commits.length).toBeGreaterThan(0);
    });

    const before = commits.at(-1);
    act(() => {
      handle.current?.setCurrentClimb(makeQueueItem('current-item'));
    });

    await waitFor(() => {
      expect(commits.at(-1)?.currentClimbQueueItem?.uuid).toBe('current-item');
    });
    expect(commits.at(-1)).not.toBe(before);
  });
});
