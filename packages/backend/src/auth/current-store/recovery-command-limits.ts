import { redisClientManager } from '../../redis/client';
import {
  createClientCommandLimiter,
  type ClientCommandAdmissionSource,
  type ClientCommandLimiter,
  type ClientCommandRedis,
} from './client-command-limits';
import { createPasswordCompareGate, type PasswordCompareGate } from './password-compare-gate';

type Operation = 'forgot-password' | 'reset-password';
export interface RecoveryCommandGuards {
  readonly limits: Readonly<Record<Operation, ClientCommandLimiter>>;
  work(operation: Operation, source: ClientCommandAdmissionSource): PasswordCompareGate;
}
export function createRecoveryCommandGuards(
  options: {
    readonly redis?: () => ClientCommandRedis | null;
    readonly now?: () => number;
    readonly concurrency?: number;
    readonly maxWaiting?: number;
  } = {},
): RecoveryCommandGuards {
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
  const limit = (operation: Operation) =>
    createClientCommandLimiter({
      redis,
      now: options.now,
      maxPendingRedisCommands: 4,
      policy: {
        attempts: 5,
        unattributedAttempts: 180,
        windowMs: 60_000,
        keyPrefix: `ratelimit:recovery:${operation}:client`,
        unattributedKey: `recovery-unattributed:${operation}`,
      },
    });
  const gates = () => ({
    'forgot-password': createPasswordCompareGate({
      concurrency: options.concurrency ?? 2,
      maxWaiting: options.maxWaiting ?? 8,
      waitMs: 2500,
    }),
    'reset-password': createPasswordCompareGate({
      concurrency: options.concurrency ?? 1,
      maxWaiting: options.maxWaiting ?? 8,
      waitMs: 2500,
    }),
  });
  const vouched = gates();
  const unattributed = gates();
  return {
    limits: { 'forgot-password': limit('forgot-password'), 'reset-password': limit('reset-password') },
    work: (operation, source) => (source === 'unattributed' ? unattributed : vouched)[operation],
  };
}
export const recoveryCommandGuards = createRecoveryCommandGuards();
