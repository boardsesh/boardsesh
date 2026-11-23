import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';

vi.mock('server-only', () => ({}));
const summaries = vi.hoisted(() => ({
  reads: 0,
  shouldThrow: false,
  stored: {
    itemCount: 2,
    lastModified: new Date('2026-05-04T11:22:33.000Z'),
    computedAt: new Date('2026-05-04T12:00:00.000Z'),
  } as { itemCount: number; lastModified: Date | null; computedAt: Date } | null,
}));
vi.mock('@/app/lib/db/db', () => ({
  dbzRead: {},
  dbz: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            summaries.reads += 1;
            if (summaries.shouldThrow) throw new Error('summary read failed');
            return summaries.stored ? [summaries.stored] : [];
          },
        }),
      }),
    }),
  },
}));

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

/**
 * Stands in for the whole read path, so every assertion below is "how many
 * grouped scans reached the pool" — the invariant the single-flight promise
 * exists to protect (#4461: a crawl burst is `/sitemap.xml` plus every page
 * arriving together, each calling this, against a pool of ten).
 */
const reads = vi.hoisted(() => ({
  count: 0,
  gate: null as null | Promise<void>,
  shouldThrow: false,
  /** Usernames the fake query hands back. */
  usernames: ['alice', 'bob'] as string[],
}));

vi.mock('@boardsesh/db/queries', () => ({
  withSerialPlan: async () => {
    reads.count += 1;
    if (reads.gate) await reads.gate;
    if (reads.shouldThrow) throw new Error('setters scan failed');
    return reads.usernames.map((username) => ({
      setter_username: username,
      last_modified: '2026-05-04T11:22:33.000Z',
    }));
  },
}));

const { buildSetterSitemapItems, fetchSetterSitemapSummary, resetSetterSitemapCachesForTests } =
  await import('../setter-query');

afterEach(() => {
  resetSetterSitemapCachesForTests();
  reads.count = 0;
  reads.gate = null;
  reads.shouldThrow = false;
  reads.usernames = ['alice', 'bob'];
  summaries.reads = 0;
  summaries.shouldThrow = false;
  summaries.stored = {
    itemCount: 2,
    lastModified: new Date('2026-05-04T11:22:33.000Z'),
    computedAt: new Date('2026-05-04T12:00:00.000Z'),
  };
});

describe('the setters item + summary caches', () => {
  it('runs ONE scan for concurrent item callers, not one each', async () => {
    let openGate = () => {};
    reads.gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });

    const pending = [buildSetterSitemapItems(), buildSetterSitemapItems(), buildSetterSitemapItems()];
    openGate();
    const results = await Promise.all(pending);

    expect(reads.count).toBe(1);
    for (const items of results) {
      expect(items.map((item) => item.path)).toEqual(['/setter/alice', '/setter/bob']);
    }
  });

  it('reads persisted summaries on a cold process without any scan', async () => {
    const [first, second] = await Promise.all([fetchSetterSitemapSummary(), fetchSetterSitemapSummary()]);
    expect(reads.count).toBe(0);
    expect(summaries.reads).toBe(2);
    expect(first).toEqual(second);
    expect(first.itemCount).toBe(2);
    expect(first.lastModified?.toISOString()).toBe('2026-05-04T11:22:33.000Z');
    resetSetterSitemapCachesForTests();
    await fetchSetterSitemapSummary();
    expect(reads.count).toBe(0);
  });

  it('runs ONE scan for a summary and a page arriving together', async () => {
    // The summary is independent of the expensive per-page catalogue scan.
    let openGate = () => {};
    reads.gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });

    const pending = Promise.all([fetchSetterSitemapSummary(), buildSetterSitemapItems()]);
    openGate();
    const [summary, items] = await pending;

    expect(reads.count).toBe(1);
    expect(summary.itemCount).toBe(items.length);
  });

  it('serves the second caller from the TTL rather than scanning again', async () => {
    await buildSetterSitemapItems();
    await buildSetterSitemapItems();

    expect(reads.count).toBe(1);
  });

  it('does not memoise a failure — the next caller retries', async () => {
    // A poisoned six-hour entry would keep 503ing the shard long after the
    // database recovered.
    reads.shouldThrow = true;
    await expect(buildSetterSitemapItems()).rejects.toThrow('setters scan failed');

    reads.shouldThrow = false;
    const items = await buildSetterSitemapItems();

    expect(reads.count).toBe(2);
    expect(items).toHaveLength(2);
  });

  it('retries a failed summary read without scanning or memoising the failure', async () => {
    summaries.shouldThrow = true;
    await expect(fetchSetterSitemapSummary()).rejects.toThrow('summary read failed');
    summaries.shouldThrow = false;
    const summary = await fetchSetterSitemapSummary();
    expect(summaries.reads).toBe(2);
    expect(reads.count).toBe(0);
    expect(summary.itemCount).toBe(2);
  });

  it('fails promptly on a missing summary without a foreground scan', async () => {
    summaries.stored = null;
    await expect(fetchSetterSitemapSummary()).rejects.toThrow('not populated');
    expect(reads.count).toBe(0);
  });

  it('serves a stale last-good summary without a foreground scan', async () => {
    summaries.stored = { itemCount: 5, lastModified: null, computedAt: new Date('2000-01-01') };
    await expect(fetchSetterSitemapSummary()).resolves.toEqual({ itemCount: 5, lastModified: null });
    expect(reads.count).toBe(0);
  });

  it('does not advertise an invalid persisted count', async () => {
    summaries.stored = { itemCount: 0, lastModified: null, computedAt: new Date() };
    await expect(fetchSetterSitemapSummary()).rejects.toThrow('not populated');
    expect(reads.count).toBe(0);
  });

  it('refuses to cache a list the summary does not describe', async () => {
    // The SQL predicate makes this unreachable, so reaching it means the SQL
    // rule and the JS round-trip check have disagreed. Caching the short list
    // would serve a wrong shard for the full TTL behind one `console.warn`; the
    // throw 503s the page and the next crawl retries.
    reads.usernames = ['alice', '\uD800'];

    await expect(buildSetterSitemapItems()).rejects.toThrow('refusing to cache a list the summary does not describe');
    // ...and nothing was cached, so a fixed catalogue recovers on the next call.
    reads.usernames = ['alice', 'bob'];
    await expect(buildSetterSitemapItems()).resolves.toHaveLength(2);
  });
});
