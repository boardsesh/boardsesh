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
  ClimbStatsWriteThroughStatus,
  OfflineDatabase,
} from '@boardsesh/offline-sync';

import {
  canStreamChangeList,
  climbDetailMatchesBatch,
  createClimbStatsLiveSync,
  isStatsDependentSearch,
  searchInputScope,
  CLIMB_STATS_INVALIDATE_MAX_WAIT_MS,
  CLIMB_STATS_INVALIDATE_TRAILING_MS,
  type ClimbStatsLiveSyncOptions,
  type FlushedClimbStat,
} from '../climb-stats-live-sync';

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
    syncSeq: '500',
    ...overrides,
  };
}

function applied(compatibleSizeIds: number[] | null = [5, 6]): ClimbStatsWriteThroughResult {
  return { status: 'applied', compatibleSizeIds };
}

function flushed(overrides: Partial<FlushedClimbStat> = {}): FlushedClimbStat {
  return { boardType: 'kilter', layoutId: 1, climbUuid: 'climb-1', angle: 40, compatibleSizeIds: [5, 6], ...overrides };
}

/** The batch writer's default: every event applies. */
function allApplied(compatibleSizeIds: number[] | null = [5, 6]) {
  return async (_db: OfflineDatabase, events: readonly ClimbStatsWriteThroughInput[]) =>
    events.map(() => applied(compatibleSizeIds));
}

/** The batch writer settling every event with one status (contention, staleness…). */
function allSettled(status: ClimbStatsWriteThroughStatus) {
  return async (_db: OfflineDatabase, events: readonly ClimbStatsWriteThroughInput[]) =>
    events.map(() => ({ status, compatibleSizeIds: [5, 6] }));
}

type Harness = {
  sync: ReturnType<typeof createClimbStatsLiveSync>;
  queryClient: QueryClient;
  writeEvents: ReturnType<typeof vi.fn>;
  isScopeDownloaded: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
  /** Every event handed to the writer, across every drain pass. */
  writtenEvents: () => ClimbStatsWriteThroughInput[];
};

let queryClient: QueryClient;

