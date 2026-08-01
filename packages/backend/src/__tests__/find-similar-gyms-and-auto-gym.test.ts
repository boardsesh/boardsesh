import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { socialGymMatchQueries } from '../graphql/resolvers/social/gym-matching';
import {
  findExactNameMatchesWithin,
  decideAutoGymAttachment,
  type SimilarGymResult,
} from '../graphql/resolvers/social/gym-matching';
import { socialBoardMutations } from '../graphql/resolvers/social/boards';
import { resetAllRateLimits } from '../utils/rate-limiter';
import { seedAuroraCatalogFixtures } from './helpers/board-catalog-fixture';

/**
 * Real-DB coverage for the gym-creation dedup surface:
 *   - findSimilarGyms matching tiers (exact-name ≤5 km, any-name ≤150 m,
 *     substring ≤1 km), ordering, exclusions, enrichment (ownerType, provider
 *     origins, isClaimable), the no-coordinates path, the private-gym visibility
 *     gate, auth, and rate limiting.
 *   - the shared findExactNameMatchesWithin physical matcher + the pure
 *     decideAutoGymAttachment branch (incl. the generic-name guard).
 *   - the createBoard MUTATION end-to-end through the auto-gym guard: attach to a
 *     SYSTEM gym vs. refuse a generic-named match.
 *
 * Seeds via raw SQL and calls the resolvers directly against the per-worker test
 * DB (plain postgres — no PostGIS), mirroring gym-branding-and-boards.test.ts.
 */

const SYSTEM_OWNER = '00000000-0000-0000-0000-000000000000';
const QUERIER = 'fsg-querier';
const OTHER = 'fsg-other';
const ALL_USERS = [SYSTEM_OWNER, QUERIER, OTHER];

// Base point + latitude offsets (111_320 m per degree lat, longitude-independent).
const BASE = { latitude: 47.0, longitude: 8.0 };
const LAT_60M = 47.0 + 0.00054; // ~60 m north
const LAT_120M = 47.0 + 0.00108; // ~120 m (still within 150 m)
const LAT_300M = 47.0 + 0.0027; // ~301 m
const LAT_2KM = 47.0 + 0.018; // ~2 km
const LAT_8KM = 47.0 + 0.072; // ~8 km

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
  latitude?: number | null;
  longitude?: number | null;
  deleted?: boolean;
  isPublic?: boolean;
}): Promise<{ id: number; uuid: string }> => {
  const { ownerId, name, latitude = null, longitude = null, deleted = false, isPublic = true } = opts;
  const uuid = uuidv4();
  const result = await db.execute(sql`
    INSERT INTO gyms (uuid, name, slug, owner_id, is_public, latitude, longitude, deleted_at, created_at, updated_at)
    VALUES (${uuid}, ${name}, ${uuid}, ${ownerId}, ${isPublic}, ${latitude}, ${longitude}, ${deleted ? sql`now()` : null}, now(), now())
    RETURNING id
  `);
  return { id: Number(Array.from(result as Iterable<{ id: number }>)[0].id), uuid };
};

const insertSource = (gymId: number, sourceKey: string) =>
  db.execute(sql`
    INSERT INTO location_sync_gym_sources (source_key, gym_id, created_at, updated_at)
    VALUES (${sourceKey}, ${gymId}, now(), now())
  `);

const countGyms = async (): Promise<number> => {
  const result = await db.execute(sql`SELECT count(*)::int AS count FROM gyms`);
  return Number(Array.from(result as Iterable<{ count: number }>)[0].count);
};

const findSimilarGyms = (input: unknown, ctx: ConnectionContext) =>
  socialGymMatchQueries.findSimilarGyms(null, { input }, ctx) as Promise<SimilarGymResult[]>;

const createBoard = (input: Record<string, unknown>, ctx: ConnectionContext) =>
  socialBoardMutations.createBoard(
    null,
    { input: { boardType: 'kilter', layoutId: 1, sizeId: 900, setIds: '1,2', ...input } },
    ctx,
  ) as Promise<{ gymId: number | null; gymUuid: string | null }>;

