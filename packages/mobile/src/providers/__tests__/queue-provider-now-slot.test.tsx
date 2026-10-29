// @vitest-environment jsdom
/**
 * F3 now-slot mode in the queue provider (#6666; docs/current-climb-outside-
 * queue.md, sections 2 and 7): opens go through `placeOnWall` (no copies), the
 * mode is the `queue-now-slot` flag solo and the flag AND the per-connect server
 * probe in a session, and legacy mode is today's behaviour exactly.
 */
import { act, render, waitFor } from '@testing-library/react';
import { createElement, useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';
import type { SessionStatus, SessionUser, UserBoard } from '@boardsesh/shared-schema';
import { SHARED_EVENTS } from '@boardsesh/analytics';

const ws = vi.hoisted(() => {
  type WsEventName = 'connected' | 'closed';
  type QueueUpdatesSink = { next: (payload: { data?: { queueUpdates?: unknown } }) => void };
  let queueUpdatesSink: QueueUpdatesSink | null = null;
  const listeners: Record<WsEventName, Set<() => void>> = { connected: new Set(), closed: new Set() };
  return {
    getQueueUpdatesSink: () => queueUpdatesSink,
    client: {
      on: vi.fn((eventName: WsEventName, listener: () => void) => {
        listeners[eventName].add(listener);
        return () => {
          listeners[eventName].delete(listener);
        };
      }),
      subscribe: vi.fn((request: { query: string }, sink: { next: (payload: unknown) => void }) => {
        if (request.query.includes('queueUpdates')) queueUpdatesSink = sink as QueueUpdatesSink;
        return vi.fn();
      }),
    },
    reset: () => {
      queueUpdatesSink = null;
      listeners.connected.clear();
      listeners.closed.clear();
    },
  };
});

const flags = vi.hoisted(() => ({ nowSlot: true }));
const probe = vi.hoisted(() => ({ fields: ['sequence', 'historyCount', 'currentChangedAt'] as string[] }));
const graph = vi.hoisted(() => ({ execute: vi.fn() }));
const http = vi.hoisted(() => ({ request: vi.fn() }));
const analytics = vi.hoisted(() => ({ track: vi.fn() }));

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
  addQueueItem: vi.fn(async (_item: ClimbQueueItem, _position?: number) => {}),
  removeQueueItem: vi.fn(async () => {}),
  reorderQueueItem: vi.fn(async (_uuid: string, _oldIndex: number, _newIndex: number) => {}),
  setCurrentClimb: vi.fn(
    async (
      _item: ClimbQueueItem | null,
      _shouldAddToQueue?: boolean,
      _correlationId?: string,
      _placement?: string,
    ) => {},
  ),
  mirrorCurrentClimb: vi.fn(async () => {}),
  publishPlaybackState: vi.fn(async () => {}),
  setQueue: vi.fn(
    async (
      _queue: ClimbQueueItem[],
      _currentClimbQueueItem?: ClimbQueueItem | null,
      _historyCount?: number | null,
    ) => {},
  ),
  replaceQueueItem: vi.fn(async () => {}),
  confirmClimbOnWall: vi.fn(async () => {}),
  reportWallDisconnect: vi.fn(async () => {}),
  setSessionBoardSerial: vi.fn(async () => {}),
  setSessionBoardPath: vi.fn(async () => {}),
  wasUuidExplicitlyRemoved: vi.fn((_uuid: string) => false),
}));

type CapturedMutationDeps = {
  shouldUseNowSlotDocuments?: () => boolean;
  onNowSlotDocumentsRejected?: (error: unknown) => void;
};
const capturedMutationDeps = vi.hoisted(() => ({ current: null as CapturedMutationDeps | null }));

