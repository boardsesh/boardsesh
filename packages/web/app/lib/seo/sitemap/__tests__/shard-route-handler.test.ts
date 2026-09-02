import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';
import type { SitemapItem } from '../entries';
import { expandAllLocales } from '../entries';
import { playlistRowsToItems } from '../playlist-entries';
import { CLIMB_URLS_PER_SHARD, MAX_ITEMS_PER_SHARD, MAX_SHARD_BYTES, renderUrlset } from '../sitemap-xml';

vi.mock('server-only', () => ({}));

const FULL_CACHE_CONTROL = 'public, s-maxage=3600, stale-while-revalidate=86400';
const DEGRADED_CACHE_CONTROL = 'public, s-maxage=60, must-revalidate';

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

const boardConfigs = vi.hoisted(() => ({ shouldThrow: false, empty: false, hang: false, delayMs: 0 }));
const playlistRows = vi.hoisted(() => ({ count: 1, uuidLength: 0, shouldThrow: false, hang: false, delayMs: 0 }));
const climbSummary = vi.hoisted(() => ({ itemCount: 25_000, shouldThrow: false, hang: false, delayMs: 0 }));
/** `static`, `gyms` and `setters` are pure builders — flags let the full index fail, or stall, at once. */
const pureBuilders = vi.hoisted(() => ({ shouldThrow: false, hang: false, delayMs: 0 }));

/** Never settles: the failure mode a try/catch cannot see. */
const forever = <T>(): Promise<T> => new Promise<T>(() => {});
/** Settles late: the failure mode a *total* budget turns into a starved shard. */
const after = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

