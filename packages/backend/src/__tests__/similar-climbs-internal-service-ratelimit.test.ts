/**
 * Regression test for issue #5291: every anonymous climb-page SSR render
 * shared ONE 30/min `similar-climbs` rate-limit bucket, because the web
 * tier's internal call to the backend presented no per-visitor identity —
 * `resolveWebSocketClientIp` fell through to the constant socket address of
 * the web-tier-to-backend connection over Railway's private network
 * (`BACKEND_INTERNAL_URL`, no Cloudflare hop in between). One instance,
 * regardless of how many distinct climbs or visitors it was rendering for,
 * ran every SSR similar-climbs read through the exact same `ip:<addr>` key.
 *
 * This exercises the REAL in-memory rate limiter (`applyRateLimit`'s Tier 1)
 * — only the Redis-backed Tier 2 is mocked, since it depends on live infra
 * this test doesn't stand up — to prove that many "SSR renders" sharing one
 * identity do not throttle each other once the caller authenticates as the
 * trusted internal-service identity (`ctx.isInternalService`), while the
 * exact same burst against the old shared-clientIp identity does throttle.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { applyRateLimit } from '../graphql/resolvers/shared/helpers';

vi.mock('../utils/redis-rate-limiter', () => ({
  checkRateLimitRedis: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../graphql/context', () => ({ getContext: vi.fn() }));
vi.mock('../services/distributed-state', () => ({ getDistributedState: vi.fn().mockReturnValue(null) }));
vi.mock('../db/client', () => ({ db: {} }));

// Mirrors the real `similarClimbs` resolver's ceiling
// (packages/backend/src/graphql/resolvers/climbs/queries.ts).
const SIMILAR_CLIMBS_LIMIT = 30;
// More renders than the 30/min ceiling that used to be shared by every SSR
// caller on the planet — a burst any single busy web instance can produce
// while rendering many different climb pages for many different visitors.
const CONCURRENT_SSR_RENDERS = 40;

describe('similar-climbs rate limit: internal-service SSR identity (#5291)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not throttle concurrent SSR renders for different climbs/visitors once authenticated as internal-service', async () => {
    const operation = `similar-climbs-internal-${Date.now()}`;
    // Every one of these represents a front-door SSR read for a different
    // climb page and a different real-world visitor. None of them carry a
    // per-visitor identity — clientIp is the SAME constant address on every
    // call, exactly as it is in production, to prove the fix doesn't merely
    // work by accident because some other field happens to vary per call.
    const renders = Array.from({ length: CONCURRENT_SSR_RENDERS }, (_, index) => {
      const ctx: ConnectionContext = {
        connectionId: `http-ssr-${index}`,
        transport: 'http',
        isAuthenticated: false,
        isInternalService: true,
        clientIp: '10.0.0.5',
      };
      return applyRateLimit(ctx, SIMILAR_CLIMBS_LIMIT, operation);
    });

    await expect(Promise.all(renders)).resolves.toBeDefined();
  });

  it('control: the identical burst DOES throttle when the caller is not authenticated as internal-service', async () => {
    // Proves the test above is meaningful: the exact same 40-call burst
    // against the pre-#5291 anonymous-IP bucket — what every SSR render
    // looked like before this fix — trips RATE_LIMITED, because they all
    // still share one clientIp-derived key.
    const operation = `similar-climbs-anon-${Date.now()}`;
    const renders = Array.from({ length: CONCURRENT_SSR_RENDERS }, (_, index) => {
      const ctx: ConnectionContext = {
        connectionId: `http-ssr-${index}`,
        transport: 'http',
        isAuthenticated: false,
        clientIp: '10.0.0.5',
      };
      return applyRateLimit(ctx, SIMILAR_CLIMBS_LIMIT, operation);
    });

    await expect(Promise.all(renders)).rejects.toThrow(/Rate limit exceeded/);
  });
});
