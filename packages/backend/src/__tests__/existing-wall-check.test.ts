import { describe, it, expect, beforeEach } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../db/client';
import { socialBoardMutations } from '../graphql/resolvers/social/boards';
import { socialBoardWallCandidateQueries } from '../graphql/resolvers/social/board-wall-candidates';
import { findGymsWithin } from '../graphql/resolvers/social/gym-matching';
import { resetAllRateLimits } from '../utils/rate-limiter';

/**
 * Real-DB coverage for the existing-wall check (#8151): the
 * `existingWallCandidates` query and createBoard's opt-in recheck. Seeds
 * gyms and boards directly and calls the resolvers against the per-worker test
 * DB (plain postgres, no PostGIS), like create-board-duplicate-guard.test.ts.
 *
 * MoonBoard configs keep the catalogue static: Masters 2019 is layout 5 with
 * sets 17-20 (20 = Screw-on Feet), MoonBoard 2016 is layout 2.
 */

const SYSTEM_OWNER = '00000000-0000-0000-0000-000000000000';
const CLIMBER = 'wall-check-climber';
const SETTER = 'wall-check-setter';
const CREW = 'wall-check-crew';
const ALL_USERS = [SYSTEM_OWNER, CLIMBER, SETTER, CREW];

const BASE = { latitude: 47.0, longitude: 8.0 };
const LAT_60M = 47.0 + 0.00054; // ~60 m north: same building
const LAT_120M = 47.0 + 0.00108; // ~120 m: still nearby
const LAT_2KM = 47.0 + 0.018; // ~2 km: another gym

const MASTERS_2019 = { boardType: 'moonboard', layoutId: 5, sizeId: 1, setIds: '17,18,19,20' };
const MASTERS_2019_NO_FEET = { ...MASTERS_2019, setIds: '17,18,19' };
const MOONBOARD_2016 = { boardType: 'moonboard', layoutId: 2, sizeId: 1, setIds: '2,3,4' };

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

type SeededGym = { id: number; uuid: string };

async function insertGym(opts: {
  ownerId?: string;
  name: string;
  latitude?: number | null;
  longitude?: number | null;
  isPublic?: boolean;
  isListed?: boolean;
  mergedIntoGymId?: number;
}): Promise<SeededGym> {
  const uuid = uuidv4();
  const [gym] = await db
    .insert(dbSchema.gyms)
    .values({
      uuid,
      slug: uuid,
      ownerId: opts.ownerId ?? SETTER,
      name: opts.name,
      latitude: opts.latitude === undefined ? BASE.latitude : opts.latitude,
      longitude: opts.longitude === undefined ? BASE.longitude : opts.longitude,
      isPublic: opts.isPublic ?? true,
      isListed: opts.isListed ?? true,
      mergedIntoGymId: opts.mergedIntoGymId ?? null,
      deletedAt: opts.mergedIntoGymId != null ? new Date() : null,
    })
    .returning({ id: dbSchema.gyms.id, uuid: dbSchema.gyms.uuid });
  return gym;
}

async function insertWall(opts: {
  gymId: number;
  ownerId?: string;
  config?: { boardType: string; layoutId: number; sizeId: number; setIds: string };
  isPublic?: boolean;
  isUnlisted?: boolean;
  createdAt?: Date;
  name?: string;
}): Promise<string> {
  const uuid = uuidv4();
  const config = opts.config ?? MASTERS_2019;
  await db.insert(dbSchema.userBoards).values({
    uuid,
    slug: uuid,
    ownerId: opts.ownerId ?? SETTER,
    ...config,
    name: opts.name ?? 'Gym MoonBoard',
    gymId: opts.gymId,
    latitude: BASE.latitude,
    longitude: BASE.longitude,
    isPublic: opts.isPublic ?? true,
    isUnlisted: opts.isUnlisted ?? false,
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
  });
  return uuid;
}

type CreatedBoard = { uuid: string; gymUuid: string | null };

