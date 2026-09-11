// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react';
import { createElement, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Climb, ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';

// Issue #5099: after the climber switches boards, the held suggestion source
// still belongs to the board they left. `next` kept walking that board's list —
// drawing nothing, lighting nothing, and (because a committed peek is APPENDED)
// leaving a foreign-board climb in the queue on every swipe.
//
// This harness drives the active board through a real external store so a board
// switch re-renders the provider the way the ['activeBoard'] query does, and
// stubs the continuation feed so the re-anchor is deterministic.

const ws = vi.hoisted(() => ({
  client: {
    on: vi.fn(() => vi.fn()),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

const graph = vi.hoisted(() => ({ execute: vi.fn() }));
const http = vi.hoisted(() => ({ request: vi.fn() }));

const boards = vi.hoisted(() => {
  const base = {
    uuid: 'board-kilter',
    slug: 'board-kilter',
    ownerId: 'owner-1',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,2',
    name: 'Kilter board',
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
  return {
    kilter: base,
    kilterTilted: { ...base, angle: 25 },
    kilterOtherSize: { ...base, uuid: 'board-kilter-big', sizeId: 11 },
    tension: {
      ...base,
      uuid: 'board-tension',
      slug: 'board-tension',
      boardType: 'tension',
      layoutId: 8,
      sizeId: 20,
      setIds: '3',
      name: 'Tension board',
    },
  };
});

// Reactive active board: the provider reads it through useSyncExternalStore so a
// switch re-renders exactly like a React Query cache write would.
const activeBoardStore = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  // One frozen snapshot object, replaced on write, so useSyncExternalStore sees a
  // stable reference between changes.
  const state = { snapshot: { board: null as unknown, isPending: false } };
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => state.snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (board: unknown) => {
      state.snapshot = { ...state.snapshot, board };
      notify();
    },
    setPending: (isPending: boolean) => {
      state.snapshot = { ...state.snapshot, isPending };
      notify();
    },
  };
});

// Stands in for the board-scoped popular feed the provider re-anchors onto.
// Records the `enabled` argument so the "only armed while a source is off-board"
// gate is checked rather than assumed.
const continuationFeed = vi.hoisted(() => ({
  climbs: [] as unknown[],
  /** Mirrors the real hook: false only while an armed query is still in flight. */
  isSettled: true,
  enabledCalls: [] as boolean[],
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

const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
const analytics = vi.hoisted(() => ({ track: vi.fn() }));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default },
  AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
}));
vi.mock('expo-crypto', () => {
  let sequence = 0;
  return { randomUUID: () => `test-uuid-${++sequence}` };
});
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
vi.mock('../../lib/session-store', () => sessionStore);
vi.mock('../../lib/queue-snapshot-store', () => queueSnapshotStore);
vi.mock('../../lib/board-details', () => ({ getBoardRenderData: () => null }));
vi.mock('../../lib/active-board-store', () => ({
  getStoredActiveBoard: async () => activeBoardStore.getSnapshot().board,
}));
vi.mock('../../lib/graphql/use-active-board', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useActiveBoard: () => {
      const { board, isPending } = useSyncExternalStore(activeBoardStore.subscribe, activeBoardStore.getSnapshot);
      return { data: board, isPending };
    },
    useSetActiveBoard: () => async () => {},
  };
});
vi.mock('../../lib/graphql/client', () => ({ getHttpClient: () => ({ request: http.request }) }));
vi.mock('../../lib/analytics', () => ({ track: analytics.track, registerRenderSuperProperties: vi.fn() }));
vi.mock('../../lib/error-reporting', () => ({ reportError: vi.fn(), reportHandledError: vi.fn() }));
vi.mock('../toast-provider', () => ({ useToast: () => ({ showToast: toast.showToast }) }));
vi.mock('../queue-snackbar-provider', () => ({ useQueueSnackbar: () => ({ showQueueAddedSnackbar: vi.fn() }) }));
vi.mock('../queue/use-cross-board-add-gate', () => ({
  useCrossBoardAddGate: () => async () => ({ outcome: 'add' }),
}));
vi.mock('../feature-flags-provider', () => ({ useSharedSessionBrowseEnabled: () => false }));
vi.mock('../party-profile-provider', () => ({
  usePartyProfile: () => ({ username: undefined, avatarUrl: undefined }),
}));
vi.mock('../queue/use-board-continuation-feed', () => ({
  useBoardContinuationFeed: (_board: unknown, enabled: boolean) => {
    continuationFeed.enabledCalls.push(enabled);
    return { climbs: enabled ? continuationFeed.climbs : [], isSettled: !enabled || continuationFeed.isSettled };
  },
}));

