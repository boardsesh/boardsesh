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

function request(path: string, platformIp?: string, userAgent?: string): Request {
  const headers: Record<string, string> = {};
  if (platformIp) headers['x-vercel-forwarded-for'] = platformIp;
  if (userAgent) headers['user-agent'] = userAgent;
  return new Request(`https://www.boardsesh.com${path}`, { headers });
}

describe('public API client identity', () => {
  it('trusts Vercel platform identity only when VERCEL is positively detected', () => {
    const publicRequest = request('/api/v1/kilter/grades', '203.0.113.8');

    expect(resolvePublicApiClientIdentity(publicRequest, { VERCEL: '1', VERCEL_ENV: 'production' })).toBe(
      '203.0.113.8',
    );
    expect(resolvePublicApiClientIdentity(publicRequest, { VERCEL_ENV: 'production' })).toBe('unknown');
  });

  it('uses Railway remote identity for direct requests and ignores forged forwarding headers', () => {
    const publicRequest = new Request('https://www.boardsesh.com/api/v1/kilter/grades', {
      headers: {
        'cf-connecting-ip': '198.51.100.5',
        'x-forwarded-for': '192.0.2.10',
        'x-real-ip': '203.0.113.8',
      },
    });

    expect(resolvePublicApiClientIdentity(publicRequest, { RAILWAY_ENVIRONMENT_ID: 'prod-id' })).toBe('203.0.113.8');
  });

  it('uses Cloudflare visitor identity only when Railway reports a Cloudflare peer', () => {
    const cloudflareRequest = new Request('https://www.boardsesh.com/api/v1/kilter/grades', {
      headers: {
        'cf-connecting-ip': '203.0.113.8',
        'x-forwarded-for': '192.0.2.10',
        'x-real-ip': '173.245.48.10',
      },
    });
    const forgedRequest = new Request('https://www.boardsesh.com/api/v1/kilter/grades', {
      headers: {
        'cf-connecting-ip': '203.0.113.8',
        'x-real-ip': '198.51.100.2',
      },
    });
    const missingClientRequest = new Request('https://www.boardsesh.com/api/v1/kilter/grades', {
      headers: { 'x-real-ip': '173.245.48.10' },
    });

    expect(resolvePublicApiClientIdentity(cloudflareRequest, { RAILWAY_ENVIRONMENT_ID: 'prod-id' })).toBe(
      '203.0.113.8',
    );
    expect(resolvePublicApiClientIdentity(forgedRequest, { RAILWAY_ENVIRONMENT_ID: 'prod-id' })).toBe('198.51.100.2');
    expect(resolvePublicApiClientIdentity(missingClientRequest, { RAILWAY_ENVIRONMENT_ID: 'prod-id' })).toBe('unknown');
  });

  it('rejects malformed Railway and Cloudflare address values into the shared fallback', () => {
    const malformedDirectRequests = [
      new Request('https://www.boardsesh.com/api/v1/kilter/grades', {
        headers: { 'x-real-ip': '203.0.113.8, 198.51.100.2' },
      }),
      new Request('https://www.boardsesh.com/api/v1/kilter/grades', {
        headers: { 'x-real-ip': 'not-an-ip' },
      }),
      new Request('https://www.boardsesh.com/api/v1/kilter/grades'),
    ];
    const malformedCloudflareRequest = new Request('https://www.boardsesh.com/api/v1/kilter/grades', {
      headers: {
        'cf-connecting-ip': '203.0.113.8, 198.51.100.2',
        'x-real-ip': '173.245.48.10',
      },
    });

    for (const malformedRequest of malformedDirectRequests) {
      expect(resolvePublicApiClientIdentity(malformedRequest, { RAILWAY_ENVIRONMENT_ID: 'prod-id' })).toBe('unknown');
    }
    expect(resolvePublicApiClientIdentity(malformedCloudflareRequest, { RAILWAY_ENVIRONMENT_ID: 'prod-id' })).toBe(
      'unknown',
    );
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
    expect(resolvePublicApiRateLimitNamespace({ RAILWAY_ENVIRONMENT_ID: 'prod-id' })).toBe(
      'public-api:web:railway:prod-id',
    );
    expect(resolvePublicApiRateLimitNamespace({ RAILWAY_ENVIRONMENT_ID: 'preview-id' })).not.toBe(
      resolvePublicApiRateLimitNamespace({ RAILWAY_ENVIRONMENT_ID: 'prod-id' }),
    );
  });
});

