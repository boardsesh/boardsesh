// The mobile live-stats consumer: what it writes, what it refreshes, and the
// much larger set of things it deliberately leaves alone.
//
// The queries here are seeded into a REAL QueryClient with the shapes the app
// caches (raw, pre-`select`), so every predicate runs against the same data the
// device would hand it. Invalidation is observed on the cache entries
// themselves rather than on a mock's arguments — a predicate that quietly
// matches nothing looks identical to a correct one from the call site.

import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ClimbStatsWriteThroughInput,
  ClimbStatsWriteThroughResult,
  OfflineDatabase,
} from '@boardsesh/offline-sync';

import {
  canStreamChangeList,
  createClimbStatsLiveSync,
  isStatsDependentSearch,
  CLIMB_STATS_INVALIDATE_MAX_WAIT_MS,
  CLIMB_STATS_INVALIDATE_TRAILING_MS,
  type ClimbStatsLiveSyncBoard,
  type ClimbStatsLiveSyncOptions,
} from '../climb-stats-live-sync';

const KILTER_BOARD: ClimbStatsLiveSyncBoard = { boardType: 'kilter', layoutId: 1, sizeId: 5, angle: 40 };

const BASE_SEARCH = { boardName: 'kilter', layoutId: 1, sizeId: 5, setIds: '1,2', angle: 40 };

const fakeDb = { name: 'offline-db' } as unknown as OfflineDatabase;

function makeEvent(overrides: Partial<ClimbStatsWriteThroughInput> = {}): ClimbStatsWriteThroughInput {
  return {
    boardType: 'kilter',
    layoutId: 1,
    climbUuid: 'climb-1',
    angle: 40,
    ascensionistCount: 12,
    qualityAverage: 3.5,
    difficultyAverage: 17.25,
    displayDifficulty: 17,
    faUsername: null,
    faAt: null,
    syncSeq: '500',
    ...overrides,
  };
}

function applied(compatibleSizeIds: number[] | null = [5, 6]): ClimbStatsWriteThroughResult {
  return { status: 'applied', compatibleSizeIds };
}

type Harness = {
  sync: ReturnType<typeof createClimbStatsLiveSync>;
  queryClient: QueryClient;
  writeEvent: ReturnType<typeof vi.fn>;
  isScopeDownloaded: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
  setActiveBoard: (board: ClimbStatsLiveSyncBoard | null) => void;
};

let queryClient: QueryClient;

function createHarness(overrides: Partial<ClimbStatsLiveSyncOptions> = {}): Harness {
  let activeBoard: ClimbStatsLiveSyncBoard | null = KILTER_BOARD;
  const writeEvent = vi.fn(async () => applied());
  const isScopeDownloaded = vi.fn(async () => true);
  const onError = vi.fn();
  const sync = createClimbStatsLiveSync({
    getDb: () => fakeDb,
    queryClient,
    getActiveBoard: () => activeBoard,
    isScopeDownloaded: isScopeDownloaded as unknown as ClimbStatsLiveSyncOptions['isScopeDownloaded'],
    shouldSkipWrites: () => false,
    hasEnabledScopeForLayout: () => true,
    writeEvent: writeEvent as unknown as ClimbStatsLiveSyncOptions['writeEvent'],
    onError,
    ...overrides,
  });
  return {
    sync,
    queryClient,
    writeEvent,
    isScopeDownloaded,
    onError,
    setActiveBoard: (board) => {
      activeBoard = board;
    },
  };
}

function seedInfiniteList(input: Record<string, unknown>, climbUuids: string[]) {
  const key = ['infiniteSearchClimbs', input];
  queryClient.setQueryData(key, {
    pages: [{ searchClimbs: { climbs: climbUuids.map((uuid) => ({ uuid })), hasMore: false, totalCount: 1 } }],
    pageParams: [0],
  });
  return key;
}

function seedCount(input: Record<string, unknown>) {
  const key = ['searchClimbsCount', input];
  queryClient.setQueryData(key, { searchClimbs: { totalCount: 42 } });
  return key;
}

function seedClimbDetail(climbUuid: string) {
  const key = ['climb', { ...BASE_SEARCH, climbUuid }];
  queryClient.setQueryData(key, { climb: { uuid: climbUuid } });
  return key;
}

