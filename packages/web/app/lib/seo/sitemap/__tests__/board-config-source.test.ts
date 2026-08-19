import { describe, expect, it, vi, beforeEach } from 'vite-plus/test';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';

vi.mock('server-only', () => ({}));

/** The Data Cache is a pass-through here; the layer under test is the merge. */
vi.mock('next/cache', () => ({ unstable_cache: (fn: (...args: never[]) => unknown) => fn }));

const KILTER_CONFIG: PopularBoardConfig = {
  boardType: 'kilter',
  layoutId: 1,
  layoutName: 'Kilter Board Original',
  sizeId: 10,
  sizeName: '12 x 12 with kickboard',
  sizeDescription: '12 x 12 Square',
  setIds: [1, 20],
  setNames: ['Bolt Ons', 'Screw Ons'],
  climbCount: 4200,
  totalAscents: 99,
  boardCount: 7,
  displayName: 'Kilter OG 12x12',
};

/**
 * Production's shape: `popularBoardConfigs` is driven by
 * `board_product_sizes_layouts_sets`, which carries no MoonBoard row, so the
 * listed configs never contain one. That is the premise this module exists for.
 */
const listed = vi.hoisted(() => ({ configs: [] as PopularBoardConfig[], calls: 0, throws: false }));
vi.mock('@/app/lib/server-popular-configs', () => ({
  getAllBoardConfigsOrThrow: async () => {
    listed.calls += 1;
    if (listed.throws) throw new Error('backend unreachable');
    return listed.configs;
  },
}));

/** Stands in for the grouped count query — one row per MoonBoard layout id. */
const climbCounts = vi.hoisted(() => ({
  rows: [] as { layoutId: number | null; climbCount: number }[],
  calls: 0,
  throws: false,
}));
vi.mock('@/app/lib/db/db', () => ({
  dbzRead: {
    select: () => ({
      from: () => ({
        where: () => ({
          groupBy: async () => {
            climbCounts.calls += 1;
            if (climbCounts.throws) throw new Error('read pool exhausted');
            return climbCounts.rows;
          },
        }),
      }),
    }),
  },
}));

const { buildMoonBoardClimbCountQuery, getSitemapBoardConfigsOrThrow, resetSitemapBoardConfigCacheForTests } =
  await import('../board-config-source');

/** Every MoonBoard layout id carrying a climb count, so all seven are synthesised. */
const ALL_LAYOUTS = [1, 2, 3, 4, 5, 6, 7].map((layoutId) => ({ layoutId, climbCount: 1_000 + layoutId }));

beforeEach(() => {
  resetSitemapBoardConfigCacheForTests();
  listed.configs = [KILTER_CONFIG];
  listed.calls = 0;
  listed.throws = false;
  climbCounts.rows = ALL_LAYOUTS;
  climbCounts.calls = 0;
  climbCounts.throws = false;
});

