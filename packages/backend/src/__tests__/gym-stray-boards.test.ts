import { describe, it, expect, beforeEach } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import {
  socialGymStrayBoardQueries,
  socialGymStrayBoardMutations,
  type StrayBoardResult,
} from '../graphql/resolvers/social/gym-stray-boards';
import { resetAllRateLimits } from '../utils/rate-limiter';

/**
 * Real-DB coverage for stray-board discovery + attach (the gym Boards tab's
 * "Boards that might be yours"). Two candidate sources:
 *   - MERGED_TWIN: boards on a listing whose merged_into chain resolves to this
 *     gym (they should have followed the merge).
 *   - NEARBY: boards within 150 m of the gym that are unlinked or on a SYSTEM
 *     listing, gated to boards the viewer may see.
 *
 * Seeds via raw SQL and calls the resolvers directly against the per-worker test
 * DB (plain postgres — no PostGIS), mirroring find-similar-gyms-and-auto-gym.
 */

const SYSTEM_OWNER = '00000000-0000-0000-0000-000000000000';
const OWNER = 'stray-owner';
const OTHER = 'stray-other';
const ALL_USERS = [SYSTEM_OWNER, OWNER, OTHER];

// Base point + latitude offsets (~111_320 m per degree of latitude).
const BASE = { latitude: 47.0, longitude: 8.0 };
const LAT_60M = 47.0 + 0.00054; // ~60 m north (inside 150 m)
const LAT_120M = 47.0 + 0.00108; // ~120 m (inside 150 m)
const LAT_300M = 47.0 + 0.0027; // ~300 m (outside 150 m)

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
  mergedIntoGymId?: number | null;
  isPublic?: boolean;
}): Promise<{ id: number; uuid: string; name: string }> => {
  const {
    ownerId,
    name,
    latitude = null,
    longitude = null,
    deleted = false,
    mergedIntoGymId = null,
    isPublic = true,
  } = opts;
  const uuid = uuidv4();
  const result = await db.execute(sql`
    INSERT INTO gyms (uuid, name, slug, owner_id, is_public, latitude, longitude, merged_into_gym_id, deleted_at, created_at, updated_at)
    VALUES (
      ${uuid}, ${name}, ${uuid}, ${ownerId}, ${isPublic}, ${latitude}, ${longitude},
      ${mergedIntoGymId}, ${deleted ? sql`now()` : sql`NULL`}, now(), now()
    )
    RETURNING id
  `);
  return { id: Number(Array.from(result as Iterable<{ id: number }>)[0].id), uuid, name };
};

// A distinct size_id per board so the (owner, type, layout, size, set_ids) unique
// partial index never trips across the several boards a single owner has here.
let boardConfigCounter = 0;
const insertBoard = async (opts: {
  ownerId: string;
  name: string;
  gymId?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  isPublic?: boolean;
  hideLocation?: boolean;
}): Promise<{ id: number; uuid: string }> => {
  const {
    ownerId,
    name,
    gymId = null,
    latitude = null,
    longitude = null,
    isPublic = true,
    hideLocation = false,
  } = opts;
  const uuid = uuidv4();
  const sizeId = 500 + boardConfigCounter++;
  const result = await db.execute(sql`
    INSERT INTO user_boards
      (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, gym_id, is_public, latitude, longitude, hide_location, created_at, updated_at)
    VALUES (
      ${uuid}, ${uuid}, ${ownerId}, 'kilter', 1, ${sizeId}, '1,2', ${name}, ${gymId}, ${isPublic},
      ${latitude}, ${longitude}, ${hideLocation}, now(), now()
    )
    RETURNING id
  `);
  return { id: Number(Array.from(result as Iterable<{ id: number }>)[0].id), uuid };
};

const insertGymMember = (gymId: number, userId: string, role: string) =>
  db.execute(sql`
    INSERT INTO gym_members (gym_id, user_id, role, created_at)
    VALUES (${gymId}, ${userId}, ${role}, now())
  `);

const boardGymId = async (boardUuid: string): Promise<number | null> => {
  const result = await db.execute(sql`SELECT gym_id FROM user_boards WHERE uuid = ${boardUuid}`);
  const row = Array.from(result as Iterable<{ gym_id: number | null }>)[0];
  return row?.gym_id != null ? Number(row.gym_id) : null;
};

const strayBoardsForGym = (gymUuid: string, ctx: ConnectionContext) =>
  socialGymStrayBoardQueries.strayBoardsForGym(null, { gymUuid }, ctx) as Promise<StrayBoardResult[]>;
const attachBoardToGym = (input: unknown, ctx: ConnectionContext) =>
  socialGymStrayBoardMutations.attachBoardToGym(null, { input }, ctx) as Promise<boolean>;

// Target gym at BASE, owned by OWNER (so requireGymEditAccess passes for OWNER).
const seedTargetGym = () =>
  insertGym({ ownerId: OWNER, name: 'Boulder Base', latitude: BASE.latitude, longitude: BASE.longitude });

