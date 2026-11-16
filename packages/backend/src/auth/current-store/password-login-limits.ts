import { createHmac } from 'node:crypto';
import type Redis from 'ioredis';
import { normalizeAccountEmail } from '@boardsesh/auth-protocol/account-email';
import { redisClientManager } from '../../redis/client';
import { reportedClientLimitKey } from '../../utils/client-ip';
import { logger } from '../../utils/logger';
import { RateLimitError } from '../../utils/rate-limiter';
import { withRedisDeadline } from '../../utils/redis-rate-limiter';
import type { PasswordCompareLane } from './password-compare-gate';

/**
 * Rejected passwords one client may send a minute: the number the web route and
 * native sign-in use. A client is the address the web reports, IPv6 by `/64`.
 */
export const PASSWORD_LOGIN_CLIENT_LIMIT = { attempts: 10, windowMs: 60_000 } as const;
/**
 * Rejected passwords one address may receive from everyone together in 15
 * minutes, counted whether or not it has an account. Caps guessing one
 * climber's password from many clients at 80 an hour.
 */
export const PASSWORD_LOGIN_ACCOUNT_LIMIT = { attempts: 20, windowMs: 15 * 60_000 } as const;

const KEY_PREFIX = 'ratelimit:password-login';
/** Windows one process keeps while Redis is away; the oldest go first past this. */
const MAX_LOCAL_WINDOWS = 50_000;
const WARNING_INTERVAL_MS = 60_000;

/**
 * Counts this attempt in every bucket only when none is full, in one step, so a
 * refused attempt costs no bucket anything and a parallel burst cannot pass
 * together. Returns the 1-based index of the full bucket (0 when admitted) and
 * the first bucket's count before this attempt.
 *
 * KEYS = bucket keys; ARGV = each bucket's limit, then each bucket's window in ms.
 */
const ADMIT_SCRIPT = `
local buckets = #KEYS
for index = 1, buckets do
  if tonumber(redis.call('GET', KEYS[index]) or '0') >= tonumber(ARGV[index]) then
    return {index, 0}
  end
end
local first = tonumber(redis.call('GET', KEYS[1]) or '0')
for index = 1, buckets do
  if redis.call('INCR', KEYS[index]) == 1 then
    redis.call('PEXPIRE', KEYS[index], ARGV[buckets + index])
  end
end
return {0, first}
`;

/** Takes one back from each bucket that still holds a count. A window that ended is left alone. */
const GIVE_BACK_SCRIPT = `
for index = 1, #KEYS do
  if tonumber(redis.call('GET', KEYS[index]) or '0') > 0 then
    redis.call('DECR', KEYS[index])
  end
end
return 0
`;

interface Bucket {
  readonly key: string;
  readonly attempts: number;
  readonly windowMs: number;
}

interface Decision {
  /** 1-based index of the bucket that was full, or 0 when admitted. */
  readonly refused: number;
  /** The first bucket's count before this attempt. */
  readonly firstPrevious: number;
  readonly store: 'redis' | 'local';
}

export type PasswordLoginRedis = Pick<Redis, 'eval'>;

/** An admitted sign-in attempt, counted against its client and its address. */
export interface PasswordLoginAttempt {
  readonly lane: PasswordCompareLane;
  /**
   * Uncounts the attempt. Call it for every outcome except a rejected password:
   * a right password, a replay, or no verdict at all. Safe to call twice.
   */
  giveBack(): Promise<void>;
}

export interface PasswordLoginLimiter {
  /**
   * Counts one attempt, or throws `RateLimitError` without counting it when the
   * client or the address is out of attempts. Reads nothing about accounts, so
   * an address with no account is limited exactly like one with an account.
   */
  admit(request: {
    readonly email: string;
    readonly clientAddress: string | undefined;
    /** Keys the address digest, so Redis never holds an address. */
    readonly keySecret: string;
  }): Promise<PasswordLoginAttempt>;
}

function windowIndex(bucket: Pick<Bucket, 'windowMs'>, now: number): number {
  return Math.floor(now / bucket.windowMs);
}

function secondsUntilWindowEnds(bucket: Bucket, now: number): number {
  return Math.max(1, Math.ceil((bucket.windowMs - (now % bucket.windowMs)) / 1000));
}

/** This process's own counts, used only while Redis is unavailable. */
class LocalWindows {
  private readonly windows = new Map<string, { count: number; expiresAt: number }>();

  private live(key: string, now: number) {
    const entry = this.windows.get(key);
    if (entry && entry.expiresAt <= now) {
      this.windows.delete(key);
      return undefined;
    }
    return entry;
  }

  admit(buckets: readonly Bucket[], now: number): Omit<Decision, 'store'> {
    const fullIndex = buckets.findIndex((bucket) => (this.live(bucket.key, now)?.count ?? 0) >= bucket.attempts);
    if (fullIndex !== -1) return { refused: fullIndex + 1, firstPrevious: 0 };
    const firstPrevious = this.live(buckets[0].key, now)?.count ?? 0;
    for (const bucket of buckets) {
      const entry = this.live(bucket.key, now);
      if (entry) {
        entry.count += 1;
        continue;
      }
      // Insertion order is age order, so the oldest windows make room first.
      while (this.windows.size >= MAX_LOCAL_WINDOWS) {
        const oldest = this.windows.keys().next();
        if (oldest.done) break;
        this.windows.delete(oldest.value);
      }
      this.windows.set(bucket.key, { count: 1, expiresAt: (windowIndex(bucket, now) + 1) * bucket.windowMs });
    }
    return { refused: 0, firstPrevious };
  }

