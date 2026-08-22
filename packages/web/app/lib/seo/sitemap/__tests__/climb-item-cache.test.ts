import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';

vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/db/db', () => ({ dbzRead: {} }));

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

const TENSION_CONFIG: PopularBoardConfig = {
  ...KILTER_CONFIG,
  boardType: 'tension',
  layoutId: 9,
  layoutName: 'Tension Board 2',
  sizeId: 1,
  setIds: [8, 9, 10, 11],
  setNames: ['Tension Sets'],
};

// Three groups, so "sequential" is observable at all: with one group a
// Promise.all rewrite and a for-loop are indistinguishable.
vi.mock('../board-config-source', () => ({
  getSitemapClimbConfigsOrThrow: async () => [
    KILTER_CONFIG,
    { ...KILTER_CONFIG, layoutId: 8, sizeId: 25, setIds: [26, 27] },
    TENSION_CONFIG,
  ],
}));

// The Next Data Cache is a pass-through here: `unstable_cache` memoises across
// requests in production, and the guard under test is the in-process one in
// front of it.
vi.mock('next/cache', () => ({ unstable_cache: (fn: (...args: never[]) => unknown) => fn }));

// Stands in for the whole read path, so the assertion is "how many scans reached
// the pool", which is the invariant the single-flight promise exists to protect.
const reads = vi.hoisted(() => ({
  count: 0,
  /** How many reads are in the pool at once, and the worst it ever got. */
  inFlight: 0,
  maxInFlight: 0,
  gate: null as null | Promise<void>,
  /** Set to hand back the summary shape instead of the row shape. */
  summaryRow: null as null | { itemCount: number; lastModified: string | null },
}));

vi.mock('@boardsesh/db/queries', () => ({
  withSerialPlan: async () => {
    reads.count += 1;
    reads.inFlight += 1;
    reads.maxInFlight = Math.max(reads.maxInFlight, reads.inFlight);
    try {
      // A real await point, so a Promise.all over the groups would actually
      // overlap here and be visible in maxInFlight.
      await Promise.resolve();
      if (reads.gate) await reads.gate;
      if (reads.summaryRow) return [reads.summaryRow];
      return [
        {
          uuid: 'abcdef1234567890abcdef1234567890',
          name: 'Test Climb',
          angle: 40,
          statsUpdatedAt: new Date('2026-05-04'),
          climbUpdatedAt: new Date('2026-05-05'),
        },
      ];
    } finally {
      reads.inFlight -= 1;
    }
  },
}));

const { buildTier2ClimbItems, fetchTier2Summary, resetTier2ItemCacheForTests } = await import('../climb-query');

afterEach(() => {
  resetTier2ItemCacheForTests();
  reads.count = 0;
  reads.inFlight = 0;
  reads.maxInFlight = 0;
  reads.gate = null;
  reads.summaryRow = null;
});

describe('the tier-2 item cache', () => {
  it('scans once and serves the second caller from the TTL cache', async () => {
    const first = await buildTier2ClimbItems();
    const second = await buildTier2ClimbItems();

    // Three groups, one build.
    expect(reads.count).toBe(3);
    expect(second).toBe(first);
    expect(first).toHaveLength(3);
    expect(first[0]?.lastModified?.toISOString()).toBe('2026-05-05T00:00:00.000Z');
  });

  it('runs the group scans one at a time, never fanned out onto the pool', async () => {
    // "Sequential, never Promise.all" is a non-negotiable (#4461): ~30 concurrent
    // hash-join scans on a ten-connection pool is the starvation this design
    // exists to prevent. A CALL COUNT cannot see the difference — rewriting the
    // loop as `Promise.all` leaves it identical — so the assertion has to be on
    // concurrency depth.
    await buildTier2ClimbItems();

    expect(reads.count).toBe(3);
    expect(reads.maxInFlight).toBe(1);
  });

  it('collapses concurrent cold-start callers into one scan', async () => {
    // A crawl burst across N shard pages on a cold instance is N full scans
    // against a ten-connection pool without this — the #4461 failure.
    let release = () => {};
    reads.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const inFlight = Promise.all([buildTier2ClimbItems(), buildTier2ClimbItems(), buildTier2ClimbItems()]);
    release();
    const [a, b, c] = await inFlight;

    // Three callers, three groups: one build's worth of scans, not three.
    expect(reads.count).toBe(3);
    expect(reads.maxInFlight).toBe(1);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('rebuilds after the cache is dropped, so the seam is not a one-way door', async () => {
    await buildTier2ClimbItems();
    resetTier2ItemCacheForTests();
    await buildTier2ClimbItems();

    expect(reads.count).toBe(6);
  });

  it('does not cache a failed build', async () => {
    await buildTier2ClimbItems();
    resetTier2ItemCacheForTests();

    reads.gate = Promise.reject(new Error('pool exhausted'));
    await expect(buildTier2ClimbItems()).rejects.toThrow('pool exhausted');

    // The next caller must retry rather than inherit a poisoned in-flight promise.
    reads.gate = null;
    await expect(buildTier2ClimbItems()).resolves.toHaveLength(3);
    expect(reads.count).toBe(7);
  });
});

describe('the tier-2 summary cache', () => {
  it('returns the real row timestamp, never a synthesised one', async () => {
    // The only place the summary aggregation actually runs. `climb-shards.test.ts`
    // mocks `../climb-query` wholesale and `climb-query.test.ts` only renders
    // `.toSQL()`, so without this a `new Date()` here would pass the whole suite
    // and tell Google every climb shard changed on every crawl.
    reads.summaryRow = { itemCount: 12, lastModified: '2026-05-04T11:22:33.000Z' };

    const summary = await fetchTier2Summary();

    expect(summary.itemCount).toBe(36);
    expect(summary.lastModified?.toISOString()).toBe('2026-05-04T11:22:33.000Z');
    // The same 60-second window static-entries.test.ts uses: a floating
    // `new Date()` lands inside it, a real content timestamp does not.
    expect(summary.lastModified!.getTime()).toBeLessThan(Date.now() - 60 * 1000);
  });

  it('reports no timestamp at all rather than inventing one', async () => {
    reads.summaryRow = { itemCount: 0, lastModified: null };

    expect((await fetchTier2Summary()).lastModified).toBeNull();
  });

  it('scans the groups one at a time and collapses concurrent cold callers', async () => {
    // `unstable_cache` does not deduplicate concurrent misses, and on a cold
    // cache the index plus every shard page call this together.
    reads.summaryRow = { itemCount: 4, lastModified: null };
    let release = () => {};
    reads.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const inFlight = Promise.all([fetchTier2Summary(), fetchTier2Summary(), fetchTier2Summary()]);
    release();
    const [first, second, third] = await inFlight;

    expect(reads.count).toBe(3);
    expect(reads.maxInFlight).toBe(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('clears a failed in-flight build so the next caller retries', async () => {
    reads.summaryRow = { itemCount: 4, lastModified: '2026-05-04T11:22:33.000Z' };
    reads.gate = Promise.reject(new Error('summary pool exhausted'));

    await expect(fetchTier2Summary()).rejects.toThrow('summary pool exhausted');

    // The rejected single-flight promise must not poison the in-process cache.
    reads.gate = null;
    await expect(fetchTier2Summary()).resolves.toEqual({
      itemCount: 12,
      lastModified: new Date('2026-05-04T11:22:33.000Z'),
    });
    // One failed first-group scan, then all three groups on the successful retry.
    expect(reads.count).toBe(4);
  });
});