const createBoard = (input: Record<string, unknown>, userId = CLIMBER) =>
  socialBoardMutations.createBoard(
    null,
    {
      input: {
        ...MASTERS_2019,
        name: 'My MoonBoard',
        latitude: LAT_60M,
        longitude: BASE.longitude,
        ...input,
      },
    },
    authCtx(userId),
  ) as Promise<CreatedBoard>;

type CandidateResult = {
  candidates: Array<{
    board: { uuid: string };
    matchKind: string | null;
    missingSetIds: number[];
    extraSetIds: number[];
    source: string;
    gymName: string;
    gymDistanceMeters: number | null;
  }>;
  truncated: boolean;
};

const existingWallCandidates = (input: Record<string, unknown>, ctx: ConnectionContext = authCtx(CLIMBER)) =>
  socialBoardWallCandidateQueries.existingWallCandidates(null, { input }, ctx) as Promise<CandidateResult>;

/** The BOARD_EXISTING_WALLS extensions, or null when the promise resolved or failed some other way. */
async function captureExistingWalls(promise: Promise<unknown>): Promise<Record<string, unknown> | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    const extensions = (error as { extensions?: Record<string, unknown> }).extensions;
    if (extensions?.code === 'BOARD_EXISTING_WALLS') return extensions;
    throw error;
  }
}

const liveBoardsOwnedBy = async (ownerId: string): Promise<number> => {
  const [row] = await db
    .select({ total: count() })
    .from(dbSchema.userBoards)
    .where(and(eq(dbSchema.userBoards.ownerId, ownerId), isNull(dbSchema.userBoards.deletedAt)));
  return Number(row.total);
};

const gymsOwnedBy = async (ownerId: string): Promise<number> => {
  const [row] = await db.select({ total: count() }).from(dbSchema.gyms).where(eq(dbSchema.gyms.ownerId, ownerId));
  return Number(row.total);
};

beforeEach(async () => {
  resetAllRateLimits();
  await db.execute(sql`
    TRUNCATE TABLE
      "community_roles", "gym_members", "gym_follows", "location_sync_gym_sources",
      "resource_privacy", "resource_grants", "user_boards", "gyms"
    RESTART IDENTITY CASCADE
  `);
  await Promise.all(ALL_USERS.map(insertUser));
});

