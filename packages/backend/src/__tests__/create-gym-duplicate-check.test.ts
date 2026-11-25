import { describe, it, expect, beforeEach } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../db/client';
import { socialGymMutations } from '../graphql/resolvers/social/gyms';
import { MAX_AUTO_MINTED_GYMS_PER_OWNER, type SimilarGymResult } from '../graphql/resolvers/social/gym-matching';
import { blockingSimilarGyms } from '../graphql/resolvers/social/gym-create-guards';
import { resetAllRateLimits } from '../utils/rate-limiter';

/**
 * Real-DB coverage for createGym's duplicate refusal and owner cap.
 *
 * Every create runs findSimilarGymCandidates as the caller. Absent (or
 * REJECT_IF_FOUND) refuses on any match with GYM_SIMILAR_EXISTS, carrying the
 * matches in the SimilarGym shape; CONFIRMED_SEPARATE passes only once every
 * current match is acknowledged. The create also stops at the 25-gym cap with
 * GYM_LIMIT_REACHED. The matching tiers themselves are covered in
 * find-similar-gyms-and-auto-gym.test.ts; this file pins what createGym does
 * with them.
 */

const SYSTEM_OWNER = '00000000-0000-0000-0000-000000000000';
const CLIMBER = 'cgd-climber';
const OTHER = 'cgd-other';
const ALL_USERS = [SYSTEM_OWNER, CLIMBER, OTHER];

// Latitude offsets from the base point (111_320 m per degree of latitude).
const BASE = { latitude: 47.0, longitude: 8.0 };
const LAT_60M = 47.0 + 0.00054;
const LAT_2KM = 47.0 + 0.018;
const LAT_20KM = 47.0 + 0.18;

let connectionCounter = 0;
const authCtx = (userId: string): ConnectionContext =>
  ({ connectionId: `conn-${userId}-${connectionCounter++}`, isAuthenticated: true, userId }) as ConnectionContext;

const insertUser = (id: string) =>
  db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'User ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);

const insertGym = async (opts: {
  ownerId?: string;
  name: string;
  latitude?: number | null;
  longitude?: number | null;
  isPublic?: boolean;
  isListed?: boolean;
}): Promise<{ id: number; uuid: string }> => {
  const { ownerId = SYSTEM_OWNER, name, latitude = null, longitude = null, isPublic = true, isListed = true } = opts;
  const uuid = uuidv4();
  const [row] = await db
    .insert(dbSchema.gyms)
    .values({ uuid, slug: uuid, name, ownerId, latitude, longitude, isPublic, isListed })
    .returning({ id: dbSchema.gyms.id });
  return { id: row.id, uuid };
};

const liveGymsOwnedBy = async (ownerId: string): Promise<number> => {
  const [row] = await db
    .select({ total: count() })
    .from(dbSchema.gyms)
    .where(and(eq(dbSchema.gyms.ownerId, ownerId), isNull(dbSchema.gyms.deletedAt)));
  return row.total;
};

type CreatedGym = { uuid: string; name: string; slug: string | null };

const createGym = (input: Record<string, unknown>, userId: string = CLIMBER) =>
  socialGymMutations.createGym(null, { input }, authCtx(userId)) as Promise<CreatedGym>;

type SimilarGymsRefusal = { code: string; candidates: SimilarGymResult[] };

/** The GYM_SIMILAR_EXISTS extensions, or null when the create went through. Any other failure rethrows. */
async function captureSimilarGyms(promise: Promise<unknown>): Promise<SimilarGymsRefusal | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    const extensions = (error as { extensions?: Record<string, unknown> }).extensions;
    if (extensions?.code === 'GYM_SIMILAR_EXISTS') return extensions as SimilarGymsRefusal;
    throw error;
  }
}

const candidateUuids = (refusal: SimilarGymsRefusal | null) => refusal?.candidates.map((gym) => gym.uuid) ?? null;