const sessionStore = vi.hoisted(() => ({
  getStoredSessionId: vi.fn(async (): Promise<string | null> => null),
  setStoredSessionId: vi.fn(async () => {}),
  clearStoredSessionId: vi.fn(async () => {}),
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

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default },
  AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })), currentState: 'active' },
}));
// A fresh uuid per call: two track peeks minted in a row must not share one.
const uuids = vi.hoisted(() => ({ minted: 0 }));
vi.mock('expo-crypto', () => ({
  randomUUID: () => {
    uuids.minted += 1;
    return `test-uuid-${uuids.minted}`;
  },
}));
vi.mock('@boardsesh/graphql-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/graphql-client')>()),
  execute: graph.execute,
}));
vi.mock('@boardsesh/queue-react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/queue-react')>()),
  useQueueMutations: (deps: CapturedMutationDeps) => {
    capturedMutationDeps.current = deps;
    return queueMutations;
  },
}));
vi.mock('@boardsesh/play-view', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/play-view')>()),
  emitWallConfirm: vi.fn(),
}));
vi.mock('../feature-flags-provider', () => ({
  useSharedSessionBrowseEnabled: () => false,
  useQueueNowSlotEnabled: () => flags.nowSlot,
}));
vi.mock('../../lib/graphql/ws-client', () => ({ getWsClient: () => ws.client }));
vi.mock('../../lib/session-store', () => sessionStore);
vi.mock('../../lib/queue-snapshot-store', () => queueSnapshotStore);
vi.mock('../../lib/active-board-store', () => ({ getStoredActiveBoard: activeBoard.getStoredActiveBoard }));
// No board art in these tests, so a track keeps every climb it was given.
vi.mock('../../lib/board-details', () => ({ getBoardRenderData: () => null }));
vi.mock('../../lib/graphql/use-active-board', () => ({
  getActiveBoardWriteGeneration: () => 0,
  useActiveBoard: () => ({ data: activeBoard.stored }),
  useSetActiveBoard: () => vi.fn(async () => {}),
}));
vi.mock('../../lib/graphql/client', () => ({ getHttpClient: () => ({ request: http.request }) }));
vi.mock('../../lib/analytics', () => ({ track: analytics.track, registerRenderSuperProperties: vi.fn() }));
vi.mock('../../lib/error-reporting', () => ({ reportError: vi.fn(), reportHandledError: vi.fn() }));
vi.mock('../toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../queue-snackbar-provider', () => ({ useQueueSnackbar: () => ({ showQueueAddedSnackbar: vi.fn() }) }));
vi.mock('../queue/use-cross-board-add-gate', () => ({
  useCrossBoardAddGate: () => async () => ({ outcome: 'add' }),
}));
vi.mock('../party-profile-provider', () => ({
  usePartyProfile: () => ({ username: undefined, avatarUrl: undefined }),
}));
vi.mock('../queue/use-reachable-board-keys', () => ({ useReachableBoardKeys: () => new Set<string>() }));
vi.mock('../queue/use-board-continuation-feed', () => ({ useBoardContinuationFeed: () => ({ climbs: [] }) }));

import { QueueProvider, useQueue, useQueueSessionId } from '../queue-provider';
import { resetQueueServerProbeReportForTests } from '../queue/now-slot-server';
import { clearRelayReceipt, takeRelayReceipt } from '../../lib/relay-receipt';

type Queue = ReturnType<typeof useQueue>;
type Snapshot = Pick<
  Queue,
  | 'state'
  | 'sessionId'
  | 'setCurrentClimb'
  | 'nextClimb'
  | 'previousClimb'
  | 'findReplayFromHereItem'
  | 'playNext'
  | 'removeQueueItems'
  | 'restoreQueueItems'
  | 'getQueueSnapshot'
> & { undoScope: string };

function Probe({ onSnapshot }: { onSnapshot: (snapshot: Snapshot) => void }) {
  const queue = useQueue();
  const { undoScope } = useQueueSessionId();
  useEffect(() => {
    onSnapshot({
      state: queue.state,
      sessionId: queue.sessionId,
      setCurrentClimb: queue.setCurrentClimb,
      nextClimb: queue.nextClimb,
      previousClimb: queue.previousClimb,
      findReplayFromHereItem: queue.findReplayFromHereItem,
      playNext: queue.playNext,
      removeQueueItems: queue.removeQueueItems,
      restoreQueueItems: queue.restoreQueueItems,
      getQueueSnapshot: queue.getQueueSnapshot,
      undoScope,
    });
  }, [queue, undoScope, onSnapshot]);
  return null;
}

