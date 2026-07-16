import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vite-plus/test';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { socialGymKioskQueries, socialGymKioskMutations } from '../graphql/resolvers/social/gym-kiosks';
import { _setKioskHeartbeatRedisForTests } from '../services/kiosk-heartbeat';

/**
 * Real-DB + real-Redis coverage for the kiosk heartbeat path:
 *   - kioskHeartbeat write → gymKiosks read roundtrip surfaces a fresh
 *     lastSeenAt;
 *   - a kiosk that never checked in reads back null (vs a set one);
 *   - a heartbeat for a non-existent (kiosk, gym) pair returns false and writes
 *     nothing;
 *   - the per-client rate limit trips after the ceiling.
 *
 * Redis is injected via the store's test seam (mirrors distributed-state.test.ts
 * driving real Redis) so the resolver path runs end-to-end without booting the
 * whole redisClientManager singleton. Redis-dependent tests skip when Redis is
 * unavailable.
 */

const OWNER = 'kh-owner';
const RANDOM = 'kh-random';
const ALL_USERS = [OWNER, RANDOM];

let connectionCounter = 0;
const authCtx = (userId: string): ConnectionContext =>
  ({ connectionId: `conn-${userId}-${connectionCounter++}`, isAuthenticated: true, userId }) as ConnectionContext;
const anonCtx = (): ConnectionContext =>
  ({ connectionId: `conn-anon-${connectionCounter++}`, isAuthenticated: false }) as ConnectionContext;

const insertUser = (id: string) =>
  db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'User ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);

const insertGym = async (opts: {
  ownerId: string;
  name: string;
  slug: string;
}): Promise<{ id: number; uuid: string; slug: string }> => {
  const uuid = uuidv4();
  const result = await db.execute(sql`
    INSERT INTO gyms (uuid, name, slug, owner_id, is_public, created_at, updated_at)
    VALUES (${uuid}, ${opts.name}, ${opts.slug}, ${opts.ownerId}, true, now(), now())
    RETURNING id
  `);
  return { id: Number(Array.from(result as Iterable<{ id: number }>)[0].id), uuid, slug: opts.slug };
};

const emptyLayout = () => JSON.stringify({ version: 1, boards: [], leaderboard: null });

const insertKiosk = async (opts: { gymId: number; slug: string; name: string }): Promise<{ uuid: string }> => {
  const uuid = uuidv4();
  await db.execute(sql`
    INSERT INTO gym_kiosks (uuid, gym_id, slug, name, layout, created_at, updated_at)
    VALUES (${uuid}, ${opts.gymId}, ${opts.slug}, ${opts.name}, ${emptyLayout()}::jsonb, now(), now())
  `);
  return { uuid };
};

let gym: { id: number; uuid: string; slug: string };
let kioskA: { uuid: string };
let kioskB: { uuid: string };

async function resetAndSeed(): Promise<void> {
  await db.execute(sql`TRUNCATE TABLE "gym_kiosks", "gym_members", "user_boards", "gyms" RESTART IDENTITY CASCADE`);
  await Promise.all(ALL_USERS.map(insertUser));
  gym = await insertGym({ ownerId: OWNER, name: 'Heartbeat Gym', slug: 'heartbeat-gym' });
  kioskA = await insertKiosk({ gymId: gym.id, slug: 'front-wall', name: 'Front Wall' });
  kioskB = await insertKiosk({ gymId: gym.id, slug: 'back-wall', name: 'Back Wall' });
}

// ---------------------------------------------------------------------------
// Real-Redis roundtrip
// ---------------------------------------------------------------------------

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6380';

async function isRedisAvailable(): Promise<boolean> {
  const probe = new Redis(REDIS_URL, { connectTimeout: 1000, maxRetriesPerRequest: 0, lazyConnect: true });
  try {
    await probe.connect();
    await probe.ping();
    await probe.quit();
    return true;
  } catch {
    try {
      await probe.quit();
    } catch {
      // ignore
    }
    return false;
  }
}

const redisAvailable = await isRedisAvailable();