let cleanupAutoGymCatalogFixture: () => Promise<void> = async () => {};

beforeAll(async () => {
  cleanupAutoGymCatalogFixture = await seedAuroraCatalogFixtures([
    {
      boardType: 'kilter',
      productId: 2_100_412_910,
      layoutId: 1,
      sizeId: 900,
      setIds: [1, 2],
      associationIdBase: 2_100_413_100,
    },
  ]);
});

afterAll(async () => {
  await cleanupAutoGymCatalogFixture();
});

beforeEach(async () => {
  resetAllRateLimits();
  await db.execute(sql`
    TRUNCATE TABLE
      "community_roles", "gym_members", "gym_follows", "location_sync_gym_sources", "user_boards", "gyms"
    RESTART IDENTITY CASCADE
  `);
  await Promise.all(ALL_USERS.map(insertUser));
});

describe('findSimilarGyms — matching tiers', () => {
  it('matches exact-name ≤5 km, any-name ≤150 m, and substring ≤1 km; excludes far & deleted; nearest first', async () => {
    // (a) exact name, 2 km away — SYSTEM-synced from Kilter.
    const exactFar = await insertGym({
      ownerId: SYSTEM_OWNER,
      name: 'Bahnhof Bloc',
      latitude: LAT_2KM,
      longitude: BASE.longitude,
    });
    await insertSource(exactFar.id, 'kilter:100');
    // (b) different name, 60 m away.
    const proximity = await insertGym({
      ownerId: OTHER,
      name: 'Random Wall',
      latitude: LAT_60M,
      longitude: BASE.longitude,
    });
    // (c) substring name, 300 m away.
    const substring = await insertGym({
      ownerId: OTHER,
      name: 'Bahnhof Bloc Annex',
      latitude: LAT_300M,
      longitude: BASE.longitude,
    });
    // exact name but 8 km away — excluded (beyond 5 km).
    await insertGym({ ownerId: OTHER, name: 'Bahnhof Bloc', latitude: LAT_8KM, longitude: BASE.longitude });
    // unrelated name at 300 m — excluded (not within 150 m, no name similarity).
    await insertGym({ ownerId: OTHER, name: 'Totally Different', latitude: LAT_300M, longitude: BASE.longitude });
    // deleted exact-name at 60 m — excluded.
    await insertGym({
      ownerId: OTHER,
      name: 'Bahnhof Bloc',
      latitude: LAT_60M,
      longitude: BASE.longitude,
      deleted: true,
    });

    const results = await findSimilarGyms(
      { name: 'Bahnhof Bloc', latitude: BASE.latitude, longitude: BASE.longitude },
      authCtx(QUERIER),
    );

    // Ordered nearest-first: proximity (60 m), substring (300 m), exactFar (2 km).
    expect(results.map((gym) => gym.uuid)).toEqual([proximity.uuid, substring.uuid, exactFar.uuid]);
    expect(results[0].distanceMeters).toBeLessThan(150);
    expect(results[2].distanceMeters).toBeGreaterThan(1000);
    expect(results[2].distanceMeters).toBeLessThan(5000);
  });

  it('enriches ownerType, providerOrigins, and isClaimable', async () => {
    const systemGym = await insertGym({
      ownerId: SYSTEM_OWNER,
      name: 'Boulder Bar',
      latitude: LAT_60M,
      longitude: BASE.longitude,
    });
    await insertSource(systemGym.id, 'kilter:1');
    await insertSource(systemGym.id, 'tension:2');
    const ownGym = await insertGym({
      ownerId: QUERIER,
      name: 'Boulder Bar',
      latitude: LAT_120M,
      longitude: BASE.longitude,
    });

    const results = await findSimilarGyms(
      { name: 'Boulder Bar', latitude: BASE.latitude, longitude: BASE.longitude },
      authCtx(QUERIER),
    );

    const byUuid = new Map(results.map((gym) => [gym.uuid, gym]));
    const system = byUuid.get(systemGym.uuid)!;
    expect(system.ownerType).toBe('SYSTEM');
    expect(system.providerOrigins).toEqual(['kilter', 'tension']);
    // A non-owner/non-member can claim the SYSTEM gym.
    expect(system.isClaimable).toBe(true);

    const own = byUuid.get(ownGym.uuid)!;
    expect(own.ownerType).toBe('USER');
    expect(own.providerOrigins).toEqual([]);
    // The querier owns this gym, so they cannot claim it.
    expect(own.isClaimable).toBe(false);
  });

  it("never enumerates another user's private gym, but includes the viewer's own private gym", async () => {
    // Another user's PRIVATE gym 60 m away — must NOT leak (name/address/distance).
    await insertGym({
      ownerId: OTHER,
      name: 'Secret Home Board',
      latitude: LAT_60M,
      longitude: BASE.longitude,
      isPublic: false,
    });
    // The viewer's OWN private gym 120 m away — a legitimate suggestion.
    const ownPrivate = await insertGym({
      ownerId: QUERIER,
      name: 'My Basement',
      latitude: LAT_120M,
      longitude: BASE.longitude,
      isPublic: false,
    });

    // Name-agnostic 150 m proximity tier: without the visibility gate this would
    // return BOTH private gyms to any authenticated caller.
    const results = await findSimilarGyms(
      { name: 'Anything At All', latitude: BASE.latitude, longitude: BASE.longitude },
      authCtx(QUERIER),
    );

    expect(results.map((gym) => gym.uuid)).toEqual([ownPrivate.uuid]);
  });

  it('falls back to name-only matching when no coordinates are given', async () => {
    const named = await insertGym({
      ownerId: OTHER,
      name: 'Far Away Gym',
      latitude: LAT_8KM,
      longitude: BASE.longitude,
    });
    await insertGym({ ownerId: OTHER, name: 'Unrelated Place', latitude: LAT_60M, longitude: BASE.longitude });

    const results = await findSimilarGyms({ name: 'Far Away Gym' }, authCtx(QUERIER));

    expect(results.map((gym) => gym.uuid)).toEqual([named.uuid]);
    expect(results[0].distanceMeters).toBeNull();
  });
});

