import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { socialGymMatchQueries } from '../graphql/resolvers/social/gym-matching';
import {
  findExactNameMatchesWithin,
  decideAutoGymAttachment,
  MAX_AUTO_MINTED_GYMS_PER_OWNER,
  type SimilarGymResult,
} from '../graphql/resolvers/social/gym-matching';
import { socialBoardMutations, socialBoardQueries } from '../graphql/resolvers/social/boards';
import { privacyMutations, resourcePrivacySettingsFields } from '../graphql/resolvers/privacy';
import { socialGymMutations } from '../graphql/resolvers/social/gyms';
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
  website?: string | null;
  websiteVouchedByOwner?: boolean;
}): Promise<{ id: number; uuid: string }> => {
  const {
    ownerId,
    name,
    latitude = null,
    longitude = null,
    deleted = false,
    isPublic = true,
    website = null,
    websiteVouchedByOwner = false,
  } = opts;
  const uuid = uuidv4();
  const result = await db.execute(sql`
    INSERT INTO gyms (uuid, name, slug, owner_id, is_public, latitude, longitude, website, website_vouched_by_owner, deleted_at, created_at, updated_at)
    VALUES (${uuid}, ${name}, ${uuid}, ${ownerId}, ${isPublic}, ${latitude}, ${longitude}, ${website}, ${websiteVouchedByOwner}, ${deleted ? sql`now()` : null}, now(), now())
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
  ) as Promise<{ uuid: string; gymId: number | null; gymUuid: string | null }>;

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

  it('reports canClaimByDomain per listing, independently of isClaimable (#4018)', async () => {
    // The two flags answer different questions — "may this viewer claim?" vs
    // "can the website on file drive the email claim?" — and the suggestion card
    // routes on the second. Conflating them puts a climber back on a dead-end
    // email form, which is the bug.
    const vouched = await insertGym({
      ownerId: OTHER,
      name: 'Boulder Bar',
      latitude: LAT_60M,
      longitude: BASE.longitude,
      website: 'https://www.bonsist.bg',
      websiteVouchedByOwner: true,
    });
    const unvouched = await insertGym({
      ownerId: OTHER,
      name: 'Boulder Bar',
      latitude: LAT_120M,
      longitude: BASE.longitude,
      website: 'https://www.bonsist.bg',
      websiteVouchedByOwner: false,
    });
    const freeProvider = await insertGym({
      ownerId: OTHER,
      name: 'Boulder Bar',
      latitude: LAT_300M,
      longitude: BASE.longitude,
      website: 'https://mygym.wixsite.com',
      websiteVouchedByOwner: true,
    });

    const byUuid = new Map(
      (
        await findSimilarGyms(
          { name: 'Boulder Bar', latitude: BASE.latitude, longitude: BASE.longitude },
          authCtx(QUERIER),
        )
      ).map((gym) => [gym.uuid, gym]),
    );

    // All three are claimable by this viewer; only the first can go by email.
    expect(byUuid.get(vouched.uuid)!.isClaimable).toBe(true);
    expect(byUuid.get(unvouched.uuid)!.isClaimable).toBe(true);
    expect(byUuid.get(freeProvider.uuid)!.isClaimable).toBe(true);

    expect(byUuid.get(vouched.uuid)!.canClaimByDomain).toBe(true);
    expect(byUuid.get(unvouched.uuid)!.canClaimByDomain).toBe(false);
    expect(byUuid.get(freeProvider.uuid)!.canClaimByDomain).toBe(false);
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
    // ...and a separate gym IS minted for it, so the board still lands somewhere.
    expect(board.gymId).not.toBeNull();
  });
});

/**
 * Auto-gym resolves per LOCATION, not per user. Until #4166 a gym was minted only
 * when the caller owned zero gyms, so every second-and-later board landed with
 * `gym_id = NULL` — 29% of real user boards in production — and showed on the map
 * as a bare pin instead of under the gym the user had just named.
 *
 * These also cover the transaction restructure: the PostGIS `location` writes now
 * run after the transaction, each guarded. Previously they were inside it, and
 * since this test DB has no PostGIS the whole mint rolled back — which is why the
 * mint path had never actually executed under test.
 */
describe('createBoard auto-gym — per-location minting', () => {
  it('mints a SECOND gym for a second board at a different location', async () => {
    await createBoard(
      { name: 'First board', locationName: 'Klimmuur', latitude: BASE.latitude, longitude: BASE.longitude },
      authCtx(QUERIER),
    );
    const afterFirst = await countGyms();

    const second = await createBoard(
      { name: 'Second board', locationName: 'Boulder Space', latitude: LAT_2KM, longitude: BASE.longitude },
      authCtx(QUERIER),
    );

    expect(second.gymId).not.toBeNull();
    expect(await countGyms()).toBe(afterFirst + 1);
  });

  it('converges a second board at the same named location onto the same gym', async () => {
    const first = await createBoard(
      { name: 'First board', locationName: 'Klimmuur', latitude: BASE.latitude, longitude: BASE.longitude },
      authCtx(QUERIER),
    );
    const afterFirst = await countGyms();

    const second = await createBoard(
      // Same config at the same place: a real duplicate, which is the user's
      // call to make. The flag isolates what's under test — gym resolution.
      {
        name: 'Second board',
        locationName: 'Klimmuur',
        latitude: LAT_60M,
        longitude: BASE.longitude,
        allowDuplicateConfig: true,
      },
      authCtx(QUERIER),
    );

    expect(second.gymId).toBe(first.gymId);
    expect(await countGyms()).toBe(afterFirst);
  });

  it('converges on the caller’s own same-named gym a couple of km away', async () => {
    const first = await createBoard(
      { name: 'First board', locationName: 'Klimmuur', latitude: BASE.latitude, longitude: BASE.longitude },
      authCtx(QUERIER),
    );
    const second = await createBoard(
      { name: 'Second board', locationName: 'Klimmuur', latitude: LAT_2KM, longitude: BASE.longitude },
      authCtx(QUERIER),
    );
    // Within the 5 km own-gym ceiling — one gym, two boards.
    expect(second.gymId).toBe(first.gymId);
  });

  it('mints a separate gym for the same name 8 km away', async () => {
    const first = await createBoard(
      { name: 'First board', locationName: 'Klimmuur', latitude: BASE.latitude, longitude: BASE.longitude },
      authCtx(QUERIER),
    );
    const second = await createBoard(
      { name: 'Second board', locationName: 'Klimmuur', latitude: LAT_8KM, longitude: BASE.longitude },
      authCtx(QUERIER),
    );
    expect(second.gymId).not.toBe(first.gymId);
    expect(second.gymId).not.toBeNull();
  });

  it('leaves a board with no location at all unlinked', async () => {
    // Previously this minted a gym named after the BOARD, with null coordinates —
    // a row that can never appear in proximity search.
    const before = await countGyms();
    const board = await createBoard({ name: 'Nameless place board' }, authCtx(QUERIER));
    expect(board.gymId).toBeNull();
    expect(await countGyms()).toBe(before);
  });

  it('attaches on coordinates alone when exactly one nearby gym is reusable', async () => {
    const systemGym = await insertGym({
      ownerId: SYSTEM_OWNER,
      name: 'Boulder Central',
      latitude: BASE.latitude,
      longitude: BASE.longitude,
    });
    const before = await countGyms();

    const board = await createBoard(
      { name: 'My Kilter', latitude: LAT_60M, longitude: BASE.longitude },
      authCtx(QUERIER),
    );

    expect(board.gymId).toBe(systemGym.id);
    expect(await countGyms()).toBe(before);
  });

  it('declines to guess when two nearby gyms are reusable', async () => {
    await insertGym({
      ownerId: SYSTEM_OWNER,
      name: 'Boulder Central',
      latitude: BASE.latitude,
      longitude: BASE.longitude,
    });
    await insertGym({ ownerId: SYSTEM_OWNER, name: 'Other Wall', latitude: LAT_60M, longitude: BASE.longitude });
    const before = await countGyms();

    const board = await createBoard(
      { name: 'My Kilter', latitude: LAT_120M, longitude: BASE.longitude },
      authCtx(QUERIER),
    );

    expect(board.gymId).toBeNull();
    expect(await countGyms()).toBe(before);
  });

  it('does not attach to another user’s gym on coordinates alone', async () => {
    await insertGym({ ownerId: OTHER, name: 'Their Gym', latitude: BASE.latitude, longitude: BASE.longitude });
    const board = await createBoard(
      { name: 'My Kilter', latitude: LAT_60M, longitude: BASE.longitude },
      authCtx(QUERIER),
    );
    expect(board.gymId).toBeNull();
  });

  it('converges onto the caller’s own same-named gym even when that gym has no coordinates', async () => {
    // Board 1 names a place but can't stamp coordinates (you have to be standing
    // there), so its gym is minted with none. Board 2 at the same place, this
    // time with coordinates, must reuse that gym — the SQL bounding box excludes
    // null-coordinate rows, so filtering there minted a twin.
    const first = await createBoard({ name: 'First board', locationName: 'Klimmuur' }, authCtx(QUERIER));
    const afterFirst = await countGyms();

    const second = await createBoard(
      {
        name: 'Second board',
        locationName: 'Klimmuur',
        latitude: BASE.latitude,
        longitude: BASE.longitude,
        allowDuplicateConfig: true,
      },
      authCtx(QUERIER),
    );

    expect(second.gymId).toBe(first.gymId);
    expect(await countGyms()).toBe(afterFirst);
  });

  it('stops minting once the caller is at the gym cap, still creating the board', async () => {
    // The runaway backstop. Approximate by design (read outside the insert
    // transaction), so this pins the threshold behaviour, not exactness.
    for (let index = 0; index < MAX_AUTO_MINTED_GYMS_PER_OWNER; index++) {
      await insertGym({ ownerId: QUERIER, name: `Capped Gym ${index}` });
    }
    const before = await countGyms();

    const board = await createBoard(
      { name: 'One board too many', locationName: 'A brand new place' },
      authCtx(QUERIER),
    );

    expect(board.gymId).toBeNull();
    expect(await countGyms()).toBe(before);
  });

  it('mints with null coordinates when only a location name is given', async () => {
    const before = await countGyms();
    const board = await createBoard({ name: 'Garage board', locationName: 'My Garage' }, authCtx(QUERIER));
    expect(board.gymId).not.toBeNull();
    expect(await countGyms()).toBe(before + 1);

    // A second board at the same typed name converges rather than minting a twin.
    const second = await createBoard(
      { name: 'Garage board 2', locationName: 'My Garage', allowDuplicateConfig: true },
      authCtx(QUERIER),
    );
    expect(second.gymId).toBe(board.gymId);
    expect(await countGyms()).toBe(before + 1);
  });
});

describe('createBoard auto-gym — minted gym visibility', () => {
  // A gym is listed with its name and coordinates, so a minted gym may only be
  // public when the board is listed publicly with its exact location shown.
  const mintedGymIsPublic = async (boardUuid: string): Promise<boolean | null> => {
    const result = await db.execute(sql`
      SELECT g.is_public AS "isPublic"
        FROM user_boards b
        JOIN gyms g ON g.id = b.gym_id
       WHERE b.uuid = ${boardUuid}
    `);
    const rows = Array.from(result as Iterable<{ isPublic: boolean }>);
    return rows[0]?.isPublic ?? null;
  };
  const place = { locationName: 'Garage wall', latitude: BASE.latitude, longitude: BASE.longitude };

  it('keeps the gym private when the create sends no visibility (location hidden by default)', async () => {
    const board = await createBoard({ name: 'Default board', ...place }, authCtx(QUERIER));
    expect(await mintedGymIsPublic(board.uuid)).toBe(false);
  });

  it('makes the gym public for a public board with its location shown', async () => {
    const board = await createBoard(
      { name: 'Shown board', isPublic: true, hideLocation: false, ...place },
      authCtx(QUERIER),
    );
    expect(await mintedGymIsPublic(board.uuid)).toBe(true);
  });

  it('keeps the gym private for an unlisted board, even with its location shown', async () => {
    const board = await createBoard(
      { name: 'Link-only board', isPublic: true, isUnlisted: true, hideLocation: false, ...place },
      authCtx(QUERIER),
    );
    expect(await mintedGymIsPublic(board.uuid)).toBe(false);
  });
});

describe('a board in a public gym shares its location', () => {
  // The hidden-location default is for home walls. A public gym already lists
  // its name and coordinates, so a board in one always shows where it is,
  // whatever the builder sent (the post-#6254 builder sends hideLocation: true).
  const boardPrivacy = async (boardUuid: string) => {
    const result = await db.execute(sql`
      SELECT b.hide_location AS "hideLocation", p.location_audience AS "locationAudience", g.is_public AS "gymIsPublic"
        FROM user_boards b
        LEFT JOIN resource_privacy p ON p.kind = 'board' AND p.resource_id = b.uuid
        LEFT JOIN gyms g ON g.id = b.gym_id
       WHERE b.uuid = ${boardUuid}
    `);
    return Array.from(
      result as Iterable<{ hideLocation: boolean; locationAudience: string | null; gymIsPublic: boolean | null }>,
    )[0];
  };
  // The builder stamps the gym's own coordinates when a climber picks it.
  const atGym = { latitude: BASE.latitude, longitude: BASE.longitude };
  const publicGym = () =>
    insertGym({ ownerId: SYSTEM_OWNER, name: 'Boulder Central', latitude: BASE.latitude, longitude: BASE.longitude });

  it('shows the location of a board created in a named gym, with no location fields sent', async () => {
    const gym = await publicGym();
    const board = await createBoard({ name: 'Gym Kilter', gymUuid: gym.uuid, ...atGym }, authCtx(QUERIER));
    expect(await boardPrivacy(board.uuid)).toMatchObject({ hideLocation: false, locationAudience: null });
  });

  it('shows it even when the create asks to hide it', async () => {
    const gym = await publicGym();
    const legacy = await createBoard(
      { name: 'Legacy hidden', gymUuid: gym.uuid, hideLocation: true, ...atGym },
      authCtx(QUERIER),
    );
    expect(await boardPrivacy(legacy.uuid)).toMatchObject({ hideLocation: false });
    const modern = await createBoard(
      {
        name: 'Modern hidden',
        gymUuid: gym.uuid,
        audience: 'public',
        locationAudience: 'only_me',
        allowDuplicateConfig: true,
        ...atGym,
      },
      authCtx(QUERIER),
    );
    expect(await boardPrivacy(modern.uuid)).toMatchObject({ hideLocation: false, locationAudience: 'public' });
  });

  it("shows it for a default create matched to a public gym at the gym's own place, and only there", async () => {
    await publicGym();
    const board = await createBoard({ name: 'Matched', locationName: 'Boulder Central', ...atGym }, authCtx(QUERIER));
    expect(await boardPrivacy(board.uuid)).toMatchObject({ hideLocation: false, gymIsPublic: true });
    // Matched by name 60 m away: the coordinates are the climber's, not the
    // gym's listing, so they stay hidden.
    const nearby = await createBoard(
      {
        name: 'Matched nearby',
        locationName: 'Boulder Central',
        latitude: LAT_60M,
        longitude: BASE.longitude,
        allowDuplicateConfig: true,
      },
      authCtx(QUERIER),
    );
    expect(await boardPrivacy(nearby.uuid)).toMatchObject({ hideLocation: true, gymIsPublic: true });
  });

  it('keeps a home wall hidden, including one whose typed location mints a gym', async () => {
    const bare = await createBoard({ name: 'Home wall' }, authCtx(QUERIER));
    expect(await boardPrivacy(bare.uuid)).toMatchObject({ hideLocation: true, gymIsPublic: null });
    // A typed home location mints the owner a gym. It is not a public gym, so
    // the address stays hidden and the gym stays off the map.
    const garage = await createBoard(
      { name: 'Garage wall', locationName: 'My Garage', latitude: LAT_8KM, longitude: BASE.longitude },
      authCtx(QUERIER),
    );
    expect(await boardPrivacy(garage.uuid)).toMatchObject({ hideLocation: true, gymIsPublic: false });
  });

  it("keeps the owner's choice for a board in their own private gym", async () => {
    const homeGym = await insertGym({ ownerId: QUERIER, name: 'Back shed', isPublic: false });
    const board = await createBoard({ name: 'Shed wall', gymUuid: homeGym.uuid }, authCtx(QUERIER));
    expect(await boardPrivacy(board.uuid)).toMatchObject({ hideLocation: true, gymIsPublic: false });
  });

  it('shows the location when an existing board joins a public gym, or is edited while in one', async () => {
    // Created before the gym exists, so the create cannot attach it by location.
    const board = await createBoard(
      { name: 'Moved in', audience: 'public', locationAudience: 'only_me', ...atGym },
      authCtx(QUERIER),
    );
    expect(await boardPrivacy(board.uuid)).toMatchObject({ hideLocation: true, locationAudience: 'only_me' });
    const gym = await publicGym();

    await socialGymMutations.linkBoardToGym(
      null,
      { input: { boardUuid: board.uuid, gymUuid: gym.uuid } },
      authCtx(QUERIER),
    );
    expect(await boardPrivacy(board.uuid)).toMatchObject({ hideLocation: false, locationAudience: 'public' });

    // An edit that resends hideLocation: true with a rename cannot hide it again.
    await socialBoardMutations.updateBoard(
      null,
      { input: { boardUuid: board.uuid, name: 'Renamed', hideLocation: true } },
      authCtx(QUERIER),
    );
    expect(await boardPrivacy(board.uuid)).toMatchObject({ hideLocation: false, locationAudience: 'public' });
  });

  it('shows the location of a board linked while creating a gym', async () => {
    const board = await createBoard({ name: 'First board' }, authCtx(QUERIER));
    await socialGymMutations.createGym(
      null,
      { input: { name: 'New Crag Gym', latitude: BASE.latitude, longitude: BASE.longitude, boardUuid: board.uuid } },
      authCtx(QUERIER),
    );
    expect(await boardPrivacy(board.uuid)).toMatchObject({ hideLocation: false, gymIsPublic: true });
  });
});

describe("the gym rule only ever shows the gym's own place", () => {
  // A board in a public gym shows its location because the gym already lists
  // that place. The rule must never publish a place the climber sent: their
  // home, their GPS fix, or a typed address.
  const GYM_NAME = 'Boulder Central';
  const gymPlace = { locationName: GYM_NAME, latitude: BASE.latitude, longitude: BASE.longitude };
  const publicGym = () => insertGym({ ownerId: SYSTEM_OWNER, name: GYM_NAME, ...BASE });
  const anonymousRead = async (boardUuid: string) => {
    const board = (await socialBoardQueries.board(null, { boardUuid }, anonCtx())) as {
      latitude: number | null;
      longitude: number | null;
      locationName: string | null;
    } | null;
    return { latitude: board?.latitude ?? null, locationName: board?.locationName ?? null };
  };
  const storedGymId = async (boardUuid: string): Promise<number | null> => {
    const result = await db.execute(sql`SELECT gym_id AS "gymId" FROM user_boards WHERE uuid = ${boardUuid}`);
    const [row] = Array.from(result as Iterable<{ gymId: number | null }>);
    return row?.gymId == null ? null : Number(row.gymId);
  };
  const updateBoard = (input: Record<string, unknown>) =>
    socialBoardMutations.updateBoard(null, { input }, authCtx(QUERIER));
  const unlink = (boardUuid: string) =>
    socialGymMutations.linkBoardToGym(null, { input: { boardUuid, gymUuid: null } }, authCtx(QUERIER));

  const boardAtGym = async () => {
    const gym = await publicGym();
    const board = await createBoard({ name: 'Gym Kilter', gymUuid: gym.uuid, ...gymPlace }, authCtx(QUERIER));
    expect(await anonymousRead(board.uuid)).toEqual({ latitude: BASE.latitude, locationName: GYM_NAME });
    return { gym, board };
  };

  it('keeps the home location hidden when an installed client moves a gym board home (edit first, unlink second)', async () => {
    const { board } = await boardAtGym();
    await updateBoard({ boardUuid: board.uuid, latitude: LAT_8KM, longitude: BASE.longitude, hideLocation: true });
    await unlink(board.uuid);
    expect(await anonymousRead(board.uuid)).toEqual({ latitude: null, locationName: null });
  });

  it('hides it when the move sends no hide choice, as the edit screen does with privacy controls on', async () => {
    const { board } = await boardAtGym();
    await updateBoard({ boardUuid: board.uuid, latitude: LAT_8KM, longitude: BASE.longitude });
    expect(await anonymousRead(board.uuid)).toEqual({ latitude: null, locationName: null });
  });

  it('hides a typed home address even when the coordinates still point at the gym', async () => {
    const { board } = await boardAtGym();
    await updateBoard({ boardUuid: board.uuid, locationName: '12 Elm Street', hideLocation: true });
    await unlink(board.uuid);
    expect(await anonymousRead(board.uuid)).toEqual({ latitude: null, locationName: null });
  });

  it('keeps a GPS fix hidden when the server guesses a gym from it, through the create and a later rename', async () => {
    const gym = await publicGym();
    const board = await createBoard(
      { name: 'Home wall', isPublic: true, hideLocation: true, latitude: LAT_120M, longitude: BASE.longitude },
      authCtx(QUERIER),
    );
    // The coordinates-only tier attached the gym: that is the path under test.
    expect(await storedGymId(board.uuid)).toBe(gym.id);
    expect(await anonymousRead(board.uuid)).toEqual({ latitude: null, locationName: null });

    await updateBoard({ boardUuid: board.uuid, name: 'Home wall renamed' });
    expect(await anonymousRead(board.uuid)).toEqual({ latitude: null, locationName: null });
  });

  it("keeps the climber's own same-name gym from publishing a GPS fix within 5 km", async () => {
    await insertGym({ ownerId: QUERIER, name: 'My Wall', latitude: BASE.latitude, longitude: BASE.longitude });
    const board = await createBoard(
      {
        name: 'Second wall',
        locationName: 'My Wall',
        hideLocation: true,
        latitude: LAT_2KM,
        longitude: BASE.longitude,
      },
      authCtx(QUERIER),
    );
    expect(await storedGymId(board.uuid)).not.toBeNull();
    expect(await anonymousRead(board.uuid)).toEqual({ latitude: null, locationName: null });
  });

  describe('with privacy controls on', () => {
    beforeEach(() => {
      vi.stubEnv('BOARDSESH_PRIVACY_ENABLED', '1');
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });
    // The mutation's answer, with the field the owner's control locks on.
    const setLocation = async (boardUuid: string, locationAudience: string) => {
      const answered = (await privacyMutations.updateResourcePrivacy(
        null,
        { input: { kind: 'board', resourceId: boardUuid, audience: 'public', locationAudience } },
        authCtx(QUERIER),
      )) as { kind: 'board'; resourceId: string; locationAudience: string };
      return {
        ...answered,
        locationSharedByGym: await resourcePrivacySettingsFields.locationSharedByGym(answered),
      };
    };

    it('answers a narrower location for a board at its public gym with the shown one it stores', async () => {
      const { board } = await boardAtGym();
      const answered = await setLocation(board.uuid, 'only_me');
      expect(answered).toMatchObject({ locationAudience: 'public', locationSharedByGym: true });

      // Nothing silently changes on the next edit: what the owner was told holds.
      await updateBoard({ boardUuid: board.uuid, name: 'Renamed' });
      expect(await anonymousRead(board.uuid)).toEqual({ latitude: BASE.latitude, locationName: GYM_NAME });
    });

    it("keeps the owner's choice for a board in a public gym that sits somewhere else", async () => {
      const gym = await publicGym();
      const board = await createBoard(
        { name: 'Near the gym', gymUuid: gym.uuid, latitude: LAT_60M, longitude: BASE.longitude },
        authCtx(QUERIER),
      );
      const answered = await setLocation(board.uuid, 'only_me');
      expect(answered).toMatchObject({ locationAudience: 'only_me', locationSharedByGym: false });
      await updateBoard({ boardUuid: board.uuid, name: 'Renamed' });
      expect(await anonymousRead(board.uuid)).toEqual({ latitude: null, locationName: null });
    });
  });
});
