import { describe, it, expect, beforeEach } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { socialGymMutations } from '../graphql/resolvers/social/gyms';
import { socialGymStrayBoardMutations } from '../graphql/resolvers/social/gym-stray-boards';
import { resetAllRateLimits } from '../utils/rate-limiter';

/**
 * The self-service half of `requireBoardGymLinkAccess` (#4166): a climber can
 * list their own board at the gym they actually climb at, without being staff
 * there. Before this, `linkBoardToGym` was owner/admin-only, which made the main
 * use case — "there's a MoonBoard at this gym someone else listed" — impossible.
 *
 * Proximity is friction, not a security boundary (board coordinates come from
 * the caller), so the tests below pin the things that actually bound it: public
 * gyms only, own boards only, a per-caller cap, and a gym-side detach.
 */

const OWNER = 'self-link-owner';
const STRANGER = 'self-link-stranger';
const ALL_USERS = [OWNER, STRANGER];

const BASE = { latitude: 47.0, longitude: 8.0 };
const LAT_60M = 47.0 + 0.00054; // ~60 m — inside the 150 m radius
const LAT_300M = 47.0 + 0.0027; // ~301 m — outside it

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
  ownerId: string;
  name: string;
  latitude?: number | null;
  longitude?: number | null;
  isPublic?: boolean;
}): Promise<{ id: number; uuid: string }> => {
  const { ownerId, name, latitude = null, longitude = null, isPublic = true } = opts;
  const uuid = uuidv4();
  const result = await db.execute(sql`
    INSERT INTO gyms (uuid, name, slug, owner_id, is_public, latitude, longitude, created_at, updated_at)
    VALUES (${uuid}, ${name}, ${uuid}, ${ownerId}, ${isPublic}, ${latitude}, ${longitude}, now(), now())
    RETURNING id
  `);
  return { id: Number(Array.from(result as Iterable<{ id: number }>)[0].id), uuid };
};

let boardConfigCounter = 0;
const insertBoard = async (opts: {
  ownerId: string;
  latitude?: number | null;
  longitude?: number | null;
  gymId?: number | null;
}): Promise<string> => {
  const { ownerId, latitude = null, longitude = null, gymId = null } = opts;
  const uuid = uuidv4();
  await db.execute(sql`
    INSERT INTO user_boards
      (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, is_public, latitude, longitude, gym_id, created_at, updated_at)
    VALUES (${uuid}, ${uuid}, ${ownerId}, 'kilter', 1, ${700 + boardConfigCounter++}, '1,2', 'A board', true,
            ${latitude}, ${longitude}, ${gymId}, now(), now())
  `);
  return uuid;
};

const gymIdOfBoard = async (uuid: string): Promise<number | null> => {
  const result = await db.execute(sql`SELECT gym_id FROM user_boards WHERE uuid = ${uuid}`);
  const value = Array.from(result as Iterable<{ gym_id: number | string | null }>)[0]?.gym_id;
  return value == null ? null : Number(value);
};

const linkBoardToGym = (boardUuid: string, gymUuid: string | null, userId: string) =>
  socialGymMutations.linkBoardToGym(null, { input: { boardUuid, gymUuid } }, authCtx(userId)) as Promise<boolean>;

beforeEach(async () => {
  resetAllRateLimits();
  await db.execute(sql`
    TRUNCATE TABLE "community_roles", "gym_members", "gym_follows", "user_boards", "gyms"
    RESTART IDENTITY CASCADE
  `);
  await Promise.all(ALL_USERS.map(insertUser));
});

