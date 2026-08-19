import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('server-only', () => ({}));

/**
 * The store's whole reason to exist is that the live scan is far too slow for the
 * index's 3 s deadline, so every test here is about which path gets taken and what
 * gets written — never about the scan itself, which `climb-query.test.ts` pins.
 */
const live = vi.hoisted(() => ({
  /** What the UNCACHED refresher path computes. */
  computed: { itemCount: 52_000, lastModifiedIso: '2026-05-04T11:22:33.000Z' } as {
    itemCount: number;
    lastModifiedIso: string | null;
  },
  computeCalls: 0,
  computeThrows: false,
  /** What the CACHED fallback returns when the store is empty. */
  fallbackCalls: 0,
}));

vi.mock('../climb-query', () => ({
  computeTier2Summary: async () => {
    live.computeCalls += 1;
    if (live.computeThrows) throw new Error('tier-2 scan exploded');
    return live.computed;
  },
  fetchTier2Summary: async () => {
    live.fallbackCalls += 1;
    return { itemCount: 999, lastModified: new Date('2020-01-01T00:00:00.000Z') };
  },
}));

type StoredRow = { itemCount: number; lastModified: Date | null; computedAt: Date };

const store = vi.hoisted(() => ({
  row: null as { itemCount: number; lastModified: Date | null; computedAt: Date } | null,
  readThrows: false,
  locked: false,
  /** Every `insert().values().onConflictDoUpdate()` the write transaction ran. */
  writes: [] as { itemCount: number; lastModified: Date | null }[],
  /** Raw SQL the transaction executed, so the lock statement is assertable. */
  executed: [] as string[],
}));

// Only `dbz` is provided, deliberately. If the store ever reached for `dbzRead`
// — a genuinely separate pool that can point at a replica — every test here would
// fail on `undefined`, which is the enforcement that replication lag never gets to
// feed the shrink guard a stale count.
vi.mock('@/app/lib/db/db', () => ({
  dbz: {
    // Re-read `store.row` per call rather than closing over it, so a test can set
    // the row after the module graph is built.
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            if (store.readThrows) throw new Error('relation "sitemap_shard_refreshes" does not exist');
            return store.row ? [store.row] : [];
          },
        }),
      }),
    }),
    transaction: async (work: (tx: unknown) => Promise<unknown>) =>
      work({
        execute: async (query: { queryChunks?: unknown[] }) => {
          store.executed.push(JSON.stringify(query?.queryChunks ?? query));
          return [{ locked: !store.locked }];
        },
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => (store.row ? [store.row] : []),
            }),
          }),
        }),
        insert: () => ({
          values: (values: { itemCount: number; lastModified: Date | null }) => ({
            onConflictDoUpdate: async () => {
              store.writes.push({ itemCount: values.itemCount, lastModified: values.lastModified });
            },
          }),
        }),
      }),
  },
}));

vi.mock('@/app/lib/db/schema', () => ({
  sitemapShardRefreshes: {
    shardId: { name: 'shard_id' },
    itemCount: { name: 'item_count' },
    lastModified: { name: 'last_modified' },
    computedAt: { name: 'computed_at' },
  },
}));

const {
  SITEMAP_CLIMB_STORE_MAX_AGE_MS,
  fetchClimbShardSummary,
  fetchStoredClimbRefresh,
  refreshClimbSummaryIfStale,
  refreshStoredClimbSummary,
  resetClimbStoreStateForTests,
} = await import('../climb-store');

function storedRow(overrides: Partial<StoredRow> = {}): StoredRow {
  return {
    itemCount: 52_000,
    lastModified: new Date('2026-05-04T11:22:33.000Z'),
    computedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  live.computed = { itemCount: 52_000, lastModifiedIso: '2026-05-04T11:22:33.000Z' };
  live.computeCalls = 0;
  live.computeThrows = false;
  live.fallbackCalls = 0;
  store.row = null;
  store.readThrows = false;
  store.locked = false;
  store.writes = [];
  store.executed = [];
  resetClimbStoreStateForTests();
});

