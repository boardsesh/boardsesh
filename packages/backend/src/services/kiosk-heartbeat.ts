import type Redis from 'ioredis';
import { redisClientManager } from '../redis/client';
import { logger } from '../utils/logger';

/**
 * Kiosk liveness heartbeats, stored in Redis (NOT Postgres) on purpose.
 *
 * A heartbeat is EPHEMERAL operational state written on a hot, public,
 * unauthenticated path (every open TV re-reports on its ~5-minute config-poll
 * cadence). Keeping it out of Postgres avoids a migration and the write
 * amplification a per-poll UPDATE would cause. The trade-off is that a Redis
 * restart drops every heartbeat — which is fine: each live kiosk re-reports
 * within one poll cycle, so the manage UI briefly shows "No signal yet" until
 * the next check-in rather than a false "dead".
 *
 * IMPORTANT for readers: a missing/expired signal means "unknown", never "this
 * TV is definitely down". Treat null as an absence of information.
 *
 * ACCEPTED RISK — forged heartbeats. Kiosk and gym UUIDs are public by design:
 * they're serialized into the kiosk page HTML and embed URLs, so anyone can
 * replay a valid pair and mark a kiosk "live" without a TV actually running.
 * This is deliberately tolerated (low severity): the only impact is griefing a
 * liveness indicator — a dead screen could read as live — with no data exposure
 * and nothing mutated in Postgres. Optional future hardening, if it ever needs
 * closing, is a server-rendered per-kiosk HMAC token the heartbeat must echo,
 * not a change to this store.
 */

/** 30 days — comfortably longer than any realistic gym closure so a kiosk that
 * goes quiet still reads as "last seen 3 weeks ago" rather than falling off. */
const HEARTBEAT_TTL_SECONDS = 30 * 24 * 60 * 60;
/** How long a positive kiosk-existence lookup is cached, to spare the DB on the
 * hot heartbeat path. Short enough that a deleted kiosk stops accepting
 * heartbeats within the hour. */
const EXISTS_CACHE_TTL_SECONDS = 60 * 60;

function heartbeatKey(gymUuid: string, kioskUuid: string): string {
  return `boardsesh:kiosk:heartbeat:${gymUuid}:${kioskUuid}`;
}

function existsCacheKey(gymUuid: string, kioskUuid: string): string {
  return `boardsesh:kiosk:exists:${gymUuid}:${kioskUuid}`;
}

/**
 * The JSON value stored per kiosk. `lastSeenAt` is epoch millis. `viewport`
 * (e.g. "1920x1080") is a coarse client marker persisted for future ops/debug
 * use — it is intentionally write-only today, not surfaced by any read.
 */
type HeartbeatValue = { lastSeenAt: number; viewport?: string };

// Test seam: the roundtrip suite injects a real Redis client here (mirrors how
// distributed-state.test.ts drives real Redis) so the resolver path can be
// exercised without booting the whole redisClientManager singleton. Module-level
// mutable state is fine for today's serial test execution; it would race if the
// suite ever ran multiple Vitest workers sharing this module.
let clientOverrideForTests: Redis | null = null;

/** @internal test-only — inject/clear the Redis client the heartbeat store uses. */
export function _setKioskHeartbeatRedisForTests(client: Redis | null): void {
  clientOverrideForTests = client;
}

/**
 * The Redis client to use, or null when Redis isn't available. Null makes every
 * operation a graceful no-op: writes drop, reads return "unknown".
 */
function resolveClient(): Redis | null {
  if (clientOverrideForTests) return clientOverrideForTests;
  if (!redisClientManager.isRedisConnected()) return null;
  return redisClientManager.getClients().publisher;
}

/** Record that a kiosk just checked in. No-op when Redis is unavailable. */
export async function recordKioskHeartbeat(params: {
  gymUuid: string;
  kioskUuid: string;
  viewport?: string | null;
}): Promise<void> {
  const client = resolveClient();
  if (!client) return;

  const value: HeartbeatValue = { lastSeenAt: Date.now() };
  if (params.viewport) value.viewport = params.viewport;

  try {
    await client.set(
      heartbeatKey(params.gymUuid, params.kioskUuid),
      JSON.stringify(value),
      'EX',
      HEARTBEAT_TTL_SECONDS,
    );
  } catch (error) {
    // A dropped heartbeat is inconsequential — the next poll re-reports.
    logger.warn('[KioskHeartbeat] Failed to record heartbeat', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** True when a prior positive existence check is still cached. */
export async function isKioskExistenceCached(gymUuid: string, kioskUuid: string): Promise<boolean> {
  const client = resolveClient();
  if (!client) return false;
  try {
    return (await client.exists(existsCacheKey(gymUuid, kioskUuid))) === 1;
  } catch {
    return false;
  }
}

/** Cache a positive kiosk-existence result so repeat heartbeats skip the DB. */
export async function cacheKioskExistence(gymUuid: string, kioskUuid: string): Promise<void> {
  const client = resolveClient();
  if (!client) return;
  try {
    await client.set(existsCacheKey(gymUuid, kioskUuid), '1', 'EX', EXISTS_CACHE_TTL_SECONDS);
  } catch {
    // Best-effort cache; a miss just costs one indexed lookup next time.
  }
}

/**
 * Batch-read last-seen timestamps for a gym's kiosks (single MGET). Every
 * requested uuid appears in the result: an ISO 8601 string when a live
 * heartbeat exists, or null for "no signal" (never reported, expired, corrupt
 * value, or Redis unavailable).
 */
export async function readKioskLastSeen(gymUuid: string, kioskUuids: string[]): Promise<Map<string, string | null>> {
  const lastSeenByUuid = new Map<string, string | null>();
  for (const uuid of kioskUuids) lastSeenByUuid.set(uuid, null);
  if (kioskUuids.length === 0) return lastSeenByUuid;

  const client = resolveClient();
  if (!client) return lastSeenByUuid;

  try {
    const keys = kioskUuids.map((uuid) => heartbeatKey(gymUuid, uuid));
    const rawValues = await client.mget(...keys);
    kioskUuids.forEach((uuid, index) => {
      const raw = rawValues[index];
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw) as HeartbeatValue;
        if (typeof parsed.lastSeenAt === 'number' && Number.isFinite(parsed.lastSeenAt)) {
          lastSeenByUuid.set(uuid, new Date(parsed.lastSeenAt).toISOString());
        }
      } catch {
        // Corrupt/legacy value: leave it null rather than surface a bad date.
      }
    });
  } catch (error) {
    logger.warn('[KioskHeartbeat] Failed to read heartbeats', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return lastSeenByUuid;
}
