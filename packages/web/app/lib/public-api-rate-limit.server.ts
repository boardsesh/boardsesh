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
const LOGGED_USER_AGENT_MAX_LENGTH = 200;

type PublicApiEnvironment = {
  readonly VERCEL?: string;
  readonly VERCEL_ENV?: string;
};

type PublicApiRateLimitGuardOptions = {
  environment?: PublicApiEnvironment;
  getRedisEvaluator?: () => RedisRateLimitEvaluate | undefined;
  logRateLimited?: (message: string) => void;
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

export function createPublicApiRateLimitGuard(
  options: PublicApiRateLimitGuardOptions = {},
): (request: Request) => Promise<NextResponse<ErrorResponse> | null> {
  const {
    environment = process.env,
    getRedisEvaluator = getWebRedisRateLimitEvaluator,
    logRateLimited = console.info,
    memoryLimiter: injectedMemoryLimiter,
    now = Date.now,
  } = options;
  const memoryLimiter =
    injectedMemoryLimiter ?? new MemoryRateLimiter({ maxEntries: PUBLIC_API_LOCAL_MAX_IDENTITIES, now });

  return async (request) => {
    const clientIdentity = resolvePublicApiClientIdentity(request, environment);
    const distributedIdentity = `ip:${clientIdentity}`;
    const localIdentifier = `${distributedIdentity}:${PUBLIC_API_RATE_LIMIT_OPERATION}`;

    try {
      memoryLimiter.check(localIdentifier, PUBLIC_API_MAX_REQUESTS, PUBLIC_API_RATE_LIMIT_WINDOW_MS);
      // `onStoreError` is intentionally omitted. The local tier has already
      // spent this request, the Redis adapter logs the failure that opens its
      // circuit, and cooldown/probe fallthrough stays silent instead of
      // producing one warning for every origin request while Redis is down.
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
      // One line per rejected request, so 429 volume stays greppable in the
      // function logs and an alert window can tell a scraper enumerating climb
      // UUIDs apart from a busy gym sharing one NAT address. This replaces the
      // per-route log the climb-stats endpoint used to emit.
      logRateLimited(
        `[public-api-rate-limit] 429 path=${resolveRequestPath(request)} ip=${clientIdentity} ua=${resolveLoggedUserAgent(request)}`,
      );
      return createRateLimitedResponse(error.retryAfterSeconds);
    }
  };
}

function resolveRequestPath(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return 'unknown';
  }
}

/**
 * The User-Agent is caller-controlled, unlike the normalized IP and the routed
 * path, so cap its length and fold control characters before it reaches a log
 * line something else will parse.
 */
function resolveLoggedUserAgent(request: Request): string {
  const rawUserAgent = request.headers.get('user-agent');
  if (!rawUserAgent) return 'unknown';
  const sanitized = rawUserAgent.replaceAll(/\p{Cc}/gu, ' ').trim();
  if (!sanitized) return 'unknown';
  return sanitized.length > LOGGED_USER_AGENT_MAX_LENGTH
    ? `${sanitized.slice(0, LOGGED_USER_AGENT_MAX_LENGTH)}…`
    : sanitized;
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
