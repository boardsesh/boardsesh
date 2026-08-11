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

const insertGymClaim = (gymId: number, claimantUserId: string, status: string) =>
  db.execute(sql`
    INSERT INTO gym_claims (gym_id, claimant_user_id, method, status, created_at, updated_at)
    VALUES (${gymId}, ${claimantUserId}, 'admin', ${status}, now(), now())
  `);

const insertGymKiosk = (gymId: number, slug: string) =>
  db.execute(sql`
    INSERT INTO gym_kiosks (uuid, gym_id, slug, name, created_at, updated_at)
    VALUES (${uuidv4()}, ${gymId}, ${slug}, ${'Kiosk ' + slug}, now(), now())
  `);

const insertGymSourceAlias = (gymId: number, sourceKey: string) =>
  db.execute(sql`
    INSERT INTO location_sync_gym_sources (source_key, gym_id, created_at, updated_at)
    VALUES (${sourceKey}, ${gymId}, now(), now())
  `);

const boardGymId = async (boardUuid: string): Promise<number | null> => {
  const result = await db.execute(sql`SELECT gym_id FROM user_boards WHERE uuid = ${boardUuid}`);
  const row = Array.from(result as Iterable<{ gym_id: number | null }>)[0];
  return row?.gym_id != null ? Number(row.gym_id) : null;
};

const boardSyncFrozen = async (boardUuid: string): Promise<boolean> => {
  const result = await db.execute(sql`SELECT sync_frozen_at FROM user_boards WHERE uuid = ${boardUuid}`);
  const row = Array.from(result as Iterable<{ sync_frozen_at: Date | null }>)[0];
  return row?.sync_frozen_at != null;
};

type GymRetireState = { deletedAt: Date | null; isPublic: boolean; mergedIntoGymId: number | null };

const gymRetireState = async (gymId: number): Promise<GymRetireState> => {
  const result = await db.execute(sql`
    SELECT deleted_at, is_public, merged_into_gym_id FROM gyms WHERE id = ${gymId}
  `);
  const row = Array.from(
    result as Iterable<{ deleted_at: Date | null; is_public: boolean; merged_into_gym_id: number | null }>,
  )[0];
  return {
    deletedAt: row.deleted_at,
    isPublic: row.is_public,
    mergedIntoGymId: row.merged_into_gym_id != null ? Number(row.merged_into_gym_id) : null,
  };
};

const sourceAliasGymId = async (sourceKey: string): Promise<number | null> => {
  const result = await db.execute(sql`SELECT gym_id FROM location_sync_gym_sources WHERE source_key = ${sourceKey}`);
  const row = Array.from(result as Iterable<{ gym_id: number | null }>)[0];
  return row?.gym_id != null ? Number(row.gym_id) : null;
};

const mergeAuditRows = async (duplicateGymId: number) => {
  const result = await db.execute(sql`
    SELECT canonical_gym_id, duplicate_gym_id, action, performed_by
      FROM gym_merge_audit
     WHERE duplicate_gym_id = ${duplicateGymId}
  `);
  return Array.from(
    result as Iterable<{
      canonical_gym_id: number | null;
      action: string;
      performed_by: string | null;
    }>,
  );
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

  it('freezes the attached board so the next location sync cannot re-point it', async () => {
    const target = await seedTargetGym();
    const board = await insertBoard({
      ownerId: SYSTEM_OWNER,
      name: 'Synced Kilter',
      latitude: LAT_60M,
      longitude: BASE.longitude,
    });

    await attachBoardToGym({ gymUuid: target.uuid, boardUuid: board.uuid }, authCtx(OWNER));

    expect(await boardSyncFrozen(board.uuid)).toBe(true);
  });
});

// ============================================
// #4188: the listing an attach empties
// ============================================