function isInvalidated(queryKey: unknown[]): boolean {
  return queryClient.getQueryCache().find({ queryKey, exact: true })?.state.isInvalidated ?? false;
}

/** Let the drain's awaited write settle without moving the timers. */
async function settleWrites(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  vi.useRealTimers();
  queryClient.clear();
});

describe('createClimbStatsLiveSync — the pre-write gates', () => {
  it('writes nothing when the database handle is not published yet', async () => {
    const harness = createHarness({ getDb: () => null });

    harness.sync.handleEvent(makeEvent());
    await settleWrites();

    expect(harness.writeEvent).not.toHaveBeenCalled();
  });

  it('writes nothing and refreshes nothing while backgrounded or signing out', async () => {
    const gradeFiltered = seedInfiniteList({ ...BASE_SEARCH, minGrade: 17 }, []);
    const harness = createHarness({ shouldSkipWrites: () => true });

    harness.sync.handleEvent(makeEvent());
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_MAX_WAIT_MS);

    expect(harness.writeEvent).not.toHaveBeenCalled();
    expect(isInvalidated(gradeFiltered)).toBe(false);
  });

  it('writes nothing for a layout with no opted-in offline scope', async () => {
    const hasEnabledScopeForLayout = vi.fn(() => false);
    const harness = createHarness({ hasEnabledScopeForLayout });

    harness.sync.handleEvent(makeEvent());
    await settleWrites();

    expect(hasEnabledScopeForLayout).toHaveBeenCalledWith('kilter', 1);
    expect(harness.writeEvent).not.toHaveBeenCalled();
  });
});

describe('createClimbStatsLiveSync — refreshing the browsed list', () => {
  it('refreshes a stats-dependent list and count once the stream goes quiet', async () => {
    const gradeFiltered = seedInfiniteList({ ...BASE_SEARCH, minGrade: 17 }, []);
    const gradeCount = seedCount({ ...BASE_SEARCH, minGrade: 17 });
    const harness = createHarness();

    harness.sync.handleEvent(makeEvent());
    await settleWrites();

    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_TRAILING_MS - 1);
    expect(isInvalidated(gradeFiltered)).toBe(false);
    expect(isInvalidated(gradeCount)).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(isInvalidated(gradeFiltered)).toBe(true);
    expect(isInvalidated(gradeCount)).toBe(true);
    expect(harness.isScopeDownloaded).toHaveBeenCalledTimes(1);
    expect(harness.isScopeDownloaded).toHaveBeenCalledWith(fakeDb, { boardType: 'kilter', layoutId: 1, sizeId: 5 });
  });

  it('narrows the climb detail to the climbs it actually wrote', async () => {
    const flushedDetail = seedClimbDetail('climb-1');
    const otherDetail = seedClimbDetail('climb-other');
    seedInfiniteList({ ...BASE_SEARCH, minGrade: 17 }, []);
    const harness = createHarness();

    harness.sync.handleEvent(makeEvent());
    await settleWrites();
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_TRAILING_MS);

    expect(isInvalidated(flushedDetail)).toBe(true);
    expect(isInvalidated(otherDetail)).toBe(false);
  });

  it('leaves a name-sorted, unfiltered list alone when the climb is not on a loaded page', async () => {
    const nameSorted = seedInfiniteList({ ...BASE_SEARCH, sortBy: 'name' }, ['climb-other']);
    const plainCount = seedCount({ ...BASE_SEARCH, sortBy: 'name' });
    const harness = createHarness();

    harness.sync.handleEvent(makeEvent());
    await settleWrites();
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_MAX_WAIT_MS);

    expect(isInvalidated(nameSorted)).toBe(false);
    expect(isInvalidated(plainCount)).toBe(false);
  });

  it('refreshes an unfiltered list that already shows the climb, but not its count', async () => {
    const showsClimb = seedInfiniteList({ ...BASE_SEARCH, sortBy: 'name' }, ['climb-other', 'climb-1']);
    const plainCount = seedCount({ ...BASE_SEARCH, sortBy: 'name' });
    const harness = createHarness();

    harness.sync.handleEvent(makeEvent());
    await settleWrites();
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_TRAILING_MS);

    expect(isInvalidated(showsClimb)).toBe(true);
    // An unfiltered count cannot move on a stats event, so it must not re-read.
    expect(isInvalidated(plainCount)).toBe(false);
  });

  it('refreshes a single-page list that already shows the climb', async () => {
    const singlePage = ['searchClimbs', { ...BASE_SEARCH, sortBy: 'name' }];
    queryClient.setQueryData(singlePage, { searchClimbs: { climbs: [{ uuid: 'climb-1' }], hasMore: false } });
    const harness = createHarness();

    harness.sync.handleEvent(makeEvent());
    await settleWrites();
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_TRAILING_MS);

    expect(isInvalidated(singlePage)).toBe(true);
  });

  it('refreshes nothing when the scope is not downloaded', async () => {
    const gradeFiltered = seedInfiniteList({ ...BASE_SEARCH, minGrade: 17 }, []);
    const harness = createHarness({ isScopeDownloaded: async () => false });

    harness.sync.handleEvent(makeEvent());
    await settleWrites();
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_MAX_WAIT_MS);

    expect(isInvalidated(gradeFiltered)).toBe(false);
  });

  it('drops the refresh when the user switched boards before it landed', async () => {
    const gradeFiltered = seedInfiniteList({ ...BASE_SEARCH, minGrade: 17 }, []);
    const harness = createHarness();

    harness.sync.handleEvent(makeEvent());
    await settleWrites();
    harness.setActiveBoard({ ...KILTER_BOARD, layoutId: 8 });
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_MAX_WAIT_MS);

    expect(isInvalidated(gradeFiltered)).toBe(false);
  });

  it('uses the shared table → key map rather than its own literals', async () => {
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');
    seedInfiniteList({ ...BASE_SEARCH, minGrade: 17 }, []);
    const harness = createHarness();

    harness.sync.handleEvent(makeEvent());
    await settleWrites();
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_TRAILING_MS);

    const roots = invalidateQueries.mock.calls.map((call) => call[0]?.queryKey);
    expect(roots).toEqual([['searchClimbs'], ['infiniteSearchClimbs'], ['searchClimbsCount'], ['climb']]);
    for (const call of invalidateQueries.mock.calls) {
      expect(call[0]?.predicate).toBeTypeOf('function');
    }
  });
});