import { QueueProvider, usePlaylistSuggestionSource, useQueue } from '../queue-provider';
import { SOLO_QUEUE_SAVE_DEBOUNCE_MS } from '../queue/use-queue-persistence';

type Snapshot = {
  state: ReturnType<typeof useQueue>['state'];
  playlistSuggestionSource: PlaylistSuggestionSource | null;
  setCurrentClimb: ReturnType<typeof useQueue>['setCurrentClimb'];
  nextClimb: ReturnType<typeof useQueue>['nextClimb'];
  previousClimb: ReturnType<typeof useQueue>['previousClimb'];
};

function Probe({ onSnapshot }: { onSnapshot: (snapshot: Snapshot) => void }) {
  const queue = useQueue();
  const playlistSuggestionSource = usePlaylistSuggestionSource();
  useEffect(() => {
    onSnapshot({
      state: queue.state,
      playlistSuggestionSource,
      setCurrentClimb: queue.setCurrentClimb,
      nextClimb: queue.nextClimb,
      previousClimb: queue.previousClimb,
    });
  }, [queue.state, playlistSuggestionSource, queue.setCurrentClimb, queue.nextClimb, queue.previousClimb, onSnapshot]);
  return null;
}

function makeClimb(uuid: string, boardType: string, layoutId: number): Climb {
  return {
    uuid,
    name: `Climb ${uuid}`,
    frames: 'p1r12',
    setter_username: 'setter',
    angle: 40,
    ascensionist_count: 0,
    difficulty: 'V3',
    quality_average: '3.0',
    stars: 3,
    difficulty_error: '0.3',
    benchmark_difficulty: null,
    boardType,
    layoutId,
  };
}

function makeItem(uuid: string, climb: Climb): ClimbQueueItem {
  return { uuid, climb, suggested: false };
}

const KILTER_BOARD_KEY = 'kilter:1:10:1,2';
const TENSION_BOARD_KEY = 'tension:8:20:3';

function kilterSource(climbs: Climb[], activatedClimb: Climb): PlaylistSuggestionSource {
  return {
    playlistUuid: 'climblist',
    activatedClimbUuid: activatedClimb.uuid,
    boardKey: KILTER_BOARD_KEY,
    climbs,
  };
}

// Cases that install fake timers must not leak them into the next one.
afterEach(() => {
  vi.useRealTimers();
});

