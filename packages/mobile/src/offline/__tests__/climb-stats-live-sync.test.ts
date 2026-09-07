// The mobile live-stats consumer: what it writes, what it refreshes, and the
// much larger set of things it deliberately leaves alone.
//
// The queries here are seeded into a REAL QueryClient with the shapes the app
// caches (raw, pre-`select`), so every predicate runs against the same data the
// device would hand it. Invalidation is observed on the cache entries
// themselves rather than on a mock's arguments — a predicate that quietly
// matches nothing looks identical to a correct one from the call site.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
  hasStatsDependentFilter,
  searchInputScope,
  CLIMB_STATS_INVALIDATE_MAX_WAIT_MS,
  CLIMB_STATS_INVALIDATE_TRAILING_MS,
  CLIMB_STATS_LOCK_BACKOFF_MS,
  CLIMB_STATS_MAX_PENDING_EVENTS,
  CLIMB_STATS_REVISION_MEMO_TTL_MS,
  CLIMB_STATS_TRACKED_REVISIONS,
  type ClimbStatsLiveSyncOptions,
  type FlushedClimbStat,
} from '../climb-stats-live-sync';

const BASE_SEARCH = { boardName: 'kilter', layoutId: 1, sizeId: 5, setIds: '1,2', angle: 40 };

const fakeDb = { name: 'offline-db' } as unknown as OfflineDatabase;

/** Every scope this suite's default probe reports as downloaded. */
const DOWNLOADED = new Map([['kilter:1:5', true]]);

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

function applied(
  compatibleSizeIds: number[] | null = [5, 6],
  layoutId: number | null = 1,
): ClimbStatsWriteThroughResult {
  return { status: 'applied', compatibleSizeIds, layoutId, settledBy: 'write' };
}

function flushed(overrides: Partial<FlushedClimbStat> = {}): FlushedClimbStat {
  return { boardType: 'kilter', layoutId: 1, climbUuid: 'climb-1', angle: 40, compatibleSizeIds: [5, 6], ...overrides };
}

/** The batch writer's default: every event applies. */
function allApplied(compatibleSizeIds: number[] | null = [5, 6], layoutId: number | null = 1) {
  return async (_db: OfflineDatabase, events: readonly ClimbStatsWriteThroughInput[]) =>
    events.map(() => applied(compatibleSizeIds, layoutId));
}

/** The batch writer settling every event with one status (contention, staleness…). */
function allSettled(status: ClimbStatsWriteThroughStatus, settledBy: 'pre_read' | 'write' = 'pre_read') {
  return async (_db: OfflineDatabase, events: readonly ClimbStatsWriteThroughInput[]) =>
    events.map(() => ({ status, compatibleSizeIds: [5, 6], layoutId: 1, settledBy }));
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
  // Both seams are wrapped rather than replaced, so `harness.writeEvents` and
  // `harness.isScopeDownloaded` observe every call even when a test supplies
  // its own behaviour — a replaced seam silently leaves the harness's spy at
  // zero calls, which reads exactly like a guard that fired.
  const { writeEvents: writeEventsOverride, isScopeDownloaded: probeOverride, ...rest } = overrides;
  const writeEvents = vi.fn(writeEventsOverride ?? (allApplied() as never));
  const isScopeDownloaded = vi.fn(probeOverride ?? ((async () => true) as never));
  const onError = vi.fn();
  const sync = createClimbStatsLiveSync({
    getDb: () => fakeDb,
    queryClient,
    isScopeDownloaded: isScopeDownloaded as unknown as ClimbStatsLiveSyncOptions['isScopeDownloaded'],
    shouldSkipWrites: () => false,
    hasEnabledScopeForBoard: () => true,
    writeEvents: writeEvents as unknown as ClimbStatsLiveSyncOptions['writeEvents'],
    onError,
    ...rest,
  });
  return {
    sync,
    queryClient,
    writeEvents,
    isScopeDownloaded,
    onError,
    writtenEvents: () => writeEvents.mock.calls.flatMap((call) => call[1] as unknown as ClimbStatsWriteThroughInput[]),
  };
}

function seedInfinitePages(input: Record<string, unknown>, pages: string[][]) {
  const key = ['infiniteSearchClimbs', input];
  queryClient.setQueryData(key, {
    pages: pages.map((climbUuids) => ({
      searchClimbs: { climbs: climbUuids.map((uuid) => ({ uuid })), hasMore: false, totalCount: 1 },
    })),
    pageParams: pages.map((_page, index) => index),
  });
  return key;
}

