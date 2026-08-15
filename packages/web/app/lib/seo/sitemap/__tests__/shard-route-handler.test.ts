import { describe, expect, it, vi } from 'vite-plus/test';

vi.mock('server-only', () => ({}));

const boardConfigs = vi.hoisted(() => ({ shouldThrow: false }));

vi.mock('@/app/lib/server-popular-configs', () => ({
  getAllBoardConfigsOrThrow: async () => {
    if (boardConfigs.shouldThrow) {
      throw new Error('backend unreachable');
    }
    return [];
  },
}));
vi.mock('../playlist-query', () => ({
  fetchPlaylistSitemapRows: async () => [{ uuid: 'abc-123', updatedAt: new Date('2026-04-30T00:00:00.000Z') }],
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
});

describe('buildSitemapIndexXml', () => {
  it('lists only the shards that carry URLs', async () => {
    const xml = await buildSitemapIndexXml();
    expect(xml).toContain('<sitemapindex');
    expect(xml).toContain('https://www.boardsesh.com/sitemaps/static.xml');
    expect(xml).toContain('https://www.boardsesh.com/sitemaps/playlists.xml');
    // boards is empty in this fixture; gyms and setters are declared-empty.
    expect(xml).not.toContain('/sitemaps/gyms.xml');
    expect(xml).not.toContain('/sitemaps/setters.xml');
    expect(xml).not.toContain('/sitemaps/boards.xml');
  });

  it('throws instead of publishing an index that quietly dropped a shard', async () => {
    boardConfigs.shouldThrow = true;
    try {
      await expect(buildSitemapIndexXml()).rejects.toThrow('backend unreachable');
    } finally {
      boardConfigs.shouldThrow = false;
    }
  });
});
