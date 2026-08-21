import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('server-only', () => ({}));

/**
 * The store's whole reason to exist is that the live build is far too slow for
 * the index's 3 s deadline and the shard pages' crawl budget, so every test here
 * is about which path gets taken and what gets written — never about the scan
 * itself, which climb-query.test.ts pins.
 */
type LiveUrlRow = { path: string; lastModified: Date | null; boardType: string; layoutId: number };

function liveUrlRows(count: number, newestIso = '2026-05-04T11:22:33.000Z'): LiveUrlRow[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `/kilter/original/12x12/screw/40/view/climb-${index}`,
    // The newest timestamp sits mid-list, so "max" is observable as distinct
    // from "last".
    lastModified: index === Math.floor(count / 2) ? new Date(newestIso) : new Date('2026-01-01T00:00:00.000Z'),
    boardType: 'kilter',
    layoutId: 1,
  }));
}

const live = vi.hoisted(() => ({
  /** What the UNCACHED refresher path builds. */
  urlRows: [] as LiveUrlRow[],
  buildCalls: 0,
  buildThrows: false,
  /** What the CACHED summary fallback returns when the store is empty. */
  fallbackSummaryCalls: 0,
  /** What the CACHED item fallback returns when the URL store is empty. */
  fallbackItems: [] as { path: string; lastModified: Date | null }[],
  fallbackItemCalls: 0,
}));

vi.mock('../climb-query', () => ({
  buildAllTier2UrlRows: async () => {
    live.buildCalls += 1;
    if (live.buildThrows) throw new Error('tier-2 scan exploded');
    return live.urlRows;
  },
  fetchTier2Summary: async () => {
    live.fallbackSummaryCalls += 1;
    return { itemCount: 999, lastModified: new Date('2020-01-01T00:00:00.000Z') };
  },
  buildTier2ClimbItems: async () => {
    live.fallbackItemCalls += 1;
    return live.fallbackItems;
  },
}));

type StoredRow = { itemCount: number; lastModified: Date | null; computedAt: Date };
type StoredUrlRow = { ordinal: number; path: string; lastModified: Date | null };

const schema = vi.hoisted(() => ({
  sitemapShardRefreshes: {
    shardId: { name: 'shard_id' },
    itemCount: { name: 'item_count' },
    lastModified: { name: 'last_modified' },
    computedAt: { name: 'computed_at' },
  },
  sitemapClimbUrls: {
    ordinal: { name: 'ordinal' },
    path: { name: 'path' },
    lastModified: { name: 'last_modified' },
    boardType: { name: 'board_type' },
    layoutId: { name: 'layout_id' },
  },
}));

vi.mock('@/app/lib/db/schema', () => schema);

const store = vi.hoisted(() => ({
  row: null as StoredRow | null,
  urlRows: [] as StoredUrlRow[],
  readThrows: false,
  locked: false,
  /** Every summary upsert the write transaction ran. */
  writes: [] as { itemCount: number; lastModified: Date | null }[],
  /** Every `sitemap_climb_urls` insert chunk, in statement order. */
  urlWrites: [] as {
    ordinal: number;
    path: string;
    lastModified: Date | null;
    boardType: string;
    layoutId: number;
  }[][],
  /** Write-transaction statements in order, so the delete-before-insert swap is assertable. */
  transactionOps: [] as string[],
  /** Raw SQL the transaction executed, so the lock statement is assertable. */
  executed: [] as string[],
}));

/**
 * Bound numeric parameters inside a drizzle condition tree — how the mock reads
 * the ordinal range back out of `where(and(gte(...), lt(...)))` without
 * serialising real SQL.
 */
function collectBoundNumbers(node: unknown, collected: number[] = []): number[] {
  if (typeof node === 'number') {
    collected.push(node);
    return collected;
  }
  if (!node || typeof node !== 'object') {
    return collected;
  }
  const record = node as { value?: unknown; queryChunks?: unknown[] };
  if (typeof record.value === 'number') {
    collected.push(record.value);
    return collected;
  }
  if (Array.isArray(record.queryChunks)) {
    for (const chunk of record.queryChunks) {
      collectBoundNumbers(chunk, collected);
    }
  }
  return collected;
}

