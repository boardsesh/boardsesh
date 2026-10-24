import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Climb, ClimbSearchInput, UserBoard } from '@boardsesh/shared-schema';
import { DEFAULT_WORKOUT_FILTERS } from '../workout-blocks';
import type { PreviewFetchContext, PreviewFilters } from '../workout-preview-pool';

vi.mock('expo-crypto', () => ({ randomUUID: () => 'qi-0' }));
vi.mock('../../../../lib/graphql/offline-request', () => ({ offlineAwareRequest: vi.fn() }));

import { offlineAwareRequest } from '../../../../lib/graphql/offline-request';
import { buildClimbSearchInput, fetchGradePool } from '../select-climbs-for-plan';

// Benchmarks only on a server from before the NaN fix (#6232): Kilter's
// onlyBenchmarks also returns many climbs that are not benchmarks, most of
// them little repeated and some highly rated. QA on Kilter V4 at 40 degrees saw
// the block find 10 benchmarks at 100+ ascents, 5 at 5+ and none at 1+.

const offlineAwareRequestMock = vi.mocked(offlineAwareRequest);
const board = { boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 } as UserBoard;
const benchmarksOnly = (filters: Partial<PreviewFilters> = {}): PreviewFetchContext => ({
  board,
  isAuthenticated: true,
  filters: { ...DEFAULT_WORKOUT_FILTERS, onlyBenchmarks: true, ...filters },
});

type CatalogueClimb = { uuid: string; ascents: number; quality: number; benchmark: boolean };

/** A deterministic catalogue: 12 benchmarks among 600 climbs the leaky filter also returns. */
function leakyCatalogue(): CatalogueClimb[] {
  let seed = 7;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const leaked = Array.from({ length: 600 }, (_, index) => ({
    uuid: `leak-${index}`,
    // Most under 100 ascents, about 40 above 1,000.
    ascents: Math.floor(next() ** 6 * 1500),
    quality: 2 + next() * 3,
    benchmark: false,
  }));
  const benchmarks = Array.from({ length: 12 }, (_, index) => ({
    uuid: `bench-${index}`,
    ascents: 1000 + Math.floor(next() * 3000),
    quality: 2 + next() * 2,
    benchmark: true,
  }));
  return [...leaked, ...benchmarks];
}

/** SEARCH_CLIMBS over the catalogue: min ascents and rating, the leaky onlyBenchmarks, the sort, the page. */
function serve(catalogue: readonly CatalogueClimb[]) {
  offlineAwareRequestMock.mockImplementation(async (_query, variables) => {
    const { input } = variables as { input: ClimbSearchInput };
    const sortKey = input.sortBy === 'ascents' ? 'ascents' : 'quality';
    const matching = catalogue
      .filter((climb) => climb.ascents >= (input.minAscents ?? 0) && climb.quality >= (input.minRating ?? 0))
      .sort((first, second) => second[sortKey] - first[sortKey] || first.uuid.localeCompare(second.uuid));
    const page = input.page ?? 0;
    const pageSize = input.pageSize ?? 20;
    const pageClimbs = matching.slice(page * pageSize, (page + 1) * pageSize).map(
      ({ uuid, benchmark }) =>
        // The leaked rows map to no benchmark difficulty, as NaN does on the server.
        ({ uuid, name: uuid, benchmark_difficulty: benchmark ? '20' : null }) as Climb,
    );
    return { searchClimbs: { climbs: pageClimbs, hasMore: (page + 1) * pageSize < matching.length } };
  });
}

beforeEach(() => {
  offlineAwareRequestMock.mockReset();
});

describe('Benchmarks only request', () => {
  it('reads by ascents with the switch on, and is the recorded request with it off', () => {
    expect(buildClimbSearchInput(20, benchmarksOnly())).toMatchObject({ sortBy: 'ascents', onlyBenchmarks: true });
    const off = buildClimbSearchInput(20, { board, isAuthenticated: true, filters: DEFAULT_WORKOUT_FILTERS });
    expect(off.sortBy).toBe('quality');
    expect(off).not.toHaveProperty('onlyBenchmarks');
  });
});

describe('Benchmarks only pool as Min ascents loosens', () => {
  const MIN_ASCENTS_STRICT_TO_LOOSE = [100, 50, 20, 10, 5, 1, 0];

  it('never shrinks: every benchmark a stricter floor found, a looser one finds too', async () => {
    serve(leakyCatalogue());
    const found: Array<Set<string>> = [];
    for (const minAscents of MIN_ASCENTS_STRICT_TO_LOOSE) {
      const pool = await fetchGradePool(20, benchmarksOnly({ minAscents }), 20);
      expect(pool.climbs.every((climb) => climb.uuid.startsWith('bench'))).toBe(true);
      found.push(new Set(pool.climbs.map((climb) => climb.uuid)));
    }
    for (let index = 1; index < found.length; index++) {
      expect([...found[index - 1]].every((uuid) => found[index].has(uuid))).toBe(true);
    }
    // The most repeated climbs come first, and that is where benchmarks sit.
    expect(found.at(-1)?.size).toBe(12);
  });

  it('costs no more requests than a grade the leak did not touch', async () => {
    serve(leakyCatalogue());

    await fetchGradePool(20, benchmarksOnly({ minAscents: 1 }), 20);

    // Up to three pages per tier, three tiers: the bound it always had.
    expect(offlineAwareRequestMock.mock.calls.length).toBeLessThanOrEqual(9);
  });
});
