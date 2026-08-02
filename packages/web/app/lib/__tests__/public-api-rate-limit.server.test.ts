import { describe, expect, it, vi } from 'vite-plus/test';
import { MemoryRateLimiter, RateLimitError } from '@boardsesh/rate-limit';

vi.mock('server-only', () => ({}));
vi.mock('../public-api-rate-limit-redis.server', () => ({
  getWebRedisRateLimitEvaluator: () => undefined,
}));

import {
  createPublicApiRateLimitGuard,
  PUBLIC_API_MAX_REQUESTS,
  PUBLIC_API_RATE_LIMIT_WINDOW_MS,
  PUBLIC_API_RATE_LIMIT_OPERATION,
  resolvePublicApiClientIdentity,
  resolvePublicApiRateLimitNamespace,
} from '../public-api-rate-limit.server';

function request(path: string, platformIp?: string): Request {
  return new Request(`https://www.boardsesh.com${path}`, {
    headers: platformIp ? { 'x-vercel-forwarded-for': platformIp } : undefined,
  });
}

describe('public API client identity', () => {
  it('trusts Vercel platform identity only when VERCEL is positively detected', () => {
    const publicRequest = request('/api/v1/kilter/grades', '203.0.113.8');

    expect(resolvePublicApiClientIdentity(publicRequest, { VERCEL: '1', VERCEL_ENV: 'production' })).toBe(
      '203.0.113.8',
    );
    expect(resolvePublicApiClientIdentity(publicRequest, { VERCEL_ENV: 'production' })).toBe('unknown');
  });

  it('ignores forgeable forwarding headers outside the platform-owned header', () => {
    const publicRequest = new Request('https://www.boardsesh.com/api/v1/kilter/grades', {
      headers: {
        'x-forwarded-for': '203.0.113.8',
        'x-real-ip': '198.51.100.2',
      },
    });

    expect(resolvePublicApiClientIdentity(publicRequest, { VERCEL: '1', VERCEL_ENV: 'production' })).toBe('unknown');
  });

  it('rejects chains and invalid platform values into the shared fallback bucket', () => {
    expect(
      resolvePublicApiClientIdentity(request('/api/v1/kilter/grades', '203.0.113.8, 198.51.100.2'), {
        VERCEL: '1',
        VERCEL_ENV: 'production',
      }),
    ).toBe('unknown');
    expect(
      resolvePublicApiClientIdentity(request('/api/v1/kilter/grades', 'not-an-ip'), {
        VERCEL: '1',
        VERCEL_ENV: 'production',
      }),
    ).toBe('unknown');
  });

  it('normalizes IPv4-mapped addresses and IPv6 /64 identities', () => {
    const environment = { VERCEL: '1', VERCEL_ENV: 'preview' };
    expect(resolvePublicApiClientIdentity(request('/api/v1/kilter/grades', '::ffff:203.0.113.8'), environment)).toBe(
      '203.0.113.8',
    );
    expect(
      resolvePublicApiClientIdentity(
        request('/api/v1/kilter/grades', '2001:0db8:85a3:0000:1111:2222:3333:4444'),
        environment,
      ),
    ).toBe('2001:db8:85a3:0::/64');
  });

  it('keeps production, preview, and local Redis keys in separate namespaces', () => {
    expect(resolvePublicApiRateLimitNamespace({ VERCEL: '1', VERCEL_ENV: 'production' })).toBe(
      'public-api:web:production',
    );
    expect(resolvePublicApiRateLimitNamespace({ VERCEL: '1', VERCEL_ENV: 'preview' })).toBe('public-api:web:preview');
    expect(resolvePublicApiRateLimitNamespace({ VERCEL_ENV: 'production' })).toBe('public-api:web:local');
  });
});

