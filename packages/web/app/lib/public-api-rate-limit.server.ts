import 'server-only';

import {
  checkRedisRateLimit,
  MemoryRateLimiter,
  normalizeRateLimitIp,
  RateLimitError,
  type RedisRateLimitEvaluate,
} from '@boardsesh/rate-limit';
import { NextResponse } from 'next/server';
import type { ErrorResponse } from '@/app/lib/types';
import { getWebRedisRateLimitEvaluator } from './public-api-rate-limit-redis.server';

export const PUBLIC_API_MAX_REQUESTS = 120;
export const PUBLIC_API_RATE_LIMIT_WINDOW_MS = 60_000;
export const PUBLIC_API_RATE_LIMIT_OPERATION = 'public-api-v1:get';

const SHARED_UNTRUSTED_IDENTITY = 'unknown';
const PUBLIC_API_LOCAL_MAX_IDENTITIES = 10_000;

type PublicApiEnvironment = {
  readonly VERCEL?: string;
  readonly VERCEL_ENV?: string;
};

type PublicApiRateLimitGuardOptions = {
  environment?: PublicApiEnvironment;
  getRedisEvaluator?: () => RedisRateLimitEvaluate | undefined;
  memoryLimiter?: MemoryRateLimiter;
  now?: () => number;
};

/**
 * Resolve only Vercel's platform-owned client-IP header.
 *
 * `x-vercel-forwarded-for` is overwritten by Vercel and contains the same
 * singular client address even when another proxy sits in front of Vercel.
 * Merely setting VERCEL_ENV is insufficient: branch deployments may carry that
 * value without running behind Vercel's header trust boundary.
 */
export function resolvePublicApiClientIdentity(
  request: Request,
  environment: PublicApiEnvironment = process.env,
): string {
  if (environment.VERCEL !== '1') return SHARED_UNTRUSTED_IDENTITY;

  const platformAddress = request.headers.get('x-vercel-forwarded-for')?.trim();
  if (!platformAddress || platformAddress.includes(',')) return SHARED_UNTRUSTED_IDENTITY;
  return normalizeRateLimitIp(platformAddress) ?? SHARED_UNTRUSTED_IDENTITY;
}

export function resolvePublicApiRateLimitNamespace(environment: PublicApiEnvironment = process.env): string {
  if (environment.VERCEL !== '1') return 'public-api:web:local';
  return environment.VERCEL_ENV === 'production' ? 'public-api:web:production' : 'public-api:web:preview';
}

export function createPublicApiRateLimitGuard({
  environment = process.env,
  getRedisEvaluator = getWebRedisRateLimitEvaluator,
  memoryLimiter = new MemoryRateLimiter({ maxEntries: PUBLIC_API_LOCAL_MAX_IDENTITIES }),
  now = Date.now,
}: PublicApiRateLimitGuardOptions = {}): (request: Request) => Promise<NextResponse<ErrorResponse> | null> {
  return async (request) => {
    const clientIdentity = resolvePublicApiClientIdentity(request, environment);
    const distributedIdentity = `ip:${clientIdentity}`;
    const localIdentifier = `${distributedIdentity}:${PUBLIC_API_RATE_LIMIT_OPERATION}`;

    try {
      memoryLimiter.check(localIdentifier, PUBLIC_API_MAX_REQUESTS, PUBLIC_API_RATE_LIMIT_WINDOW_MS);
      await checkRedisRateLimit({
        evaluate: getRedisEvaluator(),
        identity: distributedIdentity,
        maxRequests: PUBLIC_API_MAX_REQUESTS,
        namespace: resolvePublicApiRateLimitNamespace(environment),
        now,
        operation: PUBLIC_API_RATE_LIMIT_OPERATION,
        windowMs: PUBLIC_API_RATE_LIMIT_WINDOW_MS,
      });
      return null;
    } catch (error) {
      if (!(error instanceof RateLimitError)) throw error;
      return createRateLimitedResponse(error.retryAfterSeconds);
    }
  };
}

function createRateLimitedResponse(retryAfterSeconds: number): NextResponse<ErrorResponse> {
  return NextResponse.json(
    { error: 'Too many requests. Please slow down.' },
    {
      status: 429,
      headers: {
        'Cache-Control': 'private, no-store, max-age=0',
        'CDN-Cache-Control': 'no-store',
        'Retry-After': String(Math.max(1, retryAfterSeconds)),
        'Vercel-CDN-Cache-Control': 'no-store',
      },
    },
  );
}

export const enforcePublicApiRateLimit = createPublicApiRateLimitGuard();