describe('createClimbStatsLiveSync — which writes may arm a refresh', () => {
  it.each(['stale', 'climb_not_local', 'invalid_revision', 'lock_lost'] as const)(
    'never refreshes on a %s write',
    async (status) => {
      const gradeFiltered = seedInfiniteList({ ...BASE_SEARCH, minGrade: 17 }, []);
      const harness = createHarness({ writeEvent: async () => ({ status, compatibleSizeIds: [5, 6] }) });

      harness.sync.handleEvent(makeEvent());
      await settleWrites();
      await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_MAX_WAIT_MS);

      expect(isInvalidated(gradeFiltered)).toBe(false);
      expect(harness.isScopeDownloaded).not.toHaveBeenCalled();
    },
  );

  it('writes another angle but does not refresh the browsed one', async () => {
    const gradeFiltered = seedInfiniteList({ ...BASE_SEARCH, minGrade: 17 }, []);
    const harness = createHarness();

    harness.sync.handleEvent(makeEvent({ angle: 25 }));
    await settleWrites();
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_MAX_WAIT_MS);

    expect(harness.writeEvent).toHaveBeenCalledTimes(1);
    expect(isInvalidated(gradeFiltered)).toBe(false);
  });

  it('does not refresh a list on another layout', async () => {
    const gradeFiltered = seedInfiniteList({ ...BASE_SEARCH, minGrade: 17 }, []);
    const harness = createHarness();

    harness.sync.handleEvent(makeEvent({ layoutId: 8 }));
    await settleWrites();
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_MAX_WAIT_MS);

    expect(isInvalidated(gradeFiltered)).toBe(false);
  });

  it.each<[string, number[] | null]>([
    ['a climb that does not fit the browsed size', [6]],
    ['a climb with no size data', null],
  ])('does not refresh for %s', async (_label, compatibleSizeIds) => {
    const gradeFiltered = seedInfiniteList({ ...BASE_SEARCH, minGrade: 17 }, []);
    const harness = createHarness({ writeEvent: async () => applied(compatibleSizeIds) });

    harness.sync.handleEvent(makeEvent());
    await settleWrites();
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_MAX_WAIT_MS);

    expect(isInvalidated(gradeFiltered)).toBe(false);
  });

  it('skips the size gate on a board that is not size-scoped', async () => {
    const moonboardSearch = { ...BASE_SEARCH, boardName: 'moonboard', minGrade: 17 };
    const gradeFiltered = seedInfiniteList(moonboardSearch, []);
    const harness = createHarness({ writeEvent: async () => applied(null) });
    harness.setActiveBoard({ boardType: 'moonboard', layoutId: 1, sizeId: 5, angle: 40 });

    harness.sync.handleEvent(makeEvent({ boardType: 'moonboard' }));
    await settleWrites();
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_TRAILING_MS);

    expect(isInvalidated(gradeFiltered)).toBe(true);
  });
});

