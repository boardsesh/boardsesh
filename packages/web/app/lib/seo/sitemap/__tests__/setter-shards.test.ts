import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';
import { SETTER_URLS_PER_SHARD } from '../sitemap-xml';
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
vi.mock('../climb-query', () => ({
  fetchTier2Summary: async () => ({ itemCount: 0, lastModified: null }),
  buildTier2ClimbItems: async () => [],
}));

const LAST_MODIFIED = new Date('2026-05-04T11:22:33.000Z');

const setters = vi.hoisted(() => ({ itemCount: 25_000 }));

vi.mock('../setter-query', () => ({
  fetchSetterSitemapSummary: async () => ({
    itemCount: setters.itemCount,
    lastModified: new Date('2026-05-04T11:22:33.000Z'),
  }),
  buildSetterSitemapItems: async () =>
    Array.from({ length: setters.itemCount }, (_, index) => ({
      path: `/setter/climber-${index}`,
      lastModified: new Date('2026-05-04T11:22:33.000Z'),
    })) satisfies SitemapItem[],
}));

const { PAGED_SHARD_REGISTRY, buildSitemapIndexXml, pagedShardRouteHandler } = await import('../shard-registry');

beforeEach(() => {
  setters.itemCount = 25_000;
});

describe('the paged setters shard', () => {
  it('is registered as a PAGED shard, not a fixed one', () => {
    // The fixed handler hardcodes `expandAllLocales`, and a setter `<url>`
    // fanned out to four locales with a five-entry alternates block each runs
    // ~2.4 kB per item — about 27 MB on one 11,250-item page, against a 4 MB
    // ceiling. That is why filling the old `buildSetterEntries()` could not work.
    const shard = PAGED_SHARD_REGISTRY.find((candidate) => candidate.id === 'setters');
    expect(shard).toBeDefined();
    expect(shard?.routeDirectory).toBe('setters');
    expect(shard?.expansion).toBe('default-locale-only');
    expect(shard?.urlsPerShard).toBe(SETTER_URLS_PER_SHARD);
    expect(shard?.expectsUrls).toBe(true);
    expect(shard?.pagePath(2)).toBe('/sitemaps/setters/2.xml');
  });

  it('slices the last page short rather than padding or repeating', async () => {
    // 25,000 items at 10,000 per page: pages 1 and 2 are full, page 3 holds the
    // remaining 5,000. An off-by-one in the slice shows up here as 10,000 or 0.
    const lastPage = await (await pagedShardRouteHandler('setters', '3.xml')).text();
    expect(lastPage.match(/<url>/g)).toHaveLength(setters.itemCount % SETTER_URLS_PER_SHARD);

    const firstPage = await (await pagedShardRouteHandler('setters', '1.xml')).text();
    expect(firstPage.match(/<url>/g)).toHaveLength(SETTER_URLS_PER_SHARD);
    expect(firstPage).toContain('<loc>https://www.boardsesh.com/setter/climber-0</loc>');
    expect(lastPage).not.toContain('<loc>https://www.boardsesh.com/setter/climber-0</loc>');
  });

  it('404s the page past the end rather than serving an empty urlset', async () => {
    // An empty `<urlset>` on a page the index advertises tells Google the
    // surface was deleted; a 404 tells a crawler to stop asking.
    const response = await pagedShardRouteHandler('setters', '4.xml');

    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('emits one URL per setter with no hreflang block and no xhtml namespace', async () => {
    setters.itemCount = 2;

    const body = await (await pagedShardRouteHandler('setters', '1.xml')).text();

    expect(body.match(/<url>/g)).toHaveLength(2);
    expect(body).not.toContain('xmlns:xhtml');
    expect(body).not.toContain('<xhtml:link');
    expect(body).not.toContain('/es/setter/');
    expect(body).toContain(`<lastmod>${LAST_MODIFIED.toISOString()}</lastmod>`);
  });

  it('lists one index entry per page, derived from the summary', async () => {
    const { xml } = await buildSitemapIndexXml();
    const pages = Math.ceil(setters.itemCount / SETTER_URLS_PER_SHARD);

    for (let page = 1; page <= pages; page += 1) {
      expect(xml).toContain(`https://www.boardsesh.com/sitemaps/setters/${page}.xml`);
    }
    expect(xml).not.toContain(`/sitemaps/setters/${pages + 1}.xml`);
    // The old fixed URL is gone; an index still pointing at it would advertise a
    // route that no longer exists.
    expect(xml).not.toContain('/sitemaps/setters.xml');
  });
});