describe('reading the climbs shard summary', () => {
  it('answers from the stored row without touching the live scan', async () => {
    store.row = storedRow({ itemCount: 51_842 });

    const summary = await fetchClimbShardSummary();

    expect(summary.itemCount).toBe(51_842);
    expect(summary.lastModified).toEqual(new Date('2026-05-04T11:22:33.000Z'));
    // The assertion the whole change rests on: no sixteen-scan question is asked
    // on the path racing SHARD_DEADLINE_MS.
    expect(live.fallbackCalls).toBe(0);
    expect(live.computeCalls).toBe(0);
  });

  it('falls back to the live summary when nothing has been stored yet', async () => {
    // The first request after this deploy, and local dev. Never WORSE than main —
    // it is exactly main's path — but it is still the slow one, which is why the
    // rollout runs one refresh by hand.
    store.row = null;

    const summary = await fetchClimbShardSummary();

    expect(summary.itemCount).toBe(999);
    expect(live.fallbackCalls).toBe(1);
  });

  it('falls back rather than propagating when the store read throws', async () => {
    // The realistic case is the migration not having been applied yet. An index
    // that degrades because its speed-up is missing would be a worse outage than
    // the one this replaced.
    store.readThrows = true;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const summary = await fetchClimbShardSummary();

    expect(summary.itemCount).toBe(999);
    expect(errors.mock.calls.flat().join(' ')).toContain('could not read the stored climbs summary');
    errors.mockRestore();
  });

  it('serves a stale row anyway, but says so at error level', async () => {
    // A complete sitemap whose <lastmod> drifted by a day beats a shard missing
    // from the index — that omission is the bug. Silence is what would let a dead
    // refresher go unnoticed, so the log has to be loud.
    store.row = storedRow({ computedAt: new Date(Date.now() - SITEMAP_CLIMB_STORE_MAX_AGE_MS - 1_000) });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const summary = await fetchClimbShardSummary();

    expect(summary.itemCount).toBe(52_000);
    expect(live.fallbackCalls).toBe(0);
    expect(errors.mock.calls.flat().join(' ')).toContain('stored climbs summary is');
    errors.mockRestore();
  });

  it('returns null rather than undefined when the table is empty', async () => {
    expect(await fetchStoredClimbRefresh()).toBeNull();
  });
});

describe('refreshing the stored summary', () => {
  it('stores the freshly computed count and timestamp', async () => {
    const result = await refreshStoredClimbSummary();

    expect(result.skipped).toBeNull();
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0].itemCount).toBe(52_000);
    expect(store.writes[0].lastModified).toEqual(new Date('2026-05-04T11:22:33.000Z'));
  });

  it('takes a TRANSACTION-scoped advisory lock, never a session-scoped one', async () => {
    // A session-scoped pg_try_advisory_lock is not mutual exclusion on a pooled
    // drizzle client — execute() and transaction() land on different connections,
    // so the writer would not hold the lock it took. sync-daemon-leases.ts
    // documents the same trap.
    await refreshStoredClimbSummary();

    const statements = store.executed.join(' ');
    expect(statements).toContain('pg_try_advisory_xact_lock');
    expect(statements).not.toContain('pg_try_advisory_lock');
    expect(statements).not.toContain('pg_advisory_unlock');
  });

  it('writes nothing when another writer holds the lock', async () => {
    store.locked = true;

    const result = await refreshStoredClimbSummary();

    expect(result.skipped).toBe('locked');
    expect(store.writes).toHaveLength(0);
  });

  it('refuses to store a zero count even when forced', async () => {
    // A stored zero makes the index throw "expects URLs but its summary reports 0"
    // and drop the shard — the exact bug this table exists to prevent.
    live.computed = { itemCount: 0, lastModifiedIso: null };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await refreshStoredClimbSummary({ force: true });

    expect(result.skipped).toBe('empty');
    expect(store.writes).toHaveLength(0);
    errors.mockRestore();
  });

  it('refuses a >50% shrink and leaves the stored row alone', async () => {
    store.row = storedRow({ itemCount: 52_000 });
    live.computed = { itemCount: 20_000, lastModifiedIso: '2026-05-04T11:22:33.000Z' };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await refreshStoredClimbSummary();

    expect(result.skipped).toBe('shrank');
    expect(result.previousItemCount).toBe(52_000);
    expect(store.writes).toHaveLength(0);
    expect(errors.mock.calls.flat().join(' ')).toContain('refusing to store a >50% shrink');
    errors.mockRestore();
  });

  it('accepts a shrink that stays inside the guard', async () => {
    store.row = storedRow({ itemCount: 52_000 });
    live.computed = { itemCount: 40_000, lastModifiedIso: '2026-05-04T11:22:33.000Z' };

    const result = await refreshStoredClimbSummary();

    expect(result.skipped).toBeNull();
    expect(store.writes[0].itemCount).toBe(40_000);
  });

  it('lets ?force=1 through the shrink guard, so the guard cannot wedge the store', async () => {
    // Without a bypass, a real catalogue shrink would make every scheduled run
    // decline forever while the read path kept serving a frozen count.
    store.row = storedRow({ itemCount: 52_000 });
    live.computed = { itemCount: 1_000, lastModifiedIso: '2026-05-04T11:22:33.000Z' };

    const result = await refreshStoredClimbSummary({ force: true });

    expect(result.skipped).toBeNull();
    expect(store.writes[0].itemCount).toBe(1_000);
  });

  it('does not clobber a newer answer another instance wrote while it was scanning', async () => {
    store.row = storedRow({ itemCount: 52_000, computedAt: new Date(Date.now() + 60_000) });

    const result = await refreshStoredClimbSummary();

    expect(result.skipped).toBe('superseded');
    expect(store.writes).toHaveLength(0);
  });

  it('runs one scan for concurrent callers, not one per caller', async () => {
    // The cron and the after() self-heal can overlap on one instance, and the scan
    // is sixteen sequential heavy queries against a ten-connection pool (#4461).
    const [first, second] = await Promise.all([refreshStoredClimbSummary(), refreshStoredClimbSummary()]);

    expect(live.computeCalls).toBe(1);
    expect(first).toBe(second);
  });

  it('does not let a forced caller piggyback on an unforced scan', async () => {
    // Otherwise `?force=1` landing on an in-flight cron refresh would silently keep
    // the shrink guard and answer 409 — the escape hatch looking broken at exactly
    // the moment someone reached for it. Callers that disagree get their own scan.
    store.row = storedRow({ itemCount: 52_000 });
    live.computed = { itemCount: 1_000, lastModifiedIso: '2026-05-04T11:22:33.000Z' };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const [unforced, forced] = await Promise.all([
      refreshStoredClimbSummary(),
      refreshStoredClimbSummary({ force: true }),
    ]);

    expect(unforced.skipped).toBe('shrank');
    expect(forced.skipped).toBeNull();
    expect(live.computeCalls).toBe(2);
    expect(store.writes).toEqual([{ itemCount: 1_000, lastModified: new Date('2026-05-04T11:22:33.000Z') }]);
    errors.mockRestore();
  });
});