function createHarness(overrides: Partial<ClimbStatsLiveSyncOptions> = {}): Harness {
  const writeEvents = vi.fn(allApplied());
  const isScopeDownloaded = vi.fn(async () => true);
  const onError = vi.fn();
  const sync = createClimbStatsLiveSync({
    getDb: () => fakeDb,
    queryClient,
    isScopeDownloaded: isScopeDownloaded as unknown as ClimbStatsLiveSyncOptions['isScopeDownloaded'],
    shouldSkipWrites: () => false,
    hasEnabledScopeForLayout: () => true,
    writeEvents: writeEvents as unknown as ClimbStatsLiveSyncOptions['writeEvents'],
    onError,
    ...overrides,
  });
  return {
    sync,
    queryClient,
    writeEvents,
    isScopeDownloaded,
    onError,
    writtenEvents: () =>
      writeEvents.mock.calls.flatMap((call) => call[1] as unknown as ClimbStatsWriteThroughInput[]),
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

function seedClimbDetail(climbUuid: string, angle = 40) {
  const key = ['climb', { ...BASE_SEARCH, angle, climbUuid }];
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

    expect(harness.writeEvents).not.toHaveBeenCalled();
  });

  it('keeps an event queued while the handle is null and writes it once it appears', async () => {
    // The handle is null for up to ~30 s during startup migrations. Discarding
    // the event there would lose the whole window's worth of recomputes.
    let db: OfflineDatabase | null = null;
    const harness = createHarness({ getDb: () => db });

    harness.sync.handleEvent(makeEvent({ climbUuid: 'climb-early' }));
    await settleWrites();
    expect(harness.writeEvents).not.toHaveBeenCalled();

    db = fakeDb;
    harness.sync.handleEvent(makeEvent({ climbUuid: 'climb-late' }));
    await settleWrites();

    expect(harness.writtenEvents().map((event) => event.climbUuid)).toEqual(['climb-early', 'climb-late']);
  });

  it('writes nothing and refreshes nothing while backgrounded or signing out', async () => {
    const gradeFiltered = seedInfiniteList({ ...BASE_SEARCH, minGrade: 17 }, []);
    const harness = createHarness({ shouldSkipWrites: () => true });

    harness.sync.handleEvent(makeEvent());
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_MAX_WAIT_MS);

    expect(harness.writeEvents).not.toHaveBeenCalled();
    expect(isInvalidated(gradeFiltered)).toBe(false);
  });

  it('writes nothing for a layout with no opted-in offline scope', async () => {
    const hasEnabledScopeForLayout = vi.fn(() => false);
    const harness = createHarness({ hasEnabledScopeForLayout });

    harness.sync.handleEvent(makeEvent());
    await settleWrites();

    expect(hasEnabledScopeForLayout).toHaveBeenCalledWith('kilter', 1);
    expect(harness.writeEvents).not.toHaveBeenCalled();
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
    // Both queries share one scope, so it is probed once, not once per query.
    expect(harness.isScopeDownloaded).toHaveBeenCalledTimes(1);
    expect(harness.isScopeDownloaded).toHaveBeenCalledWith(fakeDb, { boardType: 'kilter', layoutId: 1, sizeId: 5 });
  });

  it('narrows the climb detail to the climbs and angles it actually wrote', async () => {
    const flushedDetail = seedClimbDetail('climb-1');
    const otherAngle = seedClimbDetail('climb-1', 25);
    const otherDetail = seedClimbDetail('climb-other');
    seedInfiniteList({ ...BASE_SEARCH, minGrade: 17 }, []);
    const harness = createHarness();

    harness.sync.handleEvent(makeEvent());
    await settleWrites();
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_TRAILING_MS);

    expect(isInvalidated(flushedDetail)).toBe(true);
    expect(isInvalidated(otherAngle)).toBe(false);
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

  it('never refreshes a count whose only stats dependency is its sort', async () => {
    // The default sort IS `ascents` (DEFAULT_CLIMB_FILTER_STATE), so without
    // this rule the filter-sheet preview count re-counts the whole catalogue
    // every time anyone anywhere logs a send.
    const defaultCount = seedCount({ ...BASE_SEARCH, sortBy: 'ascents' });
    const filteredCount = seedCount({ ...BASE_SEARCH, sortBy: 'ascents', minAscents: 5 });
    const harness = createHarness();

    harness.sync.handleEvent(makeEvent());
    await settleWrites();
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_TRAILING_MS);

    expect(isInvalidated(defaultCount)).toBe(false);
    expect(isInvalidated(filteredCount)).toBe(true);
  });

  it('refreshes nothing when the scope is not downloaded', async () => {
    const gradeFiltered = seedInfiniteList({ ...BASE_SEARCH, minGrade: 17 }, []);
    const harness = createHarness({ isScopeDownloaded: async () => false });

    harness.sync.handleEvent(makeEvent());
    await settleWrites();
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_MAX_WAIT_MS);

    expect(isInvalidated(gradeFiltered)).toBe(false);
  });

  it('refreshes only the downloaded scope when two are cached', async () => {
    const downloaded = seedInfiniteList({ ...BASE_SEARCH, minGrade: 17 }, []);
    const otherSize = seedInfiniteList({ ...BASE_SEARCH, sizeId: 9, minGrade: 17 }, []);
    const isScopeDownloaded = vi.fn(async (_db: OfflineDatabase, scope: { sizeId: number }) => scope.sizeId === 5);
    // The climb fits BOTH sizes, so the size gate cannot do this on its own —
    // only the per-scope download probe separates the two lists.
    const harness = createHarness({
      isScopeDownloaded: isScopeDownloaded as never,
      writeEvents: allApplied([5, 9]) as never,
    });

    harness.sync.handleEvent(makeEvent());
    await settleWrites();
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_TRAILING_MS);

    expect(isInvalidated(downloaded)).toBe(true);
    expect(isInvalidated(otherSize)).toBe(false);
    // One probe per distinct scope, not one per cached query.
    expect(isScopeDownloaded).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a zone filter', { zoneBox: { edgeLeft: 0, edgeRight: 10, edgeBottom: 0, edgeTop: 10 } }],
    ['a hold-state filter', { holdsFilter: { hold_12: { STARTING: 'include' } } }],
    ['a beta-video filter', { onlyWithBetaVideos: true }],
    ['the drafts path', { onlyDrafts: true }],
  ])('never refreshes a query served over the network because of %s', async (_label, filters) => {
    // A downloaded board still falls back to HTTP for these, so the stream
    // would be paying multi-page NETWORK refetches every few seconds.
    const networkServed = seedInfiniteList({ ...BASE_SEARCH, minGrade: 17, ...filters }, ['climb-1']);
    const harness = createHarness();

    harness.sync.handleEvent(makeEvent());
    await settleWrites();
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_MAX_WAIT_MS);

    expect(isInvalidated(networkServed)).toBe(false);
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

describe('createClimbStatsLiveSync — a switch inside the coalescing window', () => {
  it('refreshes the angle the user switched TO, not the one the batch started on', async () => {
    // The batch is decided per cached query at flush time, so the list that is
    // actually on screen when the timer fires is the one that gets refreshed.
    const startingAngle = seedInfiniteList({ ...BASE_SEARCH, angle: 40, minGrade: 17 }, []);
    const switchedAngle = seedInfiniteList({ ...BASE_SEARCH, angle: 45, minGrade: 17 }, []);
    const harness = createHarness();

    harness.sync.handleEvent(makeEvent({ angle: 40 }));
    await settleWrites();
    // The user switches to 45° a moment later; events at the new angle join the
    // same window and reset the trailing timer.
    harness.sync.handleEvent(makeEvent({ climbUuid: 'climb-2', angle: 45 }));
    await settleWrites();
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_TRAILING_MS);

    expect(isInvalidated(switchedAngle)).toBe(true);
    expect(isInvalidated(startingAngle)).toBe(true);
  });

  it('refreshes a list at an angle no event in the batch touched only when the sort is cross-angle', async () => {
    // `popular` orders by SUM(ascensionist_count) over every angle, so a send
    // at 25° reorders a 40° list. Every other stats column is per-angle.
    const popularSorted = seedInfiniteList({ ...BASE_SEARCH, angle: 40, sortBy: 'popular' }, []);
    const ascentsSorted = seedInfiniteList({ ...BASE_SEARCH, angle: 40, sortBy: 'ascents' }, []);
    const popularCount = seedCount({ ...BASE_SEARCH, angle: 40, sortBy: 'popular' });
    const harness = createHarness();

    harness.sync.handleEvent(makeEvent({ angle: 25 }));
    await settleWrites();
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_TRAILING_MS);

    expect(isInvalidated(popularSorted)).toBe(true);
    expect(isInvalidated(ascentsSorted)).toBe(false);
    // A sort still cannot change a total, cross-angle or not.
    expect(isInvalidated(popularCount)).toBe(false);
  });
});