describe('createBoard existing-wall recheck', () => {
  it("refuses a copy of another climber's wall that has no serial, naming it by uuid and kind only", async () => {
    const gym = await insertGym({ name: 'Klimmuur' });
    const wallUuid = await insertWall({ gymId: gym.id });

    const extensions = await captureExistingWalls(
      createBoard({ gymUuid: gym.uuid, existingWallCheck: 'REJECT_IF_FOUND' }),
    );

    expect(extensions).toEqual({
      code: 'BOARD_EXISTING_WALLS',
      candidates: [{ boardUuid: wallUuid, matchKind: 'EXACT' }],
    });
    expect(await liveBoardsOwnedBy(CLIMBER)).toBe(0);
  });

  it('creates exactly as before when the field is absent (an old binary)', async () => {
    const gym = await insertGym({ name: 'Klimmuur' });
    await insertWall({ gymId: gym.id });

    const created = await createBoard({ gymUuid: gym.uuid });

    expect(created.gymUuid).toBe(gym.uuid);
    expect(await liveBoardsOwnedBy(CLIMBER)).toBe(1);
  });

  it('never blocks on another layout: a 2016 wall does not stop a Masters 2019', async () => {
    const gym = await insertGym({ name: 'Klimmuur' });
    await insertWall({ gymId: gym.id, config: MOONBOARD_2016 });

    await createBoard({ gymUuid: gym.uuid, existingWallCheck: 'REJECT_IF_FOUND' });

    expect(await liveBoardsOwnedBy(CLIMBER)).toBe(1);
  });

  it('blocks a wall entered without its feet, and lets the climber add theirs once they acknowledge it', async () => {
    const gym = await insertGym({ name: 'Klimmuur' });
    const noFeetUuid = await insertWall({ gymId: gym.id, config: MASTERS_2019_NO_FEET });

    const extensions = await captureExistingWalls(
      createBoard({ gymUuid: gym.uuid, existingWallCheck: 'REJECT_IF_FOUND' }),
    );
    expect(extensions?.candidates).toEqual([{ boardUuid: noFeetUuid, matchKind: 'SETS_DIFFER' }]);

    await createBoard({
      gymUuid: gym.uuid,
      existingWallCheck: 'CONFIRMED_SEPARATE',
      acknowledgedWallUuids: [noFeetUuid],
    });
    expect(await liveBoardsOwnedBy(CLIMBER)).toBe(1);
  });

  it('treats a differently ordered set list as the same setup', async () => {
    const gym = await insertGym({ name: 'Klimmuur' });
    const wallUuid = await insertWall({ gymId: gym.id, config: { ...MASTERS_2019, setIds: '20,19,18,17' } });

    const extensions = await captureExistingWalls(
      createBoard({ gymUuid: gym.uuid, setIds: '17,18,19,20', existingWallCheck: 'REJECT_IF_FOUND' }),
    );

    expect(extensions?.candidates).toEqual([{ boardUuid: wallUuid, matchKind: 'EXACT' }]);
  });

  it("finds a wall left on a listing merged into the chosen gym, via either gym's uuid", async () => {
    const gym = await insertGym({ name: 'Klimmuur' });
    const twin = await insertGym({ name: 'Klimmuur (old listing)', mergedIntoGymId: gym.id });
    const strayUuid = await insertWall({ gymId: twin.id });

    for (const gymUuid of [gym.uuid, twin.uuid]) {
      const extensions = await captureExistingWalls(createBoard({ gymUuid, existingWallCheck: 'REJECT_IF_FOUND' }));
      expect(extensions?.candidates).toEqual([{ boardUuid: strayUuid, matchKind: 'EXACT' }]);
    }
  });

  it('finds a wall on a public, listed gym within 150 m, but not on a private or unlisted one', async () => {
    const gym = await insertGym({ name: 'Klimmuur' });
    const neighbour = await insertGym({ name: 'Klimmuur Boulder', latitude: LAT_120M });
    const privateNeighbour = await insertGym({ name: 'Garage', latitude: LAT_60M, isPublic: false });
    const unlistedNeighbour = await insertGym({ name: 'Back room', latitude: LAT_60M, isListed: false });
    const farGym = await insertGym({ name: 'Elsewhere', latitude: LAT_2KM });
    const neighbourWallUuid = await insertWall({ gymId: neighbour.id });
    await insertWall({ gymId: privateNeighbour.id });
    await insertWall({ gymId: unlistedNeighbour.id });
    await insertWall({ gymId: farGym.id });

    const extensions = await captureExistingWalls(
      createBoard({ gymUuid: gym.uuid, existingWallCheck: 'REJECT_IF_FOUND' }),
    );

    expect(extensions?.candidates).toEqual([{ boardUuid: neighbourWallUuid, matchKind: 'EXACT' }]);
  });

  it('never blocks on, or names, a wall the climber cannot see', async () => {
    const gym = await insertGym({ name: 'Klimmuur' });
    const privateUuid = await insertWall({ gymId: gym.id, isPublic: false, createdAt: new Date('2016-01-01') });
    const unlistedUuid = await insertWall({ gymId: gym.id, isUnlisted: true, createdAt: new Date('2017-01-01') });
    const hiddenByOverride = await insertWall({ gymId: gym.id, createdAt: new Date('2018-01-01') });
    await db.insert(dbSchema.resourcePrivacy).values({
      kind: 'board',
      resourceId: hiddenByOverride,
      ownerId: SETTER,
      audience: 'only_me',
      locationAudience: 'only_me',
    });

    // Only hidden walls: the create goes through. Made private itself, so it
    // in turn stays out of the next climber's check.
    await createBoard({ gymUuid: gym.uuid, isPublic: false, existingWallCheck: 'REJECT_IF_FOUND' });
    expect(await liveBoardsOwnedBy(CLIMBER)).toBe(1);

    // With a public wall too, the refusal names the public one and nothing else.
    const publicUuid = await insertWall({ gymId: gym.id, createdAt: new Date('2019-01-01') });
    const extensions = await captureExistingWalls(
      createBoard({ gymUuid: gym.uuid, existingWallCheck: 'REJECT_IF_FOUND' }, CREW),
    );
    const namedWalls = (extensions?.candidates ?? []) as Array<{ boardUuid: string }>;
    const namedUuids = namedWalls.map((wall) => wall.boardUuid);
    expect(namedUuids).toEqual([publicUuid]);
    for (const hiddenUuid of [privateUuid, unlistedUuid, hiddenByOverride]) {
      expect(JSON.stringify(extensions)).not.toContain(hiddenUuid);
    }
  });

  it('checks the gym a home climber is auto-attached to by their typed location', async () => {
    const syncedGym = await insertGym({ ownerId: SYSTEM_OWNER, name: 'Klimmuur Basel' });
    const wallUuid = await insertWall({ gymId: syncedGym.id, ownerId: SYSTEM_OWNER });

    const extensions = await captureExistingWalls(
      createBoard({ locationName: 'Klimmuur Basel', existingWallCheck: 'REJECT_IF_FOUND' }),
    );

    expect(extensions?.candidates).toEqual([{ boardUuid: wallUuid, matchKind: 'EXACT' }]);
    expect(await liveBoardsOwnedBy(CLIMBER)).toBe(0);
  });

  it('checks public gyms within 150 m before minting a new one, and mints nothing when refused', async () => {
    const gym = await insertGym({ name: 'Boulderhalle Nord' });
    const wallUuid = await insertWall({ gymId: gym.id });

    const extensions = await captureExistingWalls(
      createBoard({ locationName: 'My garage', existingWallCheck: 'REJECT_IF_FOUND' }),
    );

    expect(extensions?.candidates).toEqual([{ boardUuid: wallUuid, matchKind: 'EXACT' }]);
    expect(await gymsOwnedBy(CLIMBER)).toBe(0);
    expect(await liveBoardsOwnedBy(CLIMBER)).toBe(0);

    // Far from any listing, the same home wall mints its gym as before.
    await createBoard({ locationName: 'My garage', latitude: LAT_2KM, existingWallCheck: 'REJECT_IF_FOUND' });
    expect(await gymsOwnedBy(CLIMBER)).toBe(1);
  });

  it('lets only one of two simultaneous creates of the same wall through', async () => {
    const gym = await insertGym({ name: 'Klimmuur' });

    const results = await Promise.allSettled([
      createBoard({ gymUuid: gym.uuid, existingWallCheck: 'REJECT_IF_FOUND' }, CLIMBER),
      createBoard({ gymUuid: gym.uuid, existingWallCheck: 'REJECT_IF_FOUND' }, CREW),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0].reason as { extensions?: { code?: string } }).extensions?.code).toBe('BOARD_EXISTING_WALLS');
    expect((await liveBoardsOwnedBy(CLIMBER)) + (await liveBoardsOwnedBy(CREW))).toBe(1);
  });

  it('allows two identical walls at one gym once the climber confirms theirs is separate', async () => {
    const gym = await insertGym({ name: 'Klimmuur' });
    const wallUuid = await insertWall({ gymId: gym.id });

    await createBoard({
      gymUuid: gym.uuid,
      existingWallCheck: 'CONFIRMED_SEPARATE',
      acknowledgedWallUuids: [wallUuid],
    });

    expect(await liveBoardsOwnedBy(CLIMBER)).toBe(1);
  });

  it('still refuses an exact wall the climber did not acknowledge', async () => {
    const gym = await insertGym({ name: 'Klimmuur' });
    const seenUuid = await insertWall({ gymId: gym.id, createdAt: new Date('2016-01-01') });
    const unseenUuid = await insertWall({ gymId: gym.id, ownerId: CREW, createdAt: new Date('2020-01-01') });

    const extensions = await captureExistingWalls(
      createBoard({ gymUuid: gym.uuid, existingWallCheck: 'CONFIRMED_SEPARATE', acknowledgedWallUuids: [seenUuid] }),
    );

    expect(extensions?.candidates).toEqual([{ boardUuid: unseenUuid, matchKind: 'EXACT' }]);
  });

  it('refuses an empty acknowledgement when walls exist, and honours it when there are none', async () => {
    const gym = await insertGym({ name: 'Klimmuur' });
    const emptyGym = await insertGym({ name: 'New gym', latitude: LAT_2KM });
    const noFeetUuid = await insertWall({ gymId: gym.id, config: MASTERS_2019_NO_FEET });

    const extensions = await captureExistingWalls(
      createBoard({ gymUuid: gym.uuid, existingWallCheck: 'CONFIRMED_SEPARATE', acknowledgedWallUuids: [] }),
    );
    expect(extensions?.candidates).toEqual([{ boardUuid: noFeetUuid, matchKind: 'SETS_DIFFER' }]);

    await createBoard({
      gymUuid: emptyGym.uuid,
      latitude: LAT_2KM,
      existingWallCheck: 'CONFIRMED_SEPARATE',
      acknowledgedWallUuids: [],
    });
    expect(await liveBoardsOwnedBy(CLIMBER)).toBe(1);
  });

  it('treats an acknowledgement naming none of the walls found as an empty one', async () => {
    const gym = await insertGym({ name: 'Klimmuur' });
    const wallUuid = await insertWall({ gymId: gym.id });

    const extensions = await captureExistingWalls(
      createBoard({
        gymUuid: gym.uuid,
        existingWallCheck: 'CONFIRMED_SEPARATE',
        acknowledgedWallUuids: [uuidv4()],
      }),
    );

    expect(extensions?.candidates).toEqual([{ boardUuid: wallUuid, matchKind: 'EXACT' }]);
    expect(await liveBoardsOwnedBy(CLIMBER)).toBe(0);
  });

  it("keeps the chosen gym's wall in the check when a busy neighbour has 100+ older walls", async () => {
    const gym = await insertGym({ name: 'Klimmuur' });
    const neighbour = await insertGym({ name: 'Big Hall', latitude: LAT_60M });
    await db.insert(dbSchema.userBoards).values(
      Array.from({ length: 105 }, (_, wallIndex) => {
        const uuid = uuidv4();
        return {
          uuid,
          slug: uuid,
          ownerId: SETTER,
          ...MOONBOARD_2016,
          name: `Old wall ${wallIndex}`,
          gymId: neighbour.id,
          createdAt: new Date('2015-01-01'),
        };
      }),
    );
    const wallUuid = await insertWall({ gymId: gym.id, createdAt: new Date('2024-01-01') });

    const extensions = await captureExistingWalls(
      createBoard({ gymUuid: gym.uuid, existingWallCheck: 'REJECT_IF_FOUND' }),
    );
    expect(extensions?.candidates).toEqual([{ boardUuid: wallUuid, matchKind: 'EXACT' }]);

    const listed = await existingWallCandidates({ gymUuid: gym.uuid, ...MASTERS_2019, limit: 40 });
    expect(listed.candidates[0].board.uuid).toBe(wallUuid);
    expect(listed.candidates).toHaveLength(40);
    expect(listed.truncated).toBe(true);
  });

  it('serializes creates at two neighbouring gyms whose searches overlap', async () => {
    const gymA = await insertGym({ name: 'Klimmuur' });
    const gymB = await insertGym({ name: 'Klimmuur Boulder', latitude: LAT_60M });

    const results = await Promise.allSettled([
      createBoard({ gymUuid: gymA.uuid, latitude: BASE.latitude, existingWallCheck: 'REJECT_IF_FOUND' }, CLIMBER),
      createBoard({ gymUuid: gymB.uuid, existingWallCheck: 'REJECT_IF_FOUND' }, CREW),
    ]);

    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0].reason as { extensions?: { code?: string } }).extensions?.code).toBe('BOARD_EXISTING_WALLS');
  });

  it('lets only one of two simultaneous public mints near the same public gym through', async () => {
    await insertGym({ name: 'Boulderhalle Nord' });
    const publicMint = { audience: 'public', locationAudience: 'public', existingWallCheck: 'REJECT_IF_FOUND' };

    const results = await Promise.allSettled([
      createBoard({ ...publicMint, locationName: 'Garage One' }, CLIMBER),
      createBoard({ ...publicMint, locationName: 'Garage Two', latitude: LAT_120M }, CREW),
    ]);

    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0].reason as { extensions?: { code?: string } }).extensions?.code).toBe('BOARD_EXISTING_WALLS');
    expect((await gymsOwnedBy(CLIMBER)) + (await gymsOwnedBy(CREW))).toBe(1);
  });

  it('lets a newly minted nearer gym displace a full ten-gym scope after the lock', async () => {
    // Ten empty public gyms 33-133 m from the mint point: the first read is
    // already at the cap, so only the re-read after the lock can find the
    // gym the other create mints right at the point.
    for (let gymIndex = 3; gymIndex <= 12; gymIndex++) {
      await insertGym({ name: `Neighbour ${gymIndex}`, latitude: LAT_60M + gymIndex * 0.0001 });
    }
    const publicMint = { audience: 'public', locationAudience: 'public', existingWallCheck: 'REJECT_IF_FOUND' };

    const results = await Promise.allSettled([
      createBoard({ ...publicMint, locationName: 'Garage One' }, CLIMBER),
      createBoard({ ...publicMint, locationName: 'Garage Two' }, CREW),
    ]);

    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0].reason as { extensions?: { code?: string } }).extensions?.code).toBe('BOARD_EXISTING_WALLS');
    expect((await liveBoardsOwnedBy(CLIMBER)) + (await liveBoardsOwnedBy(CREW))).toBe(1);
  });

  it('refuses before the foreign-gym link bucket is charged, and leaves MAX_BOARDS_PER_FOREIGN_GYM in force', async () => {
    const gym = await insertGym({ name: 'Klimmuur' });
    const wallUuid = await insertWall({ gymId: gym.id });
    // The climber's own five walls at this gym, on another layout so they
    // don't count as the same wall.
    for (let wallIndex = 0; wallIndex < 5; wallIndex++) {
      await insertWall({ gymId: gym.id, ownerId: CLIMBER, config: MOONBOARD_2016, name: `Own ${wallIndex}` });
    }

    // Six refusals in a row: had any reached the link gate, its 5/min bucket
    // would answer the sixth with a rate-limit error instead.
    for (let attempt = 0; attempt < 6; attempt++) {
      const extensions = await captureExistingWalls(
        createBoard({ gymUuid: gym.uuid, existingWallCheck: 'REJECT_IF_FOUND' }),
      );
      expect(extensions?.candidates).toEqual([{ boardUuid: wallUuid, matchKind: 'EXACT' }]);
    }

    // Acknowledging the wall gets past the check, not past the per-gym cap.
    await expect(
      createBoard({ gymUuid: gym.uuid, existingWallCheck: 'CONFIRMED_SEPARATE', acknowledgedWallUuids: [wallUuid] }),
    ).rejects.toThrow('Not authorized to link board to this gym');
    expect(await liveBoardsOwnedBy(CLIMBER)).toBe(5);
  });

  it('answers a hidden private gym exactly as before: "Gym not found", not an existing-wall refusal', async () => {
    const privateGym = await insertGym({ name: 'Garage', isPublic: false });
    await insertWall({ gymId: privateGym.id });

    await expect(createBoard({ gymUuid: privateGym.uuid, existingWallCheck: 'REJECT_IF_FOUND' })).rejects.toThrow(
      'Gym not found',
    );
  });

  it('skips the check for a board with a serial: the serial guard settles those', async () => {
    const gym = await insertGym({ name: 'Klimmuur' });
    await insertWall({ gymId: gym.id });

    await createBoard({ gymUuid: gym.uuid, serialNumber: '123456', existingWallCheck: 'REJECT_IF_FOUND' });

    expect(await liveBoardsOwnedBy(CLIMBER)).toBe(1);
  });
});