describe('linkBoardToGym — self-service proximity path', () => {
  it("links your own board to a stranger's public gym 60 m away", async () => {
    const gym = await insertGym({ ownerId: STRANGER, name: 'Klimmuur', ...BASE });
    const boardUuid = await insertBoard({ ownerId: OWNER, latitude: LAT_60M, longitude: BASE.longitude });

    await expect(linkBoardToGym(boardUuid, gym.uuid, OWNER)).resolves.toBe(true);
    expect(await gymIdOfBoard(boardUuid)).toBe(gym.id);
  });

  it('refuses when the board is 300 m away', async () => {
    const gym = await insertGym({ ownerId: STRANGER, name: 'Klimmuur', ...BASE });
    const boardUuid = await insertBoard({ ownerId: OWNER, latitude: LAT_300M, longitude: BASE.longitude });

    await expect(linkBoardToGym(boardUuid, gym.uuid, OWNER)).rejects.toThrow(/Not authorized to link board/);
    expect(await gymIdOfBoard(boardUuid)).toBeNull();
  });

  it('refuses when the board has no coordinates to check', async () => {
    const gym = await insertGym({ ownerId: STRANGER, name: 'Klimmuur', ...BASE });
    const boardUuid = await insertBoard({ ownerId: OWNER });

    await expect(linkBoardToGym(boardUuid, gym.uuid, OWNER)).rejects.toThrow(/Not authorized to link board/);
  });

  it("hides a stranger's PRIVATE gym behind 'Gym not found'", async () => {
    // Must be indistinguishable from a gym that doesn't exist, or this becomes a
    // probe for private home-wall gyms.
    const gym = await insertGym({ ownerId: STRANGER, name: 'Secret Home Wall', ...BASE, isPublic: false });
    const boardUuid = await insertBoard({ ownerId: OWNER, latitude: LAT_60M, longitude: BASE.longitude });

    await expect(linkBoardToGym(boardUuid, gym.uuid, OWNER)).rejects.toThrow(/Gym not found/);
  });

  it("refuses to move somebody else's board, however close it is", async () => {
    const gym = await insertGym({ ownerId: STRANGER, name: 'Klimmuur', ...BASE });
    const strangersBoard = await insertBoard({ ownerId: STRANGER, latitude: LAT_60M, longitude: BASE.longitude });

    await expect(linkBoardToGym(strangersBoard, gym.uuid, OWNER)).rejects.toThrow(
      /Not authorized to modify this board/,
    );
  });

  it('still lets a gym owner link with no coordinates anywhere (no regression)', async () => {
    const gym = await insertGym({ ownerId: OWNER, name: 'My Gym' });
    const boardUuid = await insertBoard({ ownerId: OWNER });

    await expect(linkBoardToGym(boardUuid, gym.uuid, OWNER)).resolves.toBe(true);
    expect(await gymIdOfBoard(boardUuid)).toBe(gym.id);
  });

  it('counts DISTINCT foreign gyms, so several boards at one gym cost one slot', async () => {
    const gym = await insertGym({ ownerId: STRANGER, name: 'Klimmuur', ...BASE });
    for (let index = 0; index < 3; index++) {
      const boardUuid = await insertBoard({ ownerId: OWNER, latitude: LAT_60M, longitude: BASE.longitude });
      await expect(linkBoardToGym(boardUuid, gym.uuid, OWNER)).resolves.toBe(true);
    }
    // A fourth board at the SAME gym is still fine — the cap is per gym.
    const fourth = await insertBoard({ ownerId: OWNER, latitude: LAT_60M, longitude: BASE.longitude });
    await expect(linkBoardToGym(fourth, gym.uuid, OWNER)).resolves.toBe(true);
  });

  it('unlinking stays the board owner’s own call and needs no proximity', async () => {
    const gym = await insertGym({ ownerId: STRANGER, name: 'Klimmuur', ...BASE });
    const boardUuid = await insertBoard({ ownerId: OWNER, latitude: LAT_60M, longitude: BASE.longitude });
    await linkBoardToGym(boardUuid, gym.uuid, OWNER);

    await expect(linkBoardToGym(boardUuid, null, OWNER)).resolves.toBe(true);
    expect(await gymIdOfBoard(boardUuid)).toBeNull();
  });
});

describe('detachBoardFromGym', () => {
  const detach = (gymUuid: string, boardUuid: string, userId: string) =>
    socialGymStrayBoardMutations.detachBoardFromGym(
      null,
      { input: { gymUuid, boardUuid } },
      authCtx(userId),
    ) as Promise<boolean>;

  it('lets gym staff remove a board someone self-linked', async () => {
    // The counterbalance to the proximity path: without this, a gym had no way
    // to undo an unwanted link (only deleteGym cleared gym_id).
    const gym = await insertGym({ ownerId: STRANGER, name: 'Klimmuur', ...BASE });
    const boardUuid = await insertBoard({ ownerId: OWNER, latitude: LAT_60M, longitude: BASE.longitude });
    await linkBoardToGym(boardUuid, gym.uuid, OWNER);

    await expect(detach(gym.uuid, boardUuid, STRANGER)).resolves.toBe(true);
    expect(await gymIdOfBoard(boardUuid)).toBeNull();
  });

  it('refuses a caller with no edit access to the gym', async () => {
    const gym = await insertGym({ ownerId: STRANGER, name: 'Klimmuur', ...BASE });
    const boardUuid = await insertBoard({ ownerId: OWNER, latitude: LAT_60M, longitude: BASE.longitude });
    await linkBoardToGym(boardUuid, gym.uuid, OWNER);

    await expect(detach(gym.uuid, boardUuid, OWNER)).rejects.toThrow(/Not authorized to edit this gym/);
    expect(await gymIdOfBoard(boardUuid)).toBe(gym.id);
  });

  it('refuses a board that is not listed at this gym', async () => {
    const gym = await insertGym({ ownerId: STRANGER, name: 'Klimmuur', ...BASE });
    const unlinked = await insertBoard({ ownerId: OWNER });

    await expect(detach(gym.uuid, unlinked, STRANGER)).rejects.toThrow(/not listed at this gym/);
  });
});