describe('createClimbStatsLiveSync — which writes may arm a refresh', () => {
  it.each(['stale', 'climb_not_local', 'invalid_revision'] as const)(
    'never refreshes on a %s write',
    async (status) => {
      const gradeFiltered = seedInfiniteList({ ...BASE_SEARCH, minGrade: 17 }, []);
      const harness = createHarness({ writeEvents: allSettled(status) as never });

      harness.sync.handleEvent(makeEvent());
      await settleWrites();
      await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_MAX_WAIT_MS);

      expect(isInvalidated(gradeFiltered)).toBe(false);
      expect(harness.isScopeDownloaded).not.toHaveBeenCalled();
    },
  );

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
    const harness = createHarness({ writeEvents: allApplied(compatibleSizeIds) as never });

    harness.sync.handleEvent(makeEvent());
    await settleWrites();
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_MAX_WAIT_MS);

    expect(isInvalidated(gradeFiltered)).toBe(false);
  });

  it('skips the size gate on a board that is not size-scoped', async () => {
    const moonboardSearch = { ...BASE_SEARCH, boardName: 'moonboard', minGrade: 17 };
    const gradeFiltered = seedInfiniteList(moonboardSearch, []);
    const harness = createHarness({ writeEvents: allApplied(null) as never });

    harness.sync.handleEvent(makeEvent({ boardType: 'moonboard' }));
    await settleWrites();
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_TRAILING_MS);

    expect(isInvalidated(gradeFiltered)).toBe(true);
  });
});

