import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { playlistRowsToItems } from '../playlist-entries';
import { expandAllLocales, latestLastModified } from '../entries';
import { MAX_ITEMS_PER_SHARD, renderUrlset } from '../sitemap-xml';

vi.mock('server-only', () => ({}));

/**
 * Stands in for the whole read path, so every assertion below is about what
 * reached the pool rather than about what the mock was asked for.
 */
const reads = vi.hoisted(() => ({
  count: 0,
  inFlight: 0,
  maxInFlight: 0,
  /** Statements run before the select, in order — the statement-timeout oracle. */
  statements: [] as string[],
  /** Set to a rejected/pending promise to stall or fail the query. */
  gate: null as null | Promise<void>,
  rows: [] as { uuid: string; updatedAt: Date }[],
}));

vi.mock('@/app/lib/db/db', () => {
  const runSelect = async () => {
    reads.count += 1;
    reads.inFlight += 1;
    reads.maxInFlight = Math.max(reads.maxInFlight, reads.inFlight);
    try {
      // A real await point, so concurrent callers would actually overlap here
      // and show up in maxInFlight.
      await Promise.resolve();
      if (reads.gate) await reads.gate;
      return reads.rows;
    } finally {
      reads.inFlight -= 1;
    }
  };

  // Only the chain `buildPlaylistSitemapQuery` actually walks. Building the real
  // SQL is playlist-entries.test.ts's job (it renders `.toSQL()` off a real
  // drizzle handle); here the query is a stand-in for "one trip to Postgres".
  const builder: Record<string, unknown> = {};
  builder.select = () => builder;
  builder.from = () => builder;
  builder.where = () => builder;
  builder.orderBy = () => builder;
  builder.limit = () => runSelect();
  builder.execute = async (statement: { queryChunks?: { value?: string[] }[] }) => {
    reads.statements.push((statement.queryChunks ?? []).map((chunk) => (chunk.value ?? []).join('')).join(''));
  };

  return {
    dbzRead: {
      ...builder,
      transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(builder),
    },
  };
});

/**
 * The Data Cache as a JSON ROUND TRIP, deliberately not a pass-through.
 *
 * This is the oracle for the rehydration: `unstable_cache` serialises in
 * production, so a `Date` that goes in comes back a string and `renderLastMod`
 * TypeErrors on it. Delete the ISO/`new Date` pair in playlist-query.ts and the
 * first two tests below go red — a pass-through mock would let that ship.
 */
vi.mock('next/cache', () => ({
  unstable_cache: (fn: () => Promise<unknown>) => async (): Promise<unknown> => JSON.parse(JSON.stringify(await fn())),
}));

const { fetchPlaylistSitemapRows, resetPlaylistSitemapCacheForTests, warmPlaylistSitemapCache } =
  await import('../playlist-query');

const SOURCE_ROWS = [
  { uuid: 'abc-123', updatedAt: new Date('2026-04-30T10:00:00.123Z') },
  { uuid: 'def-456', updatedAt: new Date('2026-01-02T00:00:00.000Z') },
];

afterEach(() => {
  resetPlaylistSitemapCacheForTests();
  reads.count = 0;
  reads.inFlight = 0;
  reads.maxInFlight = 0;
  reads.statements = [];
  reads.gate = null;
  reads.rows = [];
  vi.restoreAllMocks();
});