function seedInfiniteList(input: Record<string, unknown>, climbUuids: string[]) {
  return seedInfinitePages(input, [climbUuids]);
}

function seedCount(input: Record<string, unknown>) {
  const key = ['searchClimbsCount', input];
  queryClient.setQueryData(key, { searchClimbs: { totalCount: 42 } });
  return key;
}

function seedClimbDetail(climbUuid: string, overrides: Record<string, unknown> = {}) {
  const key = ['climb', { ...BASE_SEARCH, ...overrides, climbUuid }];
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

  it('writes nothing for a board with no opted-in offline scope', async () => {
    const hasEnabledScopeForBoard = vi.fn(() => false);
    const harness = createHarness({ hasEnabledScopeForBoard });

    harness.sync.handleEvent(makeEvent());
    await settleWrites();

    // Board-level: the event's layout label is the browsed layout on a
    // reconciliation row, so it cannot be part of this gate.
    expect(hasEnabledScopeForBoard).toHaveBeenCalledWith('kilter');
    expect(harness.writeEvents).not.toHaveBeenCalled();
  });

  it('lets an event through on a downloaded board even when its layout label is wrong', async () => {
    const gradeFiltered = seedInfiniteList({ ...BASE_SEARCH, minGrade: 17 }, []);
    const harness = createHarness({
      hasEnabledScopeForBoard: (boardType: string) => boardType === 'kilter',
      // The write resolves the climb's real layout, which is what the list gate
      // then uses.
      writeEvents: allApplied([5, 6], 1) as never,
    });

    harness.sync.handleEvent(makeEvent({ layoutId: 99 }));
    await settleWrites();
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_TRAILING_MS);

    expect(harness.writeEvents).toHaveBeenCalledTimes(1);
    expect(isInvalidated(gradeFiltered)).toBe(true);
  });
});

