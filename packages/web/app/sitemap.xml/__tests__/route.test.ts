import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('server-only', () => ({}));

const deferred = vi.hoisted(() => ({
  callbacks: [] as Array<() => void | Promise<void>>,
  climbRefreshCalls: 0,
  playlistWarmCalls: 0,
}));

vi.mock('next/server', () => ({
  after: (callback: () => void | Promise<void>) => {
    deferred.callbacks.push(callback);
  },
}));

vi.mock('@/app/lib/seo/sitemap/climb-store', () => ({
  refreshClimbStoreIfStale: async () => {
    deferred.climbRefreshCalls += 1;
  },
}));

vi.mock('@/app/lib/seo/sitemap/playlist-query', () => ({
  warmPlaylistSitemapCache: async () => {
    deferred.playlistWarmCalls += 1;
  },
}));

vi.mock('@/app/lib/seo/sitemap/shard-registry', () => ({
  sitemapIndexRouteHandler: async () => new Response('<sitemapindex/>', { status: 200 }),
}));

const routeModule = await import('../route');

beforeEach(() => {
  deferred.callbacks = [];
  deferred.climbRefreshCalls = 0;
  deferred.playlistWarmCalls = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /sitemap.xml deferred refreshes', () => {
  it('does not schedule the climb refresh when climb sitemaps are disabled', async () => {
    vi.stubEnv('CLIMB_SITEMAPS_ENABLED', 'false');

    const response = await routeModule.GET();

    expect(response.status).toBe(200);
    expect(deferred.callbacks).toHaveLength(1);
    await deferred.callbacks[0]();
    expect(deferred.climbRefreshCalls).toBe(0);
    expect(deferred.playlistWarmCalls).toBe(1);
  });

  it('keeps both deferred refreshes when the switch is exactly true', async () => {
    vi.stubEnv('CLIMB_SITEMAPS_ENABLED', 'true');

    await routeModule.GET();

    expect(deferred.callbacks).toHaveLength(2);
    await Promise.all(deferred.callbacks.map((callback) => Promise.resolve(callback())));
    expect(deferred.climbRefreshCalls).toBe(1);
    expect(deferred.playlistWarmCalls).toBe(1);
  });
});
