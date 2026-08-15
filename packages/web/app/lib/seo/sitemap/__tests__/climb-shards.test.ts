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
  summaryThrows: false,
  buildThrows: false,
  buildsEmpty: false,
  pathLength: 0,
  buildCalls: 0,
}));

vi.mock('../climb-query', () => ({
  fetchTier2Summary: async () => {
    if (climbs.summaryThrows) throw new Error('climbs summary unavailable');
    return { itemCount: climbs.itemCount, lastModified: new Date('2026-05-04T11:22:33.000Z') };
  },
  buildTier2ClimbItems: async () => {
    climbs.buildCalls += 1;
    if (climbs.buildThrows) throw new Error('climbs builder exploded');
    if (climbs.buildsEmpty) return [];
    // Padding lives in the PATH, so the byte guard is driven by a real rendered
    // body rather than by mutating the constant it is supposed to enforce.
    const padding = climbs.pathLength > 0 ? 'x'.repeat(climbs.pathLength) : '';
    return Array.from({ length: climbs.itemCount }, (_, index) => ({
      path: `/kilter/original/12x12-square/screw_bolt/40/view/climb-${index}${padding}`,
      lastModified: new Date('2026-05-04T11:22:33.000Z'),
    })) satisfies SitemapItem[];
  },
}));

const { PAGED_SHARD_REGISTRY, buildSitemapIndexXml, pagedShardRouteHandler } = await import('../shard-registry');

beforeEach(() => {
  climbs.itemCount = 3;
  climbs.summaryThrows = false;
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
    for (const page of ['0.xml', 'abc.xml', '1.txt', '999.xml', '-1.xml']) {
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
    // quietly broken later: a 128k-row scan on every /sitemap.xml hit is the
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

  it('omits the climb pages entirely when there are none', async () => {
    climbs.itemCount = 0;

    const { xml, degradedShards } = await buildSitemapIndexXml();

    expect(xml).toContain('/sitemaps/static.xml');
    expect(xml).not.toContain('/sitemaps/climbs/');
    expect(degradedShards).toContain('climbs');
  });
});

describe('the deferred work stays deferred', () => {
  it('ships no VideoObject anywhere in a climb shard body', async () => {
    const body = await (await pagedShardRouteHandler('climbs', '1.xml')).text();
    expect(body).not.toContain('VideoObject');
  });
});