/** Matches CLIMB_URLS_PER_SHARD; the lastmods simulation groups on it. */
const PER_PAGE = 10_000;

type SelectState = { fields: string[]; table: unknown; whereCondition: unknown; limit: number | null };

function resolveRootSelect(state: SelectState): unknown[] {
  if (state.table === schema.sitemapShardRefreshes) {
    if (store.readThrows) throw new Error('relation "sitemap_shard_refreshes" does not exist');
    return store.row ? [store.row] : [];
  }
  if (store.readThrows) throw new Error('relation "sitemap_climb_urls" does not exist');
  if (state.fields.includes('totalItems')) {
    return [{ totalItems: store.urlRows.length }];
  }
  if (state.fields.includes('present')) {
    return store.urlRows.length > 0 ? [{ present: 1 }] : [];
  }
  if (state.fields.includes('pageIndex')) {
    const byPage = new Map<number, Date | null>();
    for (const urlRow of store.urlRows) {
      const pageIndex = Math.floor(urlRow.ordinal / PER_PAGE);
      const incumbent = byPage.get(pageIndex) ?? null;
      if (urlRow.lastModified && (!incumbent || urlRow.lastModified > incumbent)) {
        byPage.set(pageIndex, urlRow.lastModified);
      } else if (!byPage.has(pageIndex)) {
        byPage.set(pageIndex, incumbent);
      }
    }
    return [...byPage.entries()]
      .sort(([left], [right]) => left - right)
      .map(([pageIndex, lastModified]) => ({
        pageIndex,
        lastModifiedIso: lastModified ? lastModified.toISOString() : null,
      }));
  }
  // The ordinal range read.
  const [start, end] = collectBoundNumbers(state.whereCondition);
  return store.urlRows
    .filter((urlRow) => urlRow.ordinal >= start && urlRow.ordinal < end)
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((urlRow) => ({ path: urlRow.path, lastModified: urlRow.lastModified }));
}

function rootSelectBuilder(fields: Record<string, unknown>) {
  const state: SelectState = { fields: Object.keys(fields), table: null, whereCondition: null, limit: null };
  const builder = {
    from(table: unknown) {
      state.table = table;
      return builder;
    },
    where(condition: unknown) {
      state.whereCondition = condition;
      return builder;
    },
    orderBy() {
      return builder;
    },
    groupBy() {
      return builder;
    },
    limit(limit: number) {
      state.limit = limit;
      return builder;
    },
    then(resolve: (rows: unknown[]) => unknown, reject: (reason: unknown) => unknown): Promise<unknown> {
      return new Promise<unknown[]>((innerResolve) => innerResolve(resolveRootSelect(state))).then(resolve, reject);
    },
  };
  return builder;
}

// Only `dbz` is provided, deliberately. If the store ever reached for `dbzRead`
// — a genuinely separate pool that can point at a replica — every test here would
// fail on `undefined`, which is the enforcement that replication lag never gets
// to feed the shrink guard a stale count or 503 a freshly advertised page.
vi.mock('@/app/lib/db/db', () => ({
  dbz: {
    select: (fields: Record<string, unknown>) => rootSelectBuilder(fields),
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
        insert: (table: unknown) => ({
          values: (rows: unknown) => {
            if (table === schema.sitemapClimbUrls) {
              const chunk = rows as (typeof store.urlWrites)[number];
              store.urlWrites.push(chunk);
              store.transactionOps.push(`insert-urls:${chunk.length}`);
              return Promise.resolve();
            }
            return {
              onConflictDoUpdate: async () => {
                const summary = rows as { itemCount: number; lastModified: Date | null };
                store.writes.push({ itemCount: summary.itemCount, lastModified: summary.lastModified });
                store.transactionOps.push('upsert-summary');
              },
            };
          },
        }),
        delete: (table: unknown) => {
          store.transactionOps.push(table === schema.sitemapClimbUrls ? 'delete-urls' : 'delete-unknown');
          return Promise.resolve();
        },
      }),
  },
}));

