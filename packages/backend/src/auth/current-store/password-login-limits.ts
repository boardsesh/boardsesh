import { redisClientManager } from '../../redis/client';
import { logger } from '../../utils/logger';

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
const WARNING_INTERVAL_MS = 60_000;

import {
  createClientCommandLimiter,
  type ClientCommandRedis,
  type ClientCommandAttempt,
  type UnattributedReason,
} from './client-command-limits';

export type PasswordLoginRedis = ClientCommandRedis;
export type PasswordLoginAttempt = Pick<ClientCommandAttempt, 'giveBack'>;
export interface PasswordLoginLimiter {
  admit(request: { readonly clientAddress: string | undefined }): Promise<PasswordLoginAttempt>;
}
export type { UnattributedReason } from './client-command-limits';

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

/** Password login retains its original keys, limits, accounting and diagnostics. */
export function createPasswordLoginLimiter(options: {
  readonly redis: () => PasswordLoginRedis | null;
  readonly now?: () => number;
  readonly maxLocalClients?: number;
}): PasswordLoginLimiter {
  const limiter = createClientCommandLimiter({
    ...options,
    policy: {
      ...PASSWORD_LOGIN_CLIENT_LIMIT,
      unattributedAttempts: UNATTRIBUTED_PASSWORD_LOGIN_BUDGET.attempts,
      keyPrefix: KEY_PREFIX,
      unattributedKey: UNATTRIBUTED_BUDGET_KEY,
    },
    onUnattributed: recordUnattributed,
    onRedisFallback: recordRedisFallback,
  });
  return {
    async admit(request) {
      const attempt = await limiter.admit(request);
      return { giveBack: () => attempt.giveBack() };
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
