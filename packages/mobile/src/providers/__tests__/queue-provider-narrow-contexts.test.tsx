// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react';
import { createElement, useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser, UserBoard } from '@boardsesh/shared-schema';
import type { ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';
import { createPlaylistSuggestionSource, getQueueBoardKey } from '@boardsesh/queue';

// Focused harness for the queue-data narrow context (useQueueData). It asserts
// the referential contract the play drawer + always-mounted queue sheets rely
// on: the { queue, currentClimbQueueItem } value keeps its identity across an
// unrelated reducer/session dispatch (so a hidden sheet's frozen snapshot and a
// memoized consumer bail out), and changes on a real queue mutation.

const ws = vi.hoisted(() => {
  type Sink = { next: (payload: { data?: Record<string, unknown> }) => void };
  let sessionSink: Sink | null = null;
  return {
    getSessionSink: () => sessionSink,
    reset: () => {
      sessionSink = null;
    },
    client: {
      on: vi.fn(() => vi.fn()),
      subscribe: vi.fn((request: { query: string }, sink: Sink) => {
        if (request.query.includes('sessionUpdates')) sessionSink = sink;
        return vi.fn();
      }),
    },
  };
});

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
  setActiveBoard: vi.fn(async () => {}),
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
  getQueueSnapshotGeneration: () => 0,
  setStoredQueueSnapshot: vi.fn(async () => {}),
  clearStoredQueueSnapshot: vi.fn(async () => {}),
}));

const errorReporter = vi.hoisted(() => ({
  reportError: vi.fn(),
  reportHandledError: vi.fn(),
}));

const toast = vi.hoisted(() => ({
  showToast: vi.fn(),
  showQueueAddedSnackbar: vi.fn(),
}));
const crossBoardAdd = vi.hoisted(() => ({ request: vi.fn(async () => ({ outcome: 'add' as const })) }));
const translation = vi.hoisted(() => ({ translate: (key: string) => key }));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translation.translate }) }));
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
  getActiveBoardWriteGeneration: () => 0,
  useActiveBoard: () => ({ data: activeBoard.stored }),
  useSetActiveBoard: () => activeBoard.setActiveBoard,
}));
vi.mock('../../lib/graphql/client', () => ({ getHttpClient: () => ({ request: http.request }) }));
vi.mock('../../lib/analytics', () => ({ track: vi.fn(), registerRenderSuperProperties: vi.fn() }));
vi.mock('../../lib/error-reporting', () => ({
  reportError: errorReporter.reportError,
  reportHandledError: errorReporter.reportHandledError,
}));
vi.mock('../toast-provider', () => ({ useToast: () => ({ showToast: toast.showToast }) }));
vi.mock('../queue-snackbar-provider', () => ({
  useQueueSnackbar: () => ({ showQueueAddedSnackbar: toast.showQueueAddedSnackbar }),
}));
// The cross-board add gate calls useChoose()/useQueryClient()/expo-router, none of
// which this harness mounts. Pass every add straight through — the gate's own
// behaviour is covered by queue-provider-cross-board-add.test.tsx.
vi.mock('../queue/use-cross-board-add-gate', () => ({
  useCrossBoardAddGate: () => crossBoardAdd.request,
}));
vi.mock('../party-profile-provider', () => ({
  usePartyProfile: () => ({ username: undefined, avatarUrl: undefined }),
}));

// The board continuation feed (the re-anchor after a board switch) is a React
// Query hook and this harness mounts no QueryClient. Its own behaviour is covered
// by queue-provider-board-switch.test.tsx.
vi.mock('../queue/use-board-continuation-feed', () => ({ useBoardContinuationFeed: () => ({ climbs: [] }) }));

// The gym-sibling roster is a React Query hook and this harness mounts no
// QueryClient. An empty set means "no other wall in reach", which is exactly the
// pre-existing behaviour these tests were written against; the reachable-wall
// rule has its own coverage in queue-provider-reachable-walls.test.tsx.
vi.mock('../queue/use-reachable-board-keys', () => ({
  useReachableBoardKeys: () => new Set<string>(),
}));