describe.skipIf(!redisAvailable)('kiosk heartbeat roundtrip (real Redis)', () => {
  let redis: Redis;

  beforeAll(async () => {
    redis = new Redis(REDIS_URL);
    await new Promise<void>((resolve) => redis.once('ready', resolve));
    _setKioskHeartbeatRedisForTests(redis);
  });

  afterAll(async () => {
    _setKioskHeartbeatRedisForTests(null);
    await redis.quit();
  });

  beforeEach(async () => {
    const keys = await redis.keys('boardsesh:kiosk:*');
    if (keys.length > 0) await redis.del(...keys);
    await resetAndSeed();
  });

  it('records a heartbeat that the manage list reads back as a fresh lastSeenAt', async () => {
    const recorded = await socialGymKioskMutations.kioskHeartbeat(
      null,
      { input: { kioskUuid: kioskA.uuid, gymUuid: gym.uuid, viewportWidth: 1920, viewportHeight: 1080 } },
      anonCtx(),
    );
    expect(recorded).toBe(true);

    const kiosks = await socialGymKioskQueries.gymKiosks(null, { gymUuid: gym.uuid }, authCtx(OWNER));
    const seen = kiosks.find((kiosk) => kiosk.uuid === kioskA.uuid);
    expect(seen).toBeDefined();
    expect(seen!.lastSeenAt).not.toBeNull();
    // Fresh: within a few seconds of now.
    expect(Date.now() - Date.parse(seen!.lastSeenAt!)).toBeLessThan(5000);
  });

  it('never leaks liveness through the PUBLIC gymKiosk read, even after a heartbeat', async () => {
    // Pins the invariant that only the edit-guarded gymKiosks query exposes
    // lastSeenAt. kioskA is the oldest kiosk, so the slug-less public read
    // returns it — and even with a fresh heartbeat recorded, the public payload
    // must carry no liveness. Today that holds only because resolveKioskView
    // omits the field; this guards against it regressing into a public leak.
    await socialGymKioskMutations.kioskHeartbeat(
      null,
      { input: { kioskUuid: kioskA.uuid, gymUuid: gym.uuid } },
      anonCtx(),
    );

    const publicKiosk = await socialGymKioskQueries.gymKiosk(null, { gymSlug: gym.slug }, anonCtx());
    expect(publicKiosk).not.toBeNull();
    expect((publicKiosk as { lastSeenAt?: string | null }).lastSeenAt ?? null).toBeNull();
  });

  it('leaves an un-checked-in kiosk null while the checked-in one is set', async () => {
    await socialGymKioskMutations.kioskHeartbeat(
      null,
      { input: { kioskUuid: kioskA.uuid, gymUuid: gym.uuid } },
      anonCtx(),
    );

    const kiosks = await socialGymKioskQueries.gymKiosks(null, { gymUuid: gym.uuid }, authCtx(OWNER));
    const seen = kiosks.find((kiosk) => kiosk.uuid === kioskA.uuid);
    const unseen = kiosks.find((kiosk) => kiosk.uuid === kioskB.uuid);

    expect(seen!.lastSeenAt).not.toBeNull();
    expect(unseen!.lastSeenAt).toBeNull();
  });

  it('does not record — and returns false — for a kiosk/gym pair that does not resolve', async () => {
    // Right gym, wrong (random) kiosk uuid.
    const strayKiosk = await socialGymKioskMutations.kioskHeartbeat(
      null,
      { input: { kioskUuid: uuidv4(), gymUuid: gym.uuid } },
      anonCtx(),
    );
    expect(strayKiosk).toBe(false);

    // Real kiosk, wrong gym uuid — the cross-tenant keyspace must not accept it.
    const wrongGym = await socialGymKioskMutations.kioskHeartbeat(
      null,
      { input: { kioskUuid: kioskA.uuid, gymUuid: uuidv4() } },
      anonCtx(),
    );
    expect(wrongGym).toBe(false);

    const kiosks = await socialGymKioskQueries.gymKiosks(null, { gymUuid: gym.uuid }, authCtx(OWNER));
    expect(kiosks.every((kiosk) => kiosk.lastSeenAt === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting (Redis-independent — the heartbeat bucket is in-memory per IP)
// ---------------------------------------------------------------------------

describe('kioskHeartbeat rate limiting', () => {
  beforeEach(async () => {
    await resetAndSeed();
  });

  it('trips the per-client rate limit past the ceiling', async () => {
    // A single fixed connection so the in-memory bucket accumulates. The
    // heartbeat ceiling is 60/min; the 61st call must be throttled. `connectionId`
    // is unique to this test (no other test reuses 'kh-rate-limit-conn'), so the
    // in-memory bucket starting non-empty on a re-run isn't a real hazard —
    // beforeEach only resets the DB, not the rate limiter, on purpose.
    const ctx: ConnectionContext = {
      connectionId: 'kh-rate-limit-conn',
      isAuthenticated: false,
    } as ConnectionContext;

    for (let call = 0; call < 60; call++) {
      await socialGymKioskMutations.kioskHeartbeat(null, { input: { kioskUuid: kioskA.uuid, gymUuid: gym.uuid } }, ctx);
    }

    await expect(
      socialGymKioskMutations.kioskHeartbeat(null, { input: { kioskUuid: kioskA.uuid, gymUuid: gym.uuid } }, ctx),
    ).rejects.toThrow(/Rate limit exceeded/);
  });
});

// ---------------------------------------------------------------------------
// Input validation (Redis-independent — rejected before any store lookup)
// ---------------------------------------------------------------------------

describe('kioskHeartbeat viewport validation', () => {
  beforeEach(async () => {
    await resetAndSeed();
  });

  it.each([
    ['zero width', { viewportWidth: 0, viewportHeight: 1080 }],
    ['negative height', { viewportWidth: 1920, viewportHeight: -1 }],
    ['width over the 20000 ceiling', { viewportWidth: 20001, viewportHeight: 1080 }],
    ['height over the 20000 ceiling', { viewportWidth: 1920, viewportHeight: 20001 }],
  ])('rejects a %s viewport dimension', async (_description, viewport) => {
    await expect(
      socialGymKioskMutations.kioskHeartbeat(
        null,
        { input: { kioskUuid: kioskA.uuid, gymUuid: gym.uuid, ...viewport } },
        anonCtx(),
      ),
    ).rejects.toThrow(/Invalid input/);
  });
});