describe('createClimbStatsLiveSync — coalescing', () => {
  it('collapses a burst of five events into one refresh', async () => {
    seedInfiniteList({ ...BASE_SEARCH, minGrade: 17 }, []);
    const harness = createHarness();

    for (let index = 0; index < 5; index += 1) {
      harness.sync.handleEvent(makeEvent({ climbUuid: `climb-${index}`, syncSeq: `${500 + index}` }));
    }
    await settleWrites();
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_MAX_WAIT_MS);

    expect(harness.writeEvent).toHaveBeenCalledTimes(5);
    expect(harness.isScopeDownloaded).toHaveBeenCalledTimes(1);
  });

  it('keeps only the newest payload when the same climb re-fires during a write', async () => {
    let releaseFirstWrite: (() => void) | undefined;
    const writeEvent = vi.fn(async (_db: OfflineDatabase, _event: ClimbStatsWriteThroughInput) => {
      if (!releaseFirstWrite) {
        await new Promise<void>((resolve) => {
          releaseFirstWrite = resolve;
        });
      }
      return applied();
    });
    const harness = createHarness({ writeEvent: writeEvent as unknown as ClimbStatsLiveSyncOptions['writeEvent'] });

    harness.sync.handleEvent(makeEvent({ syncSeq: '500' }));
    await settleWrites();
    harness.sync.handleEvent(makeEvent({ syncSeq: '501' }));
    harness.sync.handleEvent(makeEvent({ syncSeq: '502' }));
    releaseFirstWrite?.();
    await settleWrites();

    expect(writeEvent).toHaveBeenCalledTimes(2);
    expect(writeEvent.mock.calls[1][1]).toMatchObject({ syncSeq: '502' });
  });

  it('still refreshes at the ceiling while events keep arriving', async () => {
    seedInfiniteList({ ...BASE_SEARCH, minGrade: 17 }, []);
    const harness = createHarness();
    // One event every 1.5 s re-arms the 2 s trailing timer before it can fire,
    // so only the 6 s ceiling ever gets the list refreshed.
    const streamFor = async (steps: number) => {
      for (let index = 0; index < steps; index += 1) {
        harness.sync.handleEvent(makeEvent({ climbUuid: `climb-${index}-${steps}` }));
        await vi.advanceTimersByTimeAsync(1_500);
      }
    };

    await streamFor(3);
    expect(harness.isScopeDownloaded).not.toHaveBeenCalled();

    harness.sync.handleEvent(makeEvent({ climbUuid: 'climb-ceiling' }));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(harness.isScopeDownloaded).toHaveBeenCalledTimes(1);

    await streamFor(4);
    expect(harness.isScopeDownloaded).toHaveBeenCalledTimes(2);
  });
});

