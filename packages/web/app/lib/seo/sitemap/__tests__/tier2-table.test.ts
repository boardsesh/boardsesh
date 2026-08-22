import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';

vi.mock('server-only', () => ({}));
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
  boardCount: 12,
  displayName: 'Kilter Original 12x12',
};

vi.mock('@/app/lib/server-popular-configs', () => ({
  getAllBoardConfigsOrThrow: async () => [KILTER_CONFIG],
}));

const sentry = vi.hoisted(() => ({ captureMessage: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureMessage: sentry.captureMessage }));

/**
 * Six climbs, uuids deliberately NOT in the order their angles or names would
 * sort in — so an `ORDER BY angle` or an accidental re-sort is visible.
 */
const CLIMBS = [
  { uuid: '1111111111111111111111111111aaaa', name: 'Zebra', angle: 40 },
  { uuid: '2222222222222222222222222222bbbb', name: 'Anchor', angle: 25 },
  { uuid: '3333333333333333333333333333cccc', name: null, angle: 55 },
  { uuid: '4444444444444444444444444444dddd', name: 'Mango', angle: 30 },
  { uuid: '5555555555555555555555555555eeee', name: 'Bolt', angle: 45 },
  { uuid: '6666666666666666666666666666ffff', name: 'Crimp', angle: 20 },
];

const STATS_UPDATED = new Date('2026-05-04T10:00:00.000Z');
const CLIMB_UPDATED = new Date('2026-05-05T10:00:00.000Z');

const store = vi.hoisted(() => ({
  /** Rows of `sitemap_tier2_groups`. Empty means "nothing refreshed yet". */
  groupRows: [] as Record<string, unknown>[],
  groupReadThrows: false,
  /** The one group's rows, in primary-key order. */
  climbRows: [] as Record<string, unknown>[],
  /** Every `(offset, limit)` the page build actually asked the database for. */
  sliceRequests: [] as { offset: number; limit: number }[],
  groupReads: 0,
}));

/**
 * A drizzle-shaped fake, discriminating the two reads by whether `.where()` was
 * called: the group read has no predicate, the climb slice has one.
 *
 * It genuinely APPLIES the `ORDER BY` it is handed — `store.climbRows` is held in
 * a deliberately scrambled order — so the ordering is observable rather than
 * assumed. A fake that ignored `orderBy` would let `ORDER BY angle`, or no
 * `ORDER BY` at all, pass the equivalence test below.
 */
vi.mock('@/app/lib/db/db', () => ({
  dbzRead: {
    select: () => ({
      from: () => {
        const state = { filtered: false, offset: 0, limit: 0, orderedBy: '' };
        const chain = {
          where: () => {
            state.filtered = true;
            return chain;
          },
          orderBy: (...order: unknown[]) => {
            state.orderedBy = order.map(orderedColumnName).join(',');
            return chain;
          },
          offset: (value: number) => {
            state.offset = value;
            return chain;
          },
          limit: (value: number) => {
            state.limit = value;
            return chain;
          },
          // Deliberately thenable: a drizzle query builder is awaited directly,
          // so the fake has to be too.
          // oxlint-disable-next-line unicorn/no-thenable
          then: (
            resolve: (rows: Record<string, unknown>[]) => unknown,
            reject: (err: unknown) => unknown,
          ): Promise<unknown> => {
            if (!state.filtered) {
              store.groupReads += 1;
              if (store.groupReadThrows) return Promise.resolve().then(() => reject(new Error('relation missing')));
              return Promise.resolve().then(() => resolve(store.groupRows));
            }
            store.sliceRequests.push({ offset: state.offset, limit: state.limit });
            const ordered = sortRows(store.climbRows, state.orderedBy);
            return Promise.resolve().then(() => resolve(ordered.slice(state.offset, state.offset + state.limit)));
          },
        };
        return chain;
      },
    }),
  },
}));

/** The column a drizzle `asc(column)` names, dug out of its query chunks. */
function orderedColumnName(order: unknown): string {
  const chunks = (order as { queryChunks?: unknown[] })?.queryChunks ?? [];
  for (const chunk of chunks) {
    const name = (chunk as { name?: unknown })?.name;
    if (typeof name === 'string') return name;
  }
  return '';
}

function sortRows(rows: Record<string, unknown>[], orderedBy: string): Record<string, unknown>[] {
  if (orderedBy === 'climb_uuid') {
    return [...rows].sort((left, right) => String(left.climbUuid).localeCompare(String(right.climbUuid)));
  }
  if (orderedBy === 'angle') {
    return [...rows].sort((left, right) => Number(left.angle) - Number(right.angle));
  }
  // No recognised ORDER BY: hand back the scrambled insertion order, so deleting
  // the clause is as visible as changing it.
  return rows;
}

/**
 * The live fallback's pool seam, plus the fingerprint (which would otherwise try
 * to render real SQL against the fake client above). Everything else in
 * `@boardsesh/db/queries` is the real implementation — the point of the
 * equivalence test below is that both paths use it.
 */
vi.mock('@boardsesh/db/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/db/queries')>()),
  tier2PredicateFingerprint: () => 'fingerprint-v1',
  withSerialPlan: async () =>
    CLIMBS.map((climb) => ({
      uuid: climb.uuid,
      name: climb.name,
      angle: climb.angle,
      statsUpdatedAt: STATS_UPDATED,
      climbUpdatedAt: CLIMB_UPDATED,
    })),
}));