describe('QueueProvider board switch (#5099)', () => {
  let snapshots: Snapshot[];

  const latest = () => {
    const snapshot = snapshots.at(-1);
    if (!snapshot) throw new Error('provider never rendered');
    return snapshot;
  };

  beforeEach(() => {
    snapshots = [];
    activeBoardStore.setPending(false);
    activeBoardStore.set(boards.kilter);
    continuationFeed.climbs = [];
    continuationFeed.isSettled = true;
    continuationFeed.enabledCalls = [];
    ws.client.on.mockClear();
    ws.client.subscribe.mockClear();
    for (const mutation of Object.values(queueMutations) as Array<ReturnType<typeof vi.fn>>) {
      mutation.mockReset();
      mutation.mockResolvedValue(undefined);
    }
    queueMutations.wasUuidExplicitlyRemoved.mockReset();
    queueMutations.wasUuidExplicitlyRemoved.mockReturnValue(false);
    sessionStore.getStoredSessionId.mockReset();
    sessionStore.getStoredSessionId.mockResolvedValue(null);
    queueSnapshotStore.getStoredQueueSnapshot.mockReset();
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue(null);
    queueSnapshotStore.setStoredQueueSnapshot.mockClear();
    toast.showToast.mockClear();
    analytics.track.mockClear();
    graph.execute.mockReset();
    http.request.mockReset();
  });

  function renderProvider() {
    return render(createElement(QueueProvider, null, createElement(Probe, { onSnapshot: (s) => snapshots.push(s) })));
  }

  /** Activate a kilter climb with a kilter-stamped suggestion source. */
  async function activateKilterBrowse() {
    const activatedClimb = makeClimb('kilter-current', 'kilter', 1);
    const nextKilterClimb = makeClimb('kilter-next', 'kilter', 1);
    renderProvider();
    await waitFor(() => expect(snapshots.length).toBeGreaterThan(0));
    act(() => {
      latest().setCurrentClimb(makeItem('item-kilter-current', activatedClimb), {
        playlistSuggestionSource: kilterSource([activatedClimb, nextKilterClimb], activatedClimb),
      });
    });
    await waitFor(() => expect(latest().playlistSuggestionSource?.boardKey).toBe(KILTER_BOARD_KEY));
    return { activatedClimb, nextKilterClimb };
  }

  it('masks a suggestion source stamped with the board the climber left', async () => {
    await activateKilterBrowse();

    act(() => activeBoardStore.set(boards.tension));

    await waitFor(() => expect(latest().playlistSuggestionSource).toBeNull());
  });

  it('restores the browsed list when the climber switches back', async () => {
    await activateKilterBrowse();

    act(() => activeBoardStore.set(boards.tension));
    await waitFor(() => expect(latest().playlistSuggestionSource).toBeNull());

    act(() => activeBoardStore.set(boards.kilter));
    await waitFor(() => expect(latest().playlistSuggestionSource?.playlistUuid).toBe('climblist'));
    expect(latest().playlistSuggestionSource?.boardKey).toBe(KILTER_BOARD_KEY);
  });

  it('keeps coming back to the browsed list on every round trip — masking never replaces it', async () => {
    // Issue #5403: masking used to be a one-shot window. Once the re-anchor
    // engine (`useBoardContinuationFeed` + the pending-source effect) landed a
    // board-scoped popular feed, it REPLACED the climblist source for good, so a
    // round trip that waited for the feed came back to the board's popular list
    // instead of what the climber was browsing. That engine is gone: masking is
    // now the whole of it, so the original source survives no matter how long the
    // climber lingers on the other board before switching back.
    await activateKilterBrowse();

    act(() => activeBoardStore.set(boards.tension));
    await waitFor(() => expect(latest().playlistSuggestionSource).toBeNull());
    // Give any stray effect a chance to run before switching back.
    await act(async () => {});

    act(() => activeBoardStore.set(boards.kilter));
    await waitFor(() => expect(latest().playlistSuggestionSource?.playlistUuid).toBe('climblist'));
    expect(latest().playlistSuggestionSource?.boardKey).toBe(KILTER_BOARD_KEY);
  });

  it('holds the solo snapshot save until the active board query settles', async () => {
    // Every source masks out against an unresolved board, so a save that raced
    // the board read would persist a null source for the wrong reason.
    activeBoardStore.setPending(true);
    const kilterClimb = makeClimb('kilter-stored', 'kilter', 1);
    const storedItem = makeItem('item-kilter-stored', kilterClimb);
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue({
      queue: [storedItem],
      currentClimbQueueItem: storedItem,
      playlistSuggestionSource: kilterSource([kilterClimb], kilterClimb),
      savedAt: '2026-06-10T00:00:00.000Z',
    });

    // Fake timers installed BEFORE the render, so the save's own setTimeout is a
    // fake one this test can drive. Installing them afterwards would leave that
    // timeout on the real clock, where advancing never reaches it and the
    // negative assertion below would hold for the wrong reason. Real wall-clock
    // sleeps are out: they flake on a loaded CI box. The wait is derived from
    // the debounce so the two cannot drift apart.
    vi.useFakeTimers();
    renderProvider();
    // The cold-start hydrate is promise-only, so a zero advance settles it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SOLO_QUEUE_SAVE_DEBOUNCE_MS * 2);
    });

    expect(latest().state.queue).toHaveLength(1);

    // Give the save a genuine chance to fire while the board is still loading:
    // a queue change re-runs the save effect with the hydrate latch already set,
    // so the ONLY thing left standing between it and a write is the gate. Without
    // this the negative assertion below would hold simply because nothing had
    // re-run the effect — true whether or not the gate exists.
    act(() => latest().setCurrentClimb(makeItem('item-second', makeClimb('second', 'kilter', 1))));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SOLO_QUEUE_SAVE_DEBOUNCE_MS * 2);
    });

    expect(queueSnapshotStore.setStoredQueueSnapshot).not.toHaveBeenCalled();

    act(() => activeBoardStore.setPending(false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SOLO_QUEUE_SAVE_DEBOUNCE_MS * 2);
    });

    expect(queueSnapshotStore.setStoredQueueSnapshot).toHaveBeenCalled();
  });

  it('keeps the source across an angle-only change', async () => {
    await activateKilterBrowse();

    act(() => activeBoardStore.set(boards.kilterTilted));

    await waitFor(() => expect(latest().state.queue).toHaveLength(1));
    expect(latest().playlistSuggestionSource?.boardKey).toBe(KILTER_BOARD_KEY);
  });

  it('retires the source when the size changes on the same layout', async () => {
    await activateKilterBrowse();

    act(() => activeBoardStore.set(boards.kilterOtherSize));

    await waitFor(() => expect(latest().playlistSuggestionSource).toBeNull());
  });

  it('never touches the board continuation feed — masking has nothing left to re-anchor onto', async () => {
    // Issue #5403: the provider used to arm `useBoardContinuationFeed` the
    // moment a held source went off-board, fetch the board's popular list, and
    // replace the masked source with it. That whole engine is deleted, so the
    // hook mocked below should never see a single call, board switch or not.
    await activateKilterBrowse();
    expect(continuationFeed.enabledCalls).toHaveLength(0);

    act(() => activeBoardStore.set(boards.tension));
    await waitFor(() => expect(latest().playlistSuggestionSource).toBeNull());
    // Give any stray effect a chance to fire before asserting the negative.
    await act(async () => {});

    expect(continuationFeed.enabledCalls).toHaveLength(0);
  });

  it('does not append a foreign-board climb to the queue on the swipe after a switch', async () => {
    await activateKilterBrowse();
    act(() => activeBoardStore.set(boards.tension));
    await waitFor(() => expect(latest().playlistSuggestionSource).toBeNull());

    act(() => latest().nextClimb());

    // Before the fix this committed the stale source's next kilter climb and
    // appended it to the queue for good — one foreign item per swipe.
    await waitFor(() => expect(latest().state.queue).toHaveLength(1));
    expect(latest().state.currentClimbQueueItem?.climb.uuid).toBe('kilter-current');
  });

  it('ignores an available board feed after masking — a swipe just stops at the end of the list', async () => {
    // Issue #5403: even a feed with climbs sitting right there must not be
    // consulted. The provider used to re-anchor onto it (`tension-1`,
    // `tension-2` below), which fed climbers climbs they had filtered out and
    // never asked for. Masking is now the whole of it: the source stays null and
    // the swipe finds nothing past the one queued (kilter) climb.
    await activateKilterBrowse();
    continuationFeed.climbs = [makeClimb('tension-1', 'tension', 8), makeClimb('tension-2', 'tension', 8)];

    act(() => activeBoardStore.set(boards.tension));
    await waitFor(() => expect(latest().playlistSuggestionSource).toBeNull());
    await act(async () => {});
    expect(latest().playlistSuggestionSource).toBeNull();

    act(() => latest().nextClimb());

    expect(latest().state.currentClimbQueueItem?.climb.uuid).toBe('kilter-current');
    expect(latest().state.queue).toHaveLength(1);
  });

  it('yields to a real activation that landed while the feed was in flight', async () => {
    await activateKilterBrowse();
    act(() => activeBoardStore.set(boards.tension));
    await waitFor(() => expect(latest().playlistSuggestionSource).toBeNull());

    const tensionClimb = makeClimb('tension-picked', 'tension', 8);
    act(() => {
      latest().setCurrentClimb(makeItem('item-tension-picked', tensionClimb), {
        playlistSuggestionSource: {
          playlistUuid: 'climblist',
          activatedClimbUuid: tensionClimb.uuid,
          boardKey: TENSION_BOARD_KEY,
          climbs: [tensionClimb],
        },
      });
    });
    await waitFor(() => expect(latest().playlistSuggestionSource?.playlistUuid).toBe('climblist'));

    // The feed resolves a beat later; the deliberate activation must survive it.
    continuationFeed.climbs = [makeClimb('tension-feed', 'tension', 8)];
    act(() => activeBoardStore.set({ ...boards.tension }));

    await waitFor(() => expect(latest().state.queue).toHaveLength(2));
    expect(latest().playlistSuggestionSource?.activatedClimbUuid).toBe('tension-picked');
  });

  it('filters mixed-board suggestions restored under a matching board key', async () => {
    const current = makeClimb('kilter-current', 'kilter', 1);
    const foreign = makeClimb('tension-foreign', 'tension', 8);
    const compatible = makeClimb('kilter-next', 'kilter', 1);
    const currentItem = makeItem('item-current', current);
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue({
      queue: [currentItem],
      currentClimbQueueItem: currentItem,
      playlistSuggestionSource: kilterSource([current, foreign, compatible], current),
      savedAt: '2026-06-10T00:00:00.000Z',
    });
    renderProvider();
    await waitFor(() => expect(latest().state.currentClimbQueueItem?.uuid).toBe(currentItem.uuid));
    act(() => latest().nextClimb());
    expect(latest().state.currentClimbQueueItem?.climb.uuid).toBe(compatible.uuid);
    expect(latest().state.queue.some(({ climb }) => climb.uuid === foreign.uuid)).toBe(false);
  });

  it('continues a restored mixed source when its current climb belongs to another board', async () => {
    activeBoardStore.set(boards.tension);
    const current = makeClimb('kilter-current', 'kilter', 1);
    const foreign = makeClimb('kilter-foreign', 'kilter', 1);
    const compatible = makeClimb('tension-next', 'tension', 8);
    const following = makeClimb('tension-following', 'tension', 8);
    const currentItem = makeItem('item-current', current);
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue({
      queue: [currentItem],
      currentClimbQueueItem: currentItem,
      playlistSuggestionSource: {
        ...kilterSource([current, foreign, compatible, following], current),
        boardKey: TENSION_BOARD_KEY,
      },
      savedAt: '2026-06-10T00:00:00.000Z',
    });
    renderProvider();
    await waitFor(() => expect(latest().state.currentClimbQueueItem?.uuid).toBe(currentItem.uuid));
    act(() => latest().nextClimb());
    expect(latest().state.currentClimbQueueItem?.climb.uuid).toBe(compatible.uuid);
    act(() => latest().nextClimb());
    expect(latest().state.currentClimbQueueItem?.climb.uuid).toBe(following.uuid);
    expect(latest().state.queue.some(({ climb }) => climb.uuid === foreign.uuid)).toBe(false);
  });

  it('masks out an all-foreign restored source even when its board key matches, with no feed to fall back to', async () => {
    // Issue #5403: this restored source has NOTHING compatible with tension once
    // normalized (both `current` and `foreign` are kilter climbs), so the old
    // anchor-preserving branch handed `createBoardFeedSuggestionSource` an empty
    // feed and then filled it from `useBoardContinuationFeed` — replacing the
    // restored source with the board's popular list. That re-anchor engine is
    // gone: an anchor with nothing to follow is just null
    // (`createBoardFeedSuggestionSource` returns null for an empty feed), and
    // `compatible` below — sitting right there in the mocked continuation feed —
    // must stay untouched.
    activeBoardStore.set(boards.tension);
    const current = makeClimb('kilter-current', 'kilter', 1);
    const currentItem = makeItem('item-current', current);
    const compatible = makeClimb('tension-feed', 'tension', 8);
    continuationFeed.climbs = [compatible];
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue({
      queue: [currentItem],
      currentClimbQueueItem: currentItem,
      playlistSuggestionSource: {
        ...kilterSource([current, makeClimb('foreign', 'kilter', 1)], current),
        boardKey: TENSION_BOARD_KEY,
      },
      savedAt: '2026-06-10T00:00:00.000Z',
    });
    renderProvider();
    await waitFor(() => expect(latest().state.currentClimbQueueItem?.uuid).toBe(currentItem.uuid));
    expect(latest().playlistSuggestionSource).toBeNull();
    act(() => latest().nextClimb());
    // No source, and nothing queued past the current item: the swipe is a
    // dead end that changes nothing, rather than a landing on `compatible`.
    expect(latest().state.currentClimbQueueItem?.climb.uuid).toBe(current.uuid);
    expect(latest().state.queue).toHaveLength(1);
    expect(toast.showToast).not.toHaveBeenCalled();
  });

  it('drops a restored snapshot source that belongs to another board, keeping the queue', async () => {
    const kilterClimb = makeClimb('kilter-stored', 'kilter', 1);
    const storedItem = makeItem('item-kilter-stored', kilterClimb);
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue({
      queue: [storedItem],
      currentClimbQueueItem: storedItem,
      playlistSuggestionSource: kilterSource([kilterClimb], kilterClimb),
      savedAt: '2026-06-10T00:00:00.000Z',
    });
    activeBoardStore.set(boards.tension);

    renderProvider();

    await waitFor(() => expect(latest().state.queue.map((item) => item.uuid)).toEqual(['item-kilter-stored']));
    expect(latest().playlistSuggestionSource).toBeNull();
  });
});