describe('getSitemapBoardConfigsOrThrow', () => {
  it('adds one MoonBoard config per layout, on top of the listed configs', async () => {
    const configs = await getSitemapBoardConfigsOrThrow();

    // The listed configs pass through untouched and stay first — a synthetic
    // source that reordered or displaced them would be a different, riskier
    // change than the additive one this is meant to be.
    expect(configs[0]).toEqual(KILTER_CONFIG);
    expect(configs.filter((config) => config.boardType === 'kilter')).toEqual([KILTER_CONFIG]);

    const moonboard = configs.filter((config) => config.boardType === 'moonboard');
    expect(moonboard).toHaveLength(7);

    // LITERAL tuples, not values re-derived by calling `getDefaultRenderBoard`
    // in the test — that would assert `f(x) === f(x)` and stay green if the
    // source started emitting a partial set list or the wrong size id.
    expect(moonboard.map(({ layoutId, sizeId, setIds }) => ({ layoutId, sizeId, setIds }))).toEqual([
      { layoutId: 1, sizeId: 1, setIds: [1] },
      { layoutId: 2, sizeId: 1, setIds: [2, 3, 4] },
      { layoutId: 3, sizeId: 1, setIds: [5, 6, 7, 8, 9, 10] },
      { layoutId: 4, sizeId: 1, setIds: [11, 12, 13, 14, 15, 16] },
      { layoutId: 5, sizeId: 1, setIds: [17, 18, 19, 20, 21, 22, 23] },
      { layoutId: 6, sizeId: 1, setIds: [24, 25, 26, 27] },
      { layoutId: 7, sizeId: 1, setIds: [28, 29, 30, 31] },
    ]);
  });

  it('carries the measured climb count, and the names both shards fall back to', async () => {
    const masters2017 = (await getSitemapBoardConfigsOrThrow()).find(
      (config) => config.boardType === 'moonboard' && config.layoutId === 4,
    );

    expect(masters2017?.climbCount).toBe(1_004);
    expect(masters2017?.layoutName).toBe('MoonBoard Masters 2017');
    expect(masters2017?.sizeName).toBe('Standard');
    expect(masters2017?.sizeDescription).toBe('11x18 Grid');
    expect(masters2017?.setNames).toEqual([
      'Hold Set A',
      'Hold Set B',
      'Hold Set C',
      'Original School Holds',
      'Screw-on Feet',
      'Wooden Holds',
    ]);
    // Zero physical boards is the truth, and it also keeps every synthetic
    // config last under `isBetterConfig`, so no Aurora group can be displaced.
    expect(masters2017?.boardCount).toBe(0);
  });

  it('drops a layout with no listed climbs rather than shipping a thin /list page', async () => {
    climbCounts.rows = [
      { layoutId: 2, climbCount: 59_019 },
      { layoutId: 4, climbCount: 0 },
    ];

    const moonboard = (await getSitemapBoardConfigsOrThrow()).filter((config) => config.boardType === 'moonboard');
    expect(moonboard.map((config) => config.layoutId)).toEqual([2]);
  });

  it('ignores a count row with no layout id', async () => {
    climbCounts.rows = [{ layoutId: null, climbCount: 12_345 }];

    const moonboard = (await getSitemapBoardConfigsOrThrow()).filter((config) => config.boardType === 'moonboard');
    expect(moonboard).toEqual([]);
  });

  it('runs the count query once across concurrent callers, then serves it from the TTL', async () => {
    // One cold `/sitemap.xml` reaches this from the boards shard and the climbs
    // summary at the same moment. `unstable_cache` does not deduplicate
    // concurrent misses, which is why the in-process single-flight is here.
    await Promise.all([
      getSitemapBoardConfigsOrThrow(),
      getSitemapBoardConfigsOrThrow(),
      getSitemapBoardConfigsOrThrow(),
    ]);
    expect(climbCounts.calls).toBe(1);

    await getSitemapBoardConfigsOrThrow();
    expect(climbCounts.calls).toBe(1);

    resetSitemapBoardConfigCacheForTests();
    await getSitemapBoardConfigsOrThrow();
    expect(climbCounts.calls).toBe(2);
  });

  it('does not memoise a failed count, so a transient DB error is not an hour of missing MoonBoard', async () => {
    // The in-process layer stores nothing on a rejection: `cachedCounts` is only
    // assigned inside the `.then`. Without that, one unlucky read would pin an
    // empty MoonBoard catalogue for the whole TTL and the sitemap would quietly
    // lose 44k URLs while answering 200.
    climbCounts.throws = true;
    await expect(getSitemapBoardConfigsOrThrow()).rejects.toThrow('read pool exhausted');
    expect(climbCounts.calls).toBe(1);

    climbCounts.throws = false;
    const moonboard = (await getSitemapBoardConfigsOrThrow()).filter((config) => config.boardType === 'moonboard');
    expect(moonboard).toHaveLength(7);
    expect(climbCounts.calls).toBe(2);
  });

  it('shares one rejection across concurrent callers, then lets the next one retry', async () => {
    climbCounts.throws = true;
    const inFlight = [
      getSitemapBoardConfigsOrThrow(),
      getSitemapBoardConfigsOrThrow(),
      getSitemapBoardConfigsOrThrow(),
    ];
    await Promise.all(inFlight.map((pending) => expect(pending).rejects.toThrow('read pool exhausted')));
    expect(climbCounts.calls).toBe(1);

    climbCounts.throws = false;
    await getSitemapBoardConfigsOrThrow();
    expect(climbCounts.calls).toBe(2);
  });

  it('propagates a listed-config failure instead of publishing a MoonBoard-only sitemap', async () => {
    // A sitemap that quietly loses its Aurora URLs tells Google those pages were
    // deleted. The shard route turns this throw into a 503.
    listed.throws = true;

    await expect(getSitemapBoardConfigsOrThrow()).rejects.toThrow('backend unreachable');
  });
});

/**
 * The stub above returns fixed rows, so it cannot say anything about the
 * predicate. This renders the SQL drizzle actually produces instead of
 * restating the WHERE clause the test hopes is there — a rebuilt predicate in a
 * stub is a tautology.
 */
describe('the MoonBoard climb-count query', () => {
  // A drizzle instance with no client behind it: building and rendering a query
  // never touches a connection.
  const { sql, params } = buildMoonBoardClimbCountQuery(drizzle({} as never) as never).toSQL();
  const normalised = sql.toLowerCase().replace(/\s+/g, ' ');

  it('counts only listed, non-draft MoonBoard climbs, grouped by layout', () => {
    expect(normalised).toMatch(/"board_climbs"\."board_type" = \$\d+/);
    expect(params).toContain('moonboard');
    expect(normalised).toMatch(/"board_climbs"\."is_listed" = \$\d+/);
    expect(normalised).toMatch(/"board_climbs"\."is_draft" = \$\d+/);
    expect(params).toContain(true);
    expect(params).toContain(false);
    expect(normalised).toContain('group by "board_climbs"."layout_id"');
  });

  it('is the cheap grouped count, not the tier-2 DISTINCT ON scan', () => {
    // The whole reason this query exists separately: both shards read the number
    // only as a `> 0` gate, so it must not carry the climbs shard's cost.
    expect(normalised).not.toContain('distinct on');
    expect(normalised).not.toContain('board_climb_stats');
    expect(normalised).toContain('count(*)');
  });
});
