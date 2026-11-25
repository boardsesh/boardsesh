import { redisClientManager } from '../../redis/client';
import {
  createClientCommandLimiter,
  type ClientCommandAdmissionSource,
  type ClientCommandLimiter,
  type ClientCommandRedis,
} from './client-command-limits';
import { createPasswordCompareGate, type PasswordCompareGate } from './password-compare-gate';

export interface SetPasswordCompatibilityGuards {
  readonly limits: ClientCommandLimiter;
  work(source: ClientCommandAdmissionSource): PasswordCompareGate;
}
export function createSetPasswordCompatibilityGuards(
  options: {
    readonly redis?: () => ClientCommandRedis | null;
    readonly now?: () => number;
    readonly concurrency?: number;
    readonly maxWaiting?: number;
  } = {},
): SetPasswordCompatibilityGuards {
  const redis =
    options.redis ??
    (() => {
      if (!redisClientManager.isRedisConnected()) return null;
      const { publisher } = redisClientManager.getClients();
      return {
        eval: (script: string, numberOfKeys: number, ...args: (string | number)[]) =>
          publisher.eval(script, numberOfKeys, ...args),
        hdel: (key: string, field: string) => publisher.hdel(key, field),
      };
    });
  const limits = createClientCommandLimiter({
    redis,
    now: options.now,
    maxPendingRedisCommands: 4,
    policy: {
      attempts: 5,
      unattributedAttempts: 180,
      windowMs: 60_000,
      keyPrefix: 'ratelimit:set-password-compatibility:client',
      unattributedKey: 'set-password-compatibility-unattributed',
    },
  });
  const gate = () =>
    createPasswordCompareGate({
      concurrency: options.concurrency ?? 1,
      maxWaiting: options.maxWaiting ?? 8,
      waitMs: 2500,
    });
  const client = gate();
  const unattributed = gate();
  return { limits, work: (source) => (source === 'unattributed' ? unattributed : client) };
}
export const setPasswordCompatibilityGuards = createSetPasswordCompatibilityGuards();
