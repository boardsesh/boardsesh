import { gunzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';
import { SETTER_URLS_PER_SHARD } from '../sitemap-xml';
import type { SitemapItem } from '../entries';

vi.mock('server-only', () => ({}));
// Authorization is exercised separately in privacy-filter.test.ts.
const visibility = vi.hoisted(() => ({ hidden: false, checks: 0 }));
vi.mock('../privacy-filter', () => ({
  filterPublicSitemapItems: async <Item>(items: Item[]) => {
    visibility.checks += 1;
    return visibility.hidden ? [] : items;
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

// `shard-registry` reads the boards shard through `board-config-source` now
// (#4493), and that module's body opens a pool. Same trap as `climb-store`
// below: without this the suite fails to load on `DATABASE_URL` before a single
// assertion runs.
vi.mock('../board-config-source', () => ({
  getSitemapClimbConfigsOrThrow: async () => [KILTER_CONFIG],
  getBoardsShardConfigsOrThrow: async () => [KILTER_CONFIG],
}));
vi.mock('@/app/lib/server-popular-configs', () => ({
  getAllBoardConfigsOrThrow: async () => [KILTER_CONFIG],
}));
vi.mock('../playlist-query', () => ({
  fetchPlaylistSitemapRows: async () => [{ uuid: 'abc-123', updatedAt: new Date('2026-04-30T00:00:00.000Z') }],
}));
// The climbs shard reads the materialised store now (#4552), not `climb-query`
// — and `shard-registry` imports `climb-store`, whose module body opens a pool.
// Without this mock the whole suite fails to load with "DATABASE_URL ... is
// required" before a single assertion runs.
//
// One healthy climb page, because `climbs` is `expectsUrls`: a zero-item
// summary would degrade it, and every assertion below reads the degrade state
// of the SETTERS shard.
vi.mock('../climb-store', () => ({
  fetchClimbShardSummary: async () => ({
    itemCount: 1,
    lastModified: new Date('2026-05-04T11:22:33.000Z'),
    source: 'store' as const,
  }),
  buildClimbShardPage: async () => ({
    items: [
      {
        path: '/kilter/original/12x12-square/screw_bolt/40/view/climb-0',
        lastModified: new Date('2026-05-04T11:22:33.000Z'),
      },
    ] satisfies SitemapItem[],
    totalItems: 1,
    source: 'store' as const,
  }),
  fetchStoredClimbPageLastmods: async () => [],
}));

const LAST_MODIFIED = new Date('2026-05-04T11:22:33.000Z');

const setters = vi.hoisted(() => ({ itemCount: 25_000, buildCalls: 0, summaryThrows: false }));

vi.mock('../setter-query', () => ({
  fetchSetterSitemapSummary: async () => {
    if (setters.summaryThrows) throw new Error('setters summary unavailable');
    return {
      itemCount: setters.itemCount,
      lastModified: new Date('2026-05-04T11:22:33.000Z'),
    };
  },
  buildSetterSitemapItems: async () => {
    setters.buildCalls += 1;
    return Array.from({ length: setters.itemCount }, (_, index) => ({
      path: `/setter/climber-${index}`,
      lastModified: new Date('2026-05-04T11:22:33.000Z'),
    })) satisfies SitemapItem[];
  },
}));

const { PAGED_SHARD_REGISTRY, buildSitemapIndexXml, pagedShardRouteHandler } = await import('../shard-registry');

async function readGzipXml(response: Response): Promise<string> {
  return gunzipSync(Buffer.from(await response.arrayBuffer())).toString('utf8');
}

beforeEach(() => {
  setters.itemCount = 25_000;
  setters.buildCalls = 0;
  setters.summaryThrows = false;
  visibility.hidden = false;
  visibility.checks = 0;
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
    expect(shard?.pagePath(2)).toBe('/sitemaps/setters/2.xml.gz');
  });

  it('slices the last page short rather than padding or repeating', async () => {
    // 25,000 items at 10,000 per page: pages 1 and 2 are full, page 3 holds the
    // remaining 5,000. An off-by-one in the slice shows up here as 10,000 or 0.
    const lastPage = await readGzipXml(await pagedShardRouteHandler('setters', '3.xml.gz'));
    expect(lastPage.match(/<url>/g)).toHaveLength(setters.itemCount % SETTER_URLS_PER_SHARD);

    const firstPage = await readGzipXml(await pagedShardRouteHandler('setters', '1.xml.gz'));
    expect(firstPage.match(/<url>/g)).toHaveLength(SETTER_URLS_PER_SHARD);
    expect(firstPage).toContain('<loc>https://www.boardsesh.com/setter/climber-0</loc>');
    expect(lastPage).not.toContain('<loc>https://www.boardsesh.com/setter/climber-0</loc>');
  });

  it('ends cleanly when the count divides exactly, with no empty trailing page', async () => {
    // The boundary the 25,000 cases cannot reach: at an exact multiple the last
    // page is FULL, so `ceil()` and a `floor() + 1` agree everywhere except
    // here, where the latter advertises one more page than exists. That page
    // would render an empty `<urlset>` — the signal that tells Google the
    // surface was deleted.
    setters.itemCount = 3 * SETTER_URLS_PER_SHARD;

    const lastPage = await pagedShardRouteHandler('setters', '3.xml.gz');
    expect(lastPage.status).toBe(200);
    expect((await readGzipXml(lastPage)).match(/<url>/g)).toHaveLength(SETTER_URLS_PER_SHARD);

    const pastEnd = await pagedShardRouteHandler('setters', '4.xml.gz');
    expect(pastEnd.status).toBe(404);

    const index = await buildSitemapIndexXml();
    expect(index.xml.match(/\/sitemaps\/setters\//g)).toHaveLength(3);
  });

  it('keeps privacy-filtered setter pages out of shared caches', async () => {
    // Unlisting, moderation or spray-wall changes can withdraw these URLs.
    const response = await pagedShardRouteHandler('setters', '1.xml.gz');

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('redirects legacy XML to gzip without building or publishing setter URLs', async () => {
    const response = await pagedShardRouteHandler('setters', '3.xml');

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('/sitemaps/setters/3.xml.gz');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.text()).toBe('');
    expect(setters.buildCalls).toBe(0);
    expect(visibility.checks).toBe(0);
  });

  it('rechecks publication visibility before each gzip response', async () => {
    setters.itemCount = 2;
    const response = await pagedShardRouteHandler('setters', '1.xml.gz');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/gzip');
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect((await readGzipXml(response)).match(/<url>/g)).toHaveLength(2);

    visibility.hidden = true;
    const withdrawn = await pagedShardRouteHandler('setters', '1.xml.gz');
    expect(withdrawn.headers.get('cache-control')).toBe('private, no-store');
    expect(await readGzipXml(withdrawn)).not.toContain('<url>');
    expect(visibility.checks).toBe(2);
  });

  it.each(['4.xml', '4.xml.gz', '0.xml', '01.xml.gz', '9007199254740992.xml', '9007199254740992.xml.gz'])(
    '404s invalid page %s without redirecting or serving an empty urlset',
    async (page) => {
      // An empty `<urlset>` on a page the index advertises tells Google the
      // surface was deleted; a 404 tells a crawler to stop asking.
      const response = await pagedShardRouteHandler('setters', page);

      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('location')).toBeNull();
      expect(setters.buildCalls).toBe(0);
    },
  );

  it.each(['1.xml', '1.xml.gz'])('503s %s when the summary fails', async (page) => {
    setters.summaryThrows = true;
    const response = await pagedShardRouteHandler('setters', page);

    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('location')).toBeNull();
    expect(setters.buildCalls).toBe(0);
  });

  it('emits one URL per setter with no hreflang block and no xhtml namespace', async () => {
    setters.itemCount = 2;

    const body = await readGzipXml(await pagedShardRouteHandler('setters', '1.xml.gz'));

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
      expect(xml).toContain(`https://www.boardsesh.com/sitemaps/setters/${page}.xml.gz`);
    }
    expect(xml).not.toContain(`/sitemaps/setters/${pages + 1}.xml`);
    // The old fixed URL is gone; an index still pointing at it would advertise a
    // route that no longer exists.
    expect(xml).not.toContain('/sitemaps/setters.xml');
  });
});