vi.mock('@/app/lib/server-popular-configs', () => ({
  getAllBoardConfigsOrThrow: async () => {
    if (boardConfigs.hang) {
      return forever<PopularBoardConfig[]>();
    }
    if (boardConfigs.shouldThrow) {
      throw new Error('backend unreachable');
    }
    if (boardConfigs.delayMs > 0) {
      await after(boardConfigs.delayMs);
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
    if (playlistRows.delayMs > 0) {
      await after(playlistRows.delayMs);
    }
    const updatedAt = new Date('2026-04-30T00:00:00.000Z');
    return Array.from({ length: playlistRows.count }, (_, index) => {
      const uuid = index === 0 ? 'abc-123' : `playlist-${index}`;
      // `uuidLength` is how the byte-budget test buys expensive URLs without
      // building millions of cheap ones: the uuid lands in every `<loc>` and in
      // all four `xhtml:link` alternates of all four locale entries.
      return { uuid: playlistRows.uuidLength > 0 ? uuid.padEnd(playlistRows.uuidLength, 'x') : uuid, updatedAt };
    });
  },
}));

/**
 * The registry wraps these three in `async () => build()`, so handing back a
 * pending or delayed promise is what a hung/slow I/O call looks like from the
 * index's side once it awaits — the cast is the price of faking that through a
 * sync signature.
 */
const pureBuilder = (real: () => SitemapItem[]): SitemapItem[] => {
  if (pureBuilders.hang) {
    return forever<SitemapItem[]>() as unknown as SitemapItem[];
  }
  if (pureBuilders.shouldThrow) {
    throw new Error('pure builder exploded');
  }
  if (pureBuilders.delayMs > 0) {
    return after(pureBuilders.delayMs).then(real) as unknown as SitemapItem[];
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

vi.mock('../climb-store', () => ({
  fetchClimbShardSummary: async () => {
    if (climbSummary.hang) {
      return forever<never>();
    }
    if (climbSummary.shouldThrow) {
      throw new Error('climbs summary unavailable');
    }
    if (climbSummary.delayMs > 0) {
      await after(climbSummary.delayMs);
    }
    return { itemCount: climbSummary.itemCount, lastModified: new Date('2026-05-04T00:00:00.000Z') };
  },
  buildClimbShardPage: async () => ({ items: [], totalItems: 0 }),
  fetchStoredClimbPageLastmods: async () => [],
}));

const { SHARD_DEADLINE_MS, buildSitemapIndexXml, shardRouteHandler, sitemapIndexRouteHandler } =
  await import('../shard-registry');

let errors: string[] = [];
let warnings: string[] = [];

beforeEach(() => {
  vi.stubEnv('CLIMB_SITEMAPS_ENABLED', 'true');
  errors = [];
  warnings = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  });
});

/**
 * Resets live here rather than in each test's `finally`, which sits *downstream*
 * of an `await` that a regression can hang: when that happens the `finally` never
 * runs, and `vi.useFakeTimers()` plus the hang flags leak into every later test
 * in the file. A one-line regression then presents as three failures, two of them
 * red herrings.
 */
afterEach(() => {
  vi.useRealTimers();
  Object.assign(boardConfigs, { shouldThrow: false, empty: false, hang: false, delayMs: 0 });
  Object.assign(playlistRows, { count: 1, uuidLength: 0, shouldThrow: false, hang: false, delayMs: 0 });
  Object.assign(climbSummary, { itemCount: 25_000, shouldThrow: false, hang: false, delayMs: 0 });
  Object.assign(pureBuilders, { shouldThrow: false, hang: false, delayMs: 0 });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('shardRouteHandler', () => {
  it('serves a shard as application/xml with a CDN cache window', async () => {
    const response = await shardRouteHandler('static');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe(FULL_CACHE_CONTROL);
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

    const response = await shardRouteHandler('boards');

    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('answers 503 when a shard that expects URLs builds none', async () => {
    // A poisoned cache or a regressed query makes the boards builder *succeed*
    // with zero rows. Serving that 200 drops ~2,600 URLs behind an hour of
    // s-maxage with nothing thrown, which is the failure the 503 doctrine exists
    // for — so an empty catalogue-derived shard fails closed too.
    boardConfigs.empty = true;

    const response = await shardRouteHandler('boards');

    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('answers 503 rather than serving a shard past the URL cap', async () => {
    // Search Console rejects a file over 50,000 URLs wholesale, so an
    // over-budget 200 loses the whole shard anyway — and silently. The constants
    // only mean something if the handler counts what it is about to serve.
    // One item past the item budget is, after locale expansion, past the URL cap.
    playlistRows.count = MAX_ITEMS_PER_SHARD + 1;

    const response = await shardRouteHandler('playlists');

    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('answers 503 rather than serving a shard past the byte budget', async () => {
    // The half of the same rule the fixed path went without until #4648 (#4618):
    // `MAX_URLS_PER_SHARD` counts URLs and cannot see how expensive one is.
    // Past `MAX_SHARD_BYTES` Search Console rejects the file whole, so an
    // over-budget 200 loses the shard anyway — and silently.
    //
    // The fixture is sized from the real render rather than guessed, so raising
    // the budget cannot leave this passing while proving nothing. Deliberately
    // few, very expensive items: the URL cap must not be what fires.
    const uuidLength = 20_000;
    const bytesPerItem = Buffer.byteLength(
      renderUrlset(expandAllLocales(playlistRowsToItems([{ uuid: 'x'.repeat(uuidLength), updatedAt: new Date() }]))),
      'utf8',
    );
    playlistRows.uuidLength = uuidLength;
    playlistRows.count = Math.ceil(MAX_SHARD_BYTES / bytesPerItem) + 1;
    expect(playlistRows.count * 4).toBeLessThan(MAX_ITEMS_PER_SHARD * 4);

    const response = await shardRouteHandler('playlists');

    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('still serves a shard sitting exactly on the URL cap', async () => {
    // The guard rejects `>` the cap, not `>=`: the budget is a size that ships,
    // not one that 503s the day a shard lands on it exactly.
    playlistRows.count = MAX_ITEMS_PER_SHARD;

    const response = await shardRouteHandler('playlists');

    expect(response.status).toBe(200);
  });
});

describe('buildSitemapIndexXml', () => {
  it('lists only the shards that carry URLs, and says which it left out', async () => {
    const { xml, degradedShards } = await buildSitemapIndexXml();

    expect(xml).toContain('<sitemapindex');
    expect(xml).toContain('https://www.boardsesh.com/sitemaps/static.xml');
    expect(xml).toContain('https://www.boardsesh.com/sitemaps/boards.xml');
    expect(xml).toContain('https://www.boardsesh.com/sitemaps/playlists.xml');
    // gyms and setters are declared-empty, so they stay out of the index — but
    // "nobody has published a gym yet" and "the gyms query regressed to []" are
    // indistinguishable from here, so the omission is logged rather than silent.
    expect(xml).not.toContain('/sitemaps/gyms.xml');
    expect(xml).not.toContain('/sitemaps/setters.xml');
    expect(warnings.join(' ')).toContain('gyms, setters');
    // An empty shard is not a degradation: nothing failed, so the response keeps
    // the full cache window.
    expect(degradedShards).toEqual([]);
  });

  it('lists one climb page per CLIMB_URLS_PER_SHARD items the summary reports', async () => {
    // 25,000 items at a 10,000-URL page budget is three pages — derived, never
    // a hardcoded shard count.
    const { xml } = await buildSitemapIndexXml();
    const pages = Math.ceil(climbSummary.itemCount / CLIMB_URLS_PER_SHARD);
    for (let page = 1; page <= pages; page += 1) {
      expect(xml).toContain(`https://www.boardsesh.com/sitemaps/climbs/${page}.xml`);
    }
    expect(xml).not.toContain(`/sitemaps/climbs/${pages + 1}.xml`);
  });

  it('serves the shards that built when one builder throws, and logs the one that did not', async () => {
    // #4476: the index was the one path that ran every builder inside a
    // `Promise.all`, so a cold boards fetch took static and playlists — which
    // were ready — down with it. A partial sitemap beats no sitemap, because
    // every shard the index does list is still served fail-closed at its own URL.
    boardConfigs.shouldThrow = true;

    const response = await sitemapIndexRouteHandler();
    const xml = await response.text();

    expect(response.status).toBe(200);
    expect(xml).toContain('/sitemaps/static.xml');
    expect(xml).toContain('/sitemaps/playlists.xml');
    expect(xml).not.toContain('/sitemaps/boards.xml');
    expect(errors.join(' ')).toContain('backend unreachable');
  });

  it('caches a degraded index for a minute, where a complete one gets the full window', async () => {
    // The half that makes degradation safe. `s-maxage=3600` + a day of
    // stale-while-revalidate on a partial index turns one cold start into 25
    // hours of telling Google that boards.xml no longer exists — while the URL
    // serves perfectly the whole time. The 503 it replaced was `no-store` and so
    // was never cached at all, which is why the old copy at the edge was always
    // complete.
    const complete = await sitemapIndexRouteHandler();
    expect(complete.headers.get('cache-control')).toBe(FULL_CACHE_CONTROL);
    expect(complete.headers.get('x-sitemap-degraded')).toBeNull();

    boardConfigs.shouldThrow = true;
    const degraded = await sitemapIndexRouteHandler();

    expect(degraded.status).toBe(200);
    expect(degraded.headers.get('cache-control')).toBe(DEGRADED_CACHE_CONTROL);
    // Named on the response, not only in a log line: a silent partial index is
    // what would make the post-deploy smoke that caught #4476 permanently green.
    expect(degraded.headers.get('x-sitemap-degraded')).toBe('boards');
  });

  it('applies the same degraded response contract to the paged climbs summary', async () => {
    climbSummary.shouldThrow = true;

    const response = await sitemapIndexRouteHandler();
    const xml = await response.text();

    expect(response.status).toBe(200);
    expect(xml).toContain('/sitemaps/static.xml');
    expect(xml).not.toContain('/sitemaps/climbs/');
    expect(response.headers.get('cache-control')).toBe(DEGRADED_CACHE_CONTROL);
    expect(response.headers.get('x-sitemap-degraded')).toBe('climbs');
  });

  it('omits — and logs — a shard that expects URLs but comes back empty', async () => {
    // Still a failure, still loud, but no longer fatal to the other ready shards: the
    // shard's own route keeps 503ing on exactly this condition (above), which is
    // where the fail-closed promise is actually kept.
    boardConfigs.empty = true;

    const response = await sitemapIndexRouteHandler();
    const xml = await response.text();

    expect(response.status).toBe(200);
    expect(xml).toContain('/sitemaps/static.xml');
    expect(xml).not.toContain('/sitemaps/boards.xml');
    expect(response.headers.get('x-sitemap-degraded')).toBe('boards');
    expect(errors.join(' ')).toContain('expects URLs but built none');
  });

  it('omits a shard past the URL budget instead of advertising a URL that always 503s', async () => {
    // The shard route rejects an over-budget shard wholesale (above). An index
    // that keeps listing it points Googlebot at a URL that cannot succeed until
    // someone reads the logs, so the two layers apply the same rule.
    playlistRows.count = MAX_ITEMS_PER_SHARD + 1;

    const response = await sitemapIndexRouteHandler();
    const xml = await response.text();

    expect(response.status).toBe(200);
    expect(xml).toContain('/sitemaps/static.xml');
    expect(xml).not.toContain('/sitemaps/playlists.xml');
    expect(response.headers.get('x-sitemap-degraded')).toBe('playlists');
    expect(errors.join(' ')).toContain('past the 45000 budget');
  });

  it('answers 503 only when no shard built at all', async () => {
    // The floor under the degradation: an empty `<sitemapindex>` under an hour of
    // s-maxage says "this site has no sitemaps", which is the harm the whole
    // fail-closed doctrine exists to avoid.
    boardConfigs.shouldThrow = true;
    playlistRows.shouldThrow = true;
    climbSummary.shouldThrow = true;
    pureBuilders.shouldThrow = true;

    const response = await sitemapIndexRouteHandler();

    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(errors.join(' ')).toContain('6 of 6 builders failed');
  });

  it('serves the rest of the index when a builder never settles', async () => {
    // The case a try/catch cannot see: a builder that stalls rather than
    // rejecting holds the request to the platform timeout, which 5xxes all six
    // shards. `fetchPlaylistSitemapRows` has no bound of its own, so this is not
    // hypothetical.
    vi.useFakeTimers();
    boardConfigs.hang = true;

    const pending = sitemapIndexRouteHandler();
    await vi.advanceTimersByTimeAsync(SHARD_DEADLINE_MS + 1);
    const response = await pending;
    const xml = await response.text();

    expect(response.status).toBe(200);
    expect(xml).toContain('/sitemaps/static.xml');
    expect(xml).toContain('/sitemaps/playlists.xml');
    expect(xml).not.toContain('/sitemaps/boards.xml');
    expect(response.headers.get('cache-control')).toBe(DEGRADED_CACHE_CONTROL);
    expect(errors.join(' ')).toContain(`exceeded its ${SHARD_DEADLINE_MS}ms deadline`);
  });

  it('keeps every shard when all six are slow but each is inside its own deadline', async () => {
    // The walk is bounded by max(builder), not sum(builder). An earlier draft
    // sequenced the shards under a shared 8s budget, which made this exact case
    // drop `playlists` — last in the registry, so the deterministic victim —
    // even though every builder finished comfortably inside `SHARD_DEADLINE_MS`.
    // A shard must be omitted for its own latency, never for its position.
    vi.useFakeTimers();
    const slowButFine = SHARD_DEADLINE_MS - 1;
    boardConfigs.delayMs = slowButFine;
    playlistRows.delayMs = slowButFine;
    climbSummary.delayMs = slowButFine;
    pureBuilders.delayMs = slowButFine;

    const pending = sitemapIndexRouteHandler();
    await vi.advanceTimersByTimeAsync(SHARD_DEADLINE_MS);
    const response = await pending;
    const xml = await response.text();

    expect(response.status).toBe(200);
    expect(xml).toContain('/sitemaps/static.xml');
    expect(xml).toContain('/sitemaps/boards.xml');
    expect(xml).toContain('/sitemaps/playlists.xml');
    expect(response.headers.get('x-sitemap-degraded')).toBeNull();
    expect(response.headers.get('cache-control')).toBe(FULL_CACHE_CONTROL);
  });

  it('still throws from the builder itself when nothing can be published', async () => {
    // `buildSitemapIndexXml` is the seam the route handler catches on, so the
    // throw has to survive the degradation rewrite — a builder that resolved to
    // an empty index would turn the 503 above into a 200.
    boardConfigs.shouldThrow = true;
    playlistRows.shouldThrow = true;
    climbSummary.shouldThrow = true;
    pureBuilders.shouldThrow = true;

    await expect(buildSitemapIndexXml()).rejects.toThrow('refusing to publish an empty index');
  });
});

describe('locale expansion is observable in the rendered shard', () => {
  /**
   * The registry field alone is not the contract — the bytes Google fetches are.
   * `board-content-metadata-guard.test.ts` checks the registry declares
   * `default-locale-only`; this renders the shard and reads the XML, so a
   * regression in `expandForShard` (or the field being read from the wrong
   * place) cannot pass while the declaration still looks right.
   */
  beforeEach(() => {
    boardConfigs.shouldThrow = false;
    boardConfigs.empty = false;
    pureBuilders.shouldThrow = false;
  });

  it('boards.xml lists the English URL only, never the locale twins', async () => {
    const response = await shardRouteHandler('boards');
    const xml = await response.text();

    expect(response.status).toBe(200);
    expect(xml).toContain('<loc>');
    // The whole point of the change: no /de, /es or /fr climb-list URLs.
    expect(xml).not.toMatch(/<loc>[^<]*boardsesh\.com\/(de|es|fr)\//);
  });

  it('emits one URL per item with no alternates block, not one per locale', async () => {
    // Structural, not arithmetic: one board config expands to one item per angle,
    // so a hard-coded URL count would pin the angle list rather than the
    // expansion. `expandDefaultLocaleOnly` emits no `xhtml:link` alternates while
    // `expandAllLocales` emits one per locale on every entry — that difference is
    // the expansion, and it is stable whatever the item count.
    //
    // This is also what pins `expandedUrlCountForShard` against `expandForShard`
    // from the outside: the over-budget guard in `buildIndexEntry` counts with
    // the former while the route renders with the latter, and a 4x disagreement
    // would withhold a healthy shard from the index with a 503.
    const boardsXml = await (await shardRouteHandler('boards')).text();
    const staticXml = await (await shardRouteHandler('static')).text();

    expect(boardsXml).not.toContain('xhtml:link');
    // Same renderer, all-locales shard — proves the assertion above can fail.
    expect(staticXml).toContain('xhtml:link');
  });

  it('still fans static.xml out to every locale', async () => {
    // The counter-assertion: /about, /legal and /docs are genuinely translated,
    // so this carve-out must not have leaked across shards.
    const response = await shardRouteHandler('static');
    const xml = await response.text();

    expect(response.status).toBe(200);
    expect(xml).toMatch(/<loc>[^<]*boardsesh\.com\/de\//);
  });
});
