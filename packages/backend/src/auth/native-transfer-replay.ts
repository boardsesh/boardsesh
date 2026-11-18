import { redisClientManager } from '../redis/client';
import { logger } from '../utils/logger';
import { legacyBridgeMode } from './authority/bridge';

/**
 * The one spent marker for native OAuth transfer tokens, shared by the native
 * exchange and the web transfer sign-in (#7596, B4c), keyed on the recomputed
 * signature (`VerifiedNativeTransfer.replayKey`). Its own module so the web
 * path does not load the native handler.
 */

/**
 * In-memory fallback for consumed transfer token signatures when Redis is
 * unavailable. When Redis is connected, tokens are stored with SET NX EX for
 * atomic, multi-instance-safe replay prevention.
 */
const consumedTransferTokens = new Map<string, number>();

/** TTL for consumed token entries (125s — slightly longer than the 120s token TTL). */
// At most 125 signed seconds + two 5-second verification tolerances, plus
// 60 seconds of clock offset in each replica, is 255 seconds. Five minutes
// also covers whole-second rounding and scheduling margin across replicas.
const CONSUMED_TOKEN_TTL_SECONDS = 5 * 60;
const CONSUMED_TOKEN_TTL_MS = CONSUMED_TOKEN_TTL_SECONDS * 1000;

/** Cleanup interval for expired consumed token entries. */
const CONSUMED_TOKEN_CLEANUP_INTERVAL_MS = 60_000;

/** Max entries before triggering early eviction. */
const MAX_CONSUMED_TOKENS = 10_000;

/** Redis key prefix for consumed transfer tokens. */
const CONSUMED_TOKEN_REDIS_PREFIX = 'boardsesh:native-auth:consumed:';

/** Evict stale entries from the consumed-token map. */
function evictStaleConsumedTokens(): void {
  const cutoff = Date.now() - CONSUMED_TOKEN_TTL_MS;
  for (const [signature, timestamp] of consumedTransferTokens) {
    if (timestamp < cutoff) consumedTransferTokens.delete(signature);
  }
}

// Periodically evict stale consumed-token entries so the map doesn't grow unbounded.
const consumedTokenEvictionHandle = setInterval(evictStaleConsumedTokens, CONSUMED_TOKEN_CLEANUP_INTERVAL_MS);
if (typeof consumedTokenEvictionHandle.unref === 'function') consumedTokenEvictionHandle.unref();

/**
 * Attempt to mark a transfer token signature as consumed.
 * Returns 'consumed' if freshly consumed, 'replay' if already used, 'overloaded' if map is full.
 *
 * When Redis is connected, uses SET NX EX for atomic multi-instance replay prevention.
 * Falls back to the in-memory map otherwise (single-instance only).
 */
export async function markTokenConsumed(tokenSignature: string): Promise<'consumed' | 'replay' | 'overloaded'> {
  if (redisClientManager.isRedisConnected()) {
    try {
      const { publisher } = redisClientManager.getClients();
      const redisKey = `${CONSUMED_TOKEN_REDIS_PREFIX}${tokenSignature}`;
      // Keep the replay key beyond the latest accepted signed expiry plus skew.
      const result = await publisher.set(redisKey, '1', 'EX', CONSUMED_TOKEN_TTL_SECONDS, 'NX');
      return result === 'OK' ? 'consumed' : 'replay';
    } catch {
      // Redis failure: fall through to in-memory map so the endpoint stays available.
      logger.warn('[NativeAuth] Redis replay store unavailable', { code: 'REDIS_REPLAY_WRITE_UNAVAILABLE' });
    }
  }

  if (legacyBridgeMode(process.env) === 'on') return 'overloaded';
  // In-memory fallback (single-instance only)
  if (consumedTransferTokens.has(tokenSignature)) {
    return 'replay';
  }

  if (consumedTransferTokens.size >= MAX_CONSUMED_TOKENS) {
    evictStaleConsumedTokens();
    if (consumedTransferTokens.size >= MAX_CONSUMED_TOKENS) {
      return 'overloaded';
    }
  }

  consumedTransferTokens.set(tokenSignature, Date.now());
  return 'consumed';
}

/**
 * Check if a transfer token signature has already been consumed (read-only check).
 * Used for the early-reject path before verifying the HMAC.
 */
export async function isTokenConsumed(tokenSignature: string): Promise<boolean> {
  if (redisClientManager.isRedisConnected()) {
    try {
      const { publisher } = redisClientManager.getClients();
      const redisKey = `${CONSUMED_TOKEN_REDIS_PREFIX}${tokenSignature}`;
      const result = await publisher.exists(redisKey);
      return result === 1;
    } catch {
      logger.warn('[NativeAuth] Redis replay check unavailable', { code: 'REDIS_REPLAY_READ_UNAVAILABLE' });
    }
  }
  return consumedTransferTokens.has(tokenSignature);
}

/** Test-only: forget every consumed token. */
export function resetConsumedTransferTokensForTests(): void {
  consumedTransferTokens.clear();
}

/** Test-only: fill the in-memory map for capacity tests. */
export function fillConsumedTransferTokensForTests(count: number): void {
  const now = Date.now();
  for (let i = 0; i < count; i++) consumedTransferTokens.set(`test-sig-${String(i)}`, now);
}