const {
  SITEMAP_CLIMB_STORE_MAX_AGE_MS,
  buildClimbShardPage,
  fetchClimbShardSummary,
  fetchStoredClimbPage,
  fetchStoredClimbPageLastmods,
  fetchStoredClimbRefresh,
  refreshClimbSitemapStore,
  refreshClimbStoreIfStale,
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

function storedUrlRows(count: number, firstOrdinal = 0): StoredUrlRow[] {
  return Array.from({ length: count }, (_, index) => ({
    ordinal: firstOrdinal + index,
    path: `/kilter/original/12x12/screw/40/view/stored-${firstOrdinal + index}`,
    lastModified: new Date('2026-05-04T11:22:33.000Z'),
  }));
}

beforeEach(() => {
  live.urlRows = liveUrlRows(52);
  live.buildCalls = 0;
  live.buildThrows = false;
  live.fallbackSummaryCalls = 0;
  live.fallbackItems = [];
  live.fallbackItemCalls = 0;
  store.row = null;
  store.urlRows = [];
  store.readThrows = false;
  store.locked = false;
  store.writes = [];
  store.urlWrites = [];
  store.transactionOps = [];
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
    expect(live.fallbackSummaryCalls).toBe(0);
    expect(live.buildCalls).toBe(0);
  });

  it('falls back to the live summary when nothing has been stored yet', async () => {
    // The first request after this deploy, and local dev. Never WORSE than main —
    // it is exactly main's path — but it is still the slow one, which is why the
    // rollout runs one refresh by hand.
    store.row = null;

    const summary = await fetchClimbShardSummary();

    expect(summary.itemCount).toBe(999);
    expect(live.fallbackSummaryCalls).toBe(1);
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
    expect(live.fallbackSummaryCalls).toBe(0);
    expect(errors.mock.calls.flat().join(' ')).toContain('stored climbs summary is');
    errors.mockRestore();
  });

  it('returns null rather than undefined when the table is empty', async () => {
    expect(await fetchStoredClimbRefresh()).toBeNull();
  });
});

