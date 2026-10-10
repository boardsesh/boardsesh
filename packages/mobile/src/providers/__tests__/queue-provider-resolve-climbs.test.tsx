import { invalidatePrivacySnapshots } from '../../lib/privacy/privacy-cache';
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
vi.mock('@boardsesh/graphql-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/graphql-client')>()),
  execute: graph.execute,
}));
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
  // Device provenance for the leave-vs-end emphasis (#3502).
  getStoredCreatedSessionId: vi.fn(async () => null),
  setStoredCreatedSessionId: vi.fn(async () => {}),
  clearStoredCreatedSessionId: vi.fn(async () => {}),
}));
vi.mock('../../lib/queue-snapshot-store', () => ({
  invalidateStoredQueueSnapshot: vi.fn(),
  getStoredQueueSnapshot: vi.fn(async () => null),
  getQueueSnapshotGeneration: () => 0,
  setStoredQueueSnapshot: vi.fn(async () => {}),
  clearStoredQueueSnapshot: vi.fn(async () => {}),
}));
vi.mock('../../lib/active-board-store', () => ({ getStoredActiveBoard: activeBoard.getStoredActiveBoard }));
vi.mock('../../lib/graphql/use-active-board', () => ({
  getActiveBoardWriteGeneration: () => 0,
  useActiveBoard: () => ({ data: activeBoard.stored }),
  useSetActiveBoard: () => vi.fn(async () => {}),
}));
vi.mock('../../lib/graphql/client', () => ({ getHttpClient: () => ({ request: http.request }) }));
vi.mock('../../lib/analytics', () => ({ track: vi.fn(), registerRenderSuperProperties: vi.fn() }));
vi.mock('../toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
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

// The gym-sibling roster is a React Query hook and this harness mounts no
// QueryClient. An empty set means "no other wall in reach", which is exactly the
// pre-existing behaviour these tests were written against; the reachable-wall
// rule has its own coverage in queue-provider-reachable-walls.test.tsx.
vi.mock('../queue/use-reachable-board-keys', () => ({
  useReachableBoardKeys: () => new Set<string>(),
}));

import { QueueProvider, useQueue } from '../queue-provider';

type QueueApi = ReturnType<typeof useQueue>;
type Snapshot = {
  state: QueueApi['state'];
  dispatch: QueueApi['dispatch'];
  setQueue: QueueApi['setQueue'];
  setCurrentClimb: QueueApi['setCurrentClimb'];
  setSessionId: QueueApi['setSessionId'];
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
      setSessionId: queue.setSessionId,
    });
  }, [queue.state, queue.dispatch, queue.setQueue, queue.setCurrentClimb, queue.setSessionId, onSnapshot]);
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

  it('withdraws copied queue details and keeps a current-only reference across privacy changes', async () => {
    http.request.mockResolvedValue({ climb: null });
    const snapshots = renderProvider();
    await waitFor(() => expect(snapshots.at(-1)).toBeTruthy());
    const current = makeItem('current-only', { ...makeClimb('private-current', 25, 'V8'), mirrored: true });
    const queued = { ...makeItem('slot', makeClimb('private-queued', 25, 'V5')), addedBy: 'Private climber' };
    act(() =>
      snapshots
        .at(-1)
        ?.dispatch({ type: 'UPDATE_QUEUE', payload: { queue: [queued], currentClimbQueueItem: current } }),
    );
    const retained = snapshots.at(-1)!;
    await act(async () => {
      invalidatePrivacySnapshots();
      // A captured callback cannot restore its old payload before React renders.
      retained.setQueue([queued], current);
    });
    expect(snapshots.at(-1)?.state.queue.map(({ uuid }) => uuid)).toEqual(['slot']);
    expect(snapshots.at(-1)?.state.queue[0].climb.name).toBe('');
    expect(snapshots.at(-1)?.state.queue[0].addedBy).toBeUndefined();
    expect(snapshots.at(-1)?.state.currentClimbQueueItem?.uuid).toBe('current-only');
    expect(snapshots.at(-1)?.state.currentClimbQueueItem?.climb.name).toBe('');
    expect(snapshots.at(-1)?.state.currentClimbQueueItem?.climb.mirrored).toBe(true);
  });

  it('resolves a current-only reference without adding a queue slot', async () => {
    http.request.mockResolvedValue({ climb: makeClimb('current-climb', 25, 'V5') });
    const snapshots = renderProvider();
    await waitFor(() => expect(snapshots.at(-1)).toBeTruthy());
    act(() =>
      snapshots.at(-1)?.dispatch({
        type: 'UPDATE_QUEUE',
        payload: {
          queue: [],
          currentClimbQueueItem: makeItem('current-only', { ...makeThinClimb('current-climb'), mirrored: true }),
        },
      }),
    );
    await waitFor(() => expect(snapshots.at(-1)?.state.currentClimbQueueItem?.climb.name).toBe('Climb current-climb'));
    expect(snapshots.at(-1)?.state.queue).toEqual([]);
    expect(snapshots.at(-1)?.state.currentClimbQueueItem?.climb.mirrored).toBe(true);
  });

  it('rejects an older hydration response after synchronous revocation', async () => {
    let resolveOld!: (response: { climb: Climb }) => void;
    http.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    http.request.mockResolvedValue({ climb: null });
    const snapshots = renderProvider();
    await waitFor(() => expect(snapshots.at(-1)).toBeTruthy());
    act(() =>
      snapshots
        .at(-1)
        ?.dispatch({ type: 'UPDATE_QUEUE', payload: { queue: [makeItem('slot', makeThinClimb('private'))] } }),
    );
    await waitFor(() => expect(resolveOld).toBeTruthy());
    await act(async () => {
      invalidatePrivacySnapshots();
      resolveOld({ climb: makeClimb('private', 25, 'V8') });
    });
    expect(snapshots.at(-1)?.state.queue[0].climb.name).toBe('');
  });

  it('retains history angle and leaves cross-board references thin', async () => {
    http.request.mockImplementation(async (_query: string, variables: { climbUuid: string; angle: number }) => ({
      climb: makeClimb(variables.climbUuid, variables.angle, 'V5'),
    }));
    const snapshots = renderProvider();
    await waitFor(() => expect(snapshots.at(-1)).toBeTruthy());
    const history = makeItem('history', { ...makeThinClimb('past'), angle: 20 });
    const current = makeItem('current', makeThinClimb('now'));
    const foreign = makeItem('foreign', { ...makeThinClimb('other-board'), boardType: 'tension', layoutId: 9 });
    act(() =>
      snapshots.at(-1)?.dispatch({
        type: 'UPDATE_QUEUE',
        payload: { queue: [history, current, foreign], currentClimbQueueItem: current },
      }),
    );
    await waitFor(() => expect(snapshots.at(-1)?.state.queue[0].climb.name).toBe('Climb past'));
    expect(snapshots.at(-1)?.state.queue[0].climb.angle).toBe(20);
    expect(snapshots.at(-1)?.state.queue[2].climb.name).toBe('');
    expect(http.request.mock.calls.some((call) => call[1].climbUuid === 'other-board')).toBe(false);
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

  it('reads each climb once when a saved queue of thin references is restored', async () => {
    // A saved queue comes back as references only (queue-privacy.ts), so every
    // launch resolves the whole queue. Each answer lands in its own task, a few
    // milliseconds after the last, the way rows come back from SQLite.
    let answered = 0;
    http.request.mockImplementation(
      (_query: string, variables: { climbUuid: string; angle: number }) =>
        new Promise<{ climb: Climb }>((resolve) => {
          answered += 1;
          setTimeout(() => resolve({ climb: makeClimb(variables.climbUuid, variables.angle, 'V5') }), answered * 4);
        }),
    );

    const snapshots = renderProvider();
    await waitFor(() => expect(snapshots.at(-1)).toBeTruthy());
    const restored = Array.from({ length: 15 }, (_unused, index) =>
      makeItem(`slot-${index}`, makeThinClimb(`climb-${index}`)),
    );
    await act(async () => {
      snapshots.at(-1)?.dispatch({ type: 'UPDATE_QUEUE', payload: { queue: restored } });
    });

    await waitFor(() => expect(snapshots.at(-1)?.state.queue.every((item) => item.climb.name !== '')).toBe(true), {
      timeout: 4000,
    });
    expect(snapshots.at(-1)?.state.queue.map((item) => item.climb.name)).toEqual(
      restored.map((item) => `Climb ${item.climb.uuid}`),
    );
    expect(http.request).toHaveBeenCalledTimes(15);
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

  it('neither repeats nor discards a read still on the wire when the queue changes', async () => {
    // A read belongs to what it asks for, not to the effect run that sent it.
    // Tying it to the run meant every queue change threw away the reads still
    // out and sent them again, and restoring a saved queue is one queue change
    // per answer.
    let releaseFetch: (() => void) | undefined;
    http.request.mockImplementation(
      (_query: string, variables: { climbUuid: string; angle: number }) =>
        new Promise<{ climb: Climb }>((resolve) => {
          releaseFetch = () => resolve({ climb: makeClimb(variables.climbUuid, 25, 'V6') });
        }),
    );

    const snapshots = renderProvider();
    await waitFor(() => expect(snapshots.at(-1)).toBeTruthy());

    await act(async () => {
      snapshots.at(-1)?.dispatch({
        type: 'UPDATE_QUEUE',
        payload: { queue: [makeItem('q1', makeThinClimb('climb-thin'))] },
      });
    });
    await waitFor(() => expect(http.request).toHaveBeenCalledTimes(1));

    // The queue changes while that read is out: a second, resolved item arrives,
    // and the thin slot itself is rebuilt with a mirror flag.
    await act(async () => {
      snapshots.at(-1)?.dispatch({
        type: 'UPDATE_QUEUE',
        payload: {
          queue: [
            makeItem('q1', { ...makeThinClimb('climb-thin'), mirrored: true }),
            makeItem('q2', makeClimb('climb-ok', 25, 'V4')),
          ],
        },
      });
    });
    expect(http.request).toHaveBeenCalledTimes(1);
    expect(snapshots.at(-1)?.state.queue.find((item) => item.uuid === 'q1')?.climb.name).toBe('');

    // The one answer lands and fills the slot as it is now.
    await act(async () => {
      releaseFetch?.();
    });
    await waitFor(() => {
      const resolved = snapshots.at(-1)?.state.queue.find((item) => item.uuid === 'q1');
      expect(resolved?.climb.name).toBe('Climb climb-thin');
      expect(resolved?.climb.frames).toBe('p1r12');
      expect(resolved?.climb.mirrored).toBe(true);
    });
    expect(http.request).toHaveBeenCalledTimes(1);
    expect(snapshots.at(-1)?.state.queue.map((item) => item.uuid)).toEqual(['q1', 'q2']);
  });

  it('asks again for a climb whose read failed, the next time the queue changes', async () => {
    // A failed read must free its marker, or the row stays "Unknown Climb" for
    // as long as the slot is in the queue.
    http.request.mockRejectedValueOnce(new Error('offline'));
    http.request.mockImplementation(async (_query: string, variables: { climbUuid: string }) => ({
      climb: makeClimb(variables.climbUuid, 25, 'V6'),
    }));

    const snapshots = renderProvider();
    await waitFor(() => expect(snapshots.at(-1)).toBeTruthy());
    await act(async () => {
      snapshots.at(-1)?.dispatch({
        type: 'UPDATE_QUEUE',
        payload: { queue: [makeItem('q1', makeThinClimb('climb-thin'))] },
      });
    });
    await waitFor(() => expect(http.request).toHaveBeenCalledTimes(1));
    expect(snapshots.at(-1)?.state.queue[0].climb.name).toBe('');

    await act(async () => {
      snapshots.at(-1)?.dispatch({
        type: 'UPDATE_QUEUE',
        payload: {
          queue: [makeItem('q1', makeThinClimb('climb-thin')), makeItem('q2', makeClimb('climb-ok', 25, 'V4'))],
        },
      });
    });

    await waitFor(() => expect(snapshots.at(-1)?.state.queue[0].climb.name).toBe('Climb climb-thin'));
    expect(http.request).toHaveBeenCalledTimes(2);
  });

  it('drops an answer for a slot that left the queue, and reads the climb again if it comes back', async () => {
    const releases: Array<() => void> = [];
    http.request.mockImplementation(
      (_query: string, variables: { climbUuid: string }) =>
        new Promise<{ climb: Climb }>((resolve) => {
          releases.push(() => resolve({ climb: makeClimb(variables.climbUuid, 25, 'V6') }));
        }),
    );

    const snapshots = renderProvider();
    await waitFor(() => expect(snapshots.at(-1)).toBeTruthy());
    const kept = makeItem('kept', makeClimb('climb-ok', 25, 'V4'));
    await act(async () => {
      snapshots.at(-1)?.dispatch({
        type: 'UPDATE_QUEUE',
        payload: { queue: [kept, makeItem('q1', makeThinClimb('climb-thin'))] },
      });
    });
    await waitFor(() => expect(releases).toHaveLength(1));

    // The slot is removed while its read is out; the answer then has nowhere to go.
    await act(async () => {
      snapshots.at(-1)?.dispatch({ type: 'UPDATE_QUEUE', payload: { queue: [kept] } });
    });
    await act(async () => {
      releases[0]();
    });
    expect(snapshots.at(-1)?.state.queue.map((item) => item.uuid)).toEqual(['kept']);

    // The same reference comes back later: it is a new wait, so it is read again.
    await act(async () => {
      snapshots.at(-1)?.dispatch({
        type: 'UPDATE_QUEUE',
        payload: { queue: [kept, makeItem('q1-again', makeThinClimb('climb-thin'))] },
      });
    });
    await waitFor(() => expect(releases).toHaveLength(2));
    await act(async () => {
      releases[1]();
    });
    await waitFor(() => expect(snapshots.at(-1)?.state.queue[1].climb.name).toBe('Climb climb-thin'));
  });

  it('drops an answer read at an angle the board has since left, and reads at the new one', async () => {
    const original = activeBoard.stored;
    const releases: Array<{ angle: number; release: () => void }> = [];
    http.request.mockImplementation(
      (_query: string, variables: { climbUuid: string; angle: number }) =>
        new Promise<{ climb: Climb }>((resolve) => {
          releases.push({
            angle: variables.angle,
            release: () => resolve({ climb: makeClimb(variables.climbUuid, variables.angle, `V${variables.angle}`) }),
          });
        }),
    );

    try {
      const snapshots = renderProvider();
      await waitFor(() => expect(snapshots.at(-1)).toBeTruthy());
      const thin = makeItem('q1', makeThinClimb('climb-thin'));
      await act(async () => {
        snapshots.at(-1)?.dispatch({ type: 'UPDATE_QUEUE', payload: { queue: [thin] } });
      });
      await waitFor(() => expect(releases.map((entry) => entry.angle)).toEqual([25]));

      // The wall moves to 40 degrees while the 25-degree read is out. The slot
      // is asked for at 40 (the regrade hook asks at the new angle too, so the
      // count of 40-degree reads is not this hook's alone).
      activeBoard.stored = { ...original, angle: 40 };
      await act(async () => {
        snapshots.at(-1)?.dispatch({ type: 'UPDATE_QUEUE', payload: { queue: [thin] } });
      });
      await waitFor(() => expect(releases.some((entry) => entry.angle === 40)).toBe(true));
      expect(releases.filter((entry) => entry.angle === 25)).toHaveLength(1);

      // The 25-degree answer has nothing waiting for it any more.
      await act(async () => {
        releases[0].release();
      });
      expect(snapshots.at(-1)?.state.queue[0].climb.name).toBe('');

      await act(async () => {
        for (const entry of releases.slice(1)) entry.release();
      });
      await waitFor(() => expect(snapshots.at(-1)?.state.queue[0].climb.difficulty).toBe('V40'));
      expect(snapshots.at(-1)?.state.queue[0].climb.angle).toBe(40);
      expect(releases.filter((entry) => entry.angle === 25)).toHaveLength(1);
    } finally {
      activeBoard.stored = original;
    }
  });

  // #3868: when setCurrentClimb lands on a thin item the broadcast is skipped
  // (a placeholder ClimbInput can't be sent). Once the resolve hook hydrates that
  // slot while it's still current, the provider must re-broadcast the now-resolved
  // climb so peers, late joiners, and a peer-held wall LED link advance.
  describe('re-broadcasts a deferred current climb after hydration (#3868)', () => {
    it('fires setCurrentClimb once the still-current thin item hydrates', async () => {
      http.request.mockImplementation(async (_query: string, variables: { climbUuid: string; angle: number }) => {
        if (variables.climbUuid === 'climb-thin' && variables.angle === 25) {
          return { climb: makeClimb('climb-thin', 25, 'V5') };
        }
        return { climb: null };
      });

      const snapshots = renderProvider();
      await waitFor(() => expect(snapshots.at(-1)).toBeTruthy());

      await act(async () => {
        snapshots.at(-1)?.setCurrentClimb(makeItem('q-thin', makeThinClimb('climb-thin')));
      });

      // The broadcast is deferred while thin, then fires exactly once with the
      // resolved climb and shouldAddToQueue=false (the slot is already queued).
      await waitFor(() => expect(queueMutations.setCurrentClimb).toHaveBeenCalledTimes(1));
      const [broadcastItem, shouldAddToQueue] = queueMutations.setCurrentClimb.mock.calls.at(-1) as unknown as [
        ClimbQueueItem,
        boolean,
      ];
      expect(broadcastItem.uuid).toBe('q-thin');
      expect(broadcastItem.climb.uuid).toBe('climb-thin');
      expect(broadcastItem.climb.frames).toBe('p1r12');
      expect(shouldAddToQueue).toBe(false);
    });

    it('holds the broadcast while the item is still thin, then fires on resolve', async () => {
      // Hold the resolve fetch open so the deferral window is observable: the
      // mutation must NOT fire while the current climb is still a placeholder.
      let releaseFetch: (() => void) | undefined;
      http.request.mockImplementation(
        async (_query: string, variables: { climbUuid: string; angle: number }) =>
          new Promise<{ climb: Climb }>((resolve) => {
            releaseFetch = () => resolve({ climb: makeClimb(variables.climbUuid, 25, 'V5') });
          }),
      );

      const snapshots = renderProvider();
      await waitFor(() => expect(snapshots.at(-1)).toBeTruthy());

      await act(async () => {
        snapshots.at(-1)?.setCurrentClimb(makeItem('q-thin', makeThinClimb('climb-thin')));
      });

      // Current is the thin item locally, but nothing was broadcast yet.
      await waitFor(() => expect(snapshots.at(-1)?.state.currentClimbQueueItem?.uuid).toBe('q-thin'));
      await waitFor(() => expect(http.request).toHaveBeenCalled());
      expect(queueMutations.setCurrentClimb).not.toHaveBeenCalled();

      // Hydration lands → the deferred broadcast fires exactly once.
      await act(async () => {
        releaseFetch?.();
      });
      await waitFor(() => expect(queueMutations.setCurrentClimb).toHaveBeenCalledTimes(1));
    });

    it('does not re-broadcast when current moved to another climb before hydration', async () => {
      // Hold the thin item's fetch open; a resolved climb is activated meanwhile.
      let releaseFetch: (() => void) | undefined;
      http.request.mockImplementation(
        async (_query: string, variables: { climbUuid: string; angle: number }) =>
          new Promise<{ climb: Climb }>((resolve) => {
            releaseFetch = () => resolve({ climb: makeClimb(variables.climbUuid, 25, 'V5') });
          }),
      );

      const snapshots = renderProvider();
      await waitFor(() => expect(snapshots.at(-1)).toBeTruthy());

      await act(async () => {
        snapshots.at(-1)?.setCurrentClimb(makeItem('q-thin', makeThinClimb('climb-thin')));
      });
      await waitFor(() => expect(http.request).toHaveBeenCalled());

      // Activate a resolved climb — this broadcasts it and supersedes the deferral.
      await act(async () => {
        snapshots.at(-1)?.setCurrentClimb(makeItem('q-ok', makeClimb('climb-ok', 25, 'V4')));
      });
      await waitFor(() => expect(snapshots.at(-1)?.state.currentClimbQueueItem?.uuid).toBe('q-ok'));

      // Let the thin item hydrate. It's no longer current, so no second broadcast.
      await act(async () => {
        releaseFetch?.();
      });
      await waitFor(() =>
        expect(snapshots.at(-1)?.state.queue.find((item) => item.uuid === 'q-thin')?.climb.frames).toBe('p1r12'),
      );

      // Exactly one broadcast total — the resolved q-ok activation, never q-thin.
      expect(queueMutations.setCurrentClimb).toHaveBeenCalledTimes(1);
      // The mock is untyped (vi.fn with no declared params); bridge through
      // `unknown` to read each call's first arg as the broadcast item.
      const broadcastCalls = queueMutations.setCurrentClimb.mock.calls as unknown as Array<[ClimbQueueItem, boolean]>;
      expect(broadcastCalls.map(([broadcastItem]) => broadcastItem.uuid)).toEqual(['q-ok']);
    });

    it('does not re-broadcast when the deferred item is removed before hydration', async () => {
      let releaseFetch: (() => void) | undefined;
      http.request.mockImplementation(
        async (_query: string, variables: { climbUuid: string; angle: number }) =>
          new Promise<{ climb: Climb }>((resolve) => {
            releaseFetch = () => resolve({ climb: makeClimb(variables.climbUuid, 25, 'V5') });
          }),
      );

      const snapshots = renderProvider();
      await waitFor(() => expect(snapshots.at(-1)).toBeTruthy());

      await act(async () => {
        snapshots.at(-1)?.setCurrentClimb(makeItem('q-thin', makeThinClimb('climb-thin')));
      });
      await waitFor(() => expect(http.request).toHaveBeenCalled());

      // Remove the deferred item — the reducer nulls the current climb.
      await act(async () => {
        snapshots.at(-1)?.dispatch({ type: 'DELTA_REMOVE_QUEUE_ITEM', payload: { uuid: 'q-thin' } });
      });
      await waitFor(() => expect(snapshots.at(-1)?.state.currentClimbQueueItem).toBeNull());

      // The held fetch settles against an item that's gone — nothing is broadcast.
      await act(async () => {
        releaseFetch?.();
      });
      expect(queueMutations.setCurrentClimb).not.toHaveBeenCalled();
    });

    it('suppresses the echo of its own re-broadcast (no current-climb churn)', async () => {
      http.request.mockImplementation(async (_query: string, variables: { climbUuid: string; angle: number }) => {
        if (variables.climbUuid === 'climb-thin' && variables.angle === 25) {
          return { climb: makeClimb('climb-thin', 25, 'V5') };
        }
        return { climb: null };
      });

      const snapshots = renderProvider();
      await waitFor(() => expect(snapshots.at(-1)).toBeTruthy());

      await act(async () => {
        snapshots.at(-1)?.setCurrentClimb(makeItem('q-thin', makeThinClimb('climb-thin')));
      });
      await waitFor(() => expect(queueMutations.setCurrentClimb).toHaveBeenCalledTimes(1));

      // The re-broadcast carries a correlationId that the provider must have
      // seeded into pendingCurrentClimbUpdates (via the reducer same-uuid branch).
      const [broadcastItem, , correlationId] = queueMutations.setCurrentClimb.mock.calls.at(-1) as unknown as [
        ClimbQueueItem,
        boolean,
        string,
      ];
      const currentBefore = snapshots.at(-1)?.state.currentClimbQueueItem;
      expect(currentBefore?.uuid).toBe('q-thin');
      expect(currentBefore?.climb.frames).toBe('p1r12');

      // Deliver the server echo: same correlationId, a FRESH item reference, and a
      // FOREIGN clientId — so only the correlationId guard (not the dead clientId
      // fallback) can suppress it.
      await act(async () => {
        snapshots.at(-1)?.dispatch({
          type: 'DELTA_UPDATE_CURRENT_CLIMB',
          payload: {
            item: { ...broadcastItem, climb: { ...broadcastItem.climb } },
            isServerEvent: true,
            serverCorrelationId: correlationId,
            eventClientId: 'server-side-client',
            myClientId: 'our-local-client',
          },
        });
      });

      // Suppressed → the current climb identity did not churn on the echo.
      expect(snapshots.at(-1)?.state.currentClimbQueueItem).toBe(currentBefore);
    });

    it('does not let a late deferred echo revert a newer navigation (revert race)', async () => {
      http.request.mockImplementation(async (_query: string, variables: { climbUuid: string; angle: number }) => {
        if (variables.climbUuid === 'climb-thin' && variables.angle === 25) {
          return { climb: makeClimb('climb-thin', 25, 'V5') };
        }
        return { climb: null };
      });

      const snapshots = renderProvider();
      await waitFor(() => expect(snapshots.at(-1)).toBeTruthy());

      // 1) Advance onto the thin item; once it hydrates the effect re-broadcasts it.
      await act(async () => {
        snapshots.at(-1)?.setCurrentClimb(makeItem('q-thin', makeThinClimb('climb-thin')));
      });
      await waitFor(() => {
        const calls = queueMutations.setCurrentClimb.mock.calls as unknown as Array<[ClimbQueueItem, boolean, string]>;
        expect(calls.some(([broadcastItem]) => broadcastItem.uuid === 'q-thin')).toBe(true);
      });
      const thinCalls = queueMutations.setCurrentClimb.mock.calls as unknown as Array<
        [ClimbQueueItem, boolean, string]
      >;
      const [thinItem, , thinCorrelationId] = thinCalls.find(([broadcastItem]) => broadcastItem.uuid === 'q-thin')!;

      // 2) The user swipes to a fully-resolved climb X — current is now X.
      await act(async () => {
        snapshots.at(-1)?.setCurrentClimb(makeItem('q-x', makeClimb('climb-x', 25, 'V7')));
      });
      await waitFor(() => expect(snapshots.at(-1)?.state.currentClimbQueueItem?.uuid).toBe('q-x'));

      // 3) q-thin's echo lands late (same correlationId, foreign clientId).
      await act(async () => {
        snapshots.at(-1)?.dispatch({
          type: 'DELTA_UPDATE_CURRENT_CLIMB',
          payload: {
            item: { ...thinItem, climb: { ...thinItem.climb } },
            isServerEvent: true,
            serverCorrelationId: thinCorrelationId,
            eventClientId: 'server-side-client',
            myClientId: 'our-local-client',
          },
        });
      });

      // The late echo is suppressed — current stays X, never reverts to q-thin.
      expect(snapshots.at(-1)?.state.currentClimbQueueItem?.uuid).toBe('q-x');
    });

    // PR #3894 Codex thread 3: the deferral records the session it was captured
    // in, and the re-broadcast effect bails when the room changed, so a hydrate
    // that completes after a session switch never leaks the old room's climb into
    // the new one. (The precise flush-ordering window — a pending re-broadcast
    // effect flushing after joinSession's synchronous sessionIdRef write but
    // before the [sessionId] backstop clear — isn't reproducible under RTL, which
    // serialises effects at act() boundaries; this locks in the session-scoped
    // contract that closes it.)
    it('does not re-broadcast a deferral after the session changes (session-scoped)', async () => {
      let releaseFetch: (() => void) | undefined;
      http.request.mockImplementation(
        async (_query: string, variables: { climbUuid: string; angle: number }) =>
          new Promise<{ climb: Climb }>((resolve) => {
            releaseFetch = () => resolve({ climb: makeClimb(variables.climbUuid, 25, 'V5') });
          }),
      );

      const snapshots = renderProvider();
      await waitFor(() => expect(snapshots.at(-1)).toBeTruthy());

      // In session A, advance onto a thin item — the deferral captures session A.
      await act(async () => {
        snapshots.at(-1)?.setSessionId('session-A');
      });
      await act(async () => {
        snapshots.at(-1)?.setCurrentClimb(makeItem('q-thin', makeThinClimb('climb-thin')));
      });
      await waitFor(() => expect(http.request).toHaveBeenCalled());

      // The room changes before hydration finishes.
      await act(async () => {
        snapshots.at(-1)?.setSessionId('session-B');
      });

      // Hydration completes — the deferral belonged to session A, so it must NOT
      // broadcast into session B.
      await act(async () => {
        releaseFetch?.();
      });
      expect(queueMutations.setCurrentClimb).not.toHaveBeenCalled();
    });
  });
});