describe('public API guard', () => {
  it('uses the injected clock for the default local limiter across its fixed window', async () => {
    let currentTime = 1_000;
    const guard = createPublicApiRateLimitGuard({
      environment: { VERCEL: '1', VERCEL_ENV: 'production' },
      getRedisEvaluator: () => undefined,
      logRateLimited: () => undefined,
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

  it('shares one aggregate budget across grade and climb-stat reads behind a gym NAT', async () => {
    const guard = createPublicApiRateLimitGuard({
      environment: { VERCEL: '1', VERCEL_ENV: 'production' },
      getRedisEvaluator: () => undefined,
      logRateLimited: () => undefined,
      memoryLimiter: new MemoryRateLimiter({ maxEntries: 10 }),
    });

    for (let requestIndex = 0; requestIndex < PUBLIC_API_MAX_REQUESTS; requestIndex += 1) {
      const path = requestIndex % 2 === 0 ? '/api/v1/kilter/grades' : '/api/v1/kilter/climb-stats/abc123';
      await expect(guard(request(path, '203.0.113.8'))).resolves.toBeNull();
    }

    const response = await guard(request('/api/v1/kilter/climb-stats/abc123', '203.0.113.8'));
    expect(response?.status).toBe(429);
    expect(Number(response?.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
    expect(response?.headers.get('Cache-Control')).toContain('no-store');
    expect(response?.headers.get('CDN-Cache-Control')).toBe('no-store');
    expect(response?.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store');
  });

  it('keeps two clients behind one Cloudflare peer on independent budgets', async () => {
    const guard = createPublicApiRateLimitGuard({
      environment: { RAILWAY_ENVIRONMENT_ID: 'prod-id' },
      getRedisEvaluator: () => undefined,
      logRateLimited: () => undefined,
      memoryLimiter: new MemoryRateLimiter({ maxEntries: 10 }),
    });
    const cloudflarePeer = '173.245.48.10';
    const firstClient = new Request('https://www.boardsesh.com/api/v1/kilter/grades', {
      headers: { 'cf-connecting-ip': '203.0.113.8', 'x-real-ip': cloudflarePeer },
    });
    const secondClient = new Request('https://www.boardsesh.com/api/v1/kilter/grades', {
      headers: { 'cf-connecting-ip': '198.51.100.9', 'x-real-ip': cloudflarePeer },
    });

    for (let requestIndex = 0; requestIndex < PUBLIC_API_MAX_REQUESTS; requestIndex += 1) {
      await expect(guard(firstClient)).resolves.toBeNull();
    }
    await expect(guard(secondClient)).resolves.toBeNull();
    await expect(guard(firstClient)).resolves.toMatchObject({ status: 429 });
  });

  it('shares a budget across IPv4-mapped spellings without merging distinct clients', async () => {
    const environment = { RAILWAY_ENVIRONMENT_ID: 'prod-id' };
    const guard = createPublicApiRateLimitGuard({
      environment,
      getRedisEvaluator: () => undefined,
      logRateLimited: () => undefined,
      memoryLimiter: new MemoryRateLimiter({ maxEntries: 10 }),
    });
    const requestFromIp = (ip: string) =>
      new Request('https://www.boardsesh.com/api/v1/kilter/grades', { headers: { 'x-real-ip': ip } });
    const firstClientAliases = [
      '203.0.113.5',
      '::ffff:203.0.113.5',
      '::ffff:cb00:7105',
      '0:0:0:0:0:ffff:cb00:7105',
      '0:0:0:0:0:ffff:203.0.113.5',
    ];
    const secondClientAliases = [
      '198.51.100.9',
      '::ffff:198.51.100.9',
      '::ffff:c633:6409',
      '0:0:0:0:0:ffff:c633:6409',
      '0:0:0:0:0:ffff:198.51.100.9',
    ];

    for (let requestIndex = 0; requestIndex < PUBLIC_API_MAX_REQUESTS; requestIndex += 1) {
      await expect(
        guard(requestFromIp(firstClientAliases[requestIndex % firstClientAliases.length] ?? '')),
      ).resolves.toBeNull();
    }
    for (const alias of firstClientAliases) {
      await expect(guard(requestFromIp(alias))).resolves.toMatchObject({ status: 429 });
    }

    for (let requestIndex = 0; requestIndex < PUBLIC_API_MAX_REQUESTS; requestIndex += 1) {
      await expect(
        guard(requestFromIp(secondClientAliases[requestIndex % secondClientAliases.length] ?? '')),
      ).resolves.toBeNull();
    }
    for (const alias of secondClientAliases) {
      await expect(guard(requestFromIp(alias))).resolves.toMatchObject({ status: 429 });
    }
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
      logRateLimited: () => undefined,
      memoryLimiter: new MemoryRateLimiter(),
    });

    const response = await guard(request('/api/v1/kilter/grades', '203.0.113.8'));
    expect(response?.status).toBe(429);
    expect(response?.headers.get('Retry-After')).toBe('17');
  });
});

describe('429 observability', () => {
  it('logs the rejected path, identity, and user agent once per rejection', async () => {
    const logRateLimited = vi.fn();
    const guard = createPublicApiRateLimitGuard({
      environment: { VERCEL: '1', VERCEL_ENV: 'production' },
      getRedisEvaluator: () => vi.fn().mockRejectedValue(new RateLimitError(9)),
      logRateLimited,
      memoryLimiter: new MemoryRateLimiter(),
    });

    await guard(request('/api/v1/kilter/climb-stats/abc123', '203.0.113.8', 'scraper/1.0'));

    expect(logRateLimited).toHaveBeenCalledOnce();
    expect(logRateLimited.mock.calls[0]?.[0]).toBe(
      '[public-api-rate-limit] 429 path=/api/v1/kilter/climb-stats/abc123 ip=203.0.113.8 ua=scraper/1.0',
    );
  });

  it('stays silent while requests are inside the budget', async () => {
    const logRateLimited = vi.fn();
    const guard = createPublicApiRateLimitGuard({
      environment: { VERCEL: '1', VERCEL_ENV: 'production' },
      getRedisEvaluator: () => undefined,
      logRateLimited,
      memoryLimiter: new MemoryRateLimiter(),
    });

    await expect(guard(request('/api/v1/kilter/grades', '203.0.113.8'))).resolves.toBeNull();
    expect(logRateLimited).not.toHaveBeenCalled();
  });

  it('folds control characters and caps a caller-controlled user agent', async () => {
    const logRateLimited = vi.fn();
    const guard = createPublicApiRateLimitGuard({
      environment: { VERCEL: '1', VERCEL_ENV: 'production' },
      getRedisEvaluator: () => vi.fn().mockRejectedValue(new RateLimitError(9)),
      logRateLimited,
      memoryLimiter: new MemoryRateLimiter(),
    });

    // Header values cannot legally carry a raw newline, so build the hostile
    // value after construction rather than trusting the Request constructor.
    const hostileRequest = request('/api/v1/kilter/grades', '203.0.113.8');
    hostileRequest.headers.set('user-agent', `curl/8\u0007ua=spoofed ${'A'.repeat(400)}`);
    await guard(hostileRequest);

    const loggedLine = String(logRateLimited.mock.calls[0]?.[0]);
    expect(loggedLine).toContain('ua=curl/8 ua=spoofed');
    expect(loggedLine).not.toContain('\u0007');
    expect(loggedLine.endsWith('…')).toBe(true);
    expect(loggedLine.length).toBeLessThan(300);
  });

  it('falls back to placeholders when the path and user agent are unavailable', async () => {
    const logRateLimited = vi.fn();
    const guard = createPublicApiRateLimitGuard({
      environment: {},
      getRedisEvaluator: () => vi.fn().mockRejectedValue(new RateLimitError(9)),
      logRateLimited,
      memoryLimiter: new MemoryRateLimiter(),
    });

    await guard(request('/api/v1/kilter/grades'));

    expect(logRateLimited.mock.calls[0]?.[0]).toBe(
      '[public-api-rate-limit] 429 path=/api/v1/kilter/grades ip=unknown ua=unknown',
    );
  });
});