describe('refreshing the store', () => {
  it('derives the summary from the built URL rows and stores both', async () => {
    live.urlRows = liveUrlRows(52, '2026-06-01T00:00:00.000Z');

    const result = await refreshClimbSitemapStore();

    expect(result.skipped).toBeNull();
    expect(result.itemCount).toBe(52);
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0].itemCount).toBe(52);
    // The MAX of the rows' timestamps, not the last row's — the newest item sits
    // mid-list in the fixture.
    expect(store.writes[0].lastModified).toEqual(new Date('2026-06-01T00:00:00.000Z'));
    expect(store.urlWrites.flat()).toHaveLength(52);
  });

  it('swaps the URL rows inside the SAME transaction, delete first', async () => {
    // One transaction is what gives the advertised count and the served rows a
    // single epoch — the cache-epoch disagreement the route handler 503s on.
    await refreshClimbSitemapStore();

    expect(store.transactionOps[0]).toBe('upsert-summary');
    expect(store.transactionOps[1]).toBe('delete-urls');
    expect(store.transactionOps.slice(2).every((op) => op.startsWith('insert-urls:'))).toBe(true);
  });

  it('chunks the URL insert at 1,000 rows and assigns contiguous 0-based ordinals', async () => {
    // 5 columns × ~52,000 rows in one .values() blows Postgres's 65,535
    // bind-parameter cap; 2,500 rows is the smallest fixture that proves both
    // the chunk boundary and the remainder.
    live.urlRows = liveUrlRows(2_500);

    await refreshClimbSitemapStore();

    expect(store.urlWrites.map((chunk) => chunk.length)).toEqual([1_000, 1_000, 500]);
    const flattened = store.urlWrites.flat();
    expect(flattened.map((urlRow) => urlRow.ordinal)).toEqual(Array.from({ length: 2_500 }, (_, index) => index));
    // Emission order is preserved — ordinal i carries the i-th built row.
    expect(flattened[1_500].path).toBe(live.urlRows[1_500].path);
    expect(flattened[0].boardType).toBe('kilter');
    expect(flattened[0].layoutId).toBe(1);
  });

  it('takes a TRANSACTION-scoped advisory lock, never a session-scoped one', async () => {
    // A session-scoped pg_try_advisory_lock is not mutual exclusion on a pooled
    // drizzle client — execute() and transaction() land on different connections,
    // so the writer would not hold the lock it took. sync-daemon-leases.ts
    // documents the same trap.
    await refreshClimbSitemapStore();

    const statements = store.executed.join(' ');
    expect(statements).toContain('pg_try_advisory_xact_lock');
    expect(statements).not.toContain('pg_try_advisory_lock');
    expect(statements).not.toContain('pg_advisory_unlock');
  });

  it('writes nothing when another writer holds the lock', async () => {
    store.locked = true;

    const result = await refreshClimbSitemapStore();

    expect(result.skipped).toBe('locked');
    expect(store.writes).toHaveLength(0);
    expect(store.urlWrites).toHaveLength(0);
    expect(store.transactionOps).not.toContain('delete-urls');
  });

  it('refuses to store zero rows even when forced', async () => {
    // A stored zero makes the index throw "expects URLs but its summary reports 0"
    // and drop the shard — the exact bug this table exists to prevent. The guard
    // covers the URL swap too: an empty build must never truncate the pages.
    live.urlRows = [];
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await refreshClimbSitemapStore({ force: true });

    expect(result.skipped).toBe('empty');
    expect(store.writes).toHaveLength(0);
    expect(store.transactionOps).not.toContain('delete-urls');
    errors.mockRestore();
  });

  it('refuses a >50% shrink and leaves both tables alone', async () => {
    store.row = storedRow({ itemCount: 52 });
    live.urlRows = liveUrlRows(20);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await refreshClimbSitemapStore();

    expect(result.skipped).toBe('shrank');
    expect(result.previousItemCount).toBe(52);
    expect(store.writes).toHaveLength(0);
    expect(store.transactionOps).not.toContain('delete-urls');
    expect(errors.mock.calls.flat().join(' ')).toContain('refusing to store a >50% shrink');
    errors.mockRestore();
  });

  it('accepts a shrink that stays inside the guard', async () => {
    store.row = storedRow({ itemCount: 52 });
    live.urlRows = liveUrlRows(40);

    const result = await refreshClimbSitemapStore();

    expect(result.skipped).toBeNull();
    expect(store.writes[0].itemCount).toBe(40);
  });

  it('lets ?force=1 through the shrink guard, so the guard cannot wedge the store', async () => {
    // Without a bypass, a real catalogue shrink would make every scheduled run
    // decline forever while the read path kept serving a frozen count.
    store.row = storedRow({ itemCount: 52 });
    live.urlRows = liveUrlRows(10);

    const result = await refreshClimbSitemapStore({ force: true });

    expect(result.skipped).toBeNull();
    expect(store.writes[0].itemCount).toBe(10);
    expect(store.urlWrites.flat()).toHaveLength(10);
  });

  it('does not clobber a newer answer another instance wrote while it was scanning', async () => {
    store.row = storedRow({ itemCount: 52_000, computedAt: new Date(Date.now() + 60_000) });

    const result = await refreshClimbSitemapStore();

    expect(result.skipped).toBe('superseded');
    expect(store.writes).toHaveLength(0);
    expect(store.transactionOps).not.toContain('delete-urls');
  });

  it('runs one scan for concurrent callers, not one per caller', async () => {
    // The cron and the after() self-heal can overlap on one instance, and the scan
    // is sixteen sequential heavy queries against a ten-connection pool (#4461).
    const [first, second] = await Promise.all([refreshClimbSitemapStore(), refreshClimbSitemapStore()]);

    expect(live.buildCalls).toBe(1);
    expect(first).toBe(second);
  });

  it('does not let a forced caller piggyback on an unforced scan', async () => {
    // Otherwise `?force=1` landing on an in-flight cron refresh would silently keep
    // the shrink guard and answer 409 — the escape hatch looking broken at exactly
    // the moment someone reached for it. Callers that disagree get their own scan.
    store.row = storedRow({ itemCount: 52 });
    live.urlRows = liveUrlRows(10);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const [unforced, forced] = await Promise.all([
      refreshClimbSitemapStore(),
      refreshClimbSitemapStore({ force: true }),
    ]);

    expect(unforced.skipped).toBe('shrank');
    expect(forced.skipped).toBeNull();
    expect(live.buildCalls).toBe(2);
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0].itemCount).toBe(10);
    errors.mockRestore();
  });
});

