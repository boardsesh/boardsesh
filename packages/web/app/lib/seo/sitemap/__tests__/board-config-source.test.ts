import { describe, expect, it, vi, beforeEach } from 'vite-plus/test';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';
import { MOONBOARD_LAYOUTS } from '@/app/lib/moonboard-config';

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
  /** A read that never comes back — the mode the pool's 30 s connect timeout and the absent statement_timeout leave unbounded. */
  stalls: false,
}));
vi.mock('@/app/lib/db/db', () => ({
  dbzRead: {
    select: () => ({
      from: () => ({
        where: () => ({
          groupBy: async () => {
            climbCounts.calls += 1;
            if (climbCounts.throws) throw new Error('read pool exhausted');
            if (climbCounts.stalls) return new Promise(() => {});
            return climbCounts.rows;
          },
        }),
      }),
    }),
  },
}));

const {
  buildMoonBoardClimbCountQuery,
  getBoardsShardConfigsOrThrow,
  getSitemapClimbConfigsOrThrow,
  resetSitemapBoardConfigCacheForTests,
} = await import('../board-config-source');

/**
 * Every MoonBoard layout id carrying a climb count, so all seven are synthesised.
 *
 * Derived from the catalogue, not a hardcoded `[1..7]`: with a literal list a new
 * `MOONBOARD_LAYOUTS` entry gets no count row, `climbCount` resolves to 0, and
 * `buildMoonBoardConfigs` drops it before `toHaveLength(7)` or the literal tuple
 * list below can see it — so this file stayed green on a half-done catalogue edit
 * that the source comment claims it catches. The EXPECTATIONS stay literal; only
 * the input is derived.
 */
const ALL_LAYOUTS = Object.values(MOONBOARD_LAYOUTS).map(({ id }) => ({
  layoutId: id,
  climbCount: 1_000 + id,
}));

beforeEach(() => {
  resetSitemapBoardConfigCacheForTests();
  listed.configs = [KILTER_CONFIG];
  listed.calls = 0;
  listed.throws = false;
  climbCounts.rows = ALL_LAYOUTS;
  climbCounts.calls = 0;
  climbCounts.throws = false;
  climbCounts.stalls = false;
});