describe('fetchPlaylistSitemapRows', () => {
  it('hands back real Date instances through the Data Cache round trip', async () => {
    reads.rows = SOURCE_ROWS;

    const rows = await fetchPlaylistSitemapRows();

    expect(rows[0].updatedAt).toBeInstanceOf(Date);
    // To the millisecond: the ISO round trip must not shift a timezone or round.
    expect(rows[0].updatedAt.getTime()).toBe(SOURCE_ROWS[0].updatedAt.getTime());
    expect(rows[1].updatedAt.toISOString()).toBe('2026-01-02T00:00:00.000Z');
  });

  it('renders through the real urlset without throwing', async () => {
    // The end-to-end proof, and the reason a cache here is not a one-liner:
    // `renderLastMod` calls `lastModified.toISOString()`, so a string timestamp
    // 503s /sitemaps/playlists.xml instead of merely serving a stale answer.
    reads.rows = SOURCE_ROWS;

    const items = playlistRowsToItems(await fetchPlaylistSitemapRows());
    const xml = renderUrlset(expandAllLocales(items));

    expect(xml).toContain('<loc>https://www.boardsesh.com/playlists/abc-123</loc>');
    expect(xml).toContain('<lastmod>2026-04-30T10:00:00.123Z</lastmod>');
    expect(latestLastModified(items)?.toISOString()).toBe('2026-04-30T10:00:00.123Z');
  });

  it('queries once and serves the second caller from the TTL cache', async () => {
    reads.rows = SOURCE_ROWS;

    const first = await fetchPlaylistSitemapRows();
    const second = await fetchPlaylistSitemapRows();

    expect(reads.count).toBe(1);
    // Same array identity: rehydration happens once per TTL, not per request.
    expect(second).toBe(first);
  });

  it('collapses concurrent cold callers into one query', async () => {
    // A crawl burst is /sitemap.xml and /sitemaps/playlists.xml arriving
    // together; `unstable_cache` does not deduplicate concurrent misses.
    reads.rows = SOURCE_ROWS;
    let release = () => {};
    reads.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const inFlight = Promise.all([fetchPlaylistSitemapRows(), fetchPlaylistSitemapRows(), fetchPlaylistSitemapRows()]);
    release();
    const [first, second, third] = await inFlight;

    expect(reads.count).toBe(1);
    expect(reads.maxInFlight).toBe(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('does not memoise a failed query', async () => {
    reads.rows = SOURCE_ROWS;
    reads.gate = Promise.reject(new Error('pool exhausted'));

    await expect(fetchPlaylistSitemapRows()).rejects.toThrow('pool exhausted');

    reads.gate = null;
    await expect(fetchPlaylistSitemapRows()).resolves.toHaveLength(2);
    expect(reads.count).toBe(2);
  });

  it('warns rather than truncating silently when the shard fills its item budget', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reads.rows = Array.from({ length: MAX_ITEMS_PER_SHARD }, (_row, index) => ({
      uuid: `playlist-${index}`,
      updatedAt: new Date('2026-04-30T10:00:00.000Z'),
    }));

    await fetchPlaylistSitemapRows();

    expect(warn.mock.calls.some(([message]) => String(message).includes('item budget'))).toBe(true);
  });

  it('bounds the query with a statement timeout before it selects anything', async () => {
    // `withDeadline` stops waiting at 3 s but does not cancel, so an abandoned
    // query would otherwise hold a connection out of a pool of ten indefinitely.
    reads.rows = SOURCE_ROWS;

    await fetchPlaylistSitemapRows();

    expect(reads.statements).toEqual(["SET LOCAL statement_timeout = '15s'"]);
    expect(reads.count).toBe(1);
  });
});

describe('warmPlaylistSitemapCache', () => {
  it('populates the cache so the next request costs nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    reads.rows = SOURCE_ROWS;

    await warmPlaylistSitemapCache();
    await fetchPlaylistSitemapRows();

    expect(reads.count).toBe(1);
  });

  it('no-ops on a fresh cache', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    reads.rows = SOURCE_ROWS;
    await fetchPlaylistSitemapRows();

    await warmPlaylistSitemapCache();

    expect(reads.count).toBe(1);
  });

  it('resolves rather than throwing when the query fails', async () => {
    // It runs inside `after()`; a rejection there is a logged task error on a
    // response that has already flushed.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    reads.gate = Promise.reject(new Error('pool exhausted'));

    await expect(warmPlaylistSitemapCache()).resolves.toBeUndefined();
    expect(error.mock.calls.some(([message]) => String(message).includes('warming the playlists'))).toBe(true);
  });

  it('holds a failing query off behind the retry floor instead of re-running per crawl hit', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    reads.gate = Promise.reject(new Error('pool exhausted'));

    await warmPlaylistSitemapCache();
    await warmPlaylistSitemapCache();
    await warmPlaylistSitemapCache();

    expect(reads.count).toBe(1);
  });
});
