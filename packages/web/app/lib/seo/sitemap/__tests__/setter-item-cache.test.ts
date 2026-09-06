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

vi.mock('@/app/lib/server-popular-configs', () => ({
  getAllBoardConfigsOrThrow: async () => [KILTER_CONFIG],
}));

// The Next Data Cache is a pass-through here: `unstable_cache` memoises across
// requests in production, and the guard under test is the in-process one in
// front of it, which is the half that dedupes CONCURRENT misses.
//
// So the two "does not memoise a failure" cases below cover the in-process
// layer only. That is sufficient, and not by luck — read from the installed
// next@16.3.2 (`server/web/spec-extension/unstable-cache.js`): the result is
// `await`ed BEFORE `cacheNewResult` is called, so a rejection throws past the
// write and never reaches the Data Cache, and the background-revalidation path
// returns the stale value on error rather than storing the rejection. A failed
// scan therefore cannot poison either layer for the `SUMMARY_REVALIDATE_SECONDS`
// window. Re-check this if the Next major changes.
vi.mock('next/cache', () => ({ unstable_cache: (fn: (...args: never[]) => unknown) => fn }));

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
      climb_count: 9,
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

  it('runs ONE scan for concurrent summary callers', async () => {
    let openGate = () => {};
    reads.gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });

    const pending = [fetchSetterSitemapSummary(), fetchSetterSitemapSummary()];
    openGate();
    const [first, second] = await Promise.all(pending);

    expect(reads.count).toBe(1);
    expect(first.itemCount).toBe(2);
    expect(second.itemCount).toBe(2);
    expect(first.lastModified?.toISOString()).toBe('2026-05-04T11:22:33.000Z');
  });

  it('runs ONE scan for a summary and a page arriving together', async () => {
    // The cold-burst shape (#4461): `/sitemap.xml` reads the summary while
    // `/sitemaps/setters/1.xml` builds the items. They share one single-flight
    // rather than each running its own grouped scan.
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

  it('does not memoise a failed SUMMARY either', async () => {
    // Symmetric with the item build above, and it matters more: the index reads
    // the summary on every hit, so a poisoned entry would keep the setters pages
    // out of `/sitemap.xml` long after the database recovered.
    reads.shouldThrow = true;
    await expect(fetchSetterSitemapSummary()).rejects.toThrow('setters scan failed');

    reads.shouldThrow = false;
    const summary = await fetchSetterSitemapSummary();

    expect(reads.count).toBe(2);
    expect(summary.itemCount).toBe(2);
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