beforeEach(async () => {
  resetAllRateLimits();
  await db.execute(sql`
    TRUNCATE TABLE
      "community_roles", "gym_members", "gym_follows", "location_sync_gym_sources", "user_boards", "gyms"
    RESTART IDENTITY CASCADE
  `);
  await Promise.all(ALL_USERS.map(insertUser));
});

describe('createGym duplicate refusal', () => {
  it('refuses with the similar gyms in the SimilarGym shape when the check is absent', async () => {
    const listed = await insertGym({ name: 'Bahnhof Bloc', latitude: LAT_2KM, longitude: BASE.longitude });

    const refusal = await captureSimilarGyms(
      createGym({ name: 'Bahnhof Bloc', latitude: BASE.latitude, longitude: BASE.longitude }),
    );

    expect(refusal).toEqual({
      code: 'GYM_SIMILAR_EXISTS',
      candidates: [
        {
          uuid: listed.uuid,
          slug: listed.uuid,
          name: 'Bahnhof Bloc',
          address: null,
          website: null,
          distanceMeters: expect.any(Number),
          ownerType: 'SYSTEM',
          isClaimable: true,
          canClaimByDomain: false,
          providerOrigins: [],
        },
      ],
    });
    expect(await liveGymsOwnedBy(CLIMBER)).toBe(0);
  });

  it('refuses under an explicit REJECT_IF_FOUND even with acknowledged gyms', async () => {
    const listed = await insertGym({ name: 'Random Wall', latitude: LAT_60M, longitude: BASE.longitude });

    const refusal = await captureSimilarGyms(
      createGym({
        name: 'Totally Different',
        latitude: BASE.latitude,
        longitude: BASE.longitude,
        duplicateCheck: { mode: 'REJECT_IF_FOUND', acknowledgedGymUuids: [listed.uuid] },
      }),
    );

    // Any name within 150 m counts.
    expect(candidateUuids(refusal)).toEqual([listed.uuid]);
    expect(await liveGymsOwnedBy(CLIMBER)).toBe(0);
  });

  it('creates once every similar gym is acknowledged as separate', async () => {
    const near = await insertGym({ name: 'Random Wall', latitude: LAT_60M, longitude: BASE.longitude });
    const sameName = await insertGym({ name: 'Bahnhof Bloc', latitude: LAT_2KM, longitude: BASE.longitude });

    const created = await createGym({
      name: 'Bahnhof Bloc',
      latitude: BASE.latitude,
      longitude: BASE.longitude,
      duplicateCheck: { mode: 'CONFIRMED_SEPARATE', acknowledgedGymUuids: [sameName.uuid, near.uuid] },
    });

    expect(created.name).toBe('Bahnhof Bloc');
    expect(await liveGymsOwnedBy(CLIMBER)).toBe(1);
  });

  it('refuses again with only the gyms a partial confirmation left out', async () => {
    const near = await insertGym({ name: 'Random Wall', latitude: LAT_60M, longitude: BASE.longitude });
    const sameName = await insertGym({ name: 'Bahnhof Bloc', latitude: LAT_2KM, longitude: BASE.longitude });

    const refusal = await captureSimilarGyms(
      createGym({
        name: 'Bahnhof Bloc',
        latitude: BASE.latitude,
        longitude: BASE.longitude,
        duplicateCheck: { mode: 'CONFIRMED_SEPARATE', acknowledgedGymUuids: [near.uuid] },
      }),
    );

    expect(candidateUuids(refusal)).toEqual([sameName.uuid]);
    expect(await liveGymsOwnedBy(CLIMBER)).toBe(0);
  });

  it('treats a confirmation with no acknowledged gyms as a refusal when any exist', async () => {
    const listed = await insertGym({ name: 'Bahnhof Bloc' });

    for (const acknowledgedGymUuids of [undefined, [], [uuidv4()]]) {
      const refusal = await captureSimilarGyms(
        createGym({ name: 'Bahnhof Bloc', duplicateCheck: { mode: 'CONFIRMED_SEPARATE', acknowledgedGymUuids } }),
      );
      expect(candidateUuids(refusal)).toEqual([listed.uuid]);
    }
    expect(await liveGymsOwnedBy(CLIMBER)).toBe(0);
  });

  it('creates without a check field when nothing similar is listed', async () => {
    await insertGym({ name: 'Bahnhof Bloc', latitude: LAT_20KM, longitude: BASE.longitude });

    const created = await createGym({ name: 'Kletterhalle Nord', latitude: BASE.latitude, longitude: BASE.longitude });

    expect(created.name).toBe('Kletterhalle Nord');
    expect(await liveGymsOwnedBy(CLIMBER)).toBe(1);
  });

  it('matches on name alone when no coordinates are sent, wherever the listing is', async () => {
    const exact = await insertGym({ name: 'Bahnhof Bloc', latitude: LAT_20KM, longitude: BASE.longitude });
    const substring = await insertGym({ name: 'Bahnhof Bloc Annex' });
    await insertGym({ name: 'Unrelated Gym', latitude: BASE.latitude, longitude: BASE.longitude });

    const refusal = await captureSimilarGyms(createGym({ name: 'Bahnhof Bloc' }));

    // Exact name first, then the substring match; the unrelated gym at the
    // base point never counts without coordinates to measure from.
    expect(candidateUuids(refusal)).toEqual([exact.uuid, substring.uuid]);
    expect(refusal?.candidates.every((gym) => gym.distanceMeters === null)).toBe(true);
  });

  it("never refuses over another climber's private or unlisted gym", async () => {
    await insertGym({ ownerId: OTHER, name: 'Bahnhof Bloc', isPublic: false });
    await insertGym({ ownerId: OTHER, name: 'Bahnhof Bloc', isListed: false });

    const created = await createGym({ name: 'Bahnhof Bloc' });

    expect(created.name).toBe('Bahnhof Bloc');
  });

  it("refuses over the caller's own private gym", async () => {
    const own = await insertGym({ ownerId: CLIMBER, name: 'Garage Wall', isPublic: false });

    const refusal = await captureSimilarGyms(createGym({ name: 'Garage Wall' }));

    expect(candidateUuids(refusal)).toEqual([own.uuid]);
    expect(refusal?.candidates[0]).toMatchObject({ ownerType: 'USER', isClaimable: false });
  });

  it('names at most five gyms a refusal, and the next ones once those are acknowledged', async () => {
    const listed: string[] = [];
    for (let index = 0; index < 7; index++) {
      const gym = await insertGym({
        name: `Wall ${index}`,
        latitude: BASE.latitude + index * 0.0001, // ~11 m apart, all within 150 m
        longitude: BASE.longitude,
      });
      listed.push(gym.uuid);
    }

    const first = await captureSimilarGyms(
      createGym({ name: 'Kletterhalle Nord', latitude: BASE.latitude, longitude: BASE.longitude }),
    );
    expect(candidateUuids(first)).toEqual(listed.slice(0, 5));

    const second = await captureSimilarGyms(
      createGym({
        name: 'Kletterhalle Nord',
        latitude: BASE.latitude,
        longitude: BASE.longitude,
        duplicateCheck: { mode: 'CONFIRMED_SEPARATE', acknowledgedGymUuids: listed.slice(0, 5) },
      }),
    );
    expect(candidateUuids(second)).toEqual(listed.slice(5));

    await createGym({
      name: 'Kletterhalle Nord',
      latitude: BASE.latitude,
      longitude: BASE.longitude,
      duplicateCheck: { mode: 'CONFIRMED_SEPARATE', acknowledgedGymUuids: listed },
    });
    expect(await liveGymsOwnedBy(CLIMBER)).toBe(1);
  });

  it('lets only one of two simultaneous creates of the same gym by one climber through', async () => {
    const results = await Promise.allSettled([
      createGym({ name: 'Bahnhof Bloc', latitude: BASE.latitude, longitude: BASE.longitude }),
      createGym({ name: 'Bahnhof Bloc', latitude: BASE.latitude, longitude: BASE.longitude }),
    ]);

    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0].reason as { extensions?: { code?: string } }).extensions?.code).toBe('GYM_SIMILAR_EXISTS');
    expect(await liveGymsOwnedBy(CLIMBER)).toBe(1);
  });

  it('lets only one of two climbers adding the same gym by name at once through', async () => {
    const results = await Promise.allSettled([
      createGym({ name: 'Bahnhof Bloc', latitude: BASE.latitude, longitude: BASE.longitude }, CLIMBER),
      createGym({ name: '  bahnhof   bloc ', latitude: LAT_60M, longitude: BASE.longitude }, OTHER),
    ]);

    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0].reason as { extensions?: { code?: string } }).extensions?.code).toBe('GYM_SIMILAR_EXISTS');
    expect((await liveGymsOwnedBy(CLIMBER)) + (await liveGymsOwnedBy(OTHER))).toBe(1);
  });
});