  giveBack(keys: readonly string[], now: number): void {
    for (const key of keys) {
      const entry = this.live(key, now);
      if (entry && entry.count > 0) entry.count -= 1;
    }
  }
}

const lastWarningAt = new Map<string, number>();

function warnAtMostOnceAMinute(message: string): void {
  const now = Date.now();
  if (now - (lastWarningAt.get(message) ?? Number.NEGATIVE_INFINITY) < WARNING_INTERVAL_MS) return;
  lastWarningAt.set(message, now);
  logger.warn(message);
}

/** HMAC, not a plain hash: an address is guessable, so a bare digest would name it. */
function accountDigest(keySecret: string, email: string): string {
  return createHmac('sha256', keySecret)
    .update('boardsesh password-login account v1\n')
    .update(normalizeAccountEmail(email))
    .digest('base64url');
}

function isDecisionReply(reply: unknown): reply is [number, number] {
  return Array.isArray(reply) && typeof reply[0] === 'number' && typeof reply[1] === 'number';
}

/**
 * Staged web sign-in limits, shared by every backend replica through Redis.
 * While Redis is unavailable (not connected, or no answer in 100 ms) each
 * replica counts its own attempts against the same numbers, as the other
 * Redis limiters do, rather than refuse every sign-in.
 */
export function createPasswordLoginLimiter(options: {
  /** A connected Redis, or null when there is none. Read on every attempt. */
  readonly redis: () => PasswordLoginRedis | null;
  /** Epoch milliseconds. Tests pin it inside one window. */
  readonly now?: () => number;
}): PasswordLoginLimiter {
  const clock = options.now ?? Date.now;
  const local = new LocalWindows();

  async function decide(buckets: readonly Bucket[], now: number): Promise<Decision> {
    const redis = options.redis();
    if (redis) {
      try {
        const reply = await withRedisDeadline(
          redis.eval(
            ADMIT_SCRIPT,
            buckets.length,
            ...buckets.map((bucket) => bucket.key),
            ...buckets.map((bucket) => bucket.attempts),
            ...buckets.map((bucket) => bucket.windowMs),
          ),
        );
        if (!isDecisionReply(reply)) throw new Error('Unexpected limit reply');
        return { refused: reply[0], firstPrevious: reply[1], store: 'redis' };
      } catch {
        warnAtMostOnceAMinute('[PasswordLogin] Redis unavailable; sign-in limits count this process only');
      }
    }
    return { ...local.admit(buckets, now), store: 'local' };
  }

  async function giveBack(store: Decision['store'], keys: readonly string[]): Promise<void> {
    if (store === 'local') {
      local.giveBack(keys, clock());
      return;
    }
    const redis = options.redis();
    if (!redis) return;
    try {
      await withRedisDeadline(redis.eval(GIVE_BACK_SCRIPT, keys.length, ...keys));
    } catch {
      // The attempt stays counted until its window ends: one extra, never one fewer.
      warnAtMostOnceAMinute('[PasswordLogin] Redis unavailable; an attempt stays counted until its window ends');
    }
  }

  return {
    async admit({ email, clientAddress, keySecret }) {
      const now = clock();
      const clientKey = reportedClientLimitKey(clientAddress);
      if (clientKey === null) {
        warnAtMostOnceAMinute(
          '[PasswordLogin] Sign-in without a public client address; only the address limit applies',
        );
      }
      const bucket = (kind: string, identity: string, limit: { attempts: number; windowMs: number }): Bucket => ({
        key: `${KEY_PREFIX}:${kind}:${identity}:${windowIndex(limit, now)}`,
        attempts: limit.attempts,
        windowMs: limit.windowMs,
      });
      // The client bucket goes first: the script reports the first bucket's count.
      const buckets = [
        ...(clientKey === null ? [] : [bucket('client', clientKey, PASSWORD_LOGIN_CLIENT_LIMIT)]),
        bucket('account', accountDigest(keySecret, email), PASSWORD_LOGIN_ACCOUNT_LIMIT),
      ];
      const decision = await decide(buckets, now);
      if (decision.refused > 0) {
        throw new RateLimitError(secondsUntilWindowEnds(buckets[decision.refused - 1], now));
      }
      let givenBack = false;
      return {
        lane: clientKey !== null && decision.firstPrevious === 0 ? 'first' : 'repeat',
        async giveBack() {
          if (givenBack) return;
          givenBack = true;
          await giveBack(
            decision.store,
            buckets.map((counted) => counted.key),
          );
        },
      };
    },
  };
}

/** The limiter the staged web sign-in route uses, on the backend's shared Redis. */
export const passwordLoginLimiter = createPasswordLoginLimiter({
  redis: () => (redisClientManager.isRedisConnected() ? redisClientManager.getClients().publisher : null),
});
