import { RateLimitError } from '../utils/rate-limiter';
import {
  consumeRateLimitRedis,
  countRateLimitRedis,
  peekRateLimitRedis,
  type RateLimitUsage,
} from '../utils/redis-rate-limiter';
import type { PartnerLimitIdentity } from '../utils/client-ip';

/**
 * The rate limits shared by the partner OAuth routes and the `/v1` API. Every
 * Redis command here gives up after 100 ms and falls back to the per-instance
 * memory limit (`redis-rate-limiter.ts`), so a paused Redis cannot hold a request.
 */
export const PARTNER_LIMIT_WINDOW_MS = 60_000;

export class PartnerRateLimited extends Error {
  constructor(
    readonly limit: number,
    readonly retryAfterSeconds: number,
  ) {
    super('Partner rate limit reached');
  }
}

/** The headers a 429 carries, naming the limit it hit. */
export function partnerRateLimitedHeaders({ limit, retryAfterSeconds }: PartnerRateLimited): Record<string, string> {
  return {
    'retry-after': String(retryAfterSeconds),
    'ratelimit-limit': String(limit),
    'ratelimit-remaining': '0',
    'ratelimit-reset': String(retryAfterSeconds),
  };
}

/**
 * The refusal a full window would give, without counting this call or
 * refusing anything yet. For work that is limited only when it actually
 * happens, decided after the check: the caller throws it or ignores it.
 */
export async function peekPartnerLimit(
  identity: string,
  operation: string,
  maxRequests: number,
): Promise<PartnerRateLimited | null> {
  try {
    await peekRateLimitRedis(identity, operation, maxRequests, PARTNER_LIMIT_WINDOW_MS);
    return null;
  } catch (error) {
    if (error instanceof RateLimitError) return new PartnerRateLimited(maxRequests, error.retryAfterSeconds);
    throw error;
  }
}

/** Adds one to a window without checking it, for work that has already happened. */
export function chargePartnerLimit(identity: string, operation: string): Promise<void> {
  return countRateLimitRedis(identity, operation, PARTNER_LIMIT_WINDOW_MS);
}

/** Limits one request has passed. The lowest `remaining` is the one a client publishes. */
export class RateLimitLedger {
  private readonly usages: RateLimitUsage[] = [];

  consume(identity: string, operation: string, maxRequests: number): Promise<void> {
    return this.record(consumeRateLimitRedis(identity, operation, maxRequests, PARTNER_LIMIT_WINDOW_MS), maxRequests);
  }

  /** Refuses when the window is full, without counting this request. */
  check(identity: string, operation: string, maxRequests: number): Promise<void> {
    return this.record(peekRateLimitRedis(identity, operation, maxRequests, PARTNER_LIMIT_WINDOW_MS), maxRequests);
  }

  private async record(pendingUsage: Promise<RateLimitUsage>, maxRequests: number): Promise<void> {
    try {
      this.usages.push(await pendingUsage);
    } catch (error) {
      if (error instanceof RateLimitError) throw new PartnerRateLimited(maxRequests, error.retryAfterSeconds);
      throw error;
    }
  }

  headers(): Record<string, string> {
    const tightest = this.usages.reduce<RateLimitUsage | undefined>(
      (lowest, usage) => (!lowest || usage.remaining < lowest.remaining ? usage : lowest),
      undefined,
    );
    if (!tightest) return {};
    return {
      'ratelimit-limit': String(tightest.limit),
      'ratelimit-remaining': String(tightest.remaining),
      'ratelimit-reset': String(tightest.resetSeconds),
    };
  }
}

/**
 * Each Cloudflare Worker zone gets every per-address limit to itself, and all
 * zones together get this many times it, counted on the Worker egress address.
 * The zone header is written by the Worker, so without a ceiling one Worker
 * claiming many zones would multiply its budget without end. Ten lets ten
 * busy Worker-hosted apps run at their full limit at once, and holds one that
 * forges zones to ten times what a single address may send.
 */
export const WORKER_EGRESS_CEILING_FACTOR = 10;
/** Names the ceiling buckets, which are never the Worker address's own header-less ones. */
export const WORKER_EGRESS_LIMIT_SUFFIX = 'worker-egress';

/**
 * One per-address limit: the address's (or the Worker zone's) own bucket, then,
 * for a Worker, the ceiling on every zone together. `bucket` builds the key
 * from the identity, so a per-app limit stays per app in the ceiling too. The
 * zone is charged first, so a zone over its own limit spends none of the ceiling.
 */
export async function consumePerAddress(
  ledger: RateLimitLedger,
  identity: PartnerLimitIdentity,
  operation: string,
  maxRequests: number,
  bucket: (address: string) => string = (address) => address,
): Promise<void> {
  await ledger.consume(bucket(identity.key), operation, maxRequests);
  if (identity.sharedEgress !== undefined) {
    await ledger.consume(
      bucket(identity.sharedEgress),
      `${operation}-${WORKER_EGRESS_LIMIT_SUFFIX}`,
      maxRequests * WORKER_EGRESS_CEILING_FACTOR,
    );
  }
}
