import { randomUUID } from 'node:crypto';
import { redisClientManager } from '../../redis/client';
import { reportedClientLimitKey } from '../../utils/client-ip';
import { logger } from '../../utils/logger';
import { checkRateLimit, RateLimitError } from '../../utils/rate-limiter';
import { withRedisDeadline } from '../../utils/redis-rate-limiter';

/**
 * Rejected passwords one client may send a minute: the number the web route and
 * native sign-in use. A client is the address the web reports, IPv6 by `/64`.
 */
export const PASSWORD_LOGIN_CLIENT_LIMIT = { attempts: 10, windowMs: 60_000 } as const;
/**
 * The per-process budget for a sign-in the per-client limit cannot key: no
 * usable client address, or a full fallback table while Redis is away. The
 * same number main applied to every sign-in, counted the same way.
 */
export const UNATTRIBUTED_PASSWORD_LOGIN_BUDGET = { attempts: 180, windowMs: 60_000 } as const;
/** The in-memory key main's budget used, kept so the number means what it did. */
const UNATTRIBUTED_BUDGET_KEY = 'current-store-web-auth:password';
const KEY_PREFIX = 'ratelimit:password-login:client';
/** Clients one process tracks in a minute while Redis is away; past this, new ones take the process budget. */
const MAX_LOCAL_CLIENTS = 50_000;
const WARNING_INTERVAL_MS = 60_000;

/**
 * Admits one attempt into the client's window when it has room, in one step,
 * so a refused attempt is never counted and a parallel burst cannot pass
 * together. Each admitted attempt is a field of the window's hash, named by a
 * random attempt ID, so giving one back is an exact `HDEL`: it removes that
 * attempt and nothing else, even when the admission's reply was lost.
 *
 * KEYS[1] = window hash; ARGV = limit, attempt ID, milliseconds left in the window.
 * Returns 0 when admitted, 1 when the window is full.
 */
const ADMIT_SCRIPT = `
if redis.call('HLEN', KEYS[1]) >= tonumber(ARGV[1]) then
  return 1
end
redis.call('HSET', KEYS[1], ARGV[2], '1')
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return 0
`;

/** The two Redis commands the limiter sends. */
export interface PasswordLoginRedis {
  eval(script: string, numberOfKeys: number, ...args: (string | number)[]): Promise<unknown>;
  hdel(key: string, field: string): Promise<number>;
}

/** An admitted sign-in attempt. */
export interface PasswordLoginAttempt {
  /**
   * Uncounts the attempt. Call it for every outcome except a rejected password:
   * a right password, a replay, a shed or abandoned compare, or no verdict at
   * all. Safe to call twice. Never throws.
   */
  giveBack(): Promise<void>;
}

export interface PasswordLoginLimiter {
  /**
   * Counts one attempt, or throws `RateLimitError` without counting it when the
   * client is out of attempts. Reads nothing about accounts, so a typed address
   * with no account is limited exactly like one with an account.
   */
  admit(request: { readonly clientAddress: string | undefined }): Promise<PasswordLoginAttempt>;
}

/** Why a sign-in fell back to the per-process budget. */
export type UnattributedReason = 'no_public_client_address' | 'local_table_full';

/** Process counters, read by tests and reported in the warning log. */
export interface PasswordLoginMetrics {
  unattributed: Record<UnattributedReason, number>;
  redisFallbacks: number;
}

const metrics: PasswordLoginMetrics = {
  unattributed: { no_public_client_address: 0, local_table_full: 0 },
  redisFallbacks: 0,
};
/** Counts since the last warning, so each log line says how many it covers. */
const sinceLastWarning: PasswordLoginMetrics = {
  unattributed: { no_public_client_address: 0, local_table_full: 0 },
  redisFallbacks: 0,
};
let lastUnattributedWarningAt = Number.NEGATIVE_INFINITY;
let lastRedisWarningAt = Number.NEGATIVE_INFINITY;

export function passwordLoginMetrics(): PasswordLoginMetrics {
  return { unattributed: { ...metrics.unattributed }, redisFallbacks: metrics.redisFallbacks };
}

/**
 * A sign-in the per-client limit could not key. With the web half in place
 * this does not happen, so the log line (at most one a minute, with the count
 * it covers) is how a misconfigured web side shows up.
 */
function recordUnattributed(reason: UnattributedReason): void {
  metrics.unattributed[reason] += 1;
  sinceLastWarning.unattributed[reason] += 1;
  const now = Date.now();
  if (now - lastUnattributedWarningAt < WARNING_INTERVAL_MS) return;
  lastUnattributedWarningAt = now;
  logger.warn('[PasswordLogin] Sign-ins without a per-client limit used the per-process budget', {
    type: 'password_login_metrics',
    ...sinceLastWarning.unattributed,
  });
  sinceLastWarning.unattributed = { no_public_client_address: 0, local_table_full: 0 };
}

function recordRedisFallback(): void {
  metrics.redisFallbacks += 1;
  sinceLastWarning.redisFallbacks += 1;
  const now = Date.now();
  if (now - lastRedisWarningAt < WARNING_INTERVAL_MS) return;
  lastRedisWarningAt = now;
  logger.warn('[PasswordLogin] Redis unavailable; per-client sign-in limits count this process only', {
    type: 'password_login_metrics',
    redisFallbacks: sinceLastWarning.redisFallbacks,
  });
  sinceLastWarning.redisFallbacks = 0;
}

