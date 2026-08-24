// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react';
import { createElement, useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';
import { SHARED_EVENTS } from '@boardsesh/analytics';

// Harness for "Play next" placement: where a climb lands (and which mutation
// carries it) when it jumps the line. Cloned from queue-provider-local-queue's
// solo setup — no session is created, so the local reducer queue is the source
// of truth and the mutations are assertable no-ops.

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
  // Typed args so the assertions read the wire position directly.
  addQueueItem: vi.fn(async (_item: ClimbQueueItem, _position?: number) => {}),
  reorderQueueItem: vi.fn(async (_uuid: string, _oldIndex: number, _newIndex: number) => {}),
  removeQueueItem: vi.fn(async () => {}),
  setCurrentClimb: vi.fn(async () => {}),
  mirrorCurrentClimb: vi.fn(async () => {}),
  publishPlaybackState: vi.fn(async () => {}),
  setQueue: vi.fn(async () => {}),
  replaceQueueItem: vi.fn(async () => {}),
  reportWallDisconnect: vi.fn(async () => {}),
  confirmClimbOnWall: vi.fn(async () => {}),
  setSessionBoardSerial: vi.fn(async () => {}),
  setSessionBoardPath: vi.fn(async () => {}),
  wasUuidExplicitlyRemoved: vi.fn((_uuid: string) => false),
}));

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
  setStoredQueueSnapshot: vi.fn(async () => {}),
  clearStoredQueueSnapshot: vi.fn(async () => {}),
}));

const snackbar = vi.hoisted(() => ({ showQueueAddedSnackbar: vi.fn() }));
const analytics = vi.hoisted(() => ({ track: vi.fn() }));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));

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
  useQueueMutations: () => queueMutations,
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
vi.mock('../../lib/analytics', () => ({ track: analytics.track }));
vi.mock('../../lib/error-reporting', () => ({ reportError: vi.fn(), reportHandledError: vi.fn() }));
vi.mock('../toast-provider', () => ({ useToast: () => ({ showToast: toast.showToast }) }));
vi.mock('../queue-snackbar-provider', () => ({
  useQueueSnackbar: () => ({ showQueueAddedSnackbar: snackbar.showQueueAddedSnackbar }),
}));
// The cross-board gate needs router/query-client context this harness doesn't
// mount; pass every add through. The gate itself is covered by
// queue-provider-cross-board-add.test.tsx.
vi.mock('../queue/use-cross-board-add-gate', () => ({
  useCrossBoardAddGate: () => async () => ({ outcome: 'add' }),
}));
vi.mock('../party-profile-provider', () => ({
  usePartyProfile: () => ({ username: undefined, avatarUrl: undefined }),
}));

import { QueueProvider, useQueue } from '../queue-provider';

type Snapshot = {
  queueUuids: string[];
  currentUuid: string | null;
  addToQueue: ReturnType<typeof useQueue>['addToQueue'];
  playNext: ReturnType<typeof useQueue>['playNext'];
};

function Probe({ onSnapshot }: { onSnapshot: (snapshot: Snapshot) => void }) {
  const queue = useQueue();
  useEffect(() => {
    onSnapshot({
      queueUuids: queue.state.queue.map((item) => item.uuid),
      currentUuid: queue.state.currentClimbQueueItem?.uuid ?? null,
      addToQueue: queue.addToQueue,
      playNext: queue.playNext,
    });
  }, [queue.state, queue.addToQueue, queue.playNext, onSnapshot]);
  return null;
}