describe('createClimbStatsLiveSync — dropping revisions already settled', () => {
  it('never re-writes a revision this instance already applied', async () => {
    // The 120 s reconciliation read re-offers every angle row of every retained
    // climb; a 50-climb batch is ~700 of them, nearly all unchanged.
    const harness = createHarness();

    harness.sync.handleEvent(makeEvent({ syncSeq: '500' }));
    await settleWrites();
    harness.sync.handleEvent(makeEvent({ syncSeq: '500' }));
    await settleWrites();

    expect(harness.writeEvents).toHaveBeenCalledTimes(1);
    expect(harness.writtenEvents()).toHaveLength(1);
  });

  it('never re-writes a revision the writer already reported stale', async () => {
    const harness = createHarness({ writeEvents: allSettled('stale') as never });

    harness.sync.handleEvent(makeEvent({ syncSeq: '500' }));
    await settleWrites();
    harness.sync.handleEvent(makeEvent({ syncSeq: '500' }));
    await settleWrites();

    expect(harness.writeEvents).toHaveBeenCalledTimes(1);
  });

  it('still writes a newer revision for the same climb and angle', async () => {
    const harness = createHarness();

    harness.sync.handleEvent(makeEvent({ syncSeq: '500' }));
    await settleWrites();
    harness.sync.handleEvent(makeEvent({ syncSeq: '501' }));
    await settleWrites();

    expect(harness.writtenEvents().map((event) => event.syncSeq)).toEqual(['500', '501']);
  });

  it('still writes a repeat the writer could not settle', async () => {
    // `climb_not_local` says nothing about a local revision — the climb could
    // be downloaded a minute later.
    const harness = createHarness({ writeEvents: allSettled('climb_not_local') as never });

    harness.sync.handleEvent(makeEvent({ syncSeq: '500' }));
    await settleWrites();
    harness.sync.handleEvent(makeEvent({ syncSeq: '500' }));
    await settleWrites();

    expect(harness.writeEvents).toHaveBeenCalledTimes(2);
  });

  it('evicts the oldest key at the cap rather than growing for the app’s lifetime', async () => {
    const harness = createHarness();
    const firstEvent = makeEvent({ climbUuid: 'climb-0' });

    harness.sync.handleEvent(firstEvent);
    await settleWrites();
    // Fill past the cap so the very first key is evicted. Drained in chunks
    // well under the pending-queue cap, so nothing is dropped before it is
    // written and remembered.
    const chunk = Math.floor(CLIMB_STATS_MAX_PENDING_EVENTS / 2);
    for (let index = 1; index <= CLIMB_STATS_TRACKED_REVISIONS; index += 1) {
      harness.sync.handleEvent(makeEvent({ climbUuid: `climb-${index}` }));
      if (index % chunk === 0) await settleWrites();
    }
    await settleWrites();

    const before = harness.writtenEvents().length;
    harness.sync.handleEvent(firstEvent);
    await settleWrites();

    expect(harness.writtenEvents()).toHaveLength(before + 1);
  });

  it('forgets a remembered revision once it is older than the reconciliation interval', async () => {
    // Another writer can delete these rows without telling us — a scope
    // teardown, a sign-out purge, a snapshot reconcile. A remove and
    // re-download inside one session can leave the re-imported row BEHIND the
    // memo, and the republish that would heal it must not be discarded forever.
    const harness = createHarness();

    harness.sync.handleEvent(makeEvent({ syncSeq: '500' }));
    await settleWrites();
    expect(harness.writeEvents).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(CLIMB_STATS_REVISION_MEMO_TTL_MS - 1);
    harness.sync.handleEvent(makeEvent({ syncSeq: '500' }));
    await settleWrites();
    expect(harness.writeEvents).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    harness.sync.handleEvent(makeEvent({ syncSeq: '500' }));
    await settleWrites();

    expect(harness.writeEvents).toHaveBeenCalledTimes(2);
  });

  it('forgets everything when the database handle is replaced', async () => {
    // A sign-out wipe and re-open, or a hot reload, publishes a new handle over
    // rows this module has never seen.
    let db: OfflineDatabase = fakeDb;
    const harness = createHarness({ getDb: () => db });

    harness.sync.handleEvent(makeEvent({ syncSeq: '500' }));
    await settleWrites();
    harness.sync.handleEvent(makeEvent({ syncSeq: '500' }));
    await settleWrites();
    expect(harness.writeEvents).toHaveBeenCalledTimes(1);

    db = { name: 'reopened-db' } as unknown as OfflineDatabase;
    harness.sync.handleEvent(makeEvent({ syncSeq: '500' }));
    await settleWrites();

    expect(harness.writeEvents).toHaveBeenCalledTimes(2);
  });

  it('never remembers a stale the WRITE reported, only one the pre-read did', async () => {
    // A `stale` from the transaction means the upsert matched nothing — the
    // climb vanished between the pre-read and the lock, so there may be no row
    // at all. Remembering it would suppress the republish that heals it.
    const harness = createHarness({ writeEvents: allSettled('stale', 'write') as never });

    harness.sync.handleEvent(makeEvent({ syncSeq: '500' }));
    await settleWrites();
    harness.sync.handleEvent(makeEvent({ syncSeq: '500' }));
    await settleWrites();

    expect(harness.writeEvents).toHaveBeenCalledTimes(2);
  });
});

