import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';
import { CLIMB_URLS_PER_SHARD, MAX_SHARD_BYTES } from '../sitemap-xml';
import type { SitemapItem } from '../entries';

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

vi.mock('@/app/lib/server-popular-configs', () => ({
  getAllBoardConfigsOrThrow: async () => [KILTER_CONFIG],
}));
vi.mock('../playlist-query', () => ({
  fetchPlaylistSitemapRows: async () => [{ uuid: 'abc-123', updatedAt: new Date('2026-04-30T00:00:00.000Z') }],
}));

const LAST_MODIFIED = new Date('2026-05-04T11:22:33.000Z');

const climbs = vi.hoisted(() => ({
  itemCount: 3,
  /** Length of the list the BUILD returns; null means "same as itemCount". */
  builtCount: null as number | null,
  summaryThrows: false,
  summaryHangs: false,
  buildThrows: false,
  buildsEmpty: false,
  pathLength: 0,
  buildCalls: 0,
}));

vi.mock('../climb-query', () => ({
  fetchTier2Summary: async () => {
    if (climbs.summaryThrows) throw new Error('climbs summary unavailable');
    // A summary that never settles: the failure a try/catch cannot see.
    if (climbs.summaryHangs) return new Promise<never>(() => {});
    return { itemCount: climbs.itemCount, lastModified: new Date('2026-05-04T11:22:33.000Z') };
  },
  buildTier2ClimbItems: async () => {
    climbs.buildCalls += 1;
    if (climbs.buildThrows) throw new Error('climbs builder exploded');
    if (climbs.buildsEmpty) return [];
    // Padding lives in the PATH, so the byte guard is driven by a real rendered
    // body rather than by mutating the constant it is supposed to enforce.
    const padding = climbs.pathLength > 0 ? 'x'.repeat(climbs.pathLength) : '';
    return Array.from({ length: climbs.builtCount ?? climbs.itemCount }, (_, index) => ({
      path: `/kilter/original/12x12-square/screw_bolt/40/view/climb-${index}${padding}`,
      lastModified: new Date('2026-05-04T11:22:33.000Z'),
    })) satisfies SitemapItem[];
  },
}));

const { PAGED_SHARD_REGISTRY, buildSitemapIndexXml, pagedShardRouteHandler } = await import('../shard-registry');

beforeEach(() => {
  climbs.itemCount = 3;
  climbs.builtCount = null;
  climbs.summaryThrows = false;
  climbs.summaryHangs = false;
  climbs.buildThrows = false;
  climbs.buildsEmpty = false;
  climbs.pathLength = 0;
  climbs.buildCalls = 0;
});