beforeEach(async () => {
  resetAllRateLimits();
  await db.execute(sql`
    TRUNCATE TABLE
      "community_roles", "gym_members", "gym_follows", "location_sync_gym_sources", "user_boards", "gyms"
    RESTART IDENTITY CASCADE
  `);
  await Promise.all(ALL_USERS.map(insertUser));
});

describe('strayBoardsForGym — merged-twin candidates', () => {
  it('surfaces a board on a listing merged into this gym, with the twin as its current gym', async () => {
    const target = await seedTargetGym();
    const twin = await insertGym({
      ownerId: OTHER,
      name: 'Old Boulder Base',
      deleted: true,
      mergedIntoGymId: target.id,
    });
    const board = await insertBoard({ ownerId: OTHER, name: 'Leftover Wall', gymId: twin.id });

    const results = await strayBoardsForGym(target.uuid, authCtx(OWNER));

    const stray = results.find((candidate) => candidate.uuid === board.uuid);
    expect(stray).toBeDefined();
    expect(stray?.reason).toBe('MERGED_TWIN');
    expect(stray?.currentGymUuid).toBe(twin.uuid);
    expect(stray?.currentGymName).toBe('Old Boulder Base');
  });

  it('follows a multi-hop merge chain (twin2 → twin1 → target)', async () => {
    const target = await seedTargetGym();
    const twin1 = await insertGym({ ownerId: OTHER, name: 'Twin One', deleted: true, mergedIntoGymId: target.id });
    const twin2 = await insertGym({ ownerId: OTHER, name: 'Twin Two', deleted: true, mergedIntoGymId: twin1.id });
    const board = await insertBoard({ ownerId: OTHER, name: 'Two Hops Away', gymId: twin2.id });

    const results = await strayBoardsForGym(target.uuid, authCtx(OWNER));

    expect(results.some((candidate) => candidate.uuid === board.uuid && candidate.reason === 'MERGED_TWIN')).toBe(true);
  });

  it('terminates on a corrupt cyclic merge pointer instead of spinning', async () => {
    // target ← twinA ← twinB, then a corrupt back-pointer target → twinB closes a
    // cycle in the reverse-walk graph. The canonical-id + visited guards must make
    // the walk finish and still surface twinB's board — never loop.
    const target = await seedTargetGym();
    const twinA = await insertGym({ ownerId: OTHER, name: 'Cycle A', deleted: true, mergedIntoGymId: target.id });
    const twinB = await insertGym({ ownerId: OTHER, name: 'Cycle B', deleted: true, mergedIntoGymId: twinA.id });
    await db.execute(sql`UPDATE gyms SET merged_into_gym_id = ${twinB.id} WHERE id = ${target.id}`);
    const board = await insertBoard({ ownerId: OTHER, name: 'On The Cycle', gymId: twinB.id });

    const results = await strayBoardsForGym(target.uuid, authCtx(OWNER));

    expect(results.some((candidate) => candidate.uuid === board.uuid)).toBe(true);
  });
});

describe('strayBoardsForGym — nearby candidates', () => {
  it('surfaces an unlinked board within 150 m and excludes one 300 m away', async () => {
    const target = await seedTargetGym();
    const near = await insertBoard({
      ownerId: OWNER,
      name: 'Wall Next Door',
      latitude: LAT_60M,
      longitude: BASE.longitude,
    });
    const far = await insertBoard({
      ownerId: OTHER,
      name: 'Across The Street',
      latitude: LAT_300M,
      longitude: BASE.longitude,
    });

    const results = await strayBoardsForGym(target.uuid, authCtx(OWNER));

    const nearStray = results.find((candidate) => candidate.uuid === near.uuid);
    expect(nearStray?.reason).toBe('NEARBY');
    expect(nearStray?.distanceMeters).toBeGreaterThan(0);
    expect(nearStray?.distanceMeters).toBeLessThanOrEqual(150);
    expect(nearStray?.currentGymUuid).toBeNull();
    expect(results.some((candidate) => candidate.uuid === far.uuid)).toBe(false);
  });

  it('surfaces a board linked to a SYSTEM listing at the same spot', async () => {
    const target = await seedTargetGym();
    const systemGym = await insertGym({
      ownerId: SYSTEM_OWNER,
      name: 'Boulder Base (synced)',
      latitude: LAT_60M,
      longitude: BASE.longitude,
    });
    const board = await insertBoard({
      ownerId: SYSTEM_OWNER,
      name: 'Synced Kilter',
      gymId: systemGym.id,
      latitude: LAT_60M,
      longitude: BASE.longitude,
    });

    const results = await strayBoardsForGym(target.uuid, authCtx(OWNER));

    const stray = results.find((candidate) => candidate.uuid === board.uuid);
    expect(stray?.reason).toBe('NEARBY');
    expect(stray?.currentGymUuid).toBe(systemGym.uuid);
  });

  it("does not surface a stranger's board — public or private — or a hide-location board", async () => {
    const target = await seedTargetGym();
    // A stranger's PUBLIC board is the hijack vector: if surfaced and attached,
    // the gym owner would gain edit rights over it via requireBoardEditAccess.
    // Public does not make a third party's board safe to capture.
    const publicWall = await insertBoard({
      ownerId: OTHER,
      name: 'Public Home Wall',
      latitude: LAT_60M,
      longitude: BASE.longitude,
      isPublic: true,
    });
    const privateWall = await insertBoard({
      ownerId: OTHER,
      name: 'Private Home Wall',
      latitude: LAT_60M,
      longitude: BASE.longitude,
      isPublic: false,
    });
    const hidden = await insertBoard({
      ownerId: OTHER,
      name: 'Hidden Location Wall',
      latitude: LAT_120M,
      longitude: BASE.longitude,
      isPublic: true,
      hideLocation: true,
    });

    const results = await strayBoardsForGym(target.uuid, authCtx(OWNER));

    expect(results.some((candidate) => candidate.uuid === publicWall.uuid)).toBe(false);
    expect(results.some((candidate) => candidate.uuid === privateWall.uuid)).toBe(false);
    expect(results.some((candidate) => candidate.uuid === hidden.uuid)).toBe(false);
  });

  it("refuses to attach a stranger's nearby public board", async () => {
    const target = await seedTargetGym();
    const strangerPublic = await insertBoard({
      ownerId: OTHER,
      name: 'Public Home Wall',
      latitude: LAT_60M,
      longitude: BASE.longitude,
      isPublic: true,
    });

    await expect(
      attachBoardToGym({ gymUuid: target.uuid, boardUuid: strangerPublic.uuid }, authCtx(OWNER)),
    ).rejects.toThrow();
    expect(await boardGymId(strangerPublic.uuid)).toBeNull();
  });
});