describe('reading a stored shard page', () => {
  it('serves a page as an ordinal range without the live build', async () => {
    store.urlRows = [...storedUrlRows(3), ...storedUrlRows(2, PER_PAGE)];

    const page = await fetchStoredClimbPage(2);

    expect(page).not.toBeNull();
    expect(page?.items.map((item) => item.path)).toEqual([
      `/kilter/original/12x12/screw/40/view/stored-${PER_PAGE}`,
      `/kilter/original/12x12/screw/40/view/stored-${PER_PAGE + 1}`,
    ]);
    expect(page?.totalItems).toBe(5);
    expect(live.fallbackItemCalls).toBe(0);
    expect(live.buildCalls).toBe(0);
  });

  it('returns null for an empty table, never an empty page', async () => {
    // "Never populated" is the caller's cue to fall back to the live build. An
    // empty SLICE of a populated table is NOT null — that verdict belongs to the
    // route handler, which has the summary in hand to tell tear from 404.
    store.urlRows = [];

    expect(await fetchStoredClimbPage(1)).toBeNull();
  });

  it('returns an empty slice with the real total for a page past the stored end', async () => {
    store.urlRows = storedUrlRows(3);

    const page = await fetchStoredClimbPage(2);

    expect(page?.items).toEqual([]);
    expect(page?.totalItems).toBe(3);
  });
});

describe('buildClimbShardPage', () => {
  it('serves from the store and never touches the live build', async () => {
    store.urlRows = storedUrlRows(3);

    const page = await buildClimbShardPage(1);

    expect(page.items).toHaveLength(3);
    expect(page.totalItems).toBe(3);
    expect(page.items[0].lastModified).toEqual(new Date('2026-05-04T11:22:33.000Z'));
    expect(live.fallbackItemCalls).toBe(0);
  });

  it('falls back to the live build, slicing the same way, when the store is empty', async () => {
    // The deploy that adds the table, a truncated store, local dev. This is the
    // 51 s path — correct, never worse than before the store existed, and the
    // reason the refresher exists.
    live.fallbackItems = Array.from({ length: PER_PAGE + 2 }, (_, index) => ({
      path: `/live-${index}`,
      lastModified: null,
    }));

    const page = await buildClimbShardPage(2);

    expect(live.fallbackItemCalls).toBe(1);
    expect(page.totalItems).toBe(PER_PAGE + 2);
    expect(page.items.map((item) => item.path)).toEqual([`/live-${PER_PAGE}`, `/live-${PER_PAGE + 1}`]);
  });

  it('falls back rather than propagating when the store read throws', async () => {
    // The realistic throw is the migration not yet applied; a page that 503s
    // because its speed-up is missing would be a worse outage than the slow path
    // it replaced.
    store.readThrows = true;
    live.fallbackItems = [{ path: '/live-0', lastModified: null }];
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const page = await buildClimbShardPage(1);

    expect(page.items.map((item) => item.path)).toEqual(['/live-0']);
    expect(errors.mock.calls.flat().join(' ')).toContain('could not read the stored climb URLs');
    errors.mockRestore();
  });
});