describe('existingWallCandidates', () => {
  it('ranks same setup, then sets that differ, then other layouts, with set differences named', async () => {
    const gym = await insertGym({ name: 'Klimmuur' });
    const otherLayoutUuid = await insertWall({
      gymId: gym.id,
      config: MOONBOARD_2016,
      createdAt: new Date('2016-01-01'),
    });
    const noFeetUuid = await insertWall({
      gymId: gym.id,
      config: MASTERS_2019_NO_FEET,
      createdAt: new Date('2017-01-01'),
    });
    const exactUuid = await insertWall({ gymId: gym.id, createdAt: new Date('2020-01-01') });

    const result = await existingWallCandidates({ gymUuid: gym.uuid, ...MASTERS_2019 });

    expect(result.truncated).toBe(false);
    expect(result.candidates.map((candidate) => [candidate.board.uuid, candidate.matchKind])).toEqual([
      [exactUuid, 'EXACT'],
      [noFeetUuid, 'SETS_DIFFER'],
      [otherLayoutUuid, 'LAYOUT_OR_SIZE_DIFFERS'],
    ]);
    expect(result.candidates[1]).toMatchObject({ missingSetIds: [20], extraSetIds: [], source: 'SELECTED_GYM' });
    expect(result.candidates[0].gymName).toBe('Klimmuur');
  });

  it('labels merged and nearby listings, with the distance to a nearby gym', async () => {
    const gym = await insertGym({ name: 'Klimmuur' });
    const twin = await insertGym({ name: 'Klimmuur old', mergedIntoGymId: gym.id });
    const neighbour = await insertGym({ name: 'Klimmuur Boulder', latitude: LAT_60M });
    await insertWall({ gymId: twin.id });
    await insertWall({ gymId: neighbour.id });

    const result = await existingWallCandidates({ gymUuid: gym.uuid, ...MASTERS_2019 });

    expect(result.candidates.map((candidate) => candidate.source)).toEqual(['MERGED_LISTING', 'NEARBY_LISTING']);
    expect(result.candidates[0].gymDistanceMeters).toBeNull();
    // A merged listing shows the gym it merged into, never the old row's own name.
    expect(result.candidates[0].gymName).toBe('Klimmuur');
    expect(result.candidates[1].gymDistanceMeters).toBeGreaterThan(50);
    expect(result.candidates[1].gymDistanceMeters).toBeLessThan(70);
    expect(result.candidates[1].gymName).toBe('Klimmuur Boulder');
  });

  it('lists without a draft, returns only visible walls, and includes the viewer’s own private wall', async () => {
    const gym = await insertGym({ name: 'Klimmuur' });
    const publicUuid = await insertWall({ gymId: gym.id, createdAt: new Date('2016-01-01') });
    await insertWall({ gymId: gym.id, isPublic: false, createdAt: new Date('2017-01-01') });
    const ownPrivateUuid = await insertWall({
      gymId: gym.id,
      ownerId: CLIMBER,
      isPublic: false,
      createdAt: new Date('2018-01-01'),
    });

    const signedIn = await existingWallCandidates({ boardType: 'moonboard', gymUuid: gym.uuid });
    expect(signedIn.candidates.map((candidate) => [candidate.board.uuid, candidate.matchKind])).toEqual([
      [publicUuid, null],
      [ownPrivateUuid, null],
    ]);

    const signedOut = await existingWallCandidates({ boardType: 'moonboard', gymUuid: gym.uuid }, anonCtx());
    expect(signedOut.candidates.map((candidate) => candidate.board.uuid)).toEqual([publicUuid]);
  });

  it('answers a signed-out climber with public walls only, classified against their draft', async () => {
    const gym = await insertGym({ name: 'Klimmuur' });
    const noFeetUuid = await insertWall({
      gymId: gym.id,
      config: MASTERS_2019_NO_FEET,
      createdAt: new Date('2016-01-01'),
    });
    const exactUuid = await insertWall({ gymId: gym.id, createdAt: new Date('2017-01-01') });
    await insertWall({ gymId: gym.id, isPublic: false, createdAt: new Date('2018-01-01') });
    await insertWall({ gymId: gym.id, ownerId: CLIMBER, isUnlisted: true, createdAt: new Date('2019-01-01') });

    const result = await existingWallCandidates({ gymUuid: gym.uuid, ...MASTERS_2019 }, anonCtx());

    expect(result.candidates.map((candidate) => [candidate.board.uuid, candidate.matchKind])).toEqual([
      [exactUuid, 'EXACT'],
      [noFeetUuid, 'SETS_DIFFER'],
    ]);
    expect(result.truncated).toBe(false);
  });

  it('caps the list and says so', async () => {
    const gym = await insertGym({ name: 'Klimmuur' });
    await insertWall({ gymId: gym.id, createdAt: new Date('2016-01-01') });
    await insertWall({ gymId: gym.id, createdAt: new Date('2017-01-01') });

    const result = await existingWallCandidates({ boardType: 'moonboard', gymUuid: gym.uuid, limit: 1 });

    expect(result.candidates).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it('masks a private gym the viewer cannot edit as NOT_FOUND, and shows it to its owner', async () => {
    const privateGym = await insertGym({ name: 'Garage', isPublic: false });
    await insertWall({ gymId: privateGym.id, isPublic: false });

    await expect(existingWallCandidates({ boardType: 'moonboard', gymUuid: privateGym.uuid })).rejects.toMatchObject({
      extensions: { code: 'NOT_FOUND' },
    });
    await expect(
      existingWallCandidates({ boardType: 'moonboard', gymUuid: uuidv4() }, anonCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });

    const ownerView = await existingWallCandidates(
      { boardType: 'moonboard', gymUuid: privateGym.uuid },
      authCtx(SETTER),
    );
    expect(ownerView.candidates).toHaveLength(1);
  });

  it('refuses spray walls and a half-sent draft', async () => {
    const gym = await insertGym({ name: 'Klimmuur' });
    await expect(existingWallCandidates({ boardType: 'spray', gymUuid: gym.uuid })).rejects.toThrow();
    await expect(existingWallCandidates({ boardType: 'moonboard', gymUuid: gym.uuid, layoutId: 5 })).rejects.toThrow();
  });
});

describe('findGymsWithin', () => {
  it('keeps every gym for existing callers and narrows to public, listed gyms on request', async () => {
    await insertGym({ name: 'Public' });
    await insertGym({ name: 'Private', isPublic: false });
    await insertGym({ name: 'Unlisted', isListed: false });

    const everyGym = await findGymsWithin({ ...BASE, radiusMeters: 150 });
    const findable = await findGymsWithin({ ...BASE, radiusMeters: 150, publicListedOnly: true });

    expect(everyGym.map((gym) => gym.name).sort()).toEqual(['Private', 'Public', 'Unlisted']);
    expect(findable.map((gym) => gym.name)).toEqual(['Public']);
  });
});