import { QueueProvider, useCurrentClimbMover, useQueue, useQueueActions, useQueueData } from '../queue-provider';

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
    ws.reset();
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

  it('keeps action consumers mounted without rerendering while their snapshot reads current climb and masked source', async () => {
    const commits: QueueData[] = [];
    const handle = { current: null as Handle | null };
    const actionOnlyRender = vi.fn();
    const actions = { current: null as ReturnType<typeof useQueueActions> | null };
    function ActionOnlyConsumer() {
      actions.current = useQueueActions();
      actionOnlyRender();
      return null;
    }
    render(
      createElement(QueueProvider, null, createElement(Probe, { commits, handle }), createElement(ActionOnlyConsumer)),
    );
    await waitFor(() => expect(actions.current).not.toBeNull());
    const readSnapshot = actions.current!.getQueueSnapshot;
    const beforeRenders = actionOnlyRender.mock.calls.length;
    const first = makeQueueItem('first');
    const second = makeQueueItem('second');
    first.climb.frames = '';
    second.climb.frames = '';
    const source = createPlaylistSuggestionSource({
      playlistUuid: 'playlist:current',
      activatedClimb: first.climb,
      climbs: [first.climb, second.climb],
      boardKey: getQueueBoardKey({ board_name: 'kilter', layout_id: 1, size_id: 10, set_ids: '1,2' }),
    });
    act(() => {
      handle.current?.dispatch({
        type: 'UPDATE_QUEUE',
        payload: { queue: [first, second], currentClimbQueueItem: first },
      });
      actions.current?.setPlaylistSuggestionSource(source);
    });
    await waitFor(() => expect(readSnapshot().playlistSuggestionSource?.playlistUuid).toBe('playlist:current'));
    expect(readSnapshot()).toMatchObject({ queue: [first, second], currentClimbQueueItem: first });
    expect(actions.current!.getQueueSnapshot).toBe(readSnapshot);
    expect(actionOnlyRender).toHaveBeenCalledTimes(beforeRenders);

    const offList = makeQueueItem('off-list');
    act(() => handle.current?.dispatch({ type: 'SET_CURRENT_CLIMB_QUEUE_ITEM', payload: offList }));
    expect(readSnapshot().currentClimbQueueItem).toBe(offList);
    expect(readSnapshot().playlistSuggestionSource).toBeNull();
    expect(actionOnlyRender).toHaveBeenCalledTimes(beforeRenders);

    act(() => {
      handle.current?.dispatch({ type: 'SET_CURRENT_CLIMB_QUEUE_ITEM', payload: first });
      actions.current?.setPlaylistSuggestionSource({ ...source, boardKey: 'another-board' });
    });
    expect(readSnapshot().playlistSuggestionSource).toBeNull();
    expect(actionOnlyRender).toHaveBeenCalledTimes(beforeRenders);
  });

  it('keeps roster getters, actions, queue data and mover faces stable during unrelated roster and stats pushes', async () => {
    const self: SessionUser = {
      id: 'participant-self',
      username: 'Self',
      isLeader: false,
      userId: 'account-self',
      connectionState: 'CONNECTED',
    };
    const sam: SessionUser = {
      id: 'participant-sam',
      username: '  Sam  ',
      isLeader: false,
      userId: 'account-sam',
      avatarUrl: 'sam.png',
      connectionState: 'CONNECTED',
    };
    sessionStore.getStoredSessionId.mockResolvedValue('session-1');
    http.request.mockResolvedValue({ sessionStatus: 'active' });
    graph.execute.mockImplementation(async (_client: unknown, operation: { query: string }) => {
      if (operation.query.includes('QueueCapabilitiesProbe')) {
        return { queueState: { fields: [] }, currentClimbChanged: { fields: [] } };
      }
      return {
        joinSession: {
          participantId: self.id,
          clientId: 'connection-self',
          isLeader: false,
          users: [self, sam],
          boardPath: '/kilter/1/10/1,2/40/list',
        },
      };
    });
    const commits: QueueData[] = [];
    const handle = { current: null as Handle | null };
    const actionOnlyRender = vi.fn();
    const actions = { current: null as ReturnType<typeof useQueueActions> | null };
    const moverCommits: Array<ReturnType<typeof useCurrentClimbMover>> = [];
    const moverRender = vi.fn();
    function ActionOnlyConsumer() {
      actions.current = useQueueActions();
      actionOnlyRender();
      return null;
    }
    function MoverConsumer() {
      const mover = useCurrentClimbMover();
      moverRender();
      useEffect(() => {
        moverCommits.push(mover);
      }, [mover]);
      return null;
    }
    render(
      createElement(
        QueueProvider,
        null,
        createElement(Probe, { commits, handle }),
        createElement(ActionOnlyConsumer),
        createElement(MoverConsumer),
      ),
    );
    await waitFor(() => expect(ws.getSessionSink()).not.toBeNull());
    const rosterSnapshot = actions.current!.getSessionRosterSnapshot;
    await waitFor(() => expect(rosterSnapshot().sessionUsers).toHaveLength(2));
    expect(rosterSnapshot()).toMatchObject({ sessionId: 'session-1', participantId: self.id });
    const current = makeQueueItem('current');
    act(() =>
      handle.current?.dispatch({
        type: 'INITIAL_QUEUE_DATA',
        payload: { queue: [current], currentClimbQueueItem: current, currentChangedBy: sam.id, sessionId: 'session-1' },
      }),
    );
    expect(moverCommits.at(-1)).toEqual({ participantId: sam.id, name: 'Sam', avatarUrl: 'sam.png' });
    const beforeMover = moverCommits.at(-1);
    const beforeMoverRenders = moverRender.mock.calls.length;
    const beforeData = commits.at(-1);
    const beforeActions = actions.current;
    const beforeActionRenders = actionOnlyRender.mock.calls.length;
    const other: SessionUser = {
      id: 'participant-other',
      username: 'Other',
      isLeader: false,
      userId: 'account-other',
      connectionState: 'CONNECTED',
    };
    act(() => {
      ws.getSessionSink()?.next({ data: { sessionUpdates: { __typename: 'UserJoined', user: other } } });
    });
    expect(rosterSnapshot().sessionUsers).toHaveLength(3);
    act(() => {
      ws.getSessionSink()?.next({
        data: {
          sessionUpdates: {
            __typename: 'SessionStatsUpdated',
            sessionId: 'session-1',
            totalSends: 7,
          },
        },
      });
      ws.getSessionSink()?.next({
        data: {
          sessionUpdates: {
            __typename: 'SessionRosterSnapshot',
            users: [{ ...self }, { ...sam }, { ...other }],
            boardPath: '/kilter/1/10/1,2/40/list',
          },
        },
      });
    });
    expect(actions.current).toBe(beforeActions);
    expect(actions.current!.getSessionRosterSnapshot).toBe(rosterSnapshot);
    expect(actionOnlyRender).toHaveBeenCalledTimes(beforeActionRenders);
    expect(moverCommits.at(-1)).toBe(beforeMover);
    expect(moverRender).toHaveBeenCalledTimes(beforeMoverRenders);
    expect(commits.at(-1)).toBe(beforeData);
    act(() => {
      ws.getSessionSink()?.next({
        data: {
          sessionUpdates: {
            __typename: 'UserPresenceChanged',
            user: { ...sam, username: 'Renamed', avatarUrl: 'renamed.png' },
          },
        },
      });
    });
    expect(moverCommits.at(-1)).toEqual({ participantId: sam.id, name: 'Renamed', avatarUrl: 'renamed.png' });
    expect(moverCommits.at(-1)).not.toBe(beforeMover);
    act(() => {
      ws.getSessionSink()?.next({
        data: {
          sessionUpdates: {
            __typename: 'UserPresenceChanged',
            user: { ...sam, username: '   ' },
          },
        },
      });
    });
    expect(moverCommits.at(-1)).toBeNull();
    act(() =>
      handle.current?.dispatch({
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: { item: current, isServerEvent: true, currentChangedBy: self.id },
      }),
    );
    expect(moverCommits.at(-1)).toBeNull();
    act(() =>
      handle.current?.dispatch({
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: { item: current, isServerEvent: true, currentChangedBy: 'unknown' },
      }),
    );
    expect(moverCommits.at(-1)).toBeNull();
  });
});