describe('attachBoardToGym — retiring the emptied source listing', () => {
  /** A SYSTEM listing at the same spot as the target gym, holding `boardCount` synced boards. */
  const seedSyncedListing = async (boardCount: number, name = 'Boulder Base (synced)') => {
    const listing = await insertGym({
      ownerId: SYSTEM_OWNER,
      name,
      latitude: LAT_60M,
      longitude: BASE.longitude,
    });
    const boards = [];
    for (let index = 0; index < boardCount; index++) {
      boards.push(
        await insertBoard({
          ownerId: SYSTEM_OWNER,
          name: `${name} wall ${index + 1}`,
          gymId: listing.id,
          latitude: LAT_60M,
          longitude: BASE.longitude,
        }),
      );
    }
    return { listing, boards };
  };

  it('folds the emptied listing into the target gym instead of leaving it live and empty', async () => {
    const target = await seedTargetGym();
    const { listing, boards } = await seedSyncedListing(1);

    await attachBoardToGym({ gymUuid: target.uuid, boardUuid: boards[0].uuid }, authCtx(OWNER));

    const state = await gymRetireState(listing.id);
    expect(state.deletedAt).not.toBeNull();
    expect(state.isPublic).toBe(false);
    expect(state.mergedIntoGymId).toBe(target.id);
  });

  it('writes a merge-audit row naming the attaching user so an admin can reverse it', async () => {
    const target = await seedTargetGym();
    const { listing, boards } = await seedSyncedListing(1);

    await attachBoardToGym({ gymUuid: target.uuid, boardUuid: boards[0].uuid }, authCtx(OWNER));

    const auditRows = await mergeAuditRows(listing.id);
    expect(auditRows.length).toBe(1);
    expect(auditRows[0].action).toBe('merged');
    expect(Number(auditRows[0].canonical_gym_id)).toBe(target.id);
    expect(auditRows[0].performed_by).toBe(OWNER);
  });

  it("moves the listing's location-sync alias to the target so the sync can't re-mint it", async () => {
    const target = await seedTargetGym();
    const { listing, boards } = await seedSyncedListing(1);
    await insertGymSourceAlias(listing.id, 'kilter:gym-4188');

    await attachBoardToGym({ gymUuid: target.uuid, boardUuid: boards[0].uuid }, authCtx(OWNER));

    expect(await sourceAliasGymId('kilter:gym-4188')).toBe(target.id);
  });

  it('leaves the source listing live when it still has another board', async () => {
    const target = await seedTargetGym();
    const { listing, boards } = await seedSyncedListing(2);

    await attachBoardToGym({ gymUuid: target.uuid, boardUuid: boards[0].uuid }, authCtx(OWNER));

    const state = await gymRetireState(listing.id);
    expect(state.deletedAt).toBeNull();
    expect(state.isPublic).toBe(true);
    expect(state.mergedIntoGymId).toBeNull();
    expect(await mergeAuditRows(listing.id)).toEqual([]);
  });

  it('does not retire a listing with a pending claim', async () => {
    const target = await seedTargetGym();
    const { listing, boards } = await seedSyncedListing(1);
    await insertGymClaim(listing.id, OTHER, 'pending');

    await attachBoardToGym({ gymUuid: target.uuid, boardUuid: boards[0].uuid }, authCtx(OWNER));

    expect((await gymRetireState(listing.id)).deletedAt).toBeNull();
    expect(await boardGymId(boards[0].uuid)).toBe(target.id);
  });

  it('does not retire a listing with an approved claim', async () => {
    const target = await seedTargetGym();
    const { listing, boards } = await seedSyncedListing(1);
    await insertGymClaim(listing.id, OTHER, 'approved');

    await attachBoardToGym({ gymUuid: target.uuid, boardUuid: boards[0].uuid }, authCtx(OWNER));

    expect((await gymRetireState(listing.id)).deletedAt).toBeNull();
  });

  it('does not retire a listing that has staff on it', async () => {
    const target = await seedTargetGym();
    const { listing, boards } = await seedSyncedListing(1);
    await insertGymMember(listing.id, OTHER, 'editor');

    await attachBoardToGym({ gymUuid: target.uuid, boardUuid: boards[0].uuid }, authCtx(OWNER));

    expect((await gymRetireState(listing.id)).deletedAt).toBeNull();
  });

  it('does not retire a listing with a live kiosk', async () => {
    const target = await seedTargetGym();
    const { listing, boards } = await seedSyncedListing(1);
    await insertGymKiosk(listing.id, 'front-desk');

    await attachBoardToGym({ gymUuid: target.uuid, boardUuid: boards[0].uuid }, authCtx(OWNER));

    expect((await gymRetireState(listing.id)).deletedAt).toBeNull();
  });

  it('leaves an already-merged twin listing untouched — it is not a second merge', async () => {
    const target = await seedTargetGym();
    const twin = await insertGym({
      ownerId: OTHER,
      name: 'Someone Else Gym',
      latitude: LAT_60M,
      longitude: BASE.longitude,
      mergedIntoGymId: target.id,
    });
    const board = await insertBoard({ ownerId: OTHER, name: 'Leftover Wall', gymId: twin.id });

    await attachBoardToGym({ gymUuid: target.uuid, boardUuid: board.uuid }, authCtx(OWNER));

    const state = await gymRetireState(twin.id);
    expect(state.deletedAt).toBeNull();
    expect(state.mergedIntoGymId).toBe(target.id); // the pre-existing pointer, not a fresh fold
    expect(await mergeAuditRows(twin.id)).toEqual([]);
  });

  it('retires nothing when the target gym is itself a synced listing', async () => {
    // An editor member can manage a SYSTEM gym, but folding one synced listing
    // into another is not this feature's job.
    const syncedTarget = await insertGym({
      ownerId: SYSTEM_OWNER,
      name: 'Synced Target',
      latitude: BASE.latitude,
      longitude: BASE.longitude,
    });
    await insertGymMember(syncedTarget.id, OWNER, 'editor');
    const { listing, boards } = await seedSyncedListing(1);

    await attachBoardToGym({ gymUuid: syncedTarget.uuid, boardUuid: boards[0].uuid }, authCtx(OWNER));

    expect(await boardGymId(boards[0].uuid)).toBe(syncedTarget.id);
    expect((await gymRetireState(listing.id)).deletedAt).toBeNull();
    expect(await mergeAuditRows(listing.id)).toEqual([]);
  });

  it('retires nothing when the attached board was unlinked', async () => {
    const target = await seedTargetGym();
    const board = await insertBoard({
      ownerId: SYSTEM_OWNER,
      name: 'Loose Wall',
      latitude: LAT_60M,
      longitude: BASE.longitude,
    });

    const ok = await attachBoardToGym({ gymUuid: target.uuid, boardUuid: board.uuid }, authCtx(OWNER));

    expect(ok).toBe(true);
    expect(await boardGymId(board.uuid)).toBe(target.id);
    expect((await gymRetireState(target.id)).deletedAt).toBeNull();
  });
});

