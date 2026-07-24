// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react';
import { createElement, useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Climb, ClimbQueueItem } from '@boardsesh/queue';
import type { UserBoard } from '@boardsesh/shared-schema';

// Self-contained QueueProvider harness (mirrors queue-provider-regrade.test.tsx)
// scoped to the self-healing resolve of partially-synced queue climbs (#2527).

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
    angle: 25,
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

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default },
  AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-correlation-id' }));
vi.mock('@boardsesh/graphql-client', () => ({ execute: graph.execute }));
vi.mock('@boardsesh/queue-react', () => ({ useQueueMutations: () => queueMutations }));
vi.mock('@boardsesh/play-view', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/play-view')>()),
  emitWallConfirm: vi.fn(),
}));
vi.mock('../../lib/graphql/ws-client', () => ({ getWsClient: () => ws.client }));
// Solo (no session) keeps the resolve path isolated from join/subscription noise.
vi.mock('../../lib/session-store', () => ({
  getStoredSessionId: vi.fn(async () => null),
  setStoredSessionId: vi.fn(async () => {}),
  clearStoredSessionId: vi.fn(async () => {}),
}));
vi.mock('../../lib/queue-snapshot-store', () => ({
  getStoredQueueSnapshot: vi.fn(async () => null),
  setStoredQueueSnapshot: vi.fn(async () => {}),
  clearStoredQueueSnapshot: vi.fn(async () => {}),
}));
vi.mock('../../lib/active-board-store', () => ({ getStoredActiveBoard: activeBoard.getStoredActiveBoard }));
vi.mock('../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: activeBoard.stored }),
  useSetActiveBoard: () => vi.fn(async () => {}),
}));
vi.mock('../../lib/graphql/client', () => ({ getHttpClient: () => ({ request: http.request }) }));
vi.mock('../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../queue-snackbar-provider', () => ({ useQueueSnackbar: () => ({ showQueueAddedSnackbar: vi.fn() }) }));
vi.mock('../party-profile-provider', () => ({
  usePartyProfile: () => ({ username: undefined, avatarUrl: undefined }),
}));

import { QueueProvider, useQueue } from '../queue-provider';

type QueueApi = ReturnType<typeof useQueue>;
type Snapshot = {
  state: QueueApi['state'];
  dispatch: QueueApi['dispatch'];
  setQueue: QueueApi['setQueue'];
  setCurrentClimb: QueueApi['setCurrentClimb'];
};

// A fully-resolved climb (uuid + name + frames): renderable and syncable.
function makeClimb(uuid: string, angle: number, difficulty: string): Climb {
  return {
    uuid,
    name: `Climb ${uuid}`,
    frames: 'p1r12',
    setter_username: 'setter',
    angle,
    ascensionist_count: 0,
    difficulty,
    quality_average: '3.0',
    stars: 3,
    difficulty_error: '0.3',
    benchmark_difficulty: null,
  };
}

// A partially-synced climb: carries a fetchable uuid but no name/frames, so it
// renders as an "Unknown Climb" placeholder until resolved.
function makeThinClimb(uuid: string): Climb {
  return {
    uuid,
    name: '',
    frames: '',
    setter_username: '',
    angle: 25,
    ascensionist_count: 0,
    difficulty: '',
    quality_average: '0',
    stars: 0,
    difficulty_error: '',
    benchmark_difficulty: null,
  };
}

function makeItem(queueUuid: string, climb: Climb): ClimbQueueItem {
  return { uuid: queueUuid, climb, suggested: false };
}

function Probe({ onSnapshot }: { onSnapshot: (snapshot: Snapshot) => void }) {
  const queue = useQueue();
  useEffect(() => {
    onSnapshot({
      state: queue.state,
      dispatch: queue.dispatch,
      setQueue: queue.setQueue,
      setCurrentClimb: queue.setCurrentClimb,
    });
  }, [queue.state, queue.dispatch, queue.setQueue, queue.setCurrentClimb, onSnapshot]);
  return null;
}