describe('createClimbStatsLiveSync — coalescing and batching', () => {
  it('collapses a burst of five events into one refresh and two write passes', async () => {
    seedInfiniteList({ ...BASE_SEARCH, minGrade: 17 }, []);
    const harness = createHarness();

    for (let index = 0; index < 5; index += 1) {
      harness.sync.handleEvent(makeEvent({ climbUuid: `climb-${index}`, syncSeq: `${500 + index}` }));
    }
    await settleWrites();
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_MAX_WAIT_MS);

    // The first event opens the drain; the four queued behind it go in one
    // batch — five events, two native write transactions rather than five.
    expect(harness.writeEvents).toHaveBeenCalledTimes(2);
    expect(harness.writtenEvents()).toHaveLength(5);
    expect(harness.isScopeDownloaded).toHaveBeenCalledTimes(1);
  });

  it('sends everything queued behind an in-flight write as a single batch', async () => {
    let releaseFirstWrite: (() => void) | undefined;
    const writeEvents = vi.fn(async (_db: OfflineDatabase, events: readonly ClimbStatsWriteThroughInput[]) => {
      if (!releaseFirstWrite) {
        await new Promise<void>((resolve) => {
          releaseFirstWrite = resolve;
        });
      }
      return events.map(() => applied());
    });
    const harness = createHarness({ writeEvents: writeEvents as never });

    harness.sync.handleEvent(makeEvent({ climbUuid: 'climb-1' }));
    await settleWrites();
    harness.sync.handleEvent(makeEvent({ climbUuid: 'climb-2' }));
    harness.sync.handleEvent(makeEvent({ climbUuid: 'climb-3' }));
    releaseFirstWrite?.();
    await settleWrites();

    expect(writeEvents).toHaveBeenCalledTimes(2);
    expect((writeEvents.mock.calls[1][1] as ClimbStatsWriteThroughInput[]).map((event) => event.climbUuid)).toEqual([
      'climb-2',
      'climb-3',
    ]);
  });

  it('keeps only the newest payload when the same climb re-fires during a write', async () => {
    let releaseFirstWrite: (() => void) | undefined;
    const writeEvents = vi.fn(async (_db: OfflineDatabase, events: readonly ClimbStatsWriteThroughInput[]) => {
      if (!releaseFirstWrite) {
        await new Promise<void>((resolve) => {
          releaseFirstWrite = resolve;
        });
      }
      return events.map(() => applied());
    });
    const harness = createHarness({ writeEvents: writeEvents as never });

    harness.sync.handleEvent(makeEvent({ syncSeq: '500' }));
    await settleWrites();
    harness.sync.handleEvent(makeEvent({ syncSeq: '501' }));
    harness.sync.handleEvent(makeEvent({ syncSeq: '502' }));
    releaseFirstWrite?.();
    await settleWrites();

    expect(writeEvents).toHaveBeenCalledTimes(2);
    expect(writeEvents.mock.calls[1][1]).toEqual([expect.objectContaining({ syncSeq: '502' })]);
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

describe('createClimbStatsLiveSync — contention and transient gates', () => {
  it('keeps a lock-lost event queued instead of discarding it', async () => {
    // A VACUUM or a snapshot import holds the write lock for 5-20 s. Dropping
    // the batch would silently lose every recompute of that window.
    let locked = true;
    const writeEvents = vi.fn(async (_db: OfflineDatabase, events: readonly ClimbStatsWriteThroughInput[]) =>
      events.map(() => (locked ? { status: 'lock_lost' as const, compatibleSizeIds: null } : applied())),
    );
    const gradeFiltered = seedInfiniteList({ ...BASE_SEARCH, minGrade: 17 }, []);
    const harness = createHarness({ writeEvents: writeEvents as never });

    harness.sync.handleEvent(makeEvent({ climbUuid: 'climb-locked' }));
    await settleWrites();
    expect(isInvalidated(gradeFiltered)).toBe(false);

    locked = false;
    harness.sync.handleEvent(makeEvent({ climbUuid: 'climb-later' }));
    await settleWrites();
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_TRAILING_MS);

    // The event held back by the lock is retried alongside the new one.
    expect((writeEvents.mock.calls[1][1] as ClimbStatsWriteThroughInput[]).map((event) => event.climbUuid)).toEqual([
      'climb-locked',
      'climb-later',
    ]);
    expect(isInvalidated(gradeFiltered)).toBe(true);
  });

  it('stops the drain on contention rather than re-paying the lock wait per event', async () => {
    const writeEvents = vi.fn(allSettled('lock_lost'));
    const harness = createHarness({ writeEvents: writeEvents as never });

    harness.sync.handleEvent(makeEvent({ climbUuid: 'climb-1' }));
    await settleWrites();
    harness.sync.handleEvent(makeEvent({ climbUuid: 'climb-2' }));
    await settleWrites();

    // Two handleEvents, two passes — not one pass per queued event.
    expect(writeEvents).toHaveBeenCalledTimes(2);
  });

  it('keeps the flush batch when it lands during a momentary background', async () => {
    const gradeFiltered = seedInfiniteList({ ...BASE_SEARCH, minGrade: 17 }, []);
    let backgrounded = false;
    const harness = createHarness({ shouldSkipWrites: () => backgrounded });

    harness.sync.handleEvent(makeEvent());
    await settleWrites();
    backgrounded = true;
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_TRAILING_MS);
    expect(isInvalidated(gradeFiltered)).toBe(false);

    // Nothing re-arms on foreground, so the ceiling has to carry the batch:
    // clearing it here would drop the refresh for good.
    backgrounded = false;
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_MAX_WAIT_MS);

    expect(isInvalidated(gradeFiltered)).toBe(true);
  });

  it('keeps the flush batch when the handle is null at flush time', async () => {
    const gradeFiltered = seedInfiniteList({ ...BASE_SEARCH, minGrade: 17 }, []);
    let db: OfflineDatabase | null = fakeDb;
    const harness = createHarness({ getDb: () => db });

    harness.sync.handleEvent(makeEvent());
    await settleWrites();
    db = null;
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_TRAILING_MS);
    expect(isInvalidated(gradeFiltered)).toBe(false);

    db = fakeDb;
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_MAX_WAIT_MS);

    expect(isInvalidated(gradeFiltered)).toBe(true);
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

  it('arms no timer from a write that resolves after dispose', async () => {
    // The drain awaits the write; dispose can land while it is in flight, and a
    // timer armed afterwards could no longer be cancelled by it.
    let releaseWrite: (() => void) | undefined;
    const scheduled: Array<ReturnType<typeof vi.fn>> = [];
    const harness = createHarness({
      scheduleTask: () => {
        const cancel = vi.fn();
        scheduled.push(cancel);
        return cancel;
      },
      writeEvents: (async (_db: OfflineDatabase, events: readonly ClimbStatsWriteThroughInput[]) => {
        await new Promise<void>((resolve) => {
          releaseWrite = resolve;
        });
        return events.map(() => applied());
      }) as never,
    });

    harness.sync.handleEvent(makeEvent());
    await settleWrites();
    harness.sync.dispose();
    releaseWrite?.();
    await settleWrites();

    expect(scheduled).toHaveLength(0);
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

    expect(harness.writeEvents).not.toHaveBeenCalled();
  });

  it('keeps a second instance out of the first one’s refresh', async () => {
    const gradeFiltered = seedInfiniteList({ ...BASE_SEARCH, minGrade: 17 }, []);
    const first = createHarness();
    const second = createHarness();

    first.sync.handleEvent(makeEvent());
    await settleWrites();
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_MAX_WAIT_MS);

    expect(isInvalidated(gradeFiltered)).toBe(true);
    expect(second.writeEvents).not.toHaveBeenCalled();
    expect(second.isScopeDownloaded).not.toHaveBeenCalled();
  });

  it('swallows a write failure and reports it once per instance', async () => {
    const brokenDatabase = new Error('database or disk is full');
    const writeEvents = vi.fn(async () => {
      throw brokenDatabase;
    });
    const harness = createHarness({ writeEvents: writeEvents as never });

    harness.sync.handleEvent(makeEvent({ climbUuid: 'climb-1' }));
    await settleWrites();
    harness.sync.handleEvent(makeEvent({ climbUuid: 'climb-2' }));
    await settleWrites();

    expect(writeEvents).toHaveBeenCalledTimes(2);
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
    const writeEvents = vi.fn(async (_db: OfflineDatabase, events: readonly ClimbStatsWriteThroughInput[]) => {
      if (!releaseFirstWrite) {
        await new Promise<void>((resolve) => {
          releaseFirstWrite = resolve;
        });
      }
      return events.map(() => applied());
    });
    const harness = createHarness({ shouldSkipWrites: () => backgrounded, writeEvents: writeEvents as never });

    harness.sync.handleEvent(makeEvent({ climbUuid: 'climb-1' }));
    await settleWrites();
    harness.sync.handleEvent(makeEvent({ climbUuid: 'climb-2' }));
    // The app backgrounds while write 1 is still in flight.
    backgrounded = true;
    releaseFirstWrite?.();
    await settleWrites();

    expect(writeEvents).toHaveBeenCalledTimes(1);
  });

  it('never reports write-lock contention', async () => {
    const harness = createHarness({ writeEvents: allSettled('lock_lost') as never });

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

  it.each(['ascents', 'difficulty', 'quality', 'popular'])(
    'is false for the %s sort when the sort cannot matter',
    (sortBy) => {
      expect(isStatsDependentSearch({ ...BASE_SEARCH, sortBy }, false)).toBe(false);
    },
  );

  it('still reads filters when the sort cannot matter', () => {
    expect(isStatsDependentSearch({ ...BASE_SEARCH, sortBy: 'name', minAscents: 5 }, false)).toBe(true);
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

describe('searchInputScope', () => {
  it('reads the offline scope out of a search input', () => {
    expect(searchInputScope(BASE_SEARCH)).toEqual({ boardType: 'kilter', layoutId: 1, sizeId: 5 });
  });

  it.each([
    ['a non-object key', 'not-an-input'],
    ['a key with no board', { layoutId: 1, sizeId: 5 }],
    ['a key with no size', { boardName: 'kilter', layoutId: 1 }],
  ])('returns null for %s', (_label, input) => {
    expect(searchInputScope(input)).toBeNull();
  });
});

describe('canStreamChangeList', () => {
  const batch = [flushed()];

  it('tolerates a query that has never fetched', () => {
    expect(canStreamChangeList('infiniteSearchClimbs', { ...BASE_SEARCH, sortBy: 'name' }, undefined, batch)).toBe(
      false,
    );
    expect(canStreamChangeList('infiniteSearchClimbs', { ...BASE_SEARCH, minGrade: 17 }, undefined, batch)).toBe(true);
  });

  it('finds the climb across every loaded page of an infinite query', () => {
    const cached = {
      pages: [
        { searchClimbs: { climbs: [{ uuid: 'climb-other' }] } },
        { searchClimbs: { climbs: [{ uuid: 'climb-1' }] } },
      ],
      pageParams: [0, 1],
    };
    expect(canStreamChangeList('infiniteSearchClimbs', { ...BASE_SEARCH, sortBy: 'name' }, cached, batch)).toBe(true);
  });

  it('does not match a query key that is not a search input', () => {
    expect(canStreamChangeList('infiniteSearchClimbs', 'not-an-input', undefined, batch)).toBe(false);
  });

  it('ignores an entry from another board or layout', () => {
    const otherBoard = [flushed({ boardType: 'tension' })];
    const otherLayout = [flushed({ layoutId: 8 })];
    const input = { ...BASE_SEARCH, minGrade: 17 };
    expect(canStreamChangeList('infiniteSearchClimbs', input, undefined, otherBoard)).toBe(false);
    expect(canStreamChangeList('infiniteSearchClimbs', input, undefined, otherLayout)).toBe(false);
  });
});

describe('climbDetailMatchesBatch', () => {
  const batch = [flushed()];

  it('matches the uuid at the written angle only', () => {
    expect(climbDetailMatchesBatch({ climbUuid: 'climb-1', angle: 40 }, batch)).toBe(true);
    expect(climbDetailMatchesBatch({ climbUuid: 'climb-1', angle: 25 }, batch)).toBe(false);
    expect(climbDetailMatchesBatch({ climbUuid: 'climb-other', angle: 40 }, batch)).toBe(false);
  });

  it('matches on the uuid alone when the variables carry no angle', () => {
    expect(climbDetailMatchesBatch({ climbUuid: 'climb-1' }, batch)).toBe(true);
  });

  it.each([
    ['a non-object key', 'not-an-input'],
    ['a key with no uuid', { angle: 40 }],
  ])('returns false for %s', (_label, variables) => {
    expect(climbDetailMatchesBatch(variables, batch)).toBe(false);
  });
});