describe('createClimbStatsLiveSync — the queue keeps the newer revision', () => {
  // The reconciliation read is a server snapshot taken BEFORE the recompute the
  // stream already published, so the two arrive out of order for the same key.
  // Latest-arrival-wins would let the older one replace the newer and lose it.
  function heldWriter() {
    let release: (() => void) | undefined;
    const writeEvents = vi.fn(async (_db: OfflineDatabase, events: readonly ClimbStatsWriteThroughInput[]) => {
      if (!release) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return events.map(() => applied());
    });
    return { writeEvents, release: () => release?.() };
  }

  it('never lets an older arrival displace a newer queued event', async () => {
    const { writeEvents, release } = heldWriter();
    const harness = createHarness({ writeEvents: writeEvents as never });

    // Event one opens the drain and blocks in the writer.
    harness.sync.handleEvent(makeEvent({ climbUuid: 'other', syncSeq: '1' }));
    await settleWrites();
    // The stream's fresh revision queues behind it…
    harness.sync.handleEvent(makeEvent({ syncSeq: '101' }));
    // …and the reconciliation's stale snapshot of the same key arrives after.
    harness.sync.handleEvent(makeEvent({ syncSeq: '100' }));
    release();
    await settleWrites();

    const second = writeEvents.mock.calls[1][1] as ClimbStatsWriteThroughInput[];
    expect(second.map((event) => event.syncSeq)).toEqual(['101']);
  });

  it('still takes a newer arrival for a queued key', async () => {
    const { writeEvents, release } = heldWriter();
    const harness = createHarness({ writeEvents: writeEvents as never });

    harness.sync.handleEvent(makeEvent({ climbUuid: 'other', syncSeq: '1' }));
    await settleWrites();
    harness.sync.handleEvent(makeEvent({ syncSeq: '100' }));
    harness.sync.handleEvent(makeEvent({ syncSeq: '101' }));
    release();
    await settleWrites();

    const second = writeEvents.mock.calls[1][1] as ClimbStatsWriteThroughInput[];
    expect(second.map((event) => event.syncSeq)).toEqual(['101']);
  });

  it('never lets a requeued event overwrite a newer one that arrived while it was in flight', async () => {
    // The write of revision 100 is still in the writer when the stream's 101
    // arrives and takes its queue slot. Losing the lock then puts 100 back —
    // and it must NOT displace the 101 already sitting there.
    let release: (() => void) | undefined;
    let locked = true;
    const writeEvents = vi.fn(async (_db: OfflineDatabase, events: readonly ClimbStatsWriteThroughInput[]) => {
      if (!release) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return events.map(() =>
        locked
          ? { status: 'lock_lost' as const, compatibleSizeIds: null, layoutId: null, settledBy: 'write' as const }
          : applied(),
      );
    });
    const harness = createHarness({ writeEvents: writeEvents as never });

    harness.sync.handleEvent(makeEvent({ syncSeq: '100' }));
    await settleWrites();
    // 101 lands on the same key while 100 is still being written.
    harness.sync.handleEvent(makeEvent({ syncSeq: '101' }));
    // The in-flight write loses the lock, so 100 is requeued on top of 101.
    release?.();
    await settleWrites();
    locked = false;
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_LOCK_BACKOFF_MS);
    await settleWrites();

    const retried = writeEvents.mock.calls[1][1] as ClimbStatsWriteThroughInput[];
    expect(retried.map((event) => event.syncSeq)).toEqual(['101']);
  });

  it('caps the pending queue and drops the oldest rather than growing unbounded', async () => {
    // The queue only grows while SQLite is unreachable, and every event on it
    // is disposable — the next pull carries the same values.
    let db: OfflineDatabase | null = null;
    const harness = createHarness({ getDb: () => db });

    const overflow = CLIMB_STATS_MAX_PENDING_EVENTS + 50;
    for (let index = 0; index < overflow; index += 1) {
      harness.sync.handleEvent(makeEvent({ climbUuid: `climb-${index}` }));
    }
    await settleWrites();
    expect(harness.writeEvents).not.toHaveBeenCalled();

    db = fakeDb;
    harness.sync.handleEvent(makeEvent({ climbUuid: 'climb-last' }));
    await settleWrites();

    const written = harness.writtenEvents().map((event) => event.climbUuid);
    expect(written).toHaveLength(CLIMB_STATS_MAX_PENDING_EVENTS);
    // The oldest went, the newest stayed.
    expect(written).not.toContain('climb-0');
    expect(written).toContain('climb-last');
  });
});