function renderProvider() {
  const snapshots: Snapshot[] = [];
  render(createElement(QueueProvider, null, createElement(Probe, { onSnapshot: (snap) => snapshots.push(snap) })));
  return snapshots;
}

describe('QueueProvider self-healing resolve of partially-synced climbs (#2527)', () => {
  beforeEach(() => {
    ws.client.on.mockClear();
    ws.client.subscribe.mockClear();
    activeBoard.getStoredActiveBoard.mockReset();
    activeBoard.getStoredActiveBoard.mockResolvedValue(activeBoard.stored);
    for (const mutation of Object.values(queueMutations) as Array<ReturnType<typeof vi.fn>>) {
      mutation.mockReset();
      mutation.mockResolvedValue(undefined);
    }
    graph.execute.mockReset();
    http.request.mockReset();
  });

  it('re-fetches an unresolved queue climb by uuid and hydrates it in place', async () => {
    http.request.mockImplementation(async (_query: string, variables: { climbUuid: string; angle: number }) => {
      if (variables.climbUuid === 'climb-thin' && variables.angle === 25) {
        return { climb: makeClimb('climb-thin', 25, 'V5') };
      }
      return { climb: null };
    });

    const snapshots = renderProvider();
    await waitFor(() => expect(snapshots.at(-1)).toBeTruthy());

    // A partially-synced item lands in the queue (as if from a peer FullSync).
    await act(async () => {
      snapshots.at(-1)?.dispatch({
        type: 'UPDATE_QUEUE',
        payload: { queue: [makeItem('q1', makeThinClimb('climb-thin'))] },
      });
    });

    // The resolve effect fetches the climb at the live angle and patches it in.
    await waitFor(() => {
      const resolved = snapshots.at(-1)?.state.queue.find((item) => item.uuid === 'q1');
      expect(resolved?.climb.name).toBe('Climb climb-thin');
      expect(resolved?.climb.frames).toBe('p1r12');
      expect(resolved?.climb.difficulty).toBe('V5');
    });

    const fetchedUuids = http.request.mock.calls.map((call) => (call[1] as { climbUuid: string }).climbUuid);
    expect(fetchedUuids).toContain('climb-thin');
  });

  it('leaves the placeholder in place and does not crash when resolution fails (offline)', async () => {
    // Simulate offline: the wrapped request rejects. offlineAwareRequest degrades
    // to plain HTTP with the offline engine off, so a network failure surfaces here.
    http.request.mockRejectedValue(new Error('offline'));

    const snapshots = renderProvider();
    await waitFor(() => expect(snapshots.at(-1)).toBeTruthy());

    await act(async () => {
      snapshots.at(-1)?.dispatch({
        type: 'UPDATE_QUEUE',
        payload: { queue: [makeItem('q1', makeThinClimb('climb-thin'))] },
      });
    });

    // It attempted a fetch...
    await waitFor(() => expect(http.request).toHaveBeenCalled());
    // ...but the item stays unresolved (no throw, no hydration).
    const stillThin = snapshots.at(-1)?.state.queue.find((item) => item.uuid === 'q1');
    expect(stillThin?.climb.name).toBe('');
  });

  it('never broadcasts an unresolved climb via setQueue (skips it from the wire payload)', async () => {
    // Keep resolution from succeeding so the thin item stays unresolved.
    http.request.mockResolvedValue({ climb: null });

    const snapshots = renderProvider();
    await waitFor(() => expect(snapshots.at(-1)).toBeTruthy());

    const resolvedItem = makeItem('q-ok', makeClimb('climb-ok', 25, 'V4'));
    const thinItem = makeItem('q-thin', makeThinClimb('climb-thin'));

    await act(async () => {
      snapshots.at(-1)?.setQueue([resolvedItem, thinItem], thinItem);
    });

    await waitFor(() => expect(queueMutations.setQueue).toHaveBeenCalled());
    // The mock is untyped (vi.fn with no declared params) but records the real
    // args; bridge through `unknown` to read them as the mutation's tuple shape.
    const [syncedQueue, syncedCurrent] = queueMutations.setQueue.mock.calls.at(-1) as unknown as [
      ClimbQueueItem[],
      ClimbQueueItem | undefined,
    ];
    // Only the resolved item reaches the wire; the thin item (and thin current) is dropped.
    expect(syncedQueue.map((item) => item.uuid)).toEqual(['q-ok']);
    expect(syncedCurrent).toBeUndefined();

    // The local reducer still holds BOTH items — the drop is wire-only.
    expect(
      snapshots
        .at(-1)
        ?.state.queue.map((item) => item.uuid)
        .sort(),
    ).toEqual(['q-ok', 'q-thin']);
  });

  it('never broadcasts an unresolved climb via setCurrentClimb', async () => {
    http.request.mockResolvedValue({ climb: null });

    const snapshots = renderProvider();
    await waitFor(() => expect(snapshots.at(-1)).toBeTruthy());

    await act(async () => {
      snapshots.at(-1)?.setCurrentClimb(makeItem('q-thin', makeThinClimb('climb-thin')));
    });

    // Local reducer applied it (so the UI can show/resolve it) but nothing was sent.
    await waitFor(() => expect(snapshots.at(-1)?.state.currentClimbQueueItem?.uuid).toBe('q-thin'));
    expect(queueMutations.setCurrentClimb).not.toHaveBeenCalled();
  });

  it('re-fetches a still-thin item when the queue changes mid-resolve (in-flight race)', async () => {
    // The first resolve fetch is held open so the queue can churn while it's in
    // flight. That churn cancels the run; its result is then discarded. The fix
    // must release the run's in-flight marker on cancel so the successor run
    // re-fetches the still-thin uuid instead of skipping it as "already resolving"
    // — without it, the row stays "Unknown Climb" until an unrelated queue change.
    let releaseFirstFetch: (() => void) | undefined;
    let fetchCount = 0;
    http.request.mockImplementation(async (_query: string, variables: { climbUuid: string; angle: number }) => {
      fetchCount += 1;
      const result = { climb: makeClimb(variables.climbUuid, 25, 'V6') };
      if (fetchCount === 1) {
        return new Promise<{ climb: Climb }>((resolve) => {
          releaseFirstFetch = () => resolve(result);
        });
      }
      return result;
    });

    const snapshots = renderProvider();
    await waitFor(() => expect(snapshots.at(-1)).toBeTruthy());

    // Thin item lands → the first resolve fetch starts and hangs.
    await act(async () => {
      snapshots.at(-1)?.dispatch({
        type: 'UPDATE_QUEUE',
        payload: { queue: [makeItem('q1', makeThinClimb('climb-thin'))] },
      });
    });
    await waitFor(() => expect(http.request).toHaveBeenCalledTimes(1));

    // Queue churns while that fetch is still in flight (a second, resolved item
    // arrives). This cancels the in-flight resolve run.
    await act(async () => {
      snapshots.at(-1)?.dispatch({
        type: 'UPDATE_QUEUE',
        payload: {
          queue: [makeItem('q1', makeThinClimb('climb-thin')), makeItem('q2', makeClimb('climb-ok', 25, 'V4'))],
        },
      });
    });

    // The successor run re-fetches the still-thin uuid and hydrates it in place.
    await waitFor(() => {
      const resolved = snapshots.at(-1)?.state.queue.find((item) => item.uuid === 'q1');
      expect(resolved?.climb.name).toBe('Climb climb-thin');
      expect(resolved?.climb.frames).toBe('p1r12');
    });
    // Proof the successor actually re-fetched rather than skipping on a stale marker.
    expect(fetchCount).toBeGreaterThanOrEqual(2);

    // Let the original (cancelled) fetch settle — its result is discarded, no crash.
    await act(async () => {
      releaseFirstFetch?.();
    });
    expect(snapshots.at(-1)?.state.queue.find((item) => item.uuid === 'q1')?.climb.name).toBe('Climb climb-thin');
  });
});