describe('createGym name and cap', () => {
  it('stores the name trimmed and slugs it from the trimmed name', async () => {
    const created = await createGym({ name: '   Kletterhalle Nord  ' });

    expect(created.name).toBe('Kletterhalle Nord');
    expect(created.slug).toBe('kletterhalle-nord');
  });

  it('refuses a name that is only whitespace', async () => {
    await expect(createGym({ name: '    ' })).rejects.toThrow('Gym name cannot be empty');
    expect(await liveGymsOwnedBy(CLIMBER)).toBe(0);
  });

  it('refuses with GYM_LIMIT_REACHED once the caller owns the cap, before any duplicate check', async () => {
    for (let index = 0; index < MAX_AUTO_MINTED_GYMS_PER_OWNER; index++) {
      await insertGym({ ownerId: CLIMBER, name: `Capped Gym ${index}` });
    }

    await expect(createGym({ name: 'Kletterhalle Nord' })).rejects.toMatchObject({
      extensions: { code: 'GYM_LIMIT_REACHED', maxGyms: MAX_AUTO_MINTED_GYMS_PER_OWNER },
    });
    expect(await liveGymsOwnedBy(CLIMBER)).toBe(MAX_AUTO_MINTED_GYMS_PER_OWNER);
  });

  it('does not count deleted gyms against the cap', async () => {
    for (let index = 0; index < MAX_AUTO_MINTED_GYMS_PER_OWNER; index++) {
      await insertGym({ ownerId: CLIMBER, name: `Capped Gym ${index}` });
    }
    await db.update(dbSchema.gyms).set({ deletedAt: new Date() }).where(eq(dbSchema.gyms.name, 'Capped Gym 0'));

    const created = await createGym({ name: 'Kletterhalle Nord' });

    expect(created.name).toBe('Kletterhalle Nord');
  });
});

describe('blockingSimilarGyms', () => {
  const gym = (uuid: string) => ({
    id: 1,
    uuid,
    slug: null,
    name: uuid,
    address: null,
    website: null,
    websiteVouchedByOwner: false,
    ownerId: SYSTEM_OWNER,
    latitude: null,
    longitude: null,
    distanceMeters: null,
  });

  it('blocks on every match under REJECT_IF_FOUND, and keeps the order', () => {
    expect(blockingSimilarGyms([gym('b'), gym('a')], 'REJECT_IF_FOUND', ['a', 'b']).map((match) => match.uuid)).toEqual(
      ['b', 'a'],
    );
  });

  it('blocks only on unacknowledged matches under CONFIRMED_SEPARATE', () => {
    expect(blockingSimilarGyms([gym('a'), gym('b')], 'CONFIRMED_SEPARATE', ['a']).map((match) => match.uuid)).toEqual([
      'b',
    ]);
    expect(blockingSimilarGyms([gym('a')], 'CONFIRMED_SEPARATE', [])).toHaveLength(1);
    expect(blockingSimilarGyms([], 'REJECT_IF_FOUND', [])).toEqual([]);
  });
});