describe('findSimilarGyms — auth & rate limit', () => {
  it('requires authentication', async () => {
    await expect(findSimilarGyms({ name: 'Anywhere' }, anonCtx())).rejects.toThrow(/Authentication required/);
  });

  it('rate limits repeated calls with a RATE_LIMITED code', async () => {
    const rateLimitUser = `fsg-ratelimit-${uuidv4()}`;
    await insertUser(rateLimitUser);
    const ctx = authCtx(rateLimitUser);

    // The first call is allowed (rate limiting doesn't block legitimate use).
    await expect(findSimilarGyms({ name: 'No Match Here' }, ctx)).resolves.toEqual([]);

    // Hammering the resolver eventually trips the limiter (bound is generous so
    // this holds whether Redis is connected or the in-memory fallback is active).
    let code: string | undefined;
    for (let i = 0; i < 300 && !code; i++) {
      try {
        await findSimilarGyms({ name: 'No Match Here' }, ctx);
      } catch (error) {
        code = (error as { extensions?: { code?: string } }).extensions?.code;
      }
    }
    expect(code).toBe('RATE_LIMITED');
  });
});

describe('findExactNameMatchesWithin (auto-gym physical matcher)', () => {
  it('matches an exact-name gym of ANY owner within the radius and excludes those beyond it', async () => {
    const near = await insertGym({
      ownerId: OTHER,
      name: 'Depot Climbing',
      latitude: LAT_120M,
      longitude: BASE.longitude,
    });
    await insertGym({ ownerId: OTHER, name: 'Depot Climbing', latitude: LAT_300M, longitude: BASE.longitude });

    const matches = await findExactNameMatchesWithin({
      name: 'depot climbing',
      latitude: BASE.latitude,
      longitude: BASE.longitude,
      radiusMeters: 150,
    });

    expect(matches.map((gym) => gym.uuid)).toEqual([near.uuid]);
    expect(matches[0].distanceMeters).toBeLessThan(150);
  });

  it('does not match a different name at the same spot', async () => {
    await insertGym({ ownerId: OTHER, name: 'Other Name', latitude: LAT_60M, longitude: BASE.longitude });

    const matches = await findExactNameMatchesWithin({
      name: 'Depot Climbing',
      latitude: BASE.latitude,
      longitude: BASE.longitude,
      radiusMeters: 150,
    });

    expect(matches).toHaveLength(0);
  });
});

