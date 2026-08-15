import { describe, expect, it, vi } from 'vite-plus/test';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';
import type { SitemapItem } from '../entries';
import { MAX_ITEMS_PER_SHARD } from '../sitemap-xml';

vi.mock('server-only', () => ({}));

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

const boardConfigs = vi.hoisted(() => ({ shouldThrow: false, empty: false, hang: false }));
const playlistRows = vi.hoisted(() => ({ count: 1, shouldThrow: false, hang: false }));
/** `static`, `gyms` and `setters` are pure builders — flags let all five fail at once. */
const pureBuilders = vi.hoisted(() => ({ shouldThrow: false, hang: false }));

/** Never settles: the failure mode a try/catch cannot see. */
const forever = <T>(): Promise<T> => new Promise<T>(() => {});

vi.mock('@/app/lib/server-popular-configs', () => ({
  getAllBoardConfigsOrThrow: async () => {
    if (boardConfigs.hang) {
      return forever<PopularBoardConfig[]>();
    }
    if (boardConfigs.shouldThrow) {
      throw new Error('backend unreachable');
    }
    return boardConfigs.empty ? [] : [KILTER_CONFIG];
  },
}));
vi.mock('../playlist-query', () => ({
  fetchPlaylistSitemapRows: async () => {
    if (playlistRows.hang) {
      return forever<never[]>();
    }
    if (playlistRows.shouldThrow) {
      throw new Error('playlist pool exhausted');
    }
    const updatedAt = new Date('2026-04-30T00:00:00.000Z');
    return Array.from({ length: playlistRows.count }, (_, index) => ({
      uuid: index === 0 ? 'abc-123' : `playlist-${index}`,
      updatedAt,
    }));
  },
}));

/**
 * The registry wraps these three in `async () => build()`, so handing back a
 * pending promise is what a hung I/O call looks like from the index's side once
 * it awaits — the cast is the price of faking that through a sync signature.
 */
const pureBuilder = (real: () => SitemapItem[]): SitemapItem[] => {
  if (pureBuilders.hang) {
    return forever<SitemapItem[]>() as unknown as SitemapItem[];
  }
  if (pureBuilders.shouldThrow) {
    throw new Error('pure builder exploded');
  }
  return real();
};

vi.mock('../static-entries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../static-entries')>();
  return { ...actual, buildStaticEntries: () => pureBuilder(actual.buildStaticEntries) };
});
vi.mock('../gym-entries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../gym-entries')>();
  return { ...actual, buildGymEntries: () => pureBuilder(actual.buildGymEntries) };
});
vi.mock('../setter-entries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../setter-entries')>();
  return { ...actual, buildSetterEntries: () => pureBuilder(actual.buildSetterEntries) };
});

const { INDEX_DEADLINE_MS, SHARD_DEADLINE_MS, buildSitemapIndexXml, shardRouteHandler, sitemapIndexRouteHandler } =
  await import('../shard-registry');

describe('shardRouteHandler', () => {
  it('serves a shard as application/xml with a CDN cache window', async () => {
    const response = await shardRouteHandler('static');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('public, s-maxage=3600, stale-while-revalidate=86400');
    expect(await response.text()).toContain('<urlset');
  });

  it('serves a declared-empty shard as a valid, empty urlset', async () => {
    const response = await shardRouteHandler('gyms');
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain('<urlset');
    expect(body).not.toContain('<url>');
  });

  it('answers 503 rather than a truncated 200 when a builder throws', async () => {
    // A short 200 tells Google the missing URLs were deleted; a 5xx makes it
    // retry and keep the last good copy.
    boardConfigs.shouldThrow = true;
    try {
      const response = await shardRouteHandler('boards');
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
    } finally {
      boardConfigs.shouldThrow = false;
    }
  });

  it('answers 503 when a shard that expects URLs builds none', async () => {
    // A poisoned cache or a regressed query makes the boards builder *succeed*
    // with zero rows. Serving that 200 drops ~2,600 URLs behind an hour of
    // s-maxage with nothing thrown, which is the failure the 503 doctrine exists
    // for — so an empty catalogue-derived shard fails closed too.
    boardConfigs.empty = true;
    try {
      const response = await shardRouteHandler('boards');
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
    } finally {
      boardConfigs.empty = false;
    }
  });

  it('answers 503 rather than serving a shard past the URL cap', async () => {
    // Search Console rejects a file over 50,000 URLs wholesale, so an
    // over-budget 200 loses the whole shard anyway — and silently. The constants
    // only mean something if the handler counts what it is about to serve.
    // One item past the item budget is, after locale expansion, past the URL cap.
    playlistRows.count = MAX_ITEMS_PER_SHARD + 1;
    try {
      const response = await shardRouteHandler('playlists');
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
    } finally {
      playlistRows.count = 1;
    }
  });

  it('still serves a shard sitting exactly on the URL cap', async () => {
    // The guard rejects `>` the cap, not `>=`: the budget is a size that ships,
    // not one that 503s the day a shard lands on it exactly.
    playlistRows.count = MAX_ITEMS_PER_SHARD;
    try {
      const response = await shardRouteHandler('playlists');
      expect(response.status).toBe(200);
    } finally {
      playlistRows.count = 1;
    }
  });
});