describe('the after() self-heal', () => {
  it('refreshes an empty store', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await refreshClimbSummaryIfStale();

    expect(live.computeCalls).toBe(1);
    expect(store.writes).toHaveLength(1);
    warnings.mockRestore();
  });

  it('does nothing when the store is fresh', async () => {
    store.row = storedRow();

    await refreshClimbSummaryIfStale();

    expect(live.computeCalls).toBe(0);
  });

  it('refreshes a store past the staleness bound', async () => {
    store.row = storedRow({ computedAt: new Date(Date.now() - SITEMAP_CLIMB_STORE_MAX_AGE_MS - 1_000) });
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await refreshClimbSummaryIfStale();

    expect(live.computeCalls).toBe(1);
    warnings.mockRestore();
  });

  it('rate-limits itself so a store that cannot be written is not rebuilt per request', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await refreshClimbSummaryIfStale();
    await refreshClimbSummaryIfStale();
    await refreshClimbSummaryIfStale();

    expect(live.computeCalls).toBe(1);
    warnings.mockRestore();
  });

  it('never throws into the caller — after() failures must not surface', async () => {
    store.readThrows = true;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(refreshClimbSummaryIfStale()).resolves.toBeUndefined();

    expect(errors.mock.calls.flat().join(' ')).toContain('self-heal failed');
    errors.mockRestore();
  });

  it('swallows a scan that throws, and does not retry it on the next request', async () => {
    // The most operationally plausible failure here is the scan itself regressing,
    // not the store read. `after()` runs post-flush, so an escaping rejection would
    // be an unhandled one; and the 15-minute floor has to hold even for the attempt
    // that failed, or a broken scan runs on every /sitemap.xml hit.
    live.computeThrows = true;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(refreshClimbSummaryIfStale()).resolves.toBeUndefined();
    await refreshClimbSummaryIfStale();

    expect(live.computeCalls).toBe(1);
    expect(errors.mock.calls.flat().join(' ')).toContain('self-heal failed');
    errors.mockRestore();
  });

  it('propagates a scan error to a direct caller, so the cron route can 500', async () => {
    // The self-heal swallows; the endpoint must not. A cron that answers 200 on a
    // broken scan is a store that silently stops being refreshed.
    live.computeThrows = true;

    await expect(refreshStoredClimbSummary()).rejects.toThrow('tier-2 scan exploded');
    expect(store.writes).toHaveLength(0);
  });
});