describe('decideAutoGymAttachment (auto-gym branch)', () => {
  it('attaches to a SYSTEM-owned, specifically-named match', () => {
    expect(decideAutoGymAttachment({ id: 7, ownerId: SYSTEM_OWNER, name: 'Boulder Central' }, QUERIER)).toEqual({
      action: 'attach',
      gymId: 7,
    });
  });

  it('attaches to a specifically-named match the requesting user already owns', () => {
    expect(decideAutoGymAttachment({ id: 9, ownerId: QUERIER, name: 'The Depot' }, QUERIER)).toEqual({
      action: 'attach',
      gymId: 9,
    });
  });

  it('mints a fresh gym when the match belongs to another user', () => {
    expect(decideAutoGymAttachment({ id: 11, ownerId: OTHER, name: 'Boulder Central' }, QUERIER)).toEqual({
      action: 'mint',
    });
  });

  it('never auto-attaches a generic name, even to a SYSTEM/own match', () => {
    // A claimable SYSTEM "home wall" pin must not silently capture a neighbour's board.
    expect(decideAutoGymAttachment({ id: 13, ownerId: SYSTEM_OWNER, name: 'Home Wall' }, QUERIER)).toEqual({
      action: 'mint',
    });
    expect(decideAutoGymAttachment({ id: 14, ownerId: QUERIER, name: 'garage' }, QUERIER)).toEqual({ action: 'mint' });
    expect(decideAutoGymAttachment({ id: 15, ownerId: SYSTEM_OWNER, name: 'Kilter Board' }, QUERIER)).toEqual({
      action: 'mint',
    });
  });

  it('mints a fresh gym when there is no match', () => {
    expect(decideAutoGymAttachment(undefined, QUERIER)).toEqual({ action: 'mint' });
  });
});

describe('createBoard auto-gym guard (end-to-end mutation)', () => {
  it('attaches a first board to a SYSTEM gym at the same coords + specific name (no duplicate gym minted)', async () => {
    const systemGym = await insertGym({
      ownerId: SYSTEM_OWNER,
      name: 'Boulder Central',
      latitude: BASE.latitude,
      longitude: BASE.longitude,
    });
    const gymCountBefore = await countGyms();

    const board = await createBoard(
      {
        name: 'My Kilter',
        locationName: 'Boulder Central',
        latitude: LAT_60M,
        longitude: BASE.longitude,
      },
      authCtx(QUERIER),
    );

    // Board attached to the existing SYSTEM gym; no new gym row minted.
    expect(board.gymId).toBe(systemGym.id);
    expect(board.gymUuid).toBe(systemGym.uuid);
    expect(await countGyms()).toBe(gymCountBefore);
  });

  it('does NOT attach a first board to a generic-named SYSTEM gym (a stranger could claim it)', async () => {
    const systemGeneric = await insertGym({
      ownerId: SYSTEM_OWNER,
      name: 'Home Wall',
      latitude: BASE.latitude,
      longitude: BASE.longitude,
    });

    const board = await createBoard(
      {
        name: 'My Home Kilter',
        locationName: 'Home Wall',
        latitude: LAT_60M,
        longitude: BASE.longitude,
      },
      authCtx(QUERIER),
    );

    // The board must NOT be linked to the stranger's claimable "Home Wall" pin.
    expect(board.gymId).not.toBe(systemGeneric.id);
  });
});
