import type { RegistrationFamilyCommand } from '@boardsesh/auth-protocol';
import { redisClientManager } from '../../redis/client';
import { logger } from '../../utils/logger';
import {
  createClientCommandLimiter,
  type ClientCommandLimiter,
  type ClientCommandRedis,
  type ClientCommandAdmissionSource,
} from './client-command-limits';
import { createPasswordCompareGate, type PasswordCompareGate } from './password-compare-gate';

export type RegistrationOperation = RegistrationFamilyCommand['operation'];
export const REGISTRATION_CLIENT_ATTEMPTS = { register: 10, 'verify-email': 20, 'resend-verification': 5 } as const;
export const REGISTRATION_UNATTRIBUTED_ATTEMPTS = {
  register: 60,
  'verify-email': 180,
  'resend-verification': 180,
} as const;
const operations = ['register', 'verify-email', 'resend-verification'] as const;

export interface RegistrationCommandGuards {
  readonly limits: Readonly<Record<RegistrationOperation, ClientCommandLimiter>>;
  work(operation: RegistrationOperation, source: ClientCommandAdmissionSource): PasswordCompareGate;
}

/** Bounded keys, Redis work and pending command work; no subject/token state. */
export function createRegistrationCommandGuards(
  options: {
    readonly redis?: () => ClientCommandRedis | null;
    readonly now?: () => number;
    readonly maxLocalClients?: number;
    readonly maxPendingRedisCommands?: number;
    readonly concurrency?: number;
    readonly maxWaiting?: number;
  } = {},
): RegistrationCommandGuards {
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
  function limit(operation: RegistrationOperation) {
    let unattributed = 0;
    let redisFallbacks = 0;
    let lastWarning = Number.NEGATIVE_INFINITY;
    function warn() {
      const now = Date.now();
      if (now - lastWarning < 60_000) return;
      lastWarning = now;
      logger.warn('[RegistrationAuth] Admission used bounded fallback', {
        type: 'registration_command_metrics',
        operation,
        unattributed,
        redisFallbacks,
      });
      unattributed = 0;
      redisFallbacks = 0;
    }
    return createClientCommandLimiter({
      redis,
      now: options.now,
      maxLocalClients: options.maxLocalClients,
      maxPendingRedisCommands: options.maxPendingRedisCommands ?? 4,
      policy: {
        attempts: REGISTRATION_CLIENT_ATTEMPTS[operation],
        unattributedAttempts: REGISTRATION_UNATTRIBUTED_ATTEMPTS[operation],
        windowMs: 60_000,
        keyPrefix: `ratelimit:registration:${operation}:client`,
        unattributedKey: `registration-unattributed:${operation}`,
      },
      onUnattributed: () => {
        unattributed += 1;
        warn();
      },
      onRedisFallback: () => {
        redisFallbacks += 1;
        warn();
      },
    });
  }
  const limits = {
    register: limit('register'),
    'verify-email': limit('verify-email'),
    'resend-verification': limit('resend-verification'),
  };
  function gates() {
    return Object.fromEntries(
      operations.map((operation) => [
        operation,
        createPasswordCompareGate({
          concurrency: options.concurrency ?? (operation === 'register' ? 1 : 2),
          maxWaiting: options.maxWaiting ?? 8,
          waitMs: 2500,
        }),
      ]),
    ) as Record<RegistrationOperation, PasswordCompareGate>;
  }
  // Unknown ingress cannot occupy the vouched traffic's work slots. Every set
  // has a fixed size and bounded FIFO; aborting an active HTTP caller never
  // releases its slot before the transaction/hash promise actually settles.
  const vouched = gates();
  const unattributed = gates();
  return { limits, work: (operation, source) => (source === 'unattributed' ? unattributed : vouched)[operation] };
}

export const registrationCommandGuards = createRegistrationCommandGuards();