describe('the paged climbs shard', () => {
  it('registers one paged shard, default-locale-only, on its own cache window', () => {
    expect(PAGED_SHARD_REGISTRY).toHaveLength(1);
    const [shard] = PAGED_SHARD_REGISTRY;
    expect(shard.id).toBe('climbs');
    expect(shard.routeDirectory).toBe('climbs');
    expect(shard.expansion).toBe('default-locale-only');
    expect(shard.urlsPerShard).toBe(CLIMB_URLS_PER_SHARD);
    expect(shard.expectsUrls).toBe(true);
    expect(shard.pagePath(2)).toBe('/sitemaps/climbs/2.xml');
  });

  it('serves a page as application/xml on the long climb cache window', async () => {
    const response = await pagedShardRouteHandler('climbs', '1.xml');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('public, s-maxage=21600, stale-while-revalidate=604800');
    expect(await response.text()).toContain('<urlset');
  });

  it('emits one URL per climb with no hreflang block and no xhtml namespace', async () => {
    // The whole reason the climb shards exist in this shape: four locales with a
    // five-entry alternates block each is ~36 MB per 45k-URL shard.
    const body = await (await pagedShardRouteHandler('climbs', '1.xml')).text();

    expect(body.match(/<url>/g)).toHaveLength(3);
    expect(body).not.toContain('xmlns:xhtml');
    expect(body).not.toContain('<xhtml:link');
    expect(body).not.toContain('/es/kilter/');
    expect(body).toContain('<lastmod>2026-05-04T11:22:33.000Z</lastmod>');
  });

  it('404s a malformed or out-of-range page rather than 503ing it', async () => {
    // A page that was never valid is not transient: 503 would have the crawler
    // retry forever.
    // The zero-padded forms are the same doctrine: `Number('007')` is 7, so a
    // `\\d+` parser gives every real page an unbounded family of alias URLs that
    // each 200 under the six-hour cache header and each look to Search Console
    // like a separate submission of the same URLs.
    for (const page of ['0.xml', 'abc.xml', '1.txt', '999.xml', '-1.xml', '01.xml', '007.xml', '0000001.xml']) {
      const response = await pagedShardRouteHandler('climbs', page);
      expect(response.status, page).toBe(404);
      expect(response.headers.get('cache-control'), page).toBe('no-store');
    }
  });

  it('derives the page count from the summary — never from a hardcoded number', async () => {
    climbs.itemCount = 0;
    expect((await pagedShardRouteHandler('climbs', '1.xml')).status).toBe(404);

    climbs.itemCount = CLIMB_URLS_PER_SHARD;
    expect((await pagedShardRouteHandler('climbs', '1.xml')).status).toBe(200);
    expect((await pagedShardRouteHandler('climbs', '2.xml')).status).toBe(404);

    climbs.itemCount = CLIMB_URLS_PER_SHARD + 1;
    expect((await pagedShardRouteHandler('climbs', '2.xml')).status).toBe(200);
    expect((await pagedShardRouteHandler('climbs', '3.xml')).status).toBe(404);
  });

  it('503s rather than serving a body past the response-payload ceiling', async () => {
    // Driven by a fixture of long paths, not by mutating MAX_SHARD_BYTES: the
    // guard has to measure the body it is about to serve.
    climbs.itemCount = CLIMB_URLS_PER_SHARD;
    climbs.pathLength = 500;

    const response = await pagedShardRouteHandler('climbs', '1.xml');

    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(CLIMB_URLS_PER_SHARD * 500).toBeGreaterThan(MAX_SHARD_BYTES);
  });

  it('503s when the builder throws', async () => {
    climbs.buildThrows = true;
    const response = await pagedShardRouteHandler('climbs', '1.xml');
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('503s when a page the summary listed builds nothing', async () => {
    climbs.buildsEmpty = true;
    const response = await pagedShardRouteHandler('climbs', '1.xml');
    expect(response.status).toBe(503);
  });

  it('503s until an older item epoch catches up with a summary-advertised page', async () => {
    // The summary lives in the Next Data Cache (global) and the item list in an
    // in-process TTL (per instance), so their epochs are independent: a warm
    // instance holding exactly one page of items can meet a refreshed summary
    // reporting one more. The page is newly valid, so 404 would tell Googlebot a
    // transiently empty cached slice is permanently absent.
    climbs.itemCount = CLIMB_URLS_PER_SHARD + 1;
    climbs.builtCount = CLIMB_URLS_PER_SHARD;

    const response = await pagedShardRouteHandler('climbs', '2.xml');

    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('503s the shard when the summary itself fails', async () => {
    climbs.summaryThrows = true;
    expect((await pagedShardRouteHandler('climbs', '1.xml')).status).toBe(503);
  });
});

describe('the index and the climbs shard', () => {
  it('lists one <sitemap> per derived page and stamps the summary timestamp', async () => {
    climbs.itemCount = CLIMB_URLS_PER_SHARD + 1;

    const { xml } = await buildSitemapIndexXml();

    expect(xml).toContain('https://www.boardsesh.com/sitemaps/climbs/1.xml');
    expect(xml).toContain('https://www.boardsesh.com/sitemaps/climbs/2.xml');
    expect(xml).not.toContain('/sitemaps/climbs/3.xml');
    expect(xml).toContain(`<lastmod>${LAST_MODIFIED.toISOString()}</lastmod>`);
  });

  it('NEVER builds the items to render the index', async () => {
    // The pool-starvation guard (#4461), and the assertion most likely to be
    // quietly broken later: the full grouped item build on every /sitemap.xml hit is the
    // failure this whole summary/build split exists to avoid.
    await buildSitemapIndexXml();

    expect(climbs.buildCalls).toBe(0);
  });

  it('degrades to a partial index when the climbs summary fails, instead of 503ing everything', async () => {
    // A failing climbs summary must not take static, boards and playlists down
    // with it. A partial sitemap beats no sitemap, and Google refetches.
    climbs.summaryThrows = true;

    const { xml, degradedShards } = await buildSitemapIndexXml();

    expect(xml).toContain('<sitemapindex');
    expect(xml).toContain('https://www.boardsesh.com/sitemaps/static.xml');
    expect(xml).toContain('https://www.boardsesh.com/sitemaps/boards.xml');
    expect(xml).toContain('https://www.boardsesh.com/sitemaps/playlists.xml');
    expect(xml).not.toContain('/sitemaps/climbs/');
    expect(degradedShards).toContain('climbs');
  });

  it('degrades the same way when the climbs summary HANGS rather than throwing', async () => {
    // A try/catch only covers a summary that rejects. A stalled one — the
    // saturated-pool case, #4461/#4476 — would otherwise hang the index to the
    // platform timeout, which is a 5xx on all six shards: strictly worse than the
    // 503 ruling 4 was written to prevent.
    climbs.summaryHangs = true;

    const { xml, degradedShards } = await Promise.race([
      buildSitemapIndexXml(),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('index hung')), 10_000)),
    ]);

    expect(xml).toContain('<sitemapindex');
    expect(xml).toContain('https://www.boardsesh.com/sitemaps/static.xml');
    expect(xml).not.toContain('/sitemaps/climbs/');
    expect(degradedShards).toContain('climbs');
  }, 15_000);

  it('omits the climb pages when there are none, but says so loudly', async () => {
    // Still a 200 — the index degrades rather than 503ing. But a shard that
    // expects URLs and reports zero has lost its whole surface, and dropping
    // every tier-2 URL behind six hours of s-maxage with nothing in the logs is how
    // that goes unnoticed until Search Console reports them removed.
    climbs.itemCount = 0;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { xml, degradedShards } = await buildSitemapIndexXml();

    expect(xml).toContain('/sitemaps/static.xml');
    expect(xml).not.toContain('/sitemaps/climbs/');
    expect(degradedShards).toContain('climbs');
    expect(errors.mock.calls.flat().join(' ')).toContain('expects URLs but its summary reports 0');
    errors.mockRestore();
  });
});

describe('the deferred work stays deferred', () => {
  it('is still tier 2, and the shard body carries no video namespace', async () => {
    // Deliberately NOT a `not.toContain('VideoObject')` on this body: it is a
    // `<urlset>` built from paths and dates, so no change to any source file in
    // this PR could put a JSON-LD type name into it — an assertion that cannot
    // fail. The real VideoObject pin lives in json-ld-payloads.test.tsx, over the
    // payloads that could actually carry one. What a climb shard CAN violate is
    // the video sitemap extension, so pin that. (`TIER_2_MIN_ASCENTS === 10` is
    // pinned in climb-query.test.ts, against the real module rather than a mock.)
    const body = await (await pagedShardRouteHandler('climbs', '1.xml')).text();

    expect(body).not.toContain('<video:');
    expect(body).not.toContain('xmlns:video');
  });
});
