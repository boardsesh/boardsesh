import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Climb, ClimbSearchInput, UserBoard } from '@boardsesh/shared-schema';
import { DEFAULT_WORKOUT_FILTERS } from '../workout-blocks';
import type { PreviewFetchContext, PreviewFilters } from '../workout-preview-pool';

// Keep expo-crypto (pulled in via workout-preview-pool → climb-to-queue-item)
// out of the node test environment.
vi.mock('expo-crypto', () => ({ randomUUID: () => 'qi-0' }));
vi.mock('../../../../lib/graphql/offline-request', () => ({ offlineAwareRequest: vi.fn() }));

import { offlineAwareRequest } from '../../../../lib/graphql/offline-request';
import { buildClimbSearchInput, fetchGradePool, searchTiers } from '../select-climbs-for-plan';

const offlineAwareRequestMock = vi.mocked(offlineAwareRequest);

const board = { boardType: 'tension', layoutId: 10, sizeId: 6, setIds: '12,13', angle: 40 } as UserBoard;
const signedIn = (filters: PreviewFilters = DEFAULT_WORKOUT_FILTERS): PreviewFetchContext => ({
  board,
  isAuthenticated: true,
  filters,
});
const signedOut = (filters: PreviewFilters = DEFAULT_WORKOUT_FILTERS): PreviewFetchContext => ({
  board,
  isAuthenticated: false,
  filters,
});

/** One climb of a fake catalogue, with the climber's history at this angle. */
type CatalogueClimb = { uuid: string; tried?: boolean; sent?: boolean; benchmark?: boolean };

const climbs = (prefix: string, count: number, history: Omit<CatalogueClimb, 'uuid'> = {}): CatalogueClimb[] =>
  Array.from({ length: count }, (_, index) => ({ uuid: `${prefix}-${index}`, ...history }));

/**
 * A grade served like SEARCH_CLIMBS: the personal flags read the history above
 * (hideAttempted drops a tried climb, hideCompleted a sent one, showOnlyAttempted
 * keeps only tried ones), onlyBenchmarks keeps benchmarks, and pages are cut in
 * catalogue order, which stands in for the quality sort.
 */
function serveCatalogue(catalogue: readonly CatalogueClimb[]) {
  offlineAwareRequestMock.mockImplementation(async (_query, variables) => {
    const { input } = variables as { input: ClimbSearchInput };
    const matching = catalogue.filter(
      (climb) =>
        !(input.hideAttempted && climb.tried) &&
        !(input.hideCompleted && climb.sent) &&
        !(input.showOnlyAttempted && !climb.tried) &&
        !(input.onlyBenchmarks && !climb.benchmark),
    );
    const page = input.page ?? 0;
    const pageSize = input.pageSize ?? 20;
    const pageClimbs = matching
      .slice(page * pageSize, (page + 1) * pageSize)
      .map(({ uuid }) => ({ uuid, name: uuid }) as Climb);
    return { searchClimbs: { climbs: pageClimbs, hasMore: (page + 1) * pageSize < matching.length } };
  });
}

/** The personal and benchmark flags of every request, in order. */
function requestedFlags() {
  return offlineAwareRequestMock.mock.calls.map(([, variables]) => {
    const { input } = variables as { input: ClimbSearchInput };
    const flags: Record<string, true> = {};
    for (const flag of ['hideAttempted', 'hideCompleted', 'showOnlyAttempted', 'onlyBenchmarks'] as const) {
      if (input[flag]) flags[flag] = true;
    }
    return flags;
  });
}

beforeEach(() => {
  offlineAwareRequestMock.mockReset();
});

describe('searchTiers', () => {
  it('puts never-tried, then tried, then sent climbs in order for the default Unfamiliar', () => {
    expect(searchTiers(DEFAULT_WORKOUT_FILTERS, true)).toEqual([
      { hideAttempted: true, hideCompleted: true },
      { hideCompleted: true },
      {},
    ]);
  });

  it('prefers climbs you have not sent for Attempted and Any too', () => {
    expect(searchTiers({ ...DEFAULT_WORKOUT_FILTERS, climbBias: 'attempted' }, true)).toEqual([
      { showOnlyAttempted: true, hideCompleted: true },
      { showOnlyAttempted: true },
    ]);
    expect(searchTiers({ ...DEFAULT_WORKOUT_FILTERS, climbBias: 'any' }, true)).toEqual([{ hideCompleted: true }, {}]);
  });

  it('keeps only the tiers that hide sent climbs when Skip what I have sent is on', () => {
    const skip = { ...DEFAULT_WORKOUT_FILTERS, skipSent: true };
    expect(searchTiers(skip, true)).toEqual([{ hideAttempted: true, hideCompleted: true }, { hideCompleted: true }]);
    expect(searchTiers({ ...skip, climbBias: 'attempted' }, true)).toEqual([
      { showOnlyAttempted: true, hideCompleted: true },
    ]);
    expect(searchTiers({ ...skip, climbBias: 'any' }, true)).toEqual([{ hideCompleted: true }]);
    for (const climbBias of ['unfamiliar', 'attempted', 'any'] as const) {
      expect(searchTiers({ ...skip, climbBias }, true).every((tier) => tier.hideCompleted)).toBe(true);
    }
  });

  it('is a single tier with no personal flags signed out or unfiltered', () => {
    expect(searchTiers({ ...DEFAULT_WORKOUT_FILTERS, skipSent: true }, false)).toEqual([{}]);
    expect(searchTiers(undefined, true)).toEqual([{}]);
  });
});

