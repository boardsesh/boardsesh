import 'server-only';

import {
  checkRedisRateLimit,
  isIpInAnyCidr,
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
  readonly RAILWAY_ENVIRONMENT_ID?: string;
  readonly VERCEL?: string;
  readonly VERCEL_ENV?: string;
};

// Current ranges from https://www.cloudflare.com/ips-v4 and /ips-v6.
// Update this list when Cloudflare publishes a range change. It is used only
// to decide whether Railway's documented remote peer is a Cloudflare edge.
const CLOUDFLARE_PROXY_CIDRS = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
] as const;

type PublicApiRateLimitGuardOptions = {
  environment?: PublicApiEnvironment;
  getRedisEvaluator?: () => RedisRateLimitEvaluate | undefined;
  logRateLimited?: (message: string) => void;
  memoryLimiter?: MemoryRateLimiter;
  now?: () => number;
};

/**
 * Resolve the platform's client identity only in an explicitly detected host.
 *
 * Railway documents `X-Real-IP` as the remote peer address. For a Cloudflare-
 * proxied request that peer is a Cloudflare egress address, so its published
 * CIDR must match before the Cloudflare-only `CF-Connecting-IP` is trusted.
 * Otherwise the Railway remote address is the client identity. This code cannot
 * prove Railway's header replacement behavior; the production host check stays
 * an operator prerequisite before relying on this boundary.
 */
export function resolvePublicApiClientIdentity(
  request: Request,
  environment: PublicApiEnvironment = process.env,
): string {
  if (environment.VERCEL === '1') {
    const platformAddress = request.headers.get('x-vercel-forwarded-for')?.trim();
    if (!platformAddress || platformAddress.includes(',')) return SHARED_UNTRUSTED_IDENTITY;
    return normalizeRateLimitIp(platformAddress) ?? SHARED_UNTRUSTED_IDENTITY;
  }

  if (!environment.RAILWAY_ENVIRONMENT_ID?.trim()) return SHARED_UNTRUSTED_IDENTITY;
  const railwayRemotePeer = request.headers.get('x-real-ip')?.trim();
  if (!railwayRemotePeer || railwayRemotePeer.includes(',')) return SHARED_UNTRUSTED_IDENTITY;

  if (isIpInAnyCidr(railwayRemotePeer, CLOUDFLARE_PROXY_CIDRS)) {
    const cloudflareClient = request.headers.get('cf-connecting-ip')?.trim();
    if (!cloudflareClient || cloudflareClient.includes(',')) return SHARED_UNTRUSTED_IDENTITY;
    return normalizeRateLimitIp(cloudflareClient) ?? SHARED_UNTRUSTED_IDENTITY;
  }

  return normalizeRateLimitIp(railwayRemotePeer) ?? SHARED_UNTRUSTED_IDENTITY;
}

export function resolvePublicApiRateLimitNamespace(environment: PublicApiEnvironment = process.env): string {
  if (environment.VERCEL === '1') {
    return environment.VERCEL_ENV === 'production' ? 'public-api:web:production' : 'public-api:web:preview';
  }

  const railwayEnvironmentId = environment.RAILWAY_ENVIRONMENT_ID?.trim();
  return railwayEnvironmentId ? `public-api:web:railway:${railwayEnvironmentId}` : 'public-api:web:local';
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