describe('strayBoardsForGym — exclusions', () => {
  it('never returns a board already linked to this gym', async () => {
    const target = await seedTargetGym();
    const alreadyLinked = await insertBoard({
      ownerId: OWNER,
      name: 'Already Home',
      gymId: target.id,
      latitude: LAT_60M,
      longitude: BASE.longitude,
    });

    const results = await strayBoardsForGym(target.uuid, authCtx(OWNER));

    expect(results.some((candidate) => candidate.uuid === alreadyLinked.uuid)).toBe(false);
  });
});

describe('strayBoardsForGym — access guard', () => {
  it('rejects an anonymous caller', async () => {
    const target = await seedTargetGym();
    await expect(strayBoardsForGym(target.uuid, anonCtx())).rejects.toThrow();
  });

  it('rejects a caller without edit access to the gym', async () => {
    const target = await seedTargetGym();
    await expect(strayBoardsForGym(target.uuid, authCtx(OTHER))).rejects.toThrow();
  });

  it('allows a gym editor member', async () => {
    const target = await seedTargetGym();
    await insertGymMember(target.id, OTHER, 'editor');
    await insertBoard({ ownerId: OTHER, name: 'Editor Sees Me', latitude: LAT_60M, longitude: BASE.longitude });

    const results = await strayBoardsForGym(target.uuid, authCtx(OTHER));
    expect(results.length).toBeGreaterThan(0);
  });
});

describe('attachBoardToGym', () => {
  it('re-points a nearby stray board to the gym', async () => {
    const target = await seedTargetGym();
    const board = await insertBoard({
      ownerId: SYSTEM_OWNER,
      name: 'Wall Next Door',
      latitude: LAT_60M,
      longitude: BASE.longitude,
    });

    const ok = await attachBoardToGym({ gymUuid: target.uuid, boardUuid: board.uuid }, authCtx(OWNER));

    expect(ok).toBe(true);
    expect(await boardGymId(board.uuid)).toBe(target.id);
  });

  it('re-points a merged-twin board even though the caller does not own it', async () => {
    const target = await seedTargetGym();
    const twin = await insertGym({ ownerId: OTHER, name: 'Old Base', deleted: true, mergedIntoGymId: target.id });
    const board = await insertBoard({ ownerId: OTHER, name: 'Leftover Wall', gymId: twin.id });

    const ok = await attachBoardToGym({ gymUuid: target.uuid, boardUuid: board.uuid }, authCtx(OWNER));

    expect(ok).toBe(true);
    expect(await boardGymId(board.uuid)).toBe(target.id);
  });

  it('refuses a board that is not a stray candidate for this gym', async () => {
    const target = await seedTargetGym();
    const far = await insertBoard({
      ownerId: OTHER,
      name: 'Across The Street',
      latitude: LAT_300M,
      longitude: BASE.longitude,
    });

    await expect(attachBoardToGym({ gymUuid: target.uuid, boardUuid: far.uuid }, authCtx(OWNER))).rejects.toThrow();
    expect(await boardGymId(far.uuid)).toBeNull();
  });

  it('rejects a caller without edit access to the gym', async () => {
    const target = await seedTargetGym();
    const board = await insertBoard({
      ownerId: OTHER,
      name: 'Wall Next Door',
      latitude: LAT_60M,
      longitude: BASE.longitude,
    });

    await expect(attachBoardToGym({ gymUuid: target.uuid, boardUuid: board.uuid }, authCtx(OTHER))).rejects.toThrow();
    expect(await boardGymId(board.uuid)).toBeNull();
  });
});