describe('buildClimbSearchInput', () => {
  it('sends the recorded screenshot request for the default filters, key for key', () => {
    // The pinned SearchClimbs fixture's variables; any added key misses on replay.
    expect(buildClimbSearchInput(15, signedIn())).toStrictEqual({
      boardName: 'tension',
      layoutId: 10,
      sizeId: 6,
      setIds: '12,13',
      angle: 40,
      minGrade: 15,
      maxGrade: 15,
      gradeAccuracy: 'moderate',
      pageSize: 50,
      page: 0,
      sortBy: 'quality',
      sortOrder: 'desc',
      minAscents: 5,
      minRating: 2,
      hideAttempted: true,
      hideCompleted: true,
    });
  });

  it('adds onlyBenchmarks only when it is on', () => {
    expect(buildClimbSearchInput(15, signedIn())).not.toHaveProperty('onlyBenchmarks');
    expect(
      buildClimbSearchInput(15, signedIn({ ...DEFAULT_WORKOUT_FILTERS, onlyBenchmarks: false })),
    ).not.toHaveProperty('onlyBenchmarks');
    expect(buildClimbSearchInput(15, signedIn({ ...DEFAULT_WORKOUT_FILTERS, onlyBenchmarks: true }))).toMatchObject({
      onlyBenchmarks: true,
    });
    // Benchmarks need no account.
    expect(buildClimbSearchInput(15, signedOut({ ...DEFAULT_WORKOUT_FILTERS, onlyBenchmarks: true }))).toMatchObject({
      onlyBenchmarks: true,
    });
  });

  it('sends the tier it is given, and never a personal flag signed out', () => {
    expect(buildClimbSearchInput(15, signedIn(), 0, 50, { hideCompleted: true })).toMatchObject({
      hideCompleted: true,
    });
    expect(buildClimbSearchInput(15, signedIn(), 0, 50, { hideCompleted: true })).not.toHaveProperty('hideAttempted');
    const anonymous = buildClimbSearchInput(15, signedOut({ ...DEFAULT_WORKOUT_FILTERS, skipSent: true }), 0, 50, {
      hideCompleted: true,
    });
    expect(anonymous).not.toHaveProperty('hideCompleted');
    expect(anonymous).not.toHaveProperty('hideAttempted');
  });

  it('keeps an unrated-climbs-friendly floor: minRating 0 is sent as 0, not dropped', () => {
    // The server lets a climb with no rating through only a 0 floor.
    expect(buildClimbSearchInput(15, signedIn({ ...DEFAULT_WORKOUT_FILTERS, minRating: 0 }))).toMatchObject({
      minRating: 0,
    });
  });
});