describe('getSitemapClimbConfigsOrThrow', () => {
  it('adds one MoonBoard config per layout, on top of the listed configs', async () => {
    const configs = await getSitemapClimbConfigsOrThrow();

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
    const masters2017 = (await getSitemapClimbConfigsOrThrow()).find(
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

    const moonboard = (await getSitemapClimbConfigsOrThrow()).filter((config) => config.boardType === 'moonboard');
    expect(moonboard.map((config) => config.layoutId)).toEqual([2]);
  });

  it('ignores a count row with no layout id', async () => {
    climbCounts.rows = [{ layoutId: null, climbCount: 12_345 }];

    const moonboard = (await getSitemapClimbConfigsOrThrow()).filter((config) => config.boardType === 'moonboard');
    expect(moonboard).toEqual([]);
  });

  it('runs the count query once across concurrent callers, then serves it from the TTL', async () => {
    // One cold `/sitemap.xml` reaches this from the boards shard and the climbs
    // summary at the same moment. `unstable_cache` does not deduplicate
    // concurrent misses, which is why the in-process single-flight is here.
    await Promise.all([
      getSitemapClimbConfigsOrThrow(),
      getSitemapClimbConfigsOrThrow(),
      getSitemapClimbConfigsOrThrow(),
    ]);
    expect(climbCounts.calls).toBe(1);
    // Exactly one listed-config call per request — the `Promise.all` leg — with
    // deduplication delegated to `getAllBoardConfigsOrThrow`'s own in-process
    // single-flight (which the mock deliberately does not reimplement, or this
    // would be asserting the mock). Three requests, three legs: replacing the
    // `Promise.all` with two sequential `getAllBoardConfigsOrThrow()` calls
    // doubles this to six. Left unasserted, the counter implied coverage the
    // file did not have.
    expect(listed.calls).toBe(3);

    await getSitemapClimbConfigsOrThrow();
    expect(climbCounts.calls).toBe(1);

    resetSitemapBoardConfigCacheForTests();
    await getSitemapClimbConfigsOrThrow();
    expect(climbCounts.calls).toBe(2);
  });

  it('does not memoise a failed count, so a transient DB error is not an hour of missing MoonBoard', async () => {
    // The in-process layer stores nothing on a rejection: `cachedCounts` is only
    // assigned inside the `.then`. Without that, one unlucky read would pin an
    // empty MoonBoard catalogue for the whole TTL and the sitemap would quietly
    // lose 44k URLs while answering 200.
    climbCounts.throws = true;
    await expect(getSitemapClimbConfigsOrThrow()).rejects.toThrow('read pool exhausted');
    expect(climbCounts.calls).toBe(1);

    climbCounts.throws = false;
    const moonboard = (await getSitemapClimbConfigsOrThrow()).filter((config) => config.boardType === 'moonboard');
    expect(moonboard).toHaveLength(7);
    expect(climbCounts.calls).toBe(2);
  });

  it('shares one rejection across concurrent callers, then lets the next one retry', async () => {
    climbCounts.throws = true;
    const inFlight = [
      getSitemapClimbConfigsOrThrow(),
      getSitemapClimbConfigsOrThrow(),
      getSitemapClimbConfigsOrThrow(),
    ];
    await Promise.all(inFlight.map((pending) => expect(pending).rejects.toThrow('read pool exhausted')));
    expect(climbCounts.calls).toBe(1);

    climbCounts.throws = false;
    await getSitemapClimbConfigsOrThrow();
    expect(climbCounts.calls).toBe(2);
  });

  it('propagates a listed-config failure instead of publishing a MoonBoard-only sitemap', async () => {
    // A sitemap that quietly loses its Aurora URLs tells Google those pages were
    // deleted. The shard route turns this throw into a 503.
    listed.throws = true;

    await expect(getSitemapClimbConfigsOrThrow()).rejects.toThrow('backend unreachable');
  });
});

describe('the count query is bounded', () => {
  it('gives up on a stalled read instead of holding the shard open', async () => {
    // Nothing else bounds this. `dbzRead`'s pool sets `connect_timeout: 30` and
    // leaves `statement_timeout` off by default, so before this the only limit
    // was the platform's — and the single-flight made every later caller join
    // the stall rather than retry.
    climbCounts.stalls = true;
    vi.useFakeTimers();
    try {
      const pending = getSitemapClimbConfigsOrThrow();
      const asserted = expect(pending).rejects.toThrow('exceeded its 10000ms budget');
      await vi.advanceTimersByTimeAsync(10_000);
      await asserted;
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets the boards shard through on a stalled read', async () => {
    climbCounts.stalls = true;
    vi.useFakeTimers();
    try {
      const pending = getBoardsShardConfigsOrThrow();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await pending).toEqual([KILTER_CONFIG]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('getBoardsShardConfigsOrThrow', () => {
  it('serves the listed configs when the MoonBoard count fails, rather than 503ing the whole shard', async () => {
    // The lopsided trade this exists for: on the dev image MoonBoard contributes
    // 8 of `/sitemaps/boards.xml`'s 668 items and the listed configs contribute
    // 660. Before this module, no database failure could reach that shard at all.
    climbCounts.throws = true;

    const configs = await getBoardsShardConfigsOrThrow();

    expect(configs).toEqual([KILTER_CONFIG]);
  });

  it('still throws when the listed configs fail', async () => {
    listed.throws = true;

    await expect(getBoardsShardConfigsOrThrow()).rejects.toThrow('backend unreachable');
  });

  it('carries the MoonBoard configs when the count succeeds', async () => {
    const moonboard = (await getBoardsShardConfigsOrThrow()).filter((config) => config.boardType === 'moonboard');

    expect(moonboard).toHaveLength(7);
  });

  it('does not swallow a MoonBoard failure for the climbs shard', async () => {
    // Same module, opposite policy — the climbs shard resolves its groups twice
    // per crawl and `pagedShardRouteHandler` throws "cache epochs disagree" if
    // those two disagree, so a tolerated failure there is worse than a 503.
    climbCounts.throws = true;

    await expect(getSitemapClimbConfigsOrThrow()).rejects.toThrow('read pool exhausted');
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
    expect(normalised).toMatch(/"board_climbs"\."board_type" = \$\d+ and "board_climbs"\."is_listed" = \$\d+/);
    expect(normalised).toMatch(/"board_climbs"\."is_listed" = \$\d+ and "board_climbs"\."is_draft" = \$\d+/);
    // POSITIONAL, not `toContain` three times. Drizzle renders the predicate as
    // `board_type = $1 and is_listed = $2 and is_draft = $3`, so swapping the two
    // booleans leaves the SQL text identical and a position-blind assertion still
    // green — while the query counts drafted, unlisted MoonBoard climbs, of which
    // the dev image has zero. `fetchMoonBoardClimbCounts` would return an empty
    // Map, all seven layouts would be dropped, and both shards would ship exactly
    // what they ship today with `expectsUrls` never firing, because Kilter and
    // Tension keep them non-empty.
    expect(params).toEqual(['moonboard', true, false]);
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