describe('createClimbStatsLiveSync — teardown and failures', () => {
  it('cancels a pending refresh on dispose', async () => {
    const gradeFiltered = seedInfiniteList({ ...BASE_SEARCH, minGrade: 17 }, []);
    const harness = createHarness();

    harness.sync.handleEvent(makeEvent());
    await settleWrites();
    harness.sync.dispose();
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_MAX_WAIT_MS);

    expect(isInvalidated(gradeFiltered)).toBe(false);
  });

  it('cancels its armed timers on dispose instead of leaving them pending', async () => {
    const cancels: Array<ReturnType<typeof vi.fn>> = [];
    const harness = createHarness({
      scheduleTask: () => {
        const cancel = vi.fn();
        cancels.push(cancel);
        return cancel;
      },
    });

    harness.sync.handleEvent(makeEvent());
    await settleWrites();
    // The ceiling and the trailing timer, neither cancelled yet.
    expect(cancels).toHaveLength(2);
    expect(cancels.filter((cancel) => cancel.mock.calls.length > 0)).toHaveLength(0);

    harness.sync.dispose();

    expect(cancels.filter((cancel) => cancel.mock.calls.length > 0)).toHaveLength(2);
  });

  it('drops a refresh whose downloaded probe resolves after dispose', async () => {
    const gradeFiltered = seedInfiniteList({ ...BASE_SEARCH, minGrade: 17 }, []);
    let releaseProbe: ((downloaded: boolean) => void) | undefined;
    const harness = createHarness({
      isScopeDownloaded: () =>
        new Promise<boolean>((resolve) => {
          releaseProbe = resolve;
        }),
    });

    harness.sync.handleEvent(makeEvent());
    await settleWrites();
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_TRAILING_MS);
    harness.sync.dispose();
    releaseProbe?.(true);
    await settleWrites();

    expect(isInvalidated(gradeFiltered)).toBe(false);
  });

  it('ignores events delivered after dispose', async () => {
    const harness = createHarness();

    harness.sync.dispose();
    harness.sync.handleEvent(makeEvent());
    await settleWrites();

    expect(harness.writeEvent).not.toHaveBeenCalled();
  });

  it('keeps a second instance out of the first one’s refresh', async () => {
    const gradeFiltered = seedInfiniteList({ ...BASE_SEARCH, minGrade: 17 }, []);
    const first = createHarness();
    const second = createHarness();

    first.sync.handleEvent(makeEvent());
    await settleWrites();
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_MAX_WAIT_MS);

    expect(isInvalidated(gradeFiltered)).toBe(true);
    expect(second.writeEvent).not.toHaveBeenCalled();
    expect(second.isScopeDownloaded).not.toHaveBeenCalled();
  });

  it('swallows a write failure, reports it once, and keeps draining', async () => {
    const brokenDatabase = new Error('database or disk is full');
    const writeEvent = vi.fn(async () => {
      throw brokenDatabase;
    });
    const harness = createHarness({ writeEvent: writeEvent as unknown as ClimbStatsLiveSyncOptions['writeEvent'] });

    harness.sync.handleEvent(makeEvent({ climbUuid: 'climb-1' }));
    harness.sync.handleEvent(makeEvent({ climbUuid: 'climb-2' }));
    await settleWrites();

    expect(writeEvent).toHaveBeenCalledTimes(2);
    expect(harness.onError).toHaveBeenCalledTimes(1);
    expect(harness.onError).toHaveBeenCalledWith(brokenDatabase);
  });

  it('never lets a failed downloaded probe escape as an unhandled rejection', async () => {
    const gradeFiltered = seedInfiniteList({ ...BASE_SEARCH, minGrade: 17 }, []);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const closedHandle = new Error('Access to closed resource: the database is closed');
    // The real isBoardDownloadedLocally throws exactly this when the handle
    // closes underneath it — a hot reload, or a sign-out wipe landing after the
    // shouldSkipWrites check. flush() runs from a timer, so an escape here is a
    // reported crash, not a silent no-op.
    const harness = createHarness({
      isScopeDownloaded: async () => {
        throw closedHandle;
      },
    });

    harness.sync.handleEvent(makeEvent());
    await settleWrites();
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_TRAILING_MS);
    await settleWrites();
    process.off('unhandledRejection', unhandled);

    expect(unhandled).not.toHaveBeenCalled();
    expect(harness.onError).toHaveBeenCalledTimes(1);
    expect(harness.onError).toHaveBeenCalledWith(closedHandle);
    expect(isInvalidated(gradeFiltered)).toBe(false);
  });

  it('stops draining a queued burst the moment the app backgrounds', async () => {
    let backgrounded = false;
    let releaseFirstWrite: (() => void) | undefined;
    const writeEvent = vi.fn(async (_db: OfflineDatabase, _event: ClimbStatsWriteThroughInput) => {
      if (!releaseFirstWrite) {
        await new Promise<void>((resolve) => {
          releaseFirstWrite = resolve;
        });
      }
      return applied();
    });
    const harness = createHarness({
      shouldSkipWrites: () => backgrounded,
      writeEvent: writeEvent as unknown as ClimbStatsLiveSyncOptions['writeEvent'],
    });

    harness.sync.handleEvent(makeEvent({ climbUuid: 'climb-1' }));
    await settleWrites();
    harness.sync.handleEvent(makeEvent({ climbUuid: 'climb-2' }));
    // The app backgrounds while write 1 is still in flight.
    backgrounded = true;
    releaseFirstWrite?.();
    await settleWrites();

    expect(writeEvent).toHaveBeenCalledTimes(1);
  });

  it('never reports write-lock contention', async () => {
    const harness = createHarness({ writeEvent: async () => ({ status: 'lock_lost', compatibleSizeIds: [5, 6] }) });

    harness.sync.handleEvent(makeEvent());
    await settleWrites();

    expect(harness.onError).not.toHaveBeenCalled();
  });
});