describe('fetchGradePool tiers', () => {
  it('asks once when the first tier fills the pool, as before the tiers existed', async () => {
    serveCatalogue([...climbs('fresh', 80), ...climbs('sent', 40, { sent: true })]);

    const pool = await fetchGradePool(15, signedIn(), 20);

    expect(offlineAwareRequestMock).toHaveBeenCalledTimes(1);
    expect(offlineAwareRequestMock.mock.calls[0][1]).toEqual({ input: buildClimbSearchInput(15, signedIn()) });
    expect(pool.climbs).toHaveLength(50);
    expect(pool.topUpTiers.size).toBe(0);
  });

  it('tops a short grade up with tried, then sent climbs, and names each top-up', async () => {
    serveCatalogue([
      ...climbs('sent', 30, { tried: true, sent: true }),
      ...climbs('fresh', 10),
      ...climbs('project', 5, { tried: true }),
    ]);

    const pool = await fetchGradePool(15, signedIn(), 20);

    expect(requestedFlags()).toEqual([{ hideAttempted: true, hideCompleted: true }, { hideCompleted: true }, {}]);
    // 50 wanted: every unsent climb first, then sent ones up to the target.
    expect(pool.climbs).toHaveLength(45);
    expect(pool.climbs.slice(0, 10).every((climb) => climb.uuid.startsWith('fresh'))).toBe(true);
    expect(pool.climbs.slice(10, 15).every((climb) => climb.uuid.startsWith('project'))).toBe(true);
    expect(pool.climbs.slice(15).every((climb) => climb.uuid.startsWith('sent'))).toBe(true);
    expect(pool.topUpTiers.get('fresh-0')).toBeUndefined();
    expect(pool.topUpTiers.get('project-0')).toBe(1);
    expect(pool.topUpTiers.get('sent-0')).toBe(2);
    expect(new Set(pool.climbs.map((climb) => climb.uuid)).size).toBe(45);
  });

  it('stops reading tiers as soon as the pool is full', async () => {
    serveCatalogue([
      ...climbs('fresh', 20),
      ...climbs('project', 60, { tried: true }),
      ...climbs('sent', 50, { sent: true }),
    ]);

    const pool = await fetchGradePool(15, signedIn(), 20);

    // The second tier fills it; the sent climbs are never asked for.
    expect(requestedFlags()).toEqual([{ hideAttempted: true, hideCompleted: true }, { hideCompleted: true }]);
    expect(pool.climbs).toHaveLength(50);
    expect(pool.climbs.some((climb) => climb.uuid.startsWith('sent'))).toBe(false);
  });

  it('fills from sent climbs when every climb at the grade is sent', async () => {
    serveCatalogue(climbs('sent', 60, { tried: true, sent: true }));

    const pool = await fetchGradePool(15, signedIn(), 20);

    expect(pool.climbs).toHaveLength(50);
    expect([...pool.topUpTiers.values()].every((tier) => tier === 2)).toBe(true);
  });

  it('comes back short rather than with a sent climb when Skip what I have sent is on', async () => {
    serveCatalogue([...climbs('fresh', 3), ...climbs('sent', 60, { sent: true })]);

    const pool = await fetchGradePool(15, signedIn({ ...DEFAULT_WORKOUT_FILTERS, skipSent: true }), 20);

    expect(requestedFlags().every((flags) => flags.hideCompleted)).toBe(true);
    expect(pool.climbs.map((climb) => climb.uuid)).toEqual(['fresh-0', 'fresh-1', 'fresh-2']);
  });

  it('comes back empty when everything is sent and Skip what I have sent is on', async () => {
    serveCatalogue(climbs('sent', 60, { sent: true }));

    const pool = await fetchGradePool(15, signedIn({ ...DEFAULT_WORKOUT_FILTERS, skipSent: true }), 20);

    expect(pool.climbs).toEqual([]);
  });

  it('keeps Benchmarks only on every tier, so a board without benchmarks comes back empty', async () => {
    serveCatalogue([...climbs('fresh', 80), ...climbs('sent', 40, { sent: true })]);

    const pool = await fetchGradePool(15, signedIn({ ...DEFAULT_WORKOUT_FILTERS, onlyBenchmarks: true }), 20);

    expect(requestedFlags()).toHaveLength(3);
    expect(requestedFlags().every((flags) => flags.onlyBenchmarks)).toBe(true);
    expect(pool.climbs).toEqual([]);
  });

  it('fills a sparse grade with what it has', async () => {
    serveCatalogue([...climbs('fresh', 2), ...climbs('sent', 1, { sent: true })]);

    const pool = await fetchGradePool(15, signedIn(), 20);

    expect(pool.climbs.map((climb) => climb.uuid)).toEqual(['fresh-0', 'fresh-1', 'sent-0']);
  });

  it('reads one tier with no personal flags signed out', async () => {
    serveCatalogue([...climbs('fresh', 3), ...climbs('sent', 3, { sent: true })]);

    const pool = await fetchGradePool(15, signedOut({ ...DEFAULT_WORKOUT_FILTERS, skipSent: true }), 20);

    expect(requestedFlags()).toEqual([{}]);
    expect(pool.climbs).toHaveLength(6);
    expect(pool.topUpTiers.size).toBe(0);
  });

  it('keeps what the first tier found when a top-up tier fails', async () => {
    offlineAwareRequestMock
      .mockResolvedValueOnce({ searchClimbs: { climbs: [{ uuid: 'fresh-0' } as Climb], hasMore: false } })
      .mockRejectedValueOnce(new Error('rate limited'));

    const pool = await fetchGradePool(15, signedIn(), 20);

    expect(pool.climbs.map((climb) => climb.uuid)).toEqual(['fresh-0']);
    expect(offlineAwareRequestMock).toHaveBeenCalledTimes(2);
  });

  it('fails when the first tier fails', async () => {
    offlineAwareRequestMock.mockRejectedValueOnce(new Error('offline'));

    await expect(fetchGradePool(15, signedIn(), 20)).rejects.toThrow('offline');
  });
});