describe('createClimbStatsLiveSync — refreshing the browsed list', () => {
  it('refreshes a stats-filtered list and count once the stream goes quiet', async () => {
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
    // The climb fits BOTH sizes, so the size gate cannot do this on its own —
    // only the per-scope download probe separates the two lists.
    const harness = createHarness({
      isScopeDownloaded: (async (_db: OfflineDatabase, scope: { sizeId: number }) => scope.sizeId === 5) as never,
      writeEvents: allApplied([5, 9]) as never,
    });

    harness.sync.handleEvent(makeEvent());
    await settleWrites();
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_TRAILING_MS);

    expect(isInvalidated(downloaded)).toBe(true);
    expect(isInvalidated(otherSize)).toBe(false);
    // One probe per distinct scope, not one per cached query.
    expect(harness.isScopeDownloaded).toHaveBeenCalledTimes(2);
  });

  it('probes no scope the batch cannot touch', async () => {
    // A cached list on another layout can never be moved by this batch, so it
    // is not worth a board_climbs EXISTS probe on every flush.
    seedInfiniteList({ ...BASE_SEARCH, minGrade: 17 }, []);
    seedInfiniteList({ ...BASE_SEARCH, layoutId: 8, minGrade: 17 }, []);
    const harness = createHarness();

    harness.sync.handleEvent(makeEvent());
    await settleWrites();
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_TRAILING_MS);

    expect(harness.isScopeDownloaded).toHaveBeenCalledTimes(1);
    expect(harness.isScopeDownloaded).toHaveBeenCalledWith(fakeDb, { boardType: 'kilter', layoutId: 1, sizeId: 5 });
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

  it('reads the default sort from the local reader rather than a second copy', () => {
    // `normalizeSortBy` maps an absent sortBy to `ascents`; a private copy of
    // that rule here would drift the moment the SQL default changed.
    const source = readFileSync(fileURLToPath(new URL('../climb-stats-live-sync.ts', import.meta.url)), 'utf8');
    expect(source).toContain('normalizeSortBy');
    expect(source).toContain("from '../db/queries/search-climbs-local'");
    expect(source).not.toMatch(/sortBy\s*\?\?\s*'ascents'/);
    expect(source).not.toMatch(/!sortBy\)\s*return 'ascents'/);
  });
});

describe('createClimbStatsLiveSync — a stats sort only moves rows already on screen', () => {
  it('leaves the default ascents-sorted list alone for a climb it has never shown', async () => {
    // This is the ordinary Climbs tab. Invalidating it here would refetch every
    // loaded page every few seconds because a stranger logged a send.
    const defaultSorted = seedInfinitePages({ ...BASE_SEARCH, sortBy: 'ascents' }, [['climb-a'], ['climb-b']]);
    const harness = createHarness();

    harness.sync.handleEvent(makeEvent());
    await settleWrites();
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_MAX_WAIT_MS);

    expect(isInvalidated(defaultSorted)).toBe(false);
  });

  it('refreshes the same list when the climb is on a deeper loaded page', async () => {
    const defaultSorted = seedInfinitePages({ ...BASE_SEARCH, sortBy: 'ascents' }, [
      ['climb-a'],
      ['climb-b'],
      ['climb-1'],
    ]);
    const harness = createHarness();

    harness.sync.handleEvent(makeEvent());
    await settleWrites();
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_TRAILING_MS);

    expect(isInvalidated(defaultSorted)).toBe(true);
  });

  it('refreshes a grade-filtered list for a climb it has never shown', async () => {
    // A filter decides membership, so an off-page climb can enter the results.
    const gradeFiltered = seedInfinitePages({ ...BASE_SEARCH, minGrade: 17 }, [['climb-a'], ['climb-b']]);
    const harness = createHarness();

    harness.sync.handleEvent(makeEvent());
    await settleWrites();
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_TRAILING_MS);

    expect(isInvalidated(gradeFiltered)).toBe(true);
  });

  it('refreshes a popular-sorted list from another angle only for a climb it shows', async () => {
    // `popular` sums ascents over every angle, so a 25° send reorders a 40°
    // list — but only the rows that list is actually rendering.
    const showsClimb = seedInfiniteList({ ...BASE_SEARCH, sortBy: 'popular' }, ['climb-1']);
    const doesNot = seedInfiniteList({ ...BASE_SEARCH, sortBy: 'popular', setIds: '3,4' }, ['climb-other']);
    const ascentsSorted = seedInfiniteList({ ...BASE_SEARCH, sortBy: 'ascents' }, ['climb-1']);
    const popularCount = seedCount({ ...BASE_SEARCH, sortBy: 'popular' });
    const harness = createHarness();

    harness.sync.handleEvent(makeEvent({ angle: 25 }));
    await settleWrites();
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_TRAILING_MS);

    expect(isInvalidated(showsClimb)).toBe(true);
    expect(isInvalidated(doesNot)).toBe(false);
    // Per-angle sorts cannot move on another angle's event at all.
    expect(isInvalidated(ascentsSorted)).toBe(false);
    // A sort still cannot change a total, cross-angle or not.
    expect(isInvalidated(popularCount)).toBe(false);
  });
});

