import { describe, expect, it, vi } from 'vite-plus/test';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';
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

const boardConfigs = vi.hoisted(() => ({ shouldThrow: false, empty: false }));
const playlistRows = vi.hoisted(() => ({ count: 1 }));

vi.mock('@/app/lib/server-popular-configs', () => ({
  getAllBoardConfigsOrThrow: async () => {
    if (boardConfigs.shouldThrow) {
      throw new Error('backend unreachable');
    }
    return boardConfigs.empty ? [] : [KILTER_CONFIG];
  },
}));
vi.mock('../playlist-query', () => ({
  fetchPlaylistSitemapRows: async () => {
    const updatedAt = new Date('2026-04-30T00:00:00.000Z');
    return Array.from({ length: playlistRows.count }, (_, index) => ({
      uuid: index === 0 ? 'abc-123' : `playlist-${index}`,
      updatedAt,
    }));
  },
}));

const { buildSitemapIndexXml, shardRouteHandler } = await import('../shard-registry');

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

  it('throws instead of publishing an index that quietly dropped a shard', async () => {
    boardConfigs.shouldThrow = true;
    try {
      await expect(buildSitemapIndexXml()).rejects.toThrow('backend unreachable');
    } finally {
      boardConfigs.shouldThrow = false;
    }
  });

  it('throws when a shard that expects URLs comes back empty', async () => {
    // Same harm as a throwing builder, minus the throw: boards would vanish from
    // the index behind a 1-hour s-maxage with a 200 on every hop.
    boardConfigs.empty = true;
    try {
      await expect(buildSitemapIndexXml()).rejects.toThrow('expects URLs but built none');
    } finally {
      boardConfigs.empty = false;
    }
  });
});