function makeQueueItem(uuid: string, climbUuid = `climb-${uuid}`): ClimbQueueItem {
  return {
    uuid,
    climb: {
      uuid: climbUuid,
      boardType: 'kilter',
      layoutId: 1,
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

const sessionUser = (id: string): SessionUser => ({
  id,
  username: id,
  isLeader: false,
  avatarUrl: undefined,
  userId: `db-${id}`,
  connectionState: 'CONNECTED',
});

const statusResponse = (status: SessionStatus | null = 'active') => ({ sessionStatus: status });

function uuidsOf(snapshot: Snapshot | undefined): string[] {
  return snapshot?.state.queue.map(({ uuid }) => uuid) ?? [];
}

function executedQueries(): string[] {
  return graph.execute.mock.calls.map(([, operation]) => (operation as { query: string }).query);
}

function subscribedQueries(): string[] {
  return ws.client.subscribe.mock.calls.map(([request]) => (request as { query: string }).query);
}

function setActiveClimbEvents() {
  return analytics.track.mock.calls.filter(([eventName]) => eventName === SHARED_EVENTS.SetActiveClimb);
}

async function renderSolo(items: ClimbQueueItem[], current: ClimbQueueItem | null, historyCount?: number) {
  queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue({
    queue: items,
    currentClimbQueueItem: current,
    playlistSuggestionSource: null,
    savedAt: '2026-10-25T00:00:00.000Z',
    ...(historyCount === undefined ? {} : { historyCount }),
  });
  const snapshots: Snapshot[] = [];
  render(createElement(QueueProvider, null, createElement(Probe, { onSnapshot: (s) => snapshots.push(s) })));
  await waitFor(() => {
    expect(uuidsOf(snapshots.at(-1))).toEqual(items.map(({ uuid }) => uuid));
    expect(snapshots.at(-1)?.state.nowSlotMode).toBe(flags.nowSlot);
  });
  return () => {
    const latest = snapshots.at(-1);
    if (!latest) throw new Error('provider never rendered');
    return latest;
  };
}

/**
 * A cold start whose restore lands while the flag is still unresolved (read as
 * off), with nothing current and a saved line. `flipFlag` then resolves it on.
 */
async function renderBeforeFlagResolves(items: ClimbQueueItem[], historyCount: number) {
  const storedSnapshot: StoredSnapshot & { historyCount: number } = {
    queue: items,
    currentClimbQueueItem: null,
    playlistSuggestionSource: null,
    savedAt: '2026-10-25T00:00:00.000Z',
    historyCount,
  };
  queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue(storedSnapshot);
  const snapshots: Snapshot[] = [];
  const onSnapshot = (snapshot: Snapshot) => snapshots.push(snapshot);
  const tree = () => createElement(QueueProvider, null, createElement(Probe, { onSnapshot }));
  const { rerender } = render(tree());
  await waitFor(() => expect(uuidsOf(snapshots.at(-1))).toEqual(items.map(({ uuid }) => uuid)));
  const latest = () => {
    const snapshot = snapshots.at(-1);
    if (!snapshot) throw new Error('provider never rendered');
    return snapshot;
  };
  const flipFlag = async () => {
    flags.nowSlot = true;
    rerender(tree());
    await waitFor(() => expect(latest().state.nowSlotMode).toBe(true));
  };
  return { latest, flipFlag };
}

async function renderSession(items: ClimbQueueItem[], current: ClimbQueueItem) {
  sessionStore.getStoredSessionId.mockResolvedValue('session-1');
  const snapshots: Snapshot[] = [];
  render(createElement(QueueProvider, null, createElement(Probe, { onSnapshot: (s) => snapshots.push(s) })));
  await waitFor(() => {
    expect(ws.getQueueUpdatesSink()).not.toBeNull();
    expect(snapshots.at(-1)?.sessionId).toBe('session-1');
  });
  const sink = ws.getQueueUpdatesSink();
  if (!sink) throw new Error('queue updates sink was not captured');
  act(() => {
    sink.next({
      data: {
        queueUpdates: {
          __typename: 'FullSync',
          sequence: 1,
          state: {
            sequence: 1,
            stateHash: 'hash-1',
            queue: items,
            currentClimbQueueItem: current,
            historyCount: items.findIndex(({ uuid }) => uuid === current.uuid),
          },
        },
      },
    });
  });
  await waitFor(() => expect(uuidsOf(snapshots.at(-1))).toEqual(items.map(({ uuid }) => uuid)));
  return () => {
    const latest = snapshots.at(-1);
    if (!latest) throw new Error('provider never rendered');
    return latest;
  };
}

const A = makeQueueItem('a');
const B = makeQueueItem('b');
const C = makeQueueItem('c');
const D = makeQueueItem('d');

describe('QueueProvider now-slot mode (F3)', () => {
  beforeEach(() => {
    flags.nowSlot = true;
    probe.fields = ['sequence', 'historyCount', 'currentChangedAt'];
    ws.reset();
    ws.client.on.mockClear();
    ws.client.subscribe.mockClear();
    capturedMutationDeps.current = null;
    resetQueueServerProbeReportForTests();
    activeBoard.getStoredActiveBoard.mockReset();
    activeBoard.getStoredActiveBoard.mockResolvedValue(activeBoard.stored);
    for (const mutation of Object.values(queueMutations) as Array<ReturnType<typeof vi.fn>>) {
      mutation.mockReset();
      mutation.mockResolvedValue(undefined);
    }
    queueMutations.wasUuidExplicitlyRemoved.mockReturnValue(false);
    sessionStore.getStoredSessionId.mockReset();
    sessionStore.getStoredSessionId.mockResolvedValue(null);
    queueSnapshotStore.getStoredQueueSnapshot.mockReset();
    analytics.track.mockClear();
    graph.execute.mockReset();
    graph.execute.mockImplementation(async (_client: unknown, operation: { query: string }) => {
      if (operation.query.includes('QueueStateFieldsProbe')) {
        return { __type: { fields: probe.fields.map((name) => ({ name })) } };
      }
      return {
        joinSession: {
          participantId: 'participant-self',
          clientId: 'client-self',
          isLeader: false,
          lastConnectedBoardSerial: null,
          boardPath: '/kilter/1/10/1,2/40/list',
          users: [sessionUser('participant-self'), sessionUser('participant-peer')],
        },
      };
    });
    http.request.mockReset();
    http.request.mockImplementation(async (operation: string) => {
      if (operation.includes('SessionStatus')) return statusResponse();
      return {};
    });
  });

  describe('solo', () => {
    it('a logbook tap on a queued climb moves it into Now: no copy', async () => {
      // A, B (current), C. Tap C in the logbook: a fresh item for the same climb.
      const latest = await renderSolo([A, B, C], B);
      act(() => latest().setCurrentClimb(makeQueueItem('c-prime', C.climb.uuid)));
      expect(uuidsOf(latest())).toEqual(['a', 'b', 'c']);
      expect(latest().state.currentClimbQueueItem?.uuid).toBe('c');
      expect(latest().state.historyCount).toBe(2);
    });

    it('Set Active Climb carries rewrite, placement and nowSlotMode, with a null sessionId', async () => {
      const latest = await renderSolo([A, B, C], B);
      act(() => latest().setCurrentClimb(makeQueueItem('c-prime', C.climb.uuid)));
      expect(setActiveClimbEvents().at(-1)?.[1]).toMatchObject({
        sessionId: null,
        nowSlotMode: true,
        rewrite: 'dedupe-up-next',
        placement: 'NOW',
      });
    });

    it('Next onto a list climb History holds puts up a fresh copy, and says how it got there', async () => {
      // A (climb x) was climbed earlier; B is on the wall, from a list [B, C, x].
      const A = makeQueueItem('a', 'climb-x');
      const latest = await renderSolo([A, B], B);
      const list: PlaylistSuggestionSource = {
        playlistUuid: 'search-1',
        activatedClimbUuid: B.climb.uuid,
        boardKey: 'kilter:1:10:1,2',
        climbs: [B.climb, C.climb, A.climb],
      };
      act(() => latest().setCurrentClimb(B, { playlistSuggestionSource: list }));
      act(() => latest().nextClimb());
      const onC = latest().state.currentClimbQueueItem;
      expect(onC?.climb.uuid).toBe(C.climb.uuid);
      act(() => latest().nextClimb());
      const onX = latest().state.currentClimbQueueItem;
      expect(onX?.climb.uuid).toBe('climb-x');
      expect(onX?.uuid).not.toBe('a');
      // History keeps A where it was.
      expect(uuidsOf(latest()).slice(0, 3)).toEqual(['a', 'b', onC?.uuid]);
      expect(setActiveClimbEvents().at(-1)?.[1]).toMatchObject({
        trigger: 'next',
        navSource: 'peek',
        rewrite: 'insert',
        placement: 'NOW',
        listIndex: 2,
        fromQueueItemUuid: onC?.uuid,
        toQueueItemUuid: onX?.uuid,
      });
      act(() => latest().previousClimb());
      expect(setActiveClimbEvents().at(-1)?.[1]).toMatchObject({
        trigger: 'previous',
        navSource: 'list',
        fromQueueItemUuid: onX?.uuid,
        toQueueItemUuid: onC?.uuid,
      });
    });

    it('a fresh track peek goes on the wall at the Now slot, and moving on files it under History', async () => {
      // Swipe-shaped opens of climbs nobody queued: each one is History once the
      // next one goes on the wall, and Up next never changes.
      const latest = await renderSolo([A, B, D], B);
      for (const peek of [makeQueueItem('x'), makeQueueItem('y')]) {
        act(() => latest().setCurrentClimb(peek));
      }
      expect(uuidsOf(latest())).toEqual(['a', 'b', 'x', 'y', 'd']);
      expect(latest().state.currentClimbQueueItem?.uuid).toBe('y');
      // Walking back and forth on the queue is a pointer walk: still no copy.
      act(() => latest().previousClimb());
      act(() => latest().nextClimb());
      expect(uuidsOf(latest())).toEqual(['a', 'b', 'x', 'y', 'd']);
      expect(latest().state.currentClimbQueueItem?.uuid).toBe('y');
    });

    it('Previous with no track walks the queue: the climb you left becomes Up next[0]', async () => {
      const latest = await renderSolo([A, B, C], B);
      act(() => latest().previousClimb());
      expect(uuidsOf(latest())).toEqual(['a', 'b', 'c']);
      expect(latest().state.currentClimbQueueItem?.uuid).toBe('a');
      expect(latest().state.historyCount).toBe(0);
    });

    it('offers Replay from here only for a History row while a climb is current', async () => {
      const latest = await renderSolo([A, B, C, D], C);
      expect(latest().findReplayFromHereItem('a')?.uuid).toBe('a');
      expect(latest().findReplayFromHereItem('b')?.uuid).toBe('b');
      expect(latest().findReplayFromHereItem('c')).toBeNull();
      expect(latest().findReplayFromHereItem('d')).toBeNull();
      expect(latest().findReplayFromHereItem('nope')).toBeNull();
    });

    it('Replay from here puts the line back: the climbs after it are Up next again, in order', async () => {
      const latest = await renderSolo([A, B, C, D], C);
      act(() => latest().setCurrentClimb(A, { placement: 'STEP' }));
      expect(uuidsOf(latest())).toEqual(['a', 'b', 'c', 'd']);
      expect(latest().state.currentClimbQueueItem?.uuid).toBe('a');
      expect(latest().state.historyCount).toBe(0);
    });

    it('Next past climbs this board cannot draw reports the skip once, though they stay at the head of Up next', async () => {
      const offBoard = { ...makeQueueItem('t'), climb: { ...makeQueueItem('t').climb, boardType: 'tension' } };
      const E = makeQueueItem('e');
      const latest = await renderSolo([A, offBoard, C, D, E], A);
      const swipeSkips = () =>
        analytics.track.mock.calls.filter(
          ([eventName, properties]) =>
            eventName === SHARED_EVENTS.QueueClimbSkippedOnBoardSwitch &&
            (properties as { trigger?: string }).trigger === 'swipe',
        );
      act(() => latest().nextClimb());
      expect(latest().state.currentClimbQueueItem?.uuid).toBe('c');
      // The move-up-next placement leaves the skipped climb where it was.
      expect(uuidsOf(latest())).toEqual(['a', 'c', 't', 'd', 'e']);
      act(() => latest().nextClimb());
      expect(latest().state.currentClimbQueueItem?.uuid).toBe('d');
      expect(swipeSkips()).toHaveLength(1);
      // A swipe back re-arms it: the same climbs walked past again are worth
      // saying again.
      act(() => latest().previousClimb());
      expect(latest().state.currentClimbQueueItem?.uuid).toBe('c');
      act(() => latest().nextClimb());
      act(() => latest().nextClimb());
      expect(latest().state.currentClimbQueueItem?.uuid).toBe('e');
      expect(swipeSkips()).toHaveLength(2);
    });

    describe('with nothing current', () => {
      it('a cold start keeps the saved line, so History stays History and Next lights Up next[0]', async () => {
        const latest = await renderSolo([A, B, C], null, 2);
        expect(latest().state.historyCount).toBe(2);
        act(() => latest().nextClimb());
        expect(latest().state.currentClimbQueueItem?.uuid).toBe('c');
      });

      // No cached flag values on the phone: the restore runs while the flag is
      // still unresolved (legacy), and the flag resolves on afterwards.
      it('a cold start before the flag resolves keeps the saved line for the mode', async () => {
        flags.nowSlot = false;
        queueSnapshotStore.setStoredQueueSnapshot.mockClear();
        const { latest, flipFlag } = await renderBeforeFlagResolves([A, B, C], 2);
        expect(latest().state.nowSlotMode).toBe(false);
        expect(latest().state.historyCount).toBeNull();
        // A legacy-mode save in that window keeps the line on disk.
        await waitFor(() => expect(queueSnapshotStore.setStoredQueueSnapshot).toHaveBeenCalled(), { timeout: 2000 });
        const savedSnapshots = queueSnapshotStore.setStoredQueueSnapshot.mock.calls as unknown as unknown[][];
        expect(savedSnapshots.at(-1)?.[0]).toMatchObject({ historyCount: 2 });

        await flipFlag();
        expect(latest().state.historyCount).toBe(2);
        act(() => latest().nextClimb());
        expect(latest().state.currentClimbQueueItem?.uuid).toBe('c');
      });

      it('a held line is dropped once the climber reshapes the queue before the flag resolves', async () => {
        flags.nowSlot = false;
        const { latest, flipFlag } = await renderBeforeFlagResolves([A, B, C], 2);
        act(() => latest().removeQueueItems(['a']));
        expect(uuidsOf(latest())).toEqual(['b', 'c']);
        await flipFlag();
        expect(latest().state.historyCount).toBe(0);
      });

      it('an older snapshot with no line still restores (the reducer derives it)', async () => {
        const latest = await renderSolo([A, B, C], null);
        expect(latest().state.historyCount).toBe(0);
      });

      it('Play next on a History climb makes it Up next[0] in one setQueue, never a reorder', async () => {
        const latest = await renderSolo([A, B, C], null, 2);
        await act(async () => {
          await latest().playNext({ item: A, queueItemUuid: 'a' });
        });
        expect(uuidsOf(latest())).toEqual(['b', 'a', 'c']);
        expect(latest().state.historyCount).toBe(1);
        await waitFor(() => expect(queueMutations.setQueue).toHaveBeenCalled());
        const [sentQueue, sentCurrent, sentLine] = queueMutations.setQueue.mock.calls.at(-1) ?? [];
        expect((sentQueue as ClimbQueueItem[]).map(({ uuid }) => uuid)).toEqual(['b', 'a', 'c']);
        expect(sentCurrent).toBeUndefined();
        expect(sentLine).toBe(1);
        expect(queueMutations.reorderQueueItem).not.toHaveBeenCalled();
        act(() => latest().nextClimb());
        expect(latest().state.currentClimbQueueItem?.uuid).toBe('a');
      });

      it('Play next on History with Up next empty still lands, at the end', async () => {
        const latest = await renderSolo([A, B], null, 2);
        await act(async () => {
          await latest().playNext({ item: A, queueItemUuid: 'a' });
        });
        expect(uuidsOf(latest())).toEqual(['b', 'a']);
        expect(latest().state.historyCount).toBe(1);
        expect(queueMutations.reorderQueueItem).not.toHaveBeenCalled();
      });

      it('Undo of an Up next removal keeps History as History', async () => {
        const latest = await renderSolo([A, B, C, D], null, 2);
        const before = latest().getQueueSnapshot();
        act(() => latest().removeQueueItems(['c']));
        expect(uuidsOf(latest())).toEqual(['a', 'b', 'd']);
        act(() => latest().restoreQueueItems(before, new Set(['c']), latest().undoScope));
        await waitFor(() => expect(uuidsOf(latest())).toEqual(['a', 'b', 'c', 'd']));
        expect(latest().state.historyCount).toBe(2);
        await waitFor(() => expect(queueMutations.setQueue).toHaveBeenCalled());
        expect(queueMutations.setQueue.mock.calls.at(-1)?.[2]).toBe(2);
        act(() => latest().nextClimb());
        expect(latest().state.currentClimbQueueItem?.uuid).toBe('c');
      });
    });

    it('flag off: today’s reducer copies the climb, and no Replay from here', async () => {
      flags.nowSlot = false;
      const latest = await renderSolo([A, B, C], B);
      expect(latest().findReplayFromHereItem('a')).toBeNull();
      act(() => latest().setCurrentClimb(makeQueueItem('c-prime', C.climb.uuid)));
      expect(uuidsOf(latest())).toEqual(['a', 'b', 'c-prime', 'c']);
      expect(latest().state.historyCount).toBeNull();
      expect(setActiveClimbEvents().at(-1)?.[1]).toMatchObject({ nowSlotMode: false, rewrite: null, placement: null });
    });
  });

  describe('in a session', () => {
    it('probe yes: the _NOW_SLOT join and subscription, and opens send placement with no queue-add', async () => {
      const latest = await renderSession([A, B, C], B);
      expect(executedQueries().some((query) => query.includes('QueueStateFieldsProbe'))).toBe(true);
      expect(executedQueries().some((query) => query.includes('JoinSessionNowSlot'))).toBe(true);
      expect(subscribedQueries().some((query) => query.includes('QueueUpdatesNowSlot'))).toBe(true);
      expect(capturedMutationDeps.current?.shouldUseNowSlotDocuments?.()).toBe(true);
      expect(analytics.track).toHaveBeenCalledWith(SHARED_EVENTS.QueueServerProbe, {
        nowSlotServer: true,
        fallback: 'probe',
      });

      act(() => latest().setCurrentClimb(makeQueueItem('c-prime', C.climb.uuid)));
      // The server gets the entry it resolved to, not the fresh copy.
      expect(queueMutations.setCurrentClimb).toHaveBeenCalledWith(
        expect.objectContaining({ uuid: 'c' }),
        false,
        expect.any(String),
        'NOW',
      );
      expect(queueMutations.addQueueItem).not.toHaveBeenCalled();
      expect(uuidsOf(latest())).toEqual(['a', 'b', 'c']);
      expect(setActiveClimbEvents().at(-1)?.[1]).toMatchObject({
        sessionId: 'session-1',
        nowSlotMode: true,
        rewrite: 'dedupe-up-next',
      });
    });

    it('three fast swipes leave Up next unchanged and send no queue-add', async () => {
      const latest = await renderSession([A, B, C], B);
      const peeks = [makeQueueItem('x'), makeQueueItem('y'), makeQueueItem('z')];
      for (const peek of peeks) {
        act(() => latest().setCurrentClimb(peek));
      }
      const { queue, currentClimbQueueItem } = latest().state;
      const currentIndex = queue.findIndex(({ uuid }) => uuid === currentClimbQueueItem?.uuid);
      expect(currentClimbQueueItem?.uuid).toBe('z');
      expect(queue.slice(currentIndex + 1).map(({ uuid }) => uuid)).toEqual(['c']);
      expect(queueMutations.addQueueItem).not.toHaveBeenCalled();
      for (const [, shouldAddToQueue, , placement] of queueMutations.setCurrentClimb.mock.calls) {
        expect(shouldAddToQueue).toBe(false);
        expect(placement).toBe('NOW');
      }
    });

    it('a validation error naming an F3 field marks the connection legacy', async () => {
      const latest = await renderSession([A, B, C], B);
      act(() => capturedMutationDeps.current?.onNowSlotDocumentsRejected?.(new Error('Unknown argument "placement"')));
      await waitFor(() => expect(latest().state.nowSlotMode).toBe(false));
      expect(capturedMutationDeps.current?.shouldUseNowSlotDocuments?.()).toBe(false);
      expect(analytics.track).toHaveBeenCalledWith(SHARED_EVENTS.QueueServerProbe, {
        nowSlotServer: false,
        fallback: 'validation-error',
      });
    });

    it('probe no: today’s documents, no placement, and today’s reducer', async () => {
      probe.fields = ['sequence', 'stateHash'];
      const latest = await renderSession([A, B, C], B);
      expect(executedQueries().some((query) => query.includes('JoinSessionNowSlot'))).toBe(false);
      expect(subscribedQueries().some((query) => query.includes('QueueUpdatesNowSlot'))).toBe(false);
      expect(capturedMutationDeps.current?.shouldUseNowSlotDocuments?.()).toBe(false);
      expect(latest().state.nowSlotMode).toBe(false);
      expect(analytics.track).toHaveBeenCalledWith(SHARED_EVENTS.QueueServerProbe, {
        nowSlotServer: false,
        fallback: 'probe',
      });

      act(() => latest().setCurrentClimb(makeQueueItem('c-prime', C.climb.uuid)));
      expect(queueMutations.setCurrentClimb).toHaveBeenCalledWith(
        expect.objectContaining({ uuid: 'c-prime' }),
        true,
        expect.any(String),
      );
      expect(queueMutations.setCurrentClimb.mock.calls.at(-1)).toHaveLength(3);
      expect(uuidsOf(latest())).toEqual(['a', 'b', 'c-prime', 'c']);
    });

    it('flag off: no probe at all, and today’s documents', async () => {
      flags.nowSlot = false;
      await renderSession([A, B, C], B);
      expect(executedQueries().some((query) => query.includes('QueueStateFieldsProbe'))).toBe(false);
      expect(subscribedQueries().some((query) => query.includes('QueueUpdatesNowSlot'))).toBe(false);
      expect(analytics.track.mock.calls.some(([eventName]) => eventName === SHARED_EVENTS.QueueServerProbe)).toBe(
        false,
      );
    });

    // #7014: the BLE auto-sender times a crewmate's climb from the moment this
    // stream hands it over, so a peer's move is stamped and this phone's own
    // echo is not.
    describe('relay receipt', () => {
      function sendCurrentClimbChanged(item: ClimbQueueItem, clientId: string, correlationId: string) {
        const sink = ws.getQueueUpdatesSink();
        if (!sink) throw new Error('queue updates sink was not captured');
        act(() => {
          sink.next({
            data: {
              queueUpdates: {
                __typename: 'CurrentClimbChanged',
                sequence: 2,
                stateHash: 'hash-2',
                item,
                clientId,
                correlationId,
              },
            },
          });
        });
      }

      it('stamps a crewmate moving the wall', async () => {
        const latest = await renderSession([A, B, C], B);
        clearRelayReceipt();

        sendCurrentClimbChanged(C, 'client-peer', 'corr-peer');

        await waitFor(() => expect(latest().state.currentClimbQueueItem?.uuid).toBe('c'));
        expect(takeRelayReceipt('c')).toMatchObject({
          queueItemUuid: 'c',
          eventType: 'CurrentClimbChanged',
          correlationId: 'corr-peer',
        });
      });

      it('does not stamp the FullSync that opens the stream', async () => {
        clearRelayReceipt();

        // The join's FullSync makes B current on a phone that had nothing.
        const latest = await renderSession([A, B, C], B);

        expect(latest().state.currentClimbQueueItem?.uuid).toBe('b');
        expect(takeRelayReceipt('b')).toBeNull();
      });

      it('stamps a crewmate’s open that arrives as a FullSync on the live stream', async () => {
        const latest = await renderSession([A, B, C], B);
        clearRelayReceipt();
        const sink = ws.getQueueUpdatesSink();
        if (!sink) throw new Error('queue updates sink was not captured');

        act(() => {
          sink.next({
            data: {
              queueUpdates: {
                __typename: 'FullSync',
                sequence: 2,
                state: {
                  sequence: 2,
                  stateHash: 'hash-2',
                  queue: [A, B, C],
                  currentClimbQueueItem: C,
                  historyCount: 2,
                },
              },
            },
          });
        });

        await waitFor(() => expect(latest().state.currentClimbQueueItem?.uuid).toBe('c'));
        expect(takeRelayReceipt('c')).toMatchObject({ queueItemUuid: 'c', eventType: 'FullSync' });
      });

      // #7039 review: the climber picks A, then C, before A's echo arrives. The
      // echo names A while C is current, so the uuid check alone would stamp it.
      it('does not stamp a late echo of an earlier move of this phone', async () => {
        const latest = await renderSession([A, B, C], B);
        act(() => latest().setCurrentClimb(A));
        act(() => latest().setCurrentClimb(C));
        expect(latest().state.currentClimbQueueItem?.uuid).toBe('c');
        const firstMoveCorrelationId = queueMutations.setCurrentClimb.mock.calls[0]?.[2];
        expect(firstMoveCorrelationId).toEqual(expect.any(String));
        clearRelayReceipt();

        sendCurrentClimbChanged(A, 'client-self', firstMoveCorrelationId ?? '');

        expect(takeRelayReceipt('a')).toBeNull();
      });

      it('does not stamp the now-slot FullSync echo of an earlier move of this phone', async () => {
        const latest = await renderSession([A, B, C], B);
        act(() => latest().setCurrentClimb(A));
        act(() => latest().setCurrentClimb(C));
        expect(latest().state.currentClimbQueueItem?.uuid).toBe('c');
        clearRelayReceipt();
        // clearRelayReceipt also forgets own moves, so re-arm them the way the
        // provider's send seam does on a re-send.
        act(() => latest().setCurrentClimb(A));
        act(() => latest().setCurrentClimb(C));
        const sink = ws.getQueueUpdatesSink();
        if (!sink) throw new Error('queue updates sink was not captured');

        act(() => {
          sink.next({
            data: {
              queueUpdates: {
                __typename: 'FullSync',
                sequence: 2,
                state: {
                  sequence: 2,
                  stateHash: 'hash-2',
                  queue: [A, B, C],
                  currentClimbQueueItem: A,
                  historyCount: 0,
                },
              },
            },
          });
        });

        expect(takeRelayReceipt('a')).toBeNull();
      });

      it('does not stamp the echo of this phone’s own move', async () => {
        const latest = await renderSession([A, B, C], B);
        act(() => latest().setCurrentClimb(C));
        expect(latest().state.currentClimbQueueItem?.uuid).toBe('c');
        clearRelayReceipt();

        sendCurrentClimbChanged(C, 'client-self', 'corr-self');

        expect(takeRelayReceipt('c')).toBeNull();
      });
    });
  });
});