describe('strayBoardsForGym — isLastBoardAtCurrentGym', () => {
  it('flags the sole board on a listing, and not a board that has company', async () => {
    const target = await seedTargetGym();
    const soleListing = await insertGym({
      ownerId: SYSTEM_OWNER,
      name: 'One Wall Spot',
      latitude: LAT_60M,
      longitude: BASE.longitude,
    });
    const soleBoard = await insertBoard({
      ownerId: SYSTEM_OWNER,
      name: 'Only Wall',
      gymId: soleListing.id,
      latitude: LAT_60M,
      longitude: BASE.longitude,
    });
    const busyListing = await insertGym({
      ownerId: SYSTEM_OWNER,
      name: 'Two Wall Spot',
      latitude: LAT_120M,
      longitude: BASE.longitude,
    });
    const busyBoard = await insertBoard({
      ownerId: SYSTEM_OWNER,
      name: 'First Of Two',
      gymId: busyListing.id,
      latitude: LAT_120M,
      longitude: BASE.longitude,
    });
    await insertBoard({
      ownerId: SYSTEM_OWNER,
      name: 'Second Of Two',
      gymId: busyListing.id,
      latitude: LAT_120M,
      longitude: BASE.longitude,
    });

    const results = await strayBoardsForGym(target.uuid, authCtx(OWNER));

    expect(results.find((candidate) => candidate.uuid === soleBoard.uuid)?.isLastBoardAtCurrentGym).toBe(true);
    expect(results.find((candidate) => candidate.uuid === busyBoard.uuid)?.isLastBoardAtCurrentGym).toBe(false);
  });

  it('never flags an unlinked board', async () => {
    const target = await seedTargetGym();
    const loose = await insertBoard({
      ownerId: SYSTEM_OWNER,
      name: 'Loose Wall',
      latitude: LAT_60M,
      longitude: BASE.longitude,
    });

    const results = await strayBoardsForGym(target.uuid, authCtx(OWNER));

    expect(results.find((candidate) => candidate.uuid === loose.uuid)?.isLastBoardAtCurrentGym).toBe(false);
  });
});