function makeQueueItem(uuid: string, climbUuid = `climb-${uuid}`): ClimbQueueItem {
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

/**
 * Render the provider with a hydrated solo queue and wait for it to land.
 * Returns the latest snapshot getter.
 */
async function renderWithQueue(items: ClimbQueueItem[], current: ClimbQueueItem | null) {
  queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue({
    queue: items,
    currentClimbQueueItem: current,
    playlistSuggestionSource: null,
    savedAt: '2026-06-10T00:00:00.000Z',
  });

  const snapshots: Snapshot[] = [];
  render(createElement(QueueProvider, null, createElement(Probe, { onSnapshot: (s) => snapshots.push(s) })));

  await waitFor(() => {
    expect(snapshots.at(-1)?.queueUuids).toEqual(items.map((item) => item.uuid));
    expect(snapshots.at(-1)?.currentUuid).toBe(current?.uuid ?? null);
  });

  return () => {
    const latest = snapshots.at(-1);
    if (!latest) throw new Error('provider never rendered');
    return latest;
  };
}

describe('QueueProvider play next', () => {
  beforeEach(() => {
    ws.client.on.mockClear();
    ws.client.subscribe.mockClear();
    activeBoard.getStoredActiveBoard.mockReset();
    activeBoard.getStoredActiveBoard.mockResolvedValue(activeBoard.stored);
    for (const mutation of Object.values(queueMutations) as Array<ReturnType<typeof vi.fn>>) {
      mutation.mockReset();
      mutation.mockResolvedValue(undefined);
    }
    queueMutations.wasUuidExplicitlyRemoved.mockReset();
    queueMutations.wasUuidExplicitlyRemoved.mockReturnValue(false);
    sessionStore.getStoredSessionId.mockReset();
    sessionStore.getStoredSessionId.mockResolvedValue(null);
    queueSnapshotStore.getStoredQueueSnapshot.mockReset();
    queueSnapshotStore.setStoredQueueSnapshot.mockClear();
    snackbar.showQueueAddedSnackbar.mockClear();
    analytics.track.mockClear();
    toast.showToast.mockClear();
    graph.execute.mockReset();
    http.request.mockReset();
  });

  // Regression guard: the default add must stay an append, with no position on
  // the wire (the server appends when `position` is absent).
  it('still appends with no position when no placement is given', async () => {
    const queued = [makeQueueItem('a'), makeQueueItem('b')];
    const latest = await renderWithQueue(queued, queued[0]);

    await act(async () => {
      await latest().addToQueue(makeQueueItem('new'));
    });

    expect(queueMutations.addQueueItem).toHaveBeenCalledWith(expect.objectContaining({ uuid: 'new' }), undefined);
    expect(latest().queueUuids).toEqual(['a', 'b', 'new']);
    expect(snackbar.showQueueAddedSnackbar).toHaveBeenCalledWith('added');
  });

  it('sends the SAME position to the local dispatch and the broadcast', async () => {
    const queued = [makeQueueItem('a'), makeQueueItem('b'), makeQueueItem('c')];
    const latest = await renderWithQueue(queued, queued[1]);

    await act(async () => {
      await latest().addToQueue(makeQueueItem('new'), { placement: 'next' });
    });

    expect(queueMutations.addQueueItem).toHaveBeenCalledWith(expect.objectContaining({ uuid: 'new' }), 2);
    // The optimistic local queue must agree with the number that went on the wire.
    expect(latest().queueUuids).toEqual(['a', 'b', 'new', 'c']);
  });

  it('inserts at the head when nothing is current', async () => {
    const queued = [makeQueueItem('a'), makeQueueItem('b')];
    const latest = await renderWithQueue(queued, null);

    await act(async () => {
      await latest().playNext({ item: makeQueueItem('new') });
    });

    expect(queueMutations.addQueueItem).toHaveBeenCalledWith(expect.objectContaining({ uuid: 'new' }), 0);
    expect(latest().queueUuids).toEqual(['new', 'a', 'b']);
  });

  it('MOVES a climb already queued after current instead of duplicating it', async () => {
    const queued = [makeQueueItem('a'), makeQueueItem('b'), makeQueueItem('c'), makeQueueItem('d')];
    const latest = await renderWithQueue(queued, queued[1]);

    await act(async () => {
      const outcome = await latest().playNext({ item: makeQueueItem('fresh', 'climb-d') });
      expect(outcome).toBe('moved');
    });

    expect(queueMutations.reorderQueueItem).toHaveBeenCalledWith('d', 3, 2);
    expect(queueMutations.addQueueItem).not.toHaveBeenCalled();
    expect(latest().queueUuids).toEqual(['a', 'b', 'd', 'c']);
    expect(snackbar.showQueueAddedSnackbar).toHaveBeenCalledWith('next');
  });

  // Direction-aware index: a history item's slot vanishes on the splice-remove,
  // so the target is `currentIndex`, not `currentIndex + 1`.
  it('pulls a HISTORY climb forward with the direction-corrected index', async () => {
    const queued = [makeQueueItem('a'), makeQueueItem('b'), makeQueueItem('c'), makeQueueItem('d')];
    const latest = await renderWithQueue(queued, queued[2]);

    await act(async () => {
      await latest().playNext({ item: makeQueueItem('fresh', 'climb-a'), queueItemUuid: 'a' });
    });

    expect(queueMutations.reorderQueueItem).toHaveBeenCalledWith('a', 0, 2);
    // `a` lands immediately after `c` — a flat currentIndex + 1 would put it after `d`.
    expect(latest().queueUuids).toEqual(['b', 'c', 'a', 'd']);
  });

  it('fires no mutation when the climb is already up next, but still confirms', async () => {
    const queued = [makeQueueItem('a'), makeQueueItem('b'), makeQueueItem('c')];
    const latest = await renderWithQueue(queued, queued[0]);

    await act(async () => {
      const outcome = await latest().playNext({ item: makeQueueItem('fresh', 'climb-b'), queueItemUuid: 'b' });
      expect(outcome).toBe('unchanged');
    });

    expect(queueMutations.reorderQueueItem).not.toHaveBeenCalled();
    expect(queueMutations.addQueueItem).not.toHaveBeenCalled();
    expect(latest().queueUuids).toEqual(['a', 'b', 'c']);
    expect(snackbar.showQueueAddedSnackbar).toHaveBeenCalledWith('next');
  });

  it('leaves the queue alone when the target is the climb on the wall', async () => {
    const queued = [makeQueueItem('a'), makeQueueItem('b')];
    const latest = await renderWithQueue(queued, queued[1]);

    await act(async () => {
      const outcome = await latest().playNext({ item: makeQueueItem('fresh', 'climb-b'), queueItemUuid: 'b' });
      expect(outcome).toBe('unchanged');
    });

    expect(queueMutations.reorderQueueItem).not.toHaveBeenCalled();
    expect(queueMutations.addQueueItem).not.toHaveBeenCalled();
    expect(latest().queueUuids).toEqual(['a', 'b']);
  });

  it('tags the add event with the placement', async () => {
    const queued = [makeQueueItem('a'), makeQueueItem('b')];
    const latest = await renderWithQueue(queued, queued[0]);

    await act(async () => {
      await latest().playNext({ item: makeQueueItem('new') });
    });

    expect(analytics.track).toHaveBeenCalledWith(
      SHARED_EVENTS.ClimbAddedToQueue,
      expect.objectContaining({ placement: 'next' }),
    );
  });

  it('attributes a play-next reorder separately from a drag', async () => {
    const queued = [makeQueueItem('a'), makeQueueItem('b'), makeQueueItem('c')];
    const latest = await renderWithQueue(queued, queued[0]);

    await act(async () => {
      await latest().playNext({ item: makeQueueItem('fresh', 'climb-c'), queueItemUuid: 'c' });
    });

    expect(analytics.track).toHaveBeenCalledWith(
      SHARED_EVENTS.QueueReordered,
      expect.objectContaining({ source: 'play-next' }),
    );
  });
});