describe('per-page lastmods', () => {
  it('answers max(last_modified) per page, indexed by 0-based page', async () => {
    store.urlRows = [
      { ordinal: 0, path: '/a', lastModified: new Date('2026-01-01T00:00:00.000Z') },
      { ordinal: 1, path: '/b', lastModified: new Date('2026-03-01T00:00:00.000Z') },
      { ordinal: PER_PAGE, path: '/c', lastModified: new Date('2026-02-01T00:00:00.000Z') },
    ];

    const lastmods = await fetchStoredClimbPageLastmods();

    expect(lastmods).toHaveLength(2);
    expect(lastmods[0]).toEqual(new Date('2026-03-01T00:00:00.000Z'));
    expect(lastmods[1]).toEqual(new Date('2026-02-01T00:00:00.000Z'));
  });

  it('returns an empty list for an empty store, so the caller keeps the uniform value', async () => {
    expect(await fetchStoredClimbPageLastmods()).toEqual([]);
  });
});

describe('the after() self-heal', () => {
  it('refreshes an empty store', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await refreshClimbStoreIfStale();

    expect(live.buildCalls).toBe(1);
    expect(store.writes).toHaveLength(1);
    warnings.mockRestore();
  });

  it('does nothing when both tables are fresh', async () => {
    store.row = storedRow();
    store.urlRows = storedUrlRows(3);

    await refreshClimbStoreIfStale();

    expect(live.buildCalls).toBe(0);
  });

  it('refreshes when the summary is fresh but the URL table is empty', async () => {
    // The state every instance is in on the deploy that ADDS sitemap_climb_urls:
    // #4523's cron kept the summary row fresh, so a summary-only staleness check
    // would wait out the six-hourly cron while every page request took the 51 s
    // fallback. The probe is what closes that window on the first crawl.
    store.row = storedRow();
    store.urlRows = [];
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await refreshClimbStoreIfStale();

    expect(live.buildCalls).toBe(1);
    expect(warnings.mock.calls.flat().join(' ')).toContain('missing URL rows');
    warnings.mockRestore();
  });

  it('refreshes a store past the staleness bound', async () => {
    store.row = storedRow({ computedAt: new Date(Date.now() - SITEMAP_CLIMB_STORE_MAX_AGE_MS - 1_000) });
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await refreshClimbStoreIfStale();

    expect(live.buildCalls).toBe(1);
    warnings.mockRestore();
  });

  it('rate-limits itself so a store that cannot be written is not rebuilt per request', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await refreshClimbStoreIfStale();
    await refreshClimbStoreIfStale();
    await refreshClimbStoreIfStale();

    expect(live.buildCalls).toBe(1);
    warnings.mockRestore();
  });

  it('never throws into the caller — after() failures must not surface', async () => {
    store.readThrows = true;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(refreshClimbStoreIfStale()).resolves.toBeUndefined();

    expect(errors.mock.calls.flat().join(' ')).toContain('self-heal failed');
    errors.mockRestore();
  });

  it('swallows a scan that throws, and does not retry it on the next request', async () => {
    // The most operationally plausible failure here is the scan itself regressing,
    // not the store read. `after()` runs post-flush, so an escaping rejection would
    // be an unhandled one; and the 15-minute floor has to hold even for the attempt
    // that failed, or a broken scan runs on every /sitemap.xml hit.
    live.buildThrows = true;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(refreshClimbStoreIfStale()).resolves.toBeUndefined();
    await refreshClimbStoreIfStale();

    expect(live.buildCalls).toBe(1);
    expect(errors.mock.calls.flat().join(' ')).toContain('self-heal failed');
    errors.mockRestore();
  });

  it('propagates a scan error to a direct caller, so the cron route can 500', async () => {
    // The self-heal swallows; the endpoint must not. A cron that answers 200 on a
    // broken scan is a store that silently stops being refreshed.
    live.buildThrows = true;

    await expect(refreshClimbSitemapStore()).rejects.toThrow('tier-2 scan exploded');
    expect(store.writes).toHaveLength(0);
  });
});