/**
 * This process's own per-client counts, used only while Redis is unavailable.
 * Every entry belongs to the current minute and the table empties when the
 * minute turns, so nothing is evicted early: once it holds `maxClients`, a new
 * client is refused a place (and takes the process budget) instead of pushing
 * out a client that is already being counted.
 */
class LocalClientCounts {
  private window = Number.NaN;
  private readonly counts = new Map<string, number>();

  constructor(private readonly maxClients: number) {}

  admit(clientKey: string, window: number): 'admitted' | 'refused' | 'full' {
    if (window !== this.window) {
      this.counts.clear();
      this.window = window;
    }
    const count = this.counts.get(clientKey);
    if (count === undefined && this.counts.size >= this.maxClients) return 'full';
    if ((count ?? 0) >= PASSWORD_LOGIN_CLIENT_LIMIT.attempts) return 'refused';
    this.counts.set(clientKey, (count ?? 0) + 1);
    return 'admitted';
  }

  giveBack(clientKey: string, window: number): void {
    if (window !== this.window) return;
    const count = this.counts.get(clientKey);
    if (count) this.counts.set(clientKey, count - 1);
  }
}

const NOTHING_TO_GIVE_BACK: PasswordLoginAttempt = { giveBack: async () => {} };

/** Main's per-process budget: counts every attempt, gives none back. */
function chargeUnattributedBudget(reason: UnattributedReason): void {
  recordUnattributed(reason);
  checkRateLimit(
    UNATTRIBUTED_BUDGET_KEY,
    UNATTRIBUTED_PASSWORD_LOGIN_BUDGET.attempts,
    UNATTRIBUTED_PASSWORD_LOGIN_BUDGET.windowMs,
  );
}

/**
 * Staged web sign-in's per-client limit, shared by every backend replica
 * through Redis. While Redis is unavailable (not connected, or no answer in
 * 100 ms) each replica counts its own attempts against the same number, as the
 * backend's other Redis limiters do, rather than refuse every sign-in.
 */
export function createPasswordLoginLimiter(options: {
  /** A connected Redis, or null when there is none. Read on every attempt. */
  readonly redis: () => PasswordLoginRedis | null;
  /** Epoch milliseconds. Tests pin it inside one window. */
  readonly now?: () => number;
  readonly maxLocalClients?: number;
}): PasswordLoginLimiter {
  const clock = options.now ?? Date.now;
  const local = new LocalClientCounts(options.maxLocalClients ?? MAX_LOCAL_CLIENTS);
  const { windowMs, attempts } = PASSWORD_LOGIN_CLIENT_LIMIT;

  /** Takes back the Redis field, if the admission ran there. Exact whether or not its reply arrived. */
  async function giveBackInRedis(windowKey: string, attemptId: string): Promise<void> {
    const redis = options.redis();
    if (!redis) return;
    try {
      await withRedisDeadline(redis.hdel(windowKey, attemptId));
    } catch {
      // The field expires with its window: one extra count for at most a minute.
      recordRedisFallback();
    }
  }

  return {
    async admit({ clientAddress }) {
      const clientKey = reportedClientLimitKey(clientAddress);
      if (clientKey === null) {
        chargeUnattributedBudget('no_public_client_address');
        return NOTHING_TO_GIVE_BACK;
      }
      const now = clock();
      const window = Math.floor(now / windowMs);
      const secondsLeft = Math.max(1, Math.ceil(((window + 1) * windowMs - now) / 1000));
      const windowKey = `${KEY_PREFIX}:${clientKey}:${window}`;
      const attemptId = randomUUID();

      const redis = options.redis();
      if (redis) {
        try {
          const reply = await withRedisDeadline(
            redis.eval(ADMIT_SCRIPT, 1, windowKey, attempts, attemptId, Math.max(1, (window + 1) * windowMs - now)),
          );
          if (reply === 1) throw new RateLimitError(secondsLeft);
          if (reply !== 0) throw new Error('Unexpected limit reply');
          let givenBack = false;
          return {
            async giveBack() {
              if (givenBack) return;
              givenBack = true;
              await giveBackInRedis(windowKey, attemptId);
            },
          };
        } catch (error) {
          if (error instanceof RateLimitError) throw error;
          recordRedisFallback();
        }
      }

      // Redis is absent, failed or slow. A slow Redis may still have run the
      // admission, so every way out also takes that field back from Redis.
      const redisMayHaveCounted = redis !== null;
      const takeBackFromRedis = () => (redisMayHaveCounted ? giveBackInRedis(windowKey, attemptId) : Promise.resolve());
      const decision = local.admit(clientKey, window);
      if (decision === 'refused') {
        await takeBackFromRedis();
        throw new RateLimitError(secondsLeft);
      }
      if (decision === 'full') {
        try {
          chargeUnattributedBudget('local_table_full');
        } catch (error) {
          await takeBackFromRedis();
          throw error;
        }
        return { giveBack: takeBackFromRedis };
      }
      let givenBack = false;
      return {
        async giveBack() {
          if (givenBack) return;
          givenBack = true;
          local.giveBack(clientKey, window);
          await takeBackFromRedis();
        },
      };
    },
  };
}

/** The limiter the staged web sign-in route uses, on the backend's shared Redis. */
export const passwordLoginLimiter = createPasswordLoginLimiter({
  redis: () => {
    if (!redisClientManager.isRedisConnected()) return null;
    const { publisher } = redisClientManager.getClients();
    return {
      eval: (script, numberOfKeys, ...args) => publisher.eval(script, numberOfKeys, ...args),
      hdel: (key, field) => publisher.hdel(key, field),
    };
  },
});
