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

/** Stands in for the listed-layout gate — one row per MoonBoard layout id with a listed climb. */
const climbCounts = vi.hoisted(() => ({
  rows: [] as { layoutId: number }[],
  calls: 0,
  throws: false,
  /** A read that never comes back — the mode the pool's 30 s connect timeout and the absent statement_timeout leave unbounded. */
  stalls: false,
}));
vi.mock('@/app/lib/db/db', () => ({
  dbzRead: {
    select: () => ({
      from: () => ({
        // Thenable rather than async: the gate builds its inner EXISTS subquery
        // on the same `db`, and only the outer query is ever awaited, so only an
        // await counts as a read.
        where: () => ({
          then: (onFulfilled: (rows: { layoutId: number }[]) => unknown, onRejected: (error: unknown) => unknown) => {
            climbCounts.calls += 1;
            if (climbCounts.throws)
              return Promise.reject(new Error('read pool exhausted')).then(onFulfilled, onRejected);
            if (climbCounts.stalls) return new Promise(() => {});
            return Promise.resolve(climbCounts.rows).then(onFulfilled, onRejected);
          },
        }),
      }),
    }),
  },
}));

/**
 * The public spray walls (SW-16, #5449), stubbed so this file keeps testing the
 * MERGE rather than the wall query — `spray-wall-sitemap.test.ts` renders that
 * query's real SQL. Stubbing it is also what keeps the `dbzRead` stand-in above
 * honest: it answers exactly the MoonBoard grouped count and nothing else.
 */
const sprayWalls = vi.hoisted(() => ({
  configs: [] as (PopularBoardConfig & { sprayWallSlug: string })[],
  calls: 0,
  throws: false,
}));
vi.mock('../spray-wall-configs', () => ({
  getPublicSprayWallConfigs: async () => {
    sprayWalls.calls += 1;
    if (sprayWalls.throws) throw new Error('spray wall read failed');
    return sprayWalls.configs;
  },
}));

const PUBLIC_SPRAY_WALL: PopularBoardConfig & { sprayWallSlug: string } = {
  boardType: 'spray',
  layoutId: 900,
  layoutName: "Marco's garage",
  sizeId: 900,
  sizeName: "Marco's garage",
  sizeDescription: "Marco's garage",
  setIds: [1],
  setNames: ['Holds'],
  climbCount: 42,
  totalAscents: 0,
  boardCount: 1,
  displayName: "Marco's garage",
  sprayWallSlug: 'marcos-garage',
};

const {
  buildMoonBoardListedLayoutsQuery,
  getBoardsShardConfigsOrThrow,
  getSitemapClimbConfigsOrThrow,
  resetSitemapBoardConfigCacheForTests,
} = await import('../board-config-source');

/**
 * Every MoonBoard layout id with a listed climb, so all seven are synthesised.
 *
 * Derived from the catalogue, not a hardcoded `[1..7]`: with a literal list a new
 * `MOONBOARD_LAYOUTS` entry gets no gate row, and `buildMoonBoardConfigs` drops it before `toHaveLength(7)` or the literal tuple
 * list below can see it — so this file stayed green on a half-done catalogue edit
 * that the source comment claims it catches. The EXPECTATIONS stay literal; only
 * the input is derived.
 */
const ALL_LAYOUTS = Object.values(MOONBOARD_LAYOUTS).map(({ id }) => ({ layoutId: id }));

beforeEach(() => {
  resetSitemapBoardConfigCacheForTests();
  listed.configs = [KILTER_CONFIG];
  listed.calls = 0;
  listed.throws = false;
  climbCounts.rows = ALL_LAYOUTS;
  climbCounts.calls = 0;
  climbCounts.throws = false;
  climbCounts.stalls = false;
  sprayWalls.configs = [];
  sprayWalls.calls = 0;
  sprayWalls.throws = false;
});