describe('isStatsDependentSearch', () => {
  it.each([
    ['minGrade', { minGrade: 17 }],
    ['maxGrade', { maxGrade: 22 }],
    ['minAscents', { minAscents: 5 }],
    ['minRating', { minRating: 3 }],
    ['gradeAccuracy', { gradeAccuracy: 'accurate' }],
    ['onlyBenchmarks', { onlyBenchmarks: true }],
    ['projectsOnly', { projectsOnly: true }],
  ])('is true for %s', (_label, filter) => {
    expect(isStatsDependentSearch({ ...BASE_SEARCH, ...filter })).toBe(true);
  });

  it.each(['ascents', 'difficulty', 'quality', 'popular'])('is true for the %s sort', (sortBy) => {
    expect(isStatsDependentSearch({ ...BASE_SEARCH, sortBy })).toBe(true);
  });

  it.each([
    ['no filters at all', {}],
    ['the name sort', { sortBy: 'name' }],
    ['the creation sort', { sortBy: 'creation' }],
    ['the random sort', { sortBy: 'random' }],
    ['a name search', { name: 'crimpy' }],
    ['a setter filter', { setter: ['someone'] }],
    ['a hold filter', { holdsFilter: { 12: 'STARTING' } }],
    ['a zone filter', { zoneBox: { edgeLeft: 0, edgeRight: 10, edgeBottom: 0, edgeTop: 10 } }],
    ['personal-progress filters', { hideCompleted: true, showOnlyAttempted: true }],
    ['a disabled benchmarks toggle', { onlyBenchmarks: false }],
  ])('is false for %s', (_label, filter) => {
    expect(isStatsDependentSearch({ ...BASE_SEARCH, ...filter } as never)).toBe(false);
  });
});

describe('canStreamChangeList', () => {
  const flushed = new Set(['climb-1']);

  it('tolerates a query that has never fetched', () => {
    expect(canStreamChangeList({ ...BASE_SEARCH, sortBy: 'name' }, undefined, flushed)).toBe(false);
    expect(canStreamChangeList({ ...BASE_SEARCH, minGrade: 17 }, undefined, flushed)).toBe(true);
  });

  it('finds the climb across every loaded page of an infinite query', () => {
    const cached = {
      pages: [
        { searchClimbs: { climbs: [{ uuid: 'climb-other' }] } },
        { searchClimbs: { climbs: [{ uuid: 'climb-1' }] } },
      ],
      pageParams: [0, 1],
    };
    expect(canStreamChangeList({ ...BASE_SEARCH, sortBy: 'name' }, cached, flushed)).toBe(true);
  });

  it('does not match a query key that is not a search input', () => {
    expect(canStreamChangeList('not-an-input', undefined, flushed)).toBe(false);
  });
});