const { buildTier2TablePage, fetchTier2TableSummary, resetTier2TableStateForTests, tier2SourceHeaders } =
  await import('../tier2-table');
const { buildTier2ClimbItems, resetTier2ItemCacheForTests } = await import('../climb-query');

function groupRow(overrides: Record<string, unknown> = {}) {
  return {
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: [1, 20],
    itemCount: CLIMBS.length,
    lastModified: CLIMB_UPDATED,
    predicateFingerprint: 'fingerprint-v1',
    refreshedAt: new Date(Date.now() - 60 * 60 * 1000),
    ...overrides,
  };
}

function populate() {
  store.groupRows = [groupRow()];
  // Scrambled on purpose — see `sortRows`. The read path has to ask for the order
  // it wants; it cannot inherit one from the fixture.
  store.climbRows = [3, 0, 5, 1, 4, 2].map((index) => ({
    climbUuid: CLIMBS[index].uuid,
    angle: CLIMBS[index].angle,
    climbName: CLIMBS[index].name,
    lastModified: CLIMB_UPDATED,
  }));
}

afterEach(() => {
  resetTier2TableStateForTests();
  resetTier2ItemCacheForTests();
  store.groupRows = [];
  store.climbRows = [];
  store.sliceRequests = [];
  store.groupReads = 0;
  store.groupReadThrows = false;
  sentry.captureMessage.mockClear();
});

describe('the materialised tier-2 read path', () => {
  it('produces byte-identical items to the live fallback, in the same order', async () => {
    // The equivalence that makes the swap safe. Same fixture behind both paths;
    // if the stored order, the name resolution or the timestamp decoding differ
    // by anything, the paths emit different URLs and Google sees churn.
    //
    // An `ORDER BY angle` on the table read, a reversed group walk, or a
    // `timestamp with time zone` column (which shifts every ISO string by the
    // session offset) all show up here.
    populate();
    const fromTable = await buildTier2TablePage(1, 10_000);
    const fromLive = await buildTier2ClimbItems();

    expect(fromTable).not.toBeNull();
    expect(fromTable?.items).toEqual(fromLive);
    expect(fromTable?.items.map((item) => item.path)).toEqual(fromLive.map((item) => item.path));
  });

  it('asks the database for only the rows the page needs', async () => {
    populate();
    store.groupRows = [groupRow({ itemCount: 6 })];

    await buildTier2TablePage(1, 4);

    // Bounded, not "fetch everything and slice" — which is the 27 s cold build
    // this replaces.
    expect(store.sliceRequests).toEqual([{ offset: 0, limit: 4 }]);
  });

  it('summarises from the same rows the page build reads', async () => {
    populate();
    const summary = await fetchTier2TableSummary();
    expect(summary).toEqual({ itemCount: 6, lastModified: CLIMB_UPDATED });
  });

  it('names the table on the response', async () => {
    populate();
    expect(await tier2SourceHeaders()).toMatchObject({ 'X-Sitemap-Tier2-Source': 'table' });
  });
});

describe('a fallback is never quiet', () => {
  it('reports an empty table once, however many callers race for it', async () => {
    // A cold crawl is /sitemap.xml plus every /sitemaps/climbs/N.xml arriving
    // together. Without the single-flight, one degradation becomes one Sentry
    // event per concurrent caller — and a console.error nobody reads is not a
    // detector at all, which is the whole lesson of #4583.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const summaries = await Promise.all([
      fetchTier2TableSummary(),
      fetchTier2TableSummary(),
      fetchTier2TableSummary(),
      fetchTier2TableSummary(),
      fetchTier2TableSummary(),
    ]);

    expect(summaries).toEqual([null, null, null, null, null]);
    expect(store.groupReads).toBe(1);
    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('no rows in sitemap_tier2_groups'),
      'error',
    );
    errors.mockRestore();
  });

  it('reports predicate drift at error level and refuses to serve the stored rows', async () => {
    populate();
    store.groupRows = [groupRow({ predicateFingerprint: 'fingerprint-v0' })];
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await fetchTier2TableSummary()).toBeNull();
    expect(await buildTier2TablePage(1, 10_000)).toBeNull();
    expect(sentry.captureMessage).toHaveBeenCalledWith(expect.stringContaining('different predicate'), 'error');
    expect(await tier2SourceHeaders()).toMatchObject({
      'X-Sitemap-Tier2-Source': 'live',
      'X-Sitemap-Tier2-Reason': 'predicate-drift',
    });
    errors.mockRestore();
  });

  it('serves a stale table, warns, and puts its age on the response', async () => {
    populate();
    store.groupRows = [groupRow({ refreshedAt: new Date(Date.now() - 72 * 3_600_000) })];
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const summary = await fetchTier2TableSummary();

    expect(summary?.itemCount).toBe(6);
    expect(sentry.captureMessage).toHaveBeenCalledWith(expect.stringContaining('72h old'), 'warning');
    expect(await tier2SourceHeaders()).toMatchObject({
      'X-Sitemap-Tier2-Source': 'table',
      'X-Sitemap-Tier2-Age-Hours': '72',
    });
    warnings.mockRestore();
  });

  it('falls back rather than propagating when the tables are not there yet', async () => {
    // The deploy window between the migration landing and the first refresh.
    store.groupReadThrows = true;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await fetchTier2TableSummary()).toBeNull();
    expect(sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('could not read sitemap_tier2_groups'),
      'error',
    );
    errors.mockRestore();
  });
});