describe('buildSitemapIndexXml', () => {
  it('lists only the shards that carry URLs', async () => {
    const xml = await buildSitemapIndexXml();
    expect(xml).toContain('<sitemapindex');
    expect(xml).toContain('https://www.boardsesh.com/sitemaps/static.xml');
    expect(xml).toContain('https://www.boardsesh.com/sitemaps/boards.xml');
    expect(xml).toContain('https://www.boardsesh.com/sitemaps/playlists.xml');
    // gyms and setters are declared-empty, so they stay out of the index.
    expect(xml).not.toContain('/sitemaps/gyms.xml');
    expect(xml).not.toContain('/sitemaps/setters.xml');
  });

  it('serves the shards that built when one builder throws, and logs the one that did not', async () => {
    // #4476: the index was the one path that ran every builder inside a
    // `Promise.all`, so a cold boards fetch took static and playlists — which
    // were ready — down with it. A partial sitemap beats no sitemap, because
    // every shard the index does list is still served fail-closed at its own URL.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    boardConfigs.shouldThrow = true;
    try {
      const response = await sitemapIndexRouteHandler();
      const xml = await response.text();

      expect(response.status).toBe(200);
      expect(xml).toContain('/sitemaps/static.xml');
      expect(xml).toContain('/sitemaps/playlists.xml');
      expect(xml).not.toContain('/sitemaps/boards.xml');
      expect(errors.mock.calls.flat().join(' ')).toContain('backend unreachable');
    } finally {
      boardConfigs.shouldThrow = false;
      errors.mockRestore();
    }
  });

  it('omits — and logs — a shard that expects URLs but comes back empty', async () => {
    // Still a failure, still loud, but no longer fatal to the other four: the
    // shard's own route keeps 503ing on exactly this condition (above), which is
    // where the fail-closed promise is actually kept.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    boardConfigs.empty = true;
    try {
      const response = await sitemapIndexRouteHandler();
      const xml = await response.text();

      expect(response.status).toBe(200);
      expect(xml).toContain('/sitemaps/static.xml');
      expect(xml).not.toContain('/sitemaps/boards.xml');
      expect(errors.mock.calls.flat().join(' ')).toContain('expects URLs but built none');
    } finally {
      boardConfigs.empty = false;
      errors.mockRestore();
    }
  });

  it('answers 503 only when no shard built at all', async () => {
    // The floor under the degradation: an empty `<sitemapindex>` under an hour of
    // s-maxage says "this site has no sitemaps", which is the harm the whole
    // fail-closed doctrine exists to avoid.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    boardConfigs.shouldThrow = true;
    playlistRows.shouldThrow = true;
    pureBuilders.shouldThrow = true;
    try {
      const response = await sitemapIndexRouteHandler();

      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(errors.mock.calls.flat().join(' ')).toContain('5 of 5 builders failed');
    } finally {
      boardConfigs.shouldThrow = false;
      playlistRows.shouldThrow = false;
      pureBuilders.shouldThrow = false;
      errors.mockRestore();
    }
  });

  it('serves the rest of the index when a builder never settles', async () => {
    // The case a try/catch cannot see, and the one #4476 actually hit: a cold
    // backend does not reject, it stalls. Without a deadline this hangs the
    // request to the platform timeout, which 5xxes all five shards.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    boardConfigs.hang = true;
    try {
      const pending = sitemapIndexRouteHandler();
      await vi.advanceTimersByTimeAsync(SHARD_DEADLINE_MS + 1);
      const response = await pending;
      const xml = await response.text();

      expect(response.status).toBe(200);
      expect(xml).toContain('/sitemaps/static.xml');
      expect(xml).toContain('/sitemaps/playlists.xml');
      expect(xml).not.toContain('/sitemaps/boards.xml');
      expect(errors.mock.calls.flat().join(' ')).toContain(`exceeded its ${SHARD_DEADLINE_MS}ms deadline`);
    } finally {
      boardConfigs.hang = false;
      vi.useRealTimers();
      errors.mockRestore();
    }
  });

  it('bounds the whole walk by the index budget when every builder stalls', async () => {
    // Sequencing the shards is only safe because the walk carries a total
    // budget: five 3s deadlines back to back is 15s, past the serverless
    // ceiling, and a platform kill is the 5xx this change exists to remove.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    boardConfigs.hang = true;
    playlistRows.hang = true;
    pureBuilders.hang = true;
    try {
      const pending = sitemapIndexRouteHandler();
      await vi.advanceTimersByTimeAsync(INDEX_DEADLINE_MS + 1);
      const response = await pending;

      expect(response.status).toBe(503);
      expect(errors.mock.calls.flat().join(' ')).toContain(`spent its ${INDEX_DEADLINE_MS}ms budget`);
    } finally {
      boardConfigs.hang = false;
      playlistRows.hang = false;
      pureBuilders.hang = false;
      vi.useRealTimers();
      errors.mockRestore();
    }
  });

  it('still throws from the builder itself when nothing can be published', async () => {
    // `buildSitemapIndexXml` is the seam the route handler catches on, so the
    // throw has to survive the degradation rewrite — a builder that resolved to
    // an empty index would turn the 503 above into a 200.
    boardConfigs.shouldThrow = true;
    playlistRows.shouldThrow = true;
    pureBuilders.shouldThrow = true;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(buildSitemapIndexXml()).rejects.toThrow('refusing to publish an empty index');
    } finally {
      boardConfigs.shouldThrow = false;
      playlistRows.shouldThrow = false;
      pureBuilders.shouldThrow = false;
      errors.mockRestore();
    }
  });
});