describe('createClimbStatsLiveSync — the climb detail', () => {
  it('narrows the detail to the climbs and angles it actually wrote', async () => {
    const flushedDetail = seedClimbDetail('climb-1');
    const otherAngle = seedClimbDetail('climb-1', { angle: 25 });
    const otherDetail = seedClimbDetail('climb-other');
    const harness = createHarness();

    harness.sync.handleEvent(makeEvent());
    await settleWrites();
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_TRAILING_MS);

    expect(isInvalidated(flushedDetail)).toBe(true);
    expect(isInvalidated(otherAngle)).toBe(false);
    expect(isInvalidated(otherDetail)).toBe(false);
  });

  it('never refreshes a detail whose scope is served over the network', async () => {
    // Same rule the lists get: an opted-in scope still mid-crawl, or a size the
    // user never downloaded, is fetched over HTTP — a global stream must not
    // make it refetch.
    const localDetail = seedClimbDetail('climb-1');
    const networkDetail = seedClimbDetail('climb-1', { sizeId: 9 });
    const harness = createHarness({
      isScopeDownloaded: (async (_db: OfflineDatabase, scope: { sizeId: number }) => scope.sizeId === 5) as never,
      writeEvents: allApplied([5, 9]) as never,
    });

    harness.sync.handleEvent(makeEvent());
    await settleWrites();
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_TRAILING_MS);

    expect(isInvalidated(localDetail)).toBe(true);
    expect(isInvalidated(networkDetail)).toBe(false);
  });

  it('never refreshes a detail on another layout', async () => {
    const otherLayout = seedClimbDetail('climb-1', { layoutId: 8 });
    seedClimbDetail('climb-1');
    const harness = createHarness();

    harness.sync.handleEvent(makeEvent());
    await settleWrites();
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_TRAILING_MS);

    expect(isInvalidated(otherLayout)).toBe(false);
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

  it('refreshes the layout the CLIMB belongs to, not the one the event was labelled with', async () => {
    // A reconciliation read stamps its rows with the layout the user is
    // browsing. The write reads the climb's own layout_id, and that is what the
    // list gate has to use.
    const climbsLayout = seedInfiniteList({ ...BASE_SEARCH, layoutId: 8, minGrade: 17 }, []);
    const eventsLayout = seedInfiniteList({ ...BASE_SEARCH, layoutId: 1, minGrade: 17 }, []);
    const harness = createHarness({ writeEvents: allApplied([5, 6], 8) as never });

    harness.sync.handleEvent(makeEvent({ layoutId: 1 }));
    await settleWrites();
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_TRAILING_MS);

    expect(isInvalidated(climbsLayout)).toBe(true);
    expect(isInvalidated(eventsLayout)).toBe(false);
  });

  it('arms nothing when the write could not resolve the climb’s layout', async () => {
    const gradeFiltered = seedInfiniteList({ ...BASE_SEARCH, minGrade: 17 }, []);
    const harness = createHarness({ writeEvents: allApplied([5, 6], null) as never });

    harness.sync.handleEvent(makeEvent());
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
  it('collapses a synchronous burst into ONE write pass and one refresh', async () => {
    seedInfiniteList({ ...BASE_SEARCH, minGrade: 17 }, []);
    const harness = createHarness();

    // A reconciliation pass delivers its rows in one synchronous loop. Draining
    // on arrival would write the first alone and batch only the remainder, so
    // the drain is deferred to a microtask.
    for (let index = 0; index < 5; index += 1) {
      harness.sync.handleEvent(makeEvent({ climbUuid: `climb-${index}`, syncSeq: `${500 + index}` }));
    }
    await settleWrites();
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_MAX_WAIT_MS);

    expect(harness.writeEvents).toHaveBeenCalledTimes(1);
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
      events.map(() =>
        locked ? { status: 'lock_lost' as const, compatibleSizeIds: null, layoutId: null } : applied(),
      ),
    );
    const gradeFiltered = seedInfiniteList({ ...BASE_SEARCH, minGrade: 17 }, []);
    const harness = createHarness({ writeEvents: writeEvents as never });

    harness.sync.handleEvent(makeEvent({ climbUuid: 'climb-locked' }));
    await settleWrites();
    expect(isInvalidated(gradeFiltered)).toBe(false);

    locked = false;
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_LOCK_BACKOFF_MS);
    harness.sync.handleEvent(makeEvent({ climbUuid: 'climb-later' }));
    await settleWrites();
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_TRAILING_MS);

    // The event held back by the lock is retried alongside the new one.
    expect(harness.writtenEvents().map((event) => event.climbUuid)).toEqual([
      'climb-locked',
      'climb-locked',
      'climb-later',
    ]);
    expect(isInvalidated(gradeFiltered)).toBe(true);
  });

  it('stands down after contention instead of re-driving on every event', async () => {
    // Without the backoff each arriving event pays a fresh pre-read pass, a new
    // native connection and the full 250 ms lock wait, all doomed.
    const writeEvents = vi.fn(allSettled('lock_lost'));
    const harness = createHarness({ writeEvents: writeEvents as never });

    harness.sync.handleEvent(makeEvent({ climbUuid: 'climb-1' }));
    await settleWrites();
    await vi.advanceTimersByTimeAsync(100);
    harness.sync.handleEvent(makeEvent({ climbUuid: 'climb-2' }));
    await settleWrites();

    // The second event joined the queue; it did not buy a second lock wait.
    expect(writeEvents).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(CLIMB_STATS_LOCK_BACKOFF_MS);

    expect(writeEvents).toHaveBeenCalledTimes(2);
    expect((writeEvents.mock.calls[1][1] as ClimbStatsWriteThroughInput[]).map((event) => event.climbUuid)).toEqual([
      'climb-1',
      'climb-2',
    ]);
  });

  it('arms no timer of its own when a flush lands during a background', async () => {
    // The ceiling used to re-arm itself here, which ticks forever while the app
    // sits in the background.
    const gradeFiltered = seedInfiniteList({ ...BASE_SEARCH, minGrade: 17 }, []);
    let backgrounded = false;
    const scheduled: number[] = [];
    const harness = createHarness({
      shouldSkipWrites: () => backgrounded,
      scheduleTask: (callback, delayMs) => {
        scheduled.push(delayMs);
        const timer = setTimeout(callback, delayMs);
        return () => clearTimeout(timer);
      },
    });

    harness.sync.handleEvent(makeEvent());
    await settleWrites();
    backgrounded = true;
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_TRAILING_MS);
    const scheduledByFlush = scheduled.length;
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_MAX_WAIT_MS * 5);

    expect(isInvalidated(gradeFiltered)).toBe(false);
    expect(scheduled).toHaveLength(scheduledByFlush);

    // The next event is the first moment the app can be foregrounded again.
    backgrounded = false;
    harness.sync.handleEvent(makeEvent({ climbUuid: 'climb-2' }));
    await settleWrites();
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_TRAILING_MS);

    expect(isInvalidated(gradeFiltered)).toBe(true);
    expect(harness.isScopeDownloaded).toHaveBeenCalledTimes(1);
  });

  it('re-arms a stranded batch even when the next event produces no write at all', async () => {
    // The batch is only saved by handleEvent's re-arm. The event that follows a
    // background is very often a republish of a revision already applied, which
    // is dropped before the queue — so nothing else would ever arm a timer and
    // the refresh would be stranded for the life of the process.
    const gradeFiltered = seedInfiniteList({ ...BASE_SEARCH, minGrade: 17 }, []);
    let backgrounded = false;
    const harness = createHarness({ shouldSkipWrites: () => backgrounded });

    harness.sync.handleEvent(makeEvent({ syncSeq: '500' }));
    await settleWrites();
    backgrounded = true;
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_MAX_WAIT_MS);
    expect(isInvalidated(gradeFiltered)).toBe(false);

    backgrounded = false;
    harness.sync.handleEvent(makeEvent({ syncSeq: '500' }));
    await settleWrites();
    // Dropped as already settled: no second write pass, so no armFlush.
    expect(harness.writeEvents).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_TRAILING_MS);

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
    harness.sync.handleEvent(makeEvent({ climbUuid: 'climb-2' }));
    await settleWrites();
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_INVALIDATE_TRAILING_MS);

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

  it('cancels a scheduled contention retry on dispose', async () => {
    const writeEvents = vi.fn(allSettled('lock_lost'));
    const harness = createHarness({ writeEvents: writeEvents as never });

    harness.sync.handleEvent(makeEvent());
    await settleWrites();
    harness.sync.dispose();
    await vi.advanceTimersByTimeAsync(CLIMB_STATS_LOCK_BACKOFF_MS * 3);

    expect(writeEvents).toHaveBeenCalledTimes(1);
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

describe('hasStatsDependentFilter', () => {
  it.each([
    ['minGrade', { minGrade: 17 }],
    ['maxGrade', { maxGrade: 22 }],
    ['minAscents', { minAscents: 5 }],
    ['minRating', { minRating: 3 }],
    ['gradeAccuracy', { gradeAccuracy: 'accurate' }],
    ['onlyBenchmarks', { onlyBenchmarks: true }],
    ['projectsOnly', { projectsOnly: true }],
  ])('is true for %s', (_label, filter) => {
    expect(hasStatsDependentFilter({ ...BASE_SEARCH, ...filter })).toBe(true);
  });

  it.each([
    ['no filters at all', {}],
    ['any stats sort, which is not a filter', { sortBy: 'ascents' }],
    ['the popular sort', { sortBy: 'popular' }],
    ['a name search', { name: 'crimpy' }],
    ['a setter filter', { setter: ['someone'] }],
    ['a hold filter', { holdsFilter: { 12: 'STARTING' } }],
    ['personal-progress filters', { hideCompleted: true, showOnlyAttempted: true }],
    ['a disabled benchmarks toggle', { onlyBenchmarks: false }],
  ])('is false for %s', (_label, filter) => {
    expect(hasStatsDependentFilter({ ...BASE_SEARCH, ...filter } as never)).toBe(false);
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

  it('treats an absent sortBy as the ascents default, not as sort-independent', () => {
    // `{}` is the default Climbs tab. It sorts on stats, so it must behave like
    // an explicit `ascents` — on-page only, and never cross-angle.
    const onPage = { pages: [{ searchClimbs: { climbs: [{ uuid: 'climb-1' }] } }], pageParams: [0] };
    const noSort = { ...BASE_SEARCH };
    const explicit = { ...BASE_SEARCH, sortBy: 'ascents' };
    const otherAngle = [flushed({ angle: 25 })];

    expect(canStreamChangeList('infiniteSearchClimbs', noSort, onPage, batch)).toBe(
      canStreamChangeList('infiniteSearchClimbs', explicit, onPage, batch),
    );
    expect(canStreamChangeList('infiniteSearchClimbs', noSort, onPage, otherAngle)).toBe(
      canStreamChangeList('infiniteSearchClimbs', explicit, onPage, otherAngle),
    );
    expect(canStreamChangeList('infiniteSearchClimbs', noSort, onPage, otherAngle)).toBe(false);
  });
});

describe('climbDetailMatchesBatch', () => {
  const batch = [flushed()];

  it('matches the uuid at the written angle only', () => {
    expect(climbDetailMatchesBatch({ ...BASE_SEARCH, climbUuid: 'climb-1' }, batch, DOWNLOADED)).toBe(true);
    expect(climbDetailMatchesBatch({ ...BASE_SEARCH, angle: 25, climbUuid: 'climb-1' }, batch, DOWNLOADED)).toBe(false);
    expect(climbDetailMatchesBatch({ ...BASE_SEARCH, climbUuid: 'climb-other' }, batch, DOWNLOADED)).toBe(false);
  });

  it('fails closed when the scope was never resolved as downloaded', () => {
    expect(climbDetailMatchesBatch({ ...BASE_SEARCH, climbUuid: 'climb-1' }, batch, new Map())).toBe(false);
    expect(
      climbDetailMatchesBatch({ ...BASE_SEARCH, climbUuid: 'climb-1' }, batch, new Map([['kilter:1:5', false]])),
    ).toBe(false);
  });

  it('accepts any downloaded scope of the board and layout when the key carries no size', () => {
    const noSize = { boardName: 'kilter', layoutId: 1, angle: 40, climbUuid: 'climb-1' };
    expect(climbDetailMatchesBatch(noSize, batch, DOWNLOADED)).toBe(true);
    expect(climbDetailMatchesBatch(noSize, batch, new Map([['kilter:8:5', true]]))).toBe(false);
  });

  it.each([
    ['a non-object key', 'not-an-input'],
    ['a key with no uuid', { ...BASE_SEARCH }],
  ])('returns false for %s', (_label, variables) => {
    expect(climbDetailMatchesBatch(variables, batch, DOWNLOADED)).toBe(false);
  });
});