describe('getSitemapClimbConfigsOrThrow', () => {
  it('adds one MoonBoard config per layout, on top of the listed configs', async () => {
    const configs = await getSitemapClimbConfigsOrThrow();

    // The listed configs pass through untouched and are still at the front of
    // THIS array: the synthetics are appended, never spliced in or substituted.
    // Array position is not shard position — `resolveClimbSitemapGroups` sorts
    // by board type downstream and does interleave MoonBoard (see
    // `moonboard-reaches-the-store.test.ts`) — so what this pins is that no
    // listed config was rewritten or dropped on the way through.
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

  it('carries a presence flag as its climb count, and the names both shards fall back to', async () => {
    const masters2017 = (await getSitemapClimbConfigsOrThrow()).find(
      (config) => config.boardType === 'moonboard' && config.layoutId === 4,
    );

    // Both shards read `climbCount` only as a `> 0` gate, so the gate query
    // returns presence, not a count.
    expect(masters2017?.climbCount).toBe(1);
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
    // Zero physical boards is the truth, and that is all it is. It does NOT
    // hold the synthetic configs last: `isBetterConfig` only ranks candidates
    // within one `boardType:layoutId` group, and `resolveClimbSitemapGroups`
    // orders groups lexicographically by board type, so `moonboard` sorts
    // between `kilter` and `soill` and moves every later group's `ordinal`.
    expect(masters2017?.boardCount).toBe(0);
  });

  it('drops a layout with no listed climbs rather than shipping a thin /list page', async () => {
    climbCounts.rows = [{ layoutId: 2 }];

    const moonboard = (await getSitemapClimbConfigsOrThrow()).filter((config) => config.boardType === 'moonboard');
    expect(moonboard.map((config) => config.layoutId)).toEqual([2]);
  });

  it('ignores a layout id the catalogue does not know', async () => {
    climbCounts.rows = [{ layoutId: 99 }];

    const moonboard = (await getSitemapClimbConfigsOrThrow()).filter((config) => config.boardType === 'moonboard');
    expect(moonboard).toEqual([]);
  });

  it('runs the gate query once across concurrent callers, then serves it from the TTL', async () => {
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

  it('does not memoise a failed gate read, so a transient DB error is not an hour of missing MoonBoard', async () => {
    // The in-process layer stores nothing on a rejection: `cachedLayouts` is only
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

describe('the gate query is bounded', () => {
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

describe('the public spray wall leg', () => {
  it('appends a public wall to the climbs shard configs, slug and all', async () => {
    sprayWalls.configs = [PUBLIC_SPRAY_WALL];

    const configs = await getSitemapClimbConfigsOrThrow();

    expect(configs.filter((config) => config.boardType === 'spray')).toEqual([PUBLIC_SPRAY_WALL]);
    // Appended, never spliced in: the listed configs still lead.
    expect(configs[0]).toEqual(KILTER_CONFIG);
  });

  it('fails the whole climbs shard rather than serving a shorter one', async () => {
    // Same reason the MoonBoard leg is strict here: the climbs shard resolves
    // its groups twice per crawl, and a wall present for one pass and absent for
    // the other is "cache epochs disagree".
    sprayWalls.throws = true;

    await expect(getSitemapClimbConfigsOrThrow()).rejects.toThrow('spray wall read failed');
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

  it('never names a spray wall: a wall has no /list URL on www', async () => {
    sprayWalls.configs = [PUBLIC_SPRAY_WALL];

    const configs = await getBoardsShardConfigsOrThrow();

    expect(configs.some((config) => config.boardType === 'spray')).toBe(false);
    expect(sprayWalls.calls).toBe(0);
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
describe('the MoonBoard listed-layout gate query', () => {
  // A drizzle instance with no client behind it: building and rendering a query
  // never touches a connection.
  const db = drizzle({} as never) as never;
  const { sql, params } = buildMoonBoardListedLayoutsQuery(db, [1, 2, 3]).toSQL();
  const normalised = sql.toLowerCase().replace(/\s+/g, ' ');

  it('asks only about listed, non-draft, non-hidden MoonBoard climbs on each layout', () => {
    expect(normalised).toMatch(
      /"board_climbs"\."board_type" = \$\d+ and "board_climbs"\."layout_id" = layout_ids\.layout_id/,
    );
    expect(normalised).toMatch(
      /"board_climbs"\."layout_id" = layout_ids\.layout_id and "board_climbs"\."is_listed" = \$\d+/,
    );
    expect(normalised).toMatch(/"board_climbs"\."is_listed" = \$\d+ and "board_climbs"\."is_draft" = \$\d+/);
    // A layout whose only listed climbs have been community-hidden drops out of
    // the sitemap entirely, instead of shipping a board URL over zero climb URLs.
    expect(normalised).toMatch(/"board_climbs"\."is_draft" = \$\d+ and "board_climbs"\."is_hidden" = \$\d+/);
    // POSITIONAL: the layout ids first (the unnest array), then the predicate.
    // Swapping the booleans leaves the SQL text identical, so only the params
    // can tell `is_listed = true and is_draft = false` from its inverse.
    expect(params).toEqual([1, 2, 3, 'moonboard', true, false, false]);
  });

  it('is one EXISTS per layout, not a count over every MoonBoard row', () => {
    // The whole reason this query exists separately: both shards read the answer
    // only as a gate, so it must stop at the first matching row of each layout.
    expect(normalised).toContain('from unnest(array[$1, $2, $3]::int[]) as layout_ids(layout_id)');
    expect(normalised).toContain('where exists (select 1 from "board_climbs"');
    expect(normalised).not.toContain('count(');
    expect(normalised).not.toContain('group by');
    expect(normalised).not.toContain('distinct on');
    expect(normalised).not.toContain('board_climb_stats');
  });
});