describe('public API guard', () => {
  it('uses the injected clock for the default local limiter across its fixed window', async () => {
    let currentTime = 1_000;
    const guard = createPublicApiRateLimitGuard({
      environment: { VERCEL: '1', VERCEL_ENV: 'production' },
      getRedisEvaluator: () => undefined,
      now: () => currentTime,
    });
    const publicRequest = request('/api/v1/kilter/grades', '203.0.113.8');

    for (let requestIndex = 0; requestIndex < PUBLIC_API_MAX_REQUESTS; requestIndex += 1) {
      await expect(guard(publicRequest)).resolves.toBeNull();
    }
    await expect(guard(publicRequest)).resolves.toMatchObject({ status: 429 });

    // Preserve MemoryRateLimiter's established inclusive reset boundary: exactly
    // resetAt is still in the old window, and the next millisecond starts a new one.
    currentTime += PUBLIC_API_RATE_LIMIT_WINDOW_MS;
    await expect(guard(publicRequest)).resolves.toMatchObject({ status: 429 });
    currentTime += 1;
    await expect(guard(publicRequest)).resolves.toBeNull();
  });

  it('shares one aggregate budget across grade and heatmap reads behind a gym NAT', async () => {
    const guard = createPublicApiRateLimitGuard({
      environment: { VERCEL: '1', VERCEL_ENV: 'production' },
      getRedisEvaluator: () => undefined,
      memoryLimiter: new MemoryRateLimiter({ maxEntries: 10 }),
    });

    for (let requestIndex = 0; requestIndex < PUBLIC_API_MAX_REQUESTS; requestIndex += 1) {
      const path =
        requestIndex % 2 === 0 ? '/api/v1/kilter/grades' : '/api/v1/kilter/home/12/mainline/40/heatmap?gradeAccuracy=3';
      await expect(guard(request(path, '203.0.113.8'))).resolves.toBeNull();
    }

    const response = await guard(request('/api/v1/kilter/home/12/mainline/40/heatmap', '203.0.113.8'));
    expect(response?.status).toBe(429);
    expect(Number(response?.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
    expect(response?.headers.get('Cache-Control')).toContain('no-store');
    expect(response?.headers.get('CDN-Cache-Control')).toBe('no-store');
    expect(response?.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store');
  });

  it('uses the one operation and preview namespace for the Redis tier', async () => {
    const evaluate = vi.fn().mockResolvedValue(1);
    const guard = createPublicApiRateLimitGuard({
      environment: { VERCEL: '1', VERCEL_ENV: 'preview' },
      getRedisEvaluator: () => evaluate,
      memoryLimiter: new MemoryRateLimiter(),
      now: () => 125_000,
    });

    await expect(guard(request('/api/v1/kilter/grades', '203.0.113.8'))).resolves.toBeNull();

    expect(evaluate).toHaveBeenCalledOnce();
    expect(evaluate.mock.calls[0]?.[2]).toBe(
      `ratelimit:public-api:web:preview:ip:203.0.113.8:${PUBLIC_API_RATE_LIMIT_OPERATION}:2`,
    );
  });

  it('fails soft to the already-spent local tier on Redis transport failure', async () => {
    const guard = createPublicApiRateLimitGuard({
      environment: { VERCEL: '1', VERCEL_ENV: 'production' },
      getRedisEvaluator: () => vi.fn().mockRejectedValue(new Error('command timed out')),
      memoryLimiter: new MemoryRateLimiter(),
    });

    await expect(guard(request('/api/v1/kilter/grades', '203.0.113.8'))).resolves.toBeNull();
  });

  it('propagates a Redis RateLimitError into an uncached 429', async () => {
    const guard = createPublicApiRateLimitGuard({
      environment: { VERCEL: '1', VERCEL_ENV: 'production' },
      getRedisEvaluator: () => vi.fn().mockRejectedValue(new RateLimitError(17)),
      memoryLimiter: new MemoryRateLimiter(),
    });

    const response = await guard(request('/api/v1/kilter/grades', '203.0.113.8'));
    expect(response?.status).toBe(429);
    expect(response?.headers.get('Retry-After')).toBe('17');
  });
});
