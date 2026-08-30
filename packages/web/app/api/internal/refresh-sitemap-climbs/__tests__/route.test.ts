import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ClimbStoreRefreshResult } from '@/app/lib/seo/sitemap/climb-store';

vi.mock('server-only', () => ({}));

const refresh = vi.hoisted(() => ({
  calls: [] as { force?: boolean }[],
  result: {
    itemCount: 52_000,
    lastModified: new Date('2026-05-04T11:22:33.000Z'),
    previousItemCount: 51_900,
    skipped: null,
    scanDurationMs: 41_000,
  } as ClimbStoreRefreshResult,
  throws: false,
}));

vi.mock('@/app/lib/seo/sitemap/climb-store', () => ({
  refreshClimbSitemapStore: async (options: { force?: boolean } = {}) => {
    refresh.calls.push(options);
    if (refresh.throws) throw new Error('scan exploded');
    return refresh.result;
  },
}));

const routeModule = await import('../route');

function request(query = '', headers?: Record<string, string>) {
  return new Request(`http://localhost/api/internal/refresh-sitemap-climbs${query}`, { headers });
}

const AUTHORIZED = { authorization: 'Bearer test-secret' };

beforeEach(() => {
  refresh.calls = [];
  refresh.throws = false;
  refresh.result = {
    itemCount: 52_000,
    lastModified: new Date('2026-05-04T11:22:33.000Z'),
    previousItemCount: 51_900,
    skipped: null,
    scanDurationMs: 41_000,
  };
  vi.stubEnv('CRON_SECRET', 'test-secret');
  vi.stubEnv('CLIMB_SITEMAPS_ENABLED', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/internal/refresh-sitemap-climbs', () => {
  it('401s an unauthenticated call without running the scan', async () => {
    // The scan is sixteen heavy queries against a ten-connection pool; an open
    // endpoint would be a free way to starve it.
    const response = await routeModule.GET(request());

    expect(response.status).toBe(401);
    expect(refresh.calls).toHaveLength(0);
  });

  it('401s a wrong bearer token', async () => {
    const response = await routeModule.GET(request('', { authorization: 'Bearer wrong-secret' }));

    expect(response.status).toBe(401);
    expect(refresh.calls).toHaveLength(0);
  });

  it('reports an authenticated disabled skip without running the scan', async () => {
    vi.stubEnv('CLIMB_SITEMAPS_ENABLED', 'false');

    const response = await routeModule.GET(request('', AUTHORIZED));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ shard: 'climbs', skipped: 'disabled' });
    expect(refresh.calls).toHaveLength(0);
  });

  it('still authenticates before reporting a disabled skip', async () => {
    vi.stubEnv('CLIMB_SITEMAPS_ENABLED', 'false');

    const response = await routeModule.GET(request());

    expect(response.status).toBe(401);
    expect(refresh.calls).toHaveLength(0);
  });

  it('refreshes and reports the counters on the cron bearer', async () => {
    const response = await routeModule.GET(request('', AUTHORIZED));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.itemCount).toBe(52_000);
    expect(body.previousItemCount).toBe(51_900);
    expect(body.lastModified).toBe('2026-05-04T11:22:33.000Z');
    expect(body.skipped).toBeNull();
    expect(refresh.calls).toEqual([{ force: false }]);
  });

  it('409s when the shrink guard declined the write', async () => {
    // A refusal to write is not a success: the store stays frozen at whatever it
    // held while the read path keeps serving it. A 200 would leave that visible
    // only to whoever greps the logs.
    refresh.result = { ...refresh.result, itemCount: 20, skipped: 'shrank' };

    const response = await routeModule.GET(request('', AUTHORIZED));

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.skipped).toBe('shrank');
    expect(body.error).toContain('?force=1');
  });

  it('409s when the refresh computed zero climbs', async () => {
    refresh.result = { ...refresh.result, itemCount: 0, skipped: 'empty' };

    const response = await routeModule.GET(request('', AUTHORIZED));

    expect(response.status).toBe(409);
    expect((await response.json()).skipped).toBe('empty');
  });

  it('200s on benign concurrency so a healthy overlap does not page anyone', async () => {
    for (const skipped of ['locked', 'superseded'] as const) {
      refresh.result = { ...refresh.result, skipped };

      const response = await routeModule.GET(request('', AUTHORIZED));

      expect(response.status, skipped).toBe(200);
      expect((await response.json()).skipped, skipped).toBe(skipped);
    }
  });

  it('passes ?force=1 through, so a wedged guard has a way out', async () => {
    const response = await routeModule.GET(request('?force=1', AUTHORIZED));

    expect(response.status).toBe(200);
    expect(refresh.calls).toEqual([{ force: true }]);
    expect((await response.json()).forced).toBe(true);
  });

  it('does not treat any other force value as truthy', async () => {
    await routeModule.GET(request('?force=maybe', AUTHORIZED));

    expect(refresh.calls).toEqual([{ force: false }]);
  });

  it('500s when the refresh throws', async () => {
    refresh.throws = true;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await routeModule.GET(request('', AUTHORIZED));

    expect(response.status).toBe(500);
    errors.mockRestore();
  });
});
