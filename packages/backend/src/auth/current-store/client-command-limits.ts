import { randomUUID } from 'node:crypto';
import { reportedClientLimitKey } from '../../utils/client-ip';
import { checkRateLimit, RateLimitError } from '../../utils/rate-limiter';
import { withRedisDeadline } from '../../utils/redis-rate-limiter';

/** Shared atomic client-window engine; callers supply fixed server-owned policies. */
const ADMIT_SCRIPT = `
if redis.call('HLEN', KEYS[1]) >= tonumber(ARGV[1]) then
  return 1
end
redis.call('HSET', KEYS[1], ARGV[2], '1')
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return 0
`;

/** The two Redis commands the limiter sends. */
export interface ClientCommandRedis {
  eval(script: string, numberOfKeys: number, ...args: (string | number)[]): Promise<unknown>;
  hdel(key: string, field: string): Promise<number>;
}

/** An admitted sign-in attempt. */
export type ClientCommandAdmissionSource = 'client' | 'unattributed';
export interface ClientCommandAttempt {
  readonly source: ClientCommandAdmissionSource;
  /**
   * Exact refund when the caller's policy permits one. Safe twice; never throws.
   * Password login refunds non-rejections; registration counts every attempt.
   */
  giveBack(): Promise<void>;
}

export interface ClientCommandLimiter {
  /**
   * Counts one attempt, or throws `RateLimitError` without counting it when the
   * client is out of attempts. Reads nothing about accounts, so a typed address
   * with no account is limited exactly like one with an account.
   */
  admit(request: { readonly clientAddress: string | undefined }): Promise<ClientCommandAttempt>;
}

/** Why a sign-in fell back to the per-process budget. */
export type UnattributedReason = 'no_public_client_address' | 'local_table_full';

class LocalClientCounts {
  private window = Number.NaN;
  private readonly counts = new Map<string, number>();

  constructor(
    private readonly maxClients: number,
    private readonly attempts: number,
  ) {}

  admit(clientKey: string, window: number): 'admitted' | 'refused' | 'full' {
    if (window < this.window) return 'refused';
    if (window !== this.window) {
      this.counts.clear();
      this.window = window;
    }
    const count = this.counts.get(clientKey);
    if (count === undefined && this.counts.size >= this.maxClients) return 'full';
    if ((count ?? 0) >= this.attempts) return 'refused';
    this.counts.set(clientKey, (count ?? 0) + 1);
    return 'admitted';
  }

  giveBack(clientKey: string, window: number): void {
    if (window !== this.window) return;
    const count = this.counts.get(clientKey);
    if (count) this.counts.set(clientKey, count - 1);
  }
}

const NOTHING_TO_GIVE_BACK: ClientCommandAttempt = { source: 'unattributed', giveBack: async () => {} };

export function createClientCommandLimiter(options: {
  readonly redis: () => ClientCommandRedis | null;
  readonly now?: () => number;
  readonly maxLocalClients?: number;
  /** Capacity remains occupied until the underlying Redis promise settles. */
  readonly maxPendingRedisCommands?: number;
  readonly policy: {
    readonly attempts: number;
    readonly unattributedAttempts: number;
    readonly windowMs: number;
    readonly keyPrefix: string;
    readonly unattributedKey: string;
  };
  readonly onUnattributed?: (reason: UnattributedReason) => void;
  readonly onRedisFallback?: () => void;
}): ClientCommandLimiter {
  let pendingRedisCommands = 0;
  async function redisCommand<Result>(start: () => Promise<Result>): Promise<Result> {
    if (pendingRedisCommands >= (options.maxPendingRedisCommands ?? Number.POSITIVE_INFINITY))
      throw new Error('Client limit Redis capacity unavailable');
    pendingRedisCommands += 1;
    let command: Promise<Result>;
    try {
      command = start();
    } catch (error) {
      pendingRedisCommands -= 1;
      throw error;
    }
    // withRedisDeadline stops only the caller's wait. The capacity follows the
    // real operation, including late fulfillment/rejection after that deadline.
    const settled = command.finally(() => {
      pendingRedisCommands -= 1;
    });
    return withRedisDeadline(settled);
  }
  const clock = options.now ?? Date.now;
  const { windowMs, attempts } = options.policy;
  const local = new LocalClientCounts(options.maxLocalClients ?? 50_000, attempts);
  function chargeUnattributedBudget(reason: UnattributedReason) {
    options.onUnattributed?.(reason);
    checkRateLimit(options.policy.unattributedKey, options.policy.unattributedAttempts, windowMs);
  }

  /** Takes back the Redis field, if the admission ran there. Exact whether or not its reply arrived. */
  async function giveBackInRedis(windowKey: string, attemptId: string): Promise<void> {
    const redis = options.redis();
    if (!redis) return;
    try {
      await redisCommand(() => redis.hdel(windowKey, attemptId));
    } catch {
      // The field expires with its window: one extra count for at most a minute.
      options.onRedisFallback?.();
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
      const windowKey = `${options.policy.keyPrefix}:${clientKey}:${window}`;
      const attemptId = randomUUID();

      const redis = options.redis();
      if (redis) {
        try {
          const reply = await redisCommand(() =>
            redis.eval(ADMIT_SCRIPT, 1, windowKey, attempts, attemptId, Math.max(1, (window + 1) * windowMs - now)),
          );
          if (reply === 1) throw new RateLimitError(secondsLeft);
          if (reply !== 0) throw new Error('Unexpected limit reply');
          let givenBack = false;
          return {
            source: 'client',
            async giveBack() {
              if (givenBack) return;
              givenBack = true;
              await giveBackInRedis(windowKey, attemptId);
            },
          };
        } catch (error) {
          if (error instanceof RateLimitError) throw error;
          options.onRedisFallback?.();
        }
      }

      // Redis is absent, failed or slow. A slow Redis may still have run the
      // admission, so every way out also takes that field back from Redis.
      const redisMayHaveCounted = redis !== null;
      const takeBackFromRedis = () => (redisMayHaveCounted ? giveBackInRedis(windowKey, attemptId) : Promise.resolve());
      // A Redis timeout may cross the boundary while a newer request already
      // populated local state. Never hand the old window back to that map.
      const localNow = clock();
      const localWindow = Math.floor(localNow / windowMs);
      const localSecondsLeft = Math.max(1, Math.ceil(((localWindow + 1) * windowMs - localNow) / 1000));
      const decision = local.admit(clientKey, localWindow);
      if (decision === 'refused') {
        await takeBackFromRedis();
        throw new RateLimitError(localSecondsLeft);
      }
      if (decision === 'full') {
        try {
          chargeUnattributedBudget('local_table_full');
        } catch (error) {
          await takeBackFromRedis();
          throw error;
        }
        return { source: 'unattributed', giveBack: takeBackFromRedis };
      }
      let givenBack = false;
      return {
        source: 'client',
        async giveBack() {
          if (givenBack) return;
          givenBack = true;
          local.giveBack(clientKey, localWindow);
          await takeBackFromRedis();
        },
      };
    },
  };
}