describe('QueueProvider cross-board swipe skip (#5099)', () => {
  let snapshots: Snapshot[];
  const latest = () => {
    const snapshot = snapshots.at(-1);
    if (!snapshot) throw new Error('provider never rendered');
    return snapshot;
  };

  beforeEach(() => {
    snapshots = [];
    activeBoardStore.setPending(false);
    activeBoardStore.set(boards.tension);
    continuationFeed.climbs = [];
    continuationFeed.isSettled = true;
    continuationFeed.enabledCalls = [];
    for (const mutation of Object.values(queueMutations) as Array<ReturnType<typeof vi.fn>>) {
      mutation.mockReset();
      mutation.mockResolvedValue(undefined);
    }
    queueMutations.wasUuidExplicitlyRemoved.mockReset();
    queueMutations.wasUuidExplicitlyRemoved.mockReturnValue(false);
    sessionStore.getStoredSessionId.mockReset();
    sessionStore.getStoredSessionId.mockResolvedValue(null);
    queueSnapshotStore.getStoredQueueSnapshot.mockReset();
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue(null);
    toast.showToast.mockClear();
    analytics.track.mockClear();
    graph.execute.mockReset();
    http.request.mockReset();
  });

  it('walks past queued climbs this board cannot draw and says how many', async () => {
    const tensionCurrent = makeClimb('tension-current', 'tension', 8);
    const tensionLater = makeClimb('tension-later', 'tension', 8);
    const storedQueue = [
      makeItem('item-tension-current', tensionCurrent),
      makeItem('item-kilter-a', makeClimb('kilter-a', 'kilter', 1)),
      makeItem('item-kilter-b', makeClimb('kilter-b', 'kilter', 1)),
      makeItem('item-tension-later', tensionLater),
    ];
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue({
      queue: storedQueue,
      currentClimbQueueItem: storedQueue[0],
      playlistSuggestionSource: null,
      savedAt: '2026-06-10T00:00:00.000Z',
    });

    render(createElement(QueueProvider, null, createElement(Probe, { onSnapshot: (s) => snapshots.push(s) })));
    await waitFor(() => expect(latest().state.queue).toHaveLength(4));

    act(() => latest().nextClimb());

    await waitFor(() => expect(latest().state.currentClimbQueueItem?.uuid).toBe('item-tension-later'));
    // The skipped climbs stay in the queue — they are still reachable by tapping
    // them in the queue sheet, they just stop being swipe targets.
    expect(latest().state.queue).toHaveLength(4);
    expect(toast.showToast).toHaveBeenCalledWith('boardConfigMismatch.skippedOnBoardSwitchToast', 'info');
    expect(analytics.track).toHaveBeenCalledWith(
      'Queue Climb Skipped on Board Switch',
      expect.objectContaining({
        skippedCount: 2,
        skippedClimbUuid: 'kilter-a',
        advancedToClimbUuid: 'tension-later',
        advancedToSuggestion: false,
        inSession: false,
      }),
    );
  });

  it('reports one notice per skip run, not one per repeated swipe', async () => {
    const storedQueue = [
      makeItem('item-tension-current', makeClimb('tension-current', 'tension', 8)),
      makeItem('item-kilter-a', makeClimb('kilter-a', 'kilter', 1)),
      makeItem('item-tension-later', makeClimb('tension-later', 'tension', 8)),
    ];
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue({
      queue: storedQueue,
      currentClimbQueueItem: storedQueue[0],
      playlistSuggestionSource: null,
      savedAt: '2026-06-10T00:00:00.000Z',
    });

    render(createElement(QueueProvider, null, createElement(Probe, { onSnapshot: (s) => snapshots.push(s) })));
    await waitFor(() => expect(latest().state.queue).toHaveLength(3));

    // Both calls read the same pre-dispatch state, exactly like a held swipe.
    act(() => {
      latest().nextClimb();
      latest().nextClimb();
    });

    expect(toast.showToast).toHaveBeenCalledTimes(1);
    expect(toast.showToast).toHaveBeenCalledWith('boardConfigMismatch.skippedOnBoardSwitchToast', 'info');
  });

  it('re-arms the notice after the climber swipes away and back', async () => {
    const storedQueue = [
      makeItem('item-tension-first', makeClimb('tension-first', 'tension', 8)),
      makeItem('item-kilter-a', makeClimb('kilter-a', 'kilter', 1)),
      makeItem('item-tension-later', makeClimb('tension-later', 'tension', 8)),
    ];
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue({
      queue: storedQueue,
      currentClimbQueueItem: storedQueue[0],
      playlistSuggestionSource: null,
      savedAt: '2026-06-10T00:00:00.000Z',
    });

    render(createElement(QueueProvider, null, createElement(Probe, { onSnapshot: (s) => snapshots.push(s) })));
    await waitFor(() => expect(latest().state.queue).toHaveLength(3));

    act(() => latest().nextClimb());
    await waitFor(() => expect(latest().state.currentClimbQueueItem?.uuid).toBe('item-tension-later'));
    act(() => latest().previousClimb());
    await waitFor(() => expect(latest().state.currentClimbQueueItem?.uuid).toBe('item-kilter-a'));
    act(() => latest().previousClimb());
    await waitFor(() => expect(latest().state.currentClimbQueueItem?.uuid).toBe('item-tension-first'));

    act(() => latest().nextClimb());

    // A latch keyed on the item swiped away FROM would have gone silent here.
    await waitFor(() => expect(toast.showToast).toHaveBeenCalledTimes(2));
  });

  it('tells the climber why the swipe is dead when nothing left is on this board', async () => {
    // Every remaining climb is off-board and there is no feed, so canNext is
    // false: the gesture and the Next button are both disabled and no swipe can
    // ever report this. The state notice is the only way the climber hears it.
    const storedQueue = [
      makeItem('item-tension-current', makeClimb('tension-current', 'tension', 8)),
      makeItem('item-kilter-a', makeClimb('kilter-a', 'kilter', 1)),
      makeItem('item-kilter-b', makeClimb('kilter-b', 'kilter', 1)),
    ];
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue({
      queue: storedQueue,
      currentClimbQueueItem: storedQueue[0],
      playlistSuggestionSource: null,
      savedAt: '2026-06-10T00:00:00.000Z',
    });

    render(createElement(QueueProvider, null, createElement(Probe, { onSnapshot: (s) => snapshots.push(s) })));

    await waitFor(() => expect(toast.showToast).toHaveBeenCalledWith('boardConfigMismatch.queueOffBoardToast', 'info'));
    expect(analytics.track).toHaveBeenCalledWith(
      'Queue Climb Skipped on Board Switch',
      expect.objectContaining({ trigger: 'queue_dead_end', skippedCount: 2, advancedToClimbUuid: null }),
    );
    // Said once, not once per render.
    expect(toast.showToast).toHaveBeenCalledTimes(1);
  });

  it('announces a dead end immediately on a live board switch — there is no loading window to wait through', async () => {
    // Issue #5403: the dead-end notice used to gate on the re-anchor feed's
    // `isSettled` flag, staying quiet until a fetch resolved (or re-anchoring
    // before it ever had to speak). That fetch is gone — `forwardSelection` is a
    // synchronous `useMemo` now — so the notice fires on the very commit the
    // switch lands on, with nothing left to wait through and no feed to rescue it.
    //
    // This block defaults to tension; start on kilter so the queue is fully
    // on-board at first and the switch below is the thing under test.
    activeBoardStore.set(boards.kilter);
    const kilterClimb = makeClimb('kilter-current', 'kilter', 1);
    const storedQueue = [
      makeItem('item-kilter-current', kilterClimb),
      makeItem('item-kilter-a', makeClimb('kilter-a', 'kilter', 1)),
    ];
    queueSnapshotStore.getStoredQueueSnapshot.mockResolvedValue({
      queue: storedQueue,
      currentClimbQueueItem: storedQueue[0],
      playlistSuggestionSource: null,
      savedAt: '2026-06-10T00:00:00.000Z',
    });

    render(createElement(QueueProvider, null, createElement(Probe, { onSnapshot: (s) => snapshots.push(s) })));
    await waitFor(() => expect(latest().state.queue).toHaveLength(2));
    // Nothing to say yet: `item-kilter-a` is still compatible with the kilter
    // board the climber is standing at.
    expect(toast.showToast).not.toHaveBeenCalled();

    act(() => activeBoardStore.set(boards.tension));

    await waitFor(() => expect(toast.showToast).toHaveBeenCalledWith('boardConfigMismatch.queueOffBoardToast', 'info'));
    expect(analytics.track).toHaveBeenCalledWith(
      'Queue Climb Skipped on Board Switch',
      expect.objectContaining({ trigger: 'queue_dead_end', skippedCount: 1, advancedToClimbUuid: null }),
    );
    // No continuation feed ever arrives to rescue it — the queue and the notice
    // both stay exactly as they are.
    await act(async () => {});
    expect(toast.showToast).toHaveBeenCalledTimes(1);
    expect(latest().playlistSuggestionSource).toBeNull();
  });
});
