import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { socialBoardQueries, socialBoardMutations } from '../graphql/resolvers/social/boards';
import { socialGymQueries, socialGymMutations } from '../graphql/resolvers/social/gyms';
import { seedAuroraCatalogFixtures } from './helpers/board-catalog-fixture';

/**
 * Real-DB coverage for the moderator board/gym editing authorization
 * (issue: let community admins & leaders fix outdated catalog boards/gyms).
 *
 * The board/gym/role records that need fixing are owned by a system/import user,
 * so the authorization under test is: owner OR community admin/leader scoped to
 * the board type OR the linked gym's owner/admin may edit; a wrong-board-type
 * leader and a plain user may not. enrichBoard/enrichGym must surface the same
 * decision as `canEdit`.
 *
 * Mirrors session-feed-board-scope-integration.test.ts: inserts via raw SQL,
 * calls the resolvers directly against the per-worker test DB.
 */

const SYS_OWNER = 'bg-auth-sys-owner';
const GLOBAL_ADMIN = 'bg-auth-global-admin';
const KILTER_LEADER = 'bg-auth-kilter-leader';
const MOON_LEADER = 'bg-auth-moon-leader';
const GLOBAL_LEADER = 'bg-auth-global-leader';
const PLAIN_USER = 'bg-auth-plain-user';
const GYM_ADMIN_MEMBER = 'bg-auth-gym-admin';
const CLIMBER = 'bg-auth-climber';

const ALL_USERS = [SYS_OWNER, GLOBAL_ADMIN, KILTER_LEADER, MOON_LEADER, GLOBAL_LEADER, PLAIN_USER, GYM_ADMIN_MEMBER];

const authCtx = (userId: string): ConnectionContext =>
  ({ connectionId: `conn-${userId}`, isAuthenticated: true, userId }) as ConnectionContext;

const anonCtx = (): ConnectionContext => ({ connectionId: 'conn-anon', isAuthenticated: false }) as ConnectionContext;

const insertUser = (id: string) =>
  db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'User ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);

const insertRole = (userId: string, role: string, boardType: string | null) =>
  db.execute(sql`
    INSERT INTO community_roles (user_id, role, board_type, created_at)
    VALUES (${userId}, ${role}, ${boardType}, now())
  `);

const insertGym = async (uuid: string, ownerId: string, name: string): Promise<number> => {
  const result = await db.execute(sql`
    INSERT INTO gyms (uuid, name, slug, owner_id, is_public, created_at, updated_at)
    VALUES (${uuid}, ${name}, ${uuid}, ${ownerId}, true, now(), now())
    RETURNING id
  `);
  return Number(Array.from(result as Iterable<{ id: number }>)[0].id);
};

const insertBoard = async (opts: {
  uuid: string;
  ownerId: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  gymId?: number | null;
  boardType?: string;
  name?: string;
  isPublic?: boolean;
}): Promise<number> => {
  const {
    uuid,
    ownerId,
    layoutId,
    sizeId,
    setIds,
    gymId = null,
    boardType = 'kilter',
    name = 'Board',
    isPublic = true,
  } = opts;
  const result = await db.execute(sql`
    INSERT INTO user_boards
      (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, gym_id, is_public, created_at, updated_at)
    VALUES (${uuid}, ${uuid}, ${ownerId}, ${boardType}, ${layoutId}, ${sizeId}, ${setIds}, ${name}, ${gymId}, ${isPublic}, now(), now())
    RETURNING id
  `);
  return Number(Array.from(result as Iterable<{ id: number }>)[0].id);
};

const insertTick = (uuid: string, boardId: number, status: 'send' | 'flash' | 'attempt') =>
  db.execute(sql`
    INSERT INTO boardsesh_ticks
      (uuid, user_id, board_type, board_id, climb_uuid, angle, status, attempt_count, difficulty, climbed_at)
    VALUES (${uuid}, ${CLIMBER}, 'kilter', ${boardId}, 'bg-auth-climb', 40, ${status}, 1, 20, now())
  `);

type TickRow = {
  uuid: string;
  board_id: number;
  status: string;
  climb_uuid: string;
  angle: number;
  difficulty: number | null;
};

const ticksForBoard = async (boardId: number): Promise<TickRow[]> => {
  const result = await db.execute(sql`
    SELECT uuid, board_id, status, climb_uuid, angle, difficulty
    FROM boardsesh_ticks
    WHERE board_id = ${boardId}
    ORDER BY uuid
  `);
  return Array.from(result as Iterable<TickRow>).map((row) => ({
    uuid: row.uuid,
    board_id: Number(row.board_id),
    status: row.status,
    climb_uuid: row.climb_uuid,
    angle: Number(row.angle),
    difficulty: row.difficulty == null ? null : Number(row.difficulty),
  }));
};

const boardConfig = async (uuid: string) => {
  const result = await db.execute(sql`
    SELECT layout_id, size_id, set_ids, name FROM user_boards WHERE uuid = ${uuid}
  `);
  const row = Array.from(result as Iterable<{ layout_id: number; size_id: number; set_ids: string; name: string }>)[0];
  return { layoutId: Number(row.layout_id), sizeId: Number(row.size_id), setIds: row.set_ids, name: row.name };
};

let kilterGymUuid: string;
let kilterGymId: number;
let kilterBoardUuid: string;
let kilterBoardId: number;

let cleanupBoardEditCatalogFixtures: () => Promise<void> = async () => {};

beforeAll(async () => {
  cleanupBoardEditCatalogFixtures = await seedAuroraCatalogFixtures([
    {
      boardType: 'kilter',
      productId: 2_100_412_920,
      layoutId: 2,
      sizeId: 11,
      setIds: [3, 4],
      associationIdBase: 2_100_413_200,
    },
    {
      boardType: 'kilter',
      productId: 2_100_412_920,
      layoutId: 9,
      sizeId: 9,
      setIds: [9],
      associationIdBase: 2_100_413_210,
    },
  ]);
});

afterAll(async () => {
  await cleanupBoardEditCatalogFixtures();
});

beforeEach(async () => {
  // Reset only the tables this suite owns; CASCADE clears their FK dependents.
  // `users` is left intact and re-seeded idempotently to avoid a wide cascade.
  await db.execute(sql`
    TRUNCATE TABLE
      "community_roles", "gym_members", "gym_follows", "board_follows",
      "boardsesh_ticks", "user_boards", "gyms"
    RESTART IDENTITY CASCADE
  `);

  await Promise.all(ALL_USERS.map(insertUser));

  await Promise.all([
    insertRole(GLOBAL_ADMIN, 'admin', null),
    insertRole(KILTER_LEADER, 'community_leader', 'kilter'),
    insertRole(MOON_LEADER, 'community_leader', 'moonboard'),
    insertRole(GLOBAL_LEADER, 'community_leader', null),
  ]);

  kilterGymUuid = uuidv4();
  kilterGymId = await insertGym(kilterGymUuid, SYS_OWNER, 'Bonsist');

  kilterBoardUuid = uuidv4();
  kilterBoardId = await insertBoard({
    uuid: kilterBoardUuid,
    ownerId: SYS_OWNER,
    layoutId: 1,
    sizeId: 10,
    setIds: '1,2',
    gymId: kilterGymId,
    name: 'Bonsist Wall',
  });

  // A gym admin member (not the owner) — exercises the linked-gym edit path.
  await db.execute(sql`
    INSERT INTO gym_members (gym_id, user_id, role, created_at)
    VALUES (${kilterGymId}, ${GYM_ADMIN_MEMBER}, 'admin', now())
  `);
});

describe('updateBoard authorization for community moderators', () => {
  it('lets a global community admin update a board they do not own', async () => {
    const result = await socialBoardMutations.updateBoard(
      null,
      { input: { boardUuid: kilterBoardUuid, name: 'Bonsist 2019 Masters' } },
      authCtx(GLOBAL_ADMIN),
    );

    expect(result.name).toBe('Bonsist 2019 Masters');
    expect(result.ownerId).toBe(SYS_OWNER);
    expect((await boardConfig(kilterBoardUuid)).name).toBe('Bonsist 2019 Masters');
  });

  it('lets a board-type-scoped community_leader update a board they do not own', async () => {
    const result = await socialBoardMutations.updateBoard(
      null,
      { input: { boardUuid: kilterBoardUuid, angle: 40 } },
      authCtx(KILTER_LEADER),
    );

    expect(result.angle).toBe(40);
    expect(result.ownerId).toBe(SYS_OWNER);
  });

  it('lets the linked gym owner/admin member update the gym board', async () => {
    const result = await socialBoardMutations.updateBoard(
      null,
      { input: { boardUuid: kilterBoardUuid, name: 'Gym-admin edit' } },
      authCtx(GYM_ADMIN_MEMBER),
    );

    expect(result.name).toBe('Gym-admin edit');
  });

  it('rejects a community_leader scoped to the WRONG board type', async () => {
    await expect(
      socialBoardMutations.updateBoard(
        null,
        { input: { boardUuid: kilterBoardUuid, name: 'should fail' } },
        authCtx(MOON_LEADER),
      ),
    ).rejects.toThrow(/Not authorized to update this board/);

    // The board is untouched.
    expect((await boardConfig(kilterBoardUuid)).name).toBe('Bonsist Wall');
  });

  it('allows a GLOBAL community_leader (boardType null) on a kilter board', async () => {
    const result = await socialBoardMutations.updateBoard(
      null,
      { input: { boardUuid: kilterBoardUuid, name: 'Global leader edit' } },
      authCtx(GLOBAL_LEADER),
    );

    expect(result.name).toBe('Global leader edit');
  });

  it('rejects a logged-in user with no role and no ownership', async () => {
    await expect(
      socialBoardMutations.updateBoard(
        null,
        { input: { boardUuid: kilterBoardUuid, name: 'nope' } },
        authCtx(PLAIN_USER),
      ),
    ).rejects.toThrow(/Not authorized to update this board/);

    expect((await boardConfig(kilterBoardUuid)).name).toBe('Bonsist Wall');
  });
});

describe('updateBoard config change with existing ticks', () => {
  it('changes layout/size/set with ticks present and leaves the tick rows untouched', async () => {
    await Promise.all([
      insertTick('bg-auth-tick-1', kilterBoardId, 'send'),
      insertTick('bg-auth-tick-2', kilterBoardId, 'flash'),
      insertTick('bg-auth-tick-3', kilterBoardId, 'attempt'),
    ]);

    const before = await ticksForBoard(kilterBoardId);
    expect(before).toHaveLength(3);

    const result = await socialBoardMutations.updateBoard(
      null,
      { input: { boardUuid: kilterBoardUuid, layoutId: 2, sizeId: 11, setIds: '3,4' } },
      authCtx(GLOBAL_ADMIN),
    );

    // Config reflects the physical reconfiguration.
    expect(result.layoutId).toBe(2);
    expect(result.sizeId).toBe(11);
    expect(result.setIds).toBe('3,4');
    expect(await boardConfig(kilterBoardUuid)).toMatchObject({ layoutId: 2, sizeId: 11, setIds: '3,4' });

    // Old ticks are preserved verbatim — not deleted, moved, or re-pointed.
    const after = await ticksForBoard(kilterBoardId);
    expect(after).toHaveLength(3);
    expect(after).toEqual(before);
  });
});

describe('updateBoard duplicate-config uniqueness keys off the board owner', () => {
  it('blocks a config change that collides with another board owned by the BOARD OWNER', async () => {
    // The board's owner (SYS_OWNER) already has a second board with this config.
    await insertBoard({
      uuid: uuidv4(),
      ownerId: SYS_OWNER,
      layoutId: 2,
      sizeId: 11,
      setIds: '3,4',
      name: 'Owner second board',
    });

    await expect(
      socialBoardMutations.updateBoard(
        null,
        { input: { boardUuid: kilterBoardUuid, layoutId: 2, sizeId: 11, setIds: '3,4' } },
        authCtx(GLOBAL_ADMIN),
      ),
    ).rejects.toThrow(/already has a board with this configuration/);
  });

  it('does NOT block when only the editing admin owns a board with the target config', async () => {
    // The admin (caller) owns a board with the target config, but the board's
    // owner (SYS_OWNER) does not. Keying the check off the owner means the edit
    // must succeed — a caller-keyed check would have wrongly blocked it.
    await insertBoard({
      uuid: uuidv4(),
      ownerId: GLOBAL_ADMIN,
      layoutId: 9,
      sizeId: 9,
      setIds: '9,9',
      name: "Admin's own board",
    });

    const result = await socialBoardMutations.updateBoard(
      null,
      { input: { boardUuid: kilterBoardUuid, layoutId: 9, sizeId: 9, setIds: '9,9' } },
      authCtx(GLOBAL_ADMIN),
    );

    expect(result.layoutId).toBe(9);
    expect(result.sizeId).toBe(9);
    expect(result.setIds).toBe('9,9');
  });
});

describe('updateGym authorization for community moderators', () => {
  it('lets a global community admin update a gym they do not own', async () => {
    const result = await socialGymMutations.updateGym(
      null,
      { input: { gymUuid: kilterGymUuid, name: 'Bonsist (fixed)' } },
      authCtx(GLOBAL_ADMIN),
    );

    expect(result.name).toBe('Bonsist (fixed)');
    expect(result.ownerId).toBe(SYS_OWNER);
  });

  it('lets a board-type-scoped community_leader update a gym whose boards match', async () => {
    const result = await socialGymMutations.updateGym(
      null,
      { input: { gymUuid: kilterGymUuid, description: 'All holds, no neutral screw-ons' } },
      authCtx(KILTER_LEADER),
    );

    expect(result.description).toBe('All holds, no neutral screw-ons');
  });

  it('lets a GLOBAL community_leader (boardType null) update the gym', async () => {
    const result = await socialGymMutations.updateGym(
      null,
      { input: { gymUuid: kilterGymUuid, name: 'Global leader gym edit' } },
      authCtx(GLOBAL_LEADER),
    );

    expect(result.name).toBe('Global leader gym edit');
  });

  it('rejects a community_leader scoped to a board type the gym does not have', async () => {
    await expect(
      socialGymMutations.updateGym(
        null,
        { input: { gymUuid: kilterGymUuid, name: 'should fail' } },
        authCtx(MOON_LEADER),
      ),
    ).rejects.toThrow(/Not authorized to edit this gym/);
  });

  it('rejects a logged-in user with no role and no ownership', async () => {
    await expect(
      socialGymMutations.updateGym(null, { input: { gymUuid: kilterGymUuid, name: 'nope' } }, authCtx(PLAIN_USER)),
    ).rejects.toThrow(/Not authorized to edit this gym/);
  });
});

describe('enrichBoard canEdit', () => {
  const canEditBoard = async (ctx: ConnectionContext): Promise<boolean> => {
    const board = await socialBoardQueries.board(null, { boardUuid: kilterBoardUuid }, ctx);
    expect(board).not.toBeNull();
    return board!.canEdit;
  };

  it('is true for the owner', async () => {
    expect(await canEditBoard(authCtx(SYS_OWNER))).toBe(true);
  });

  it('is true for a matching-board-type community_leader and a global admin', async () => {
    expect(await canEditBoard(authCtx(KILTER_LEADER))).toBe(true);
    expect(await canEditBoard(authCtx(GLOBAL_ADMIN))).toBe(true);
  });

  it('is true for the linked gym admin member', async () => {
    expect(await canEditBoard(authCtx(GYM_ADMIN_MEMBER))).toBe(true);
  });

  it('is false for a wrong-board-type community_leader', async () => {
    expect(await canEditBoard(authCtx(MOON_LEADER))).toBe(false);
  });

  it('is false for a plain logged-in user', async () => {
    expect(await canEditBoard(authCtx(PLAIN_USER))).toBe(false);
  });

  it('is false for an anonymous viewer', async () => {
    expect(await canEditBoard(anonCtx())).toBe(false);
  });
});

describe('enrichGym canEdit', () => {
  const canEditGym = async (ctx: ConnectionContext): Promise<boolean> => {
    const gym = await socialGymQueries.gym(null, { gymUuid: kilterGymUuid }, ctx);
    expect(gym).not.toBeNull();
    return gym!.canEdit;
  };

  it('is true for the owner', async () => {
    expect(await canEditGym(authCtx(SYS_OWNER))).toBe(true);
  });

  it('is true for a matching-board-type community_leader and a global admin', async () => {
    expect(await canEditGym(authCtx(KILTER_LEADER))).toBe(true);
    expect(await canEditGym(authCtx(GLOBAL_ADMIN))).toBe(true);
  });

  it('is true for a gym admin member', async () => {
    expect(await canEditGym(authCtx(GYM_ADMIN_MEMBER))).toBe(true);
  });

  it('is false for a wrong-board-type community_leader', async () => {
    expect(await canEditGym(authCtx(MOON_LEADER))).toBe(false);
  });

  it('is false for a plain logged-in user', async () => {
    expect(await canEditGym(authCtx(PLAIN_USER))).toBe(false);
  });

  it('is false for an anonymous viewer', async () => {
    expect(await canEditGym(anonCtx())).toBe(false);
  });
});

describe('updateGym for a gym admin member', () => {
  it('lets a gym admin member (not owner, no community role) update the gym', async () => {
    const result = await socialGymMutations.updateGym(
      null,
      { input: { gymUuid: kilterGymUuid, name: 'Gym-admin gym edit' } },
      authCtx(GYM_ADMIN_MEMBER),
    );

    expect(result.name).toBe('Gym-admin gym edit');
  });
});

describe('gym membership management excludes community moderators (escalation guard)', () => {
  // editing a gym's details (updateGym) is open to community moderators, but
  // membership management (addGymMember/removeGymMember/linkBoardToGym) must NOT
  // be — otherwise a board-type-scoped role could self-promote to a persistent
  // gym admin that outlives the community role, or evict real gym admins.
  const gymMemberRole = async (userId: string): Promise<string | null> => {
    const result = await db.execute(sql`
      SELECT role FROM gym_members WHERE gym_id = ${kilterGymId} AND user_id = ${userId} LIMIT 1
    `);
    const row = Array.from(result as Iterable<{ role: string }>)[0];
    return row ? row.role : null;
  };

  it('rejects a community admin/leader adding a gym member (no self-promotion to gym admin)', async () => {
    await expect(
      socialGymMutations.addGymMember(
        null,
        { input: { gymUuid: kilterGymUuid, userId: GLOBAL_ADMIN, role: 'admin' } },
        authCtx(GLOBAL_ADMIN),
      ),
    ).rejects.toThrow(/Not authorized: must be gym owner or admin/);

    await expect(
      socialGymMutations.addGymMember(
        null,
        { input: { gymUuid: kilterGymUuid, userId: KILTER_LEADER, role: 'admin' } },
        authCtx(KILTER_LEADER),
      ),
    ).rejects.toThrow(/Not authorized: must be gym owner or admin/);

    // Neither moderator gained a persistent gym_members row.
    expect(await gymMemberRole(GLOBAL_ADMIN)).toBeNull();
    expect(await gymMemberRole(KILTER_LEADER)).toBeNull();
  });

  it('rejects a community moderator removing an existing gym admin', async () => {
    await expect(
      socialGymMutations.removeGymMember(
        null,
        { input: { gymUuid: kilterGymUuid, userId: GYM_ADMIN_MEMBER } },
        authCtx(GLOBAL_ADMIN),
      ),
    ).rejects.toThrow(/Not authorized: must be gym owner or admin/);

    // The gym admin member is still there.
    expect(await gymMemberRole(GYM_ADMIN_MEMBER)).toBe('admin');
  });

  it('still lets the gym owner and a gym admin member manage membership', async () => {
    await expect(
      socialGymMutations.addGymMember(
        null,
        { input: { gymUuid: kilterGymUuid, userId: PLAIN_USER, role: 'member' } },
        authCtx(SYS_OWNER),
      ),
    ).resolves.toBe(true);
    expect(await gymMemberRole(PLAIN_USER)).toBe('member');

    await expect(
      socialGymMutations.removeGymMember(
        null,
        { input: { gymUuid: kilterGymUuid, userId: PLAIN_USER } },
        authCtx(GYM_ADMIN_MEMBER),
      ),
    ).resolves.toBe(true);
    expect(await gymMemberRole(PLAIN_USER)).toBeNull();
  });
});

describe('gym admin edit access is revoked when the linked gym is soft-deleted', () => {
  // The board keeps its gym_id, but the gym is soft-deleted. A gym admin member
  // should lose the linked-gym edit path — a removed gym must not keep granting
  // edit rights on the boards that still point at it.
  beforeEach(async () => {
    await db.execute(sql`UPDATE gyms SET deleted_at = now() WHERE id = ${kilterGymId}`);
  });

  it('rejects a gym admin member updating a board linked to the deleted gym', async () => {
    await expect(
      socialBoardMutations.updateBoard(
        null,
        { input: { boardUuid: kilterBoardUuid, name: 'deleted-gym edit' } },
        authCtx(GYM_ADMIN_MEMBER),
      ),
    ).rejects.toThrow(/Not authorized to update this board/);

    expect((await boardConfig(kilterBoardUuid)).name).toBe('Bonsist Wall');
  });

  it('reports canEdit=false for a gym admin member of the deleted gym', async () => {
    const board = await socialBoardQueries.board(null, { boardUuid: kilterBoardUuid }, authCtx(GYM_ADMIN_MEMBER));
    expect(board?.canEdit).toBe(false);
  });
});

describe('gym admin member can edit a PRIVATE board linked to their gym', () => {
  // Linking a board to a gym requires the board's own owner (linkBoardToGym),
  // so this is opt-in: the owner deliberately connected their private board to
  // the gym, and gym admins manage the gym's physical boards. Unlike a community
  // role, the linked-gym path intentionally reaches private boards.
  let privateGymBoardUuid: string;

  beforeEach(async () => {
    privateGymBoardUuid = uuidv4();
    await insertBoard({
      uuid: privateGymBoardUuid,
      ownerId: SYS_OWNER,
      layoutId: 7,
      sizeId: 7,
      setIds: '7,8',
      gymId: kilterGymId,
      name: 'Private gym wall',
      isPublic: false,
    });
  });

  it('lets the gym admin member update the private linked board', async () => {
    const result = await socialBoardMutations.updateBoard(
      null,
      { input: { boardUuid: privateGymBoardUuid, name: 'Gym-admin private edit' } },
      authCtx(GYM_ADMIN_MEMBER),
    );

    expect(result.name).toBe('Gym-admin private edit');
    expect((await boardConfig(privateGymBoardUuid)).name).toBe('Gym-admin private edit');
  });

  it('reports canEdit=true for the gym admin member on the private linked board', async () => {
    const board = await socialBoardQueries.board(null, { boardUuid: privateGymBoardUuid }, authCtx(GYM_ADMIN_MEMBER));
    expect(board?.canEdit).toBe(true);
  });
});

describe('community roles reach public/catalog boards only, not private ones', () => {
  let privateBoardUuid: string;

  beforeEach(async () => {
    // A stranger's PRIVATE kilter board (owner PLAIN_USER, no linked gym).
    privateBoardUuid = uuidv4();
    await db.execute(sql`
      INSERT INTO user_boards
        (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, is_public, created_at, updated_at)
      VALUES (${privateBoardUuid}, ${privateBoardUuid}, ${PLAIN_USER}, 'kilter', 5, 5, '5,6', 'Private wall', false, now(), now())
    `);
  });

  it("rejects a community leader/admin editing a stranger's private board", async () => {
    await expect(
      socialBoardMutations.updateBoard(
        null,
        { input: { boardUuid: privateBoardUuid, name: 'nope' } },
        authCtx(KILTER_LEADER),
      ),
    ).rejects.toThrow(/Not authorized to update this board/);
    await expect(
      socialBoardMutations.updateBoard(
        null,
        { input: { boardUuid: privateBoardUuid, name: 'nope' } },
        authCtx(GLOBAL_ADMIN),
      ),
    ).rejects.toThrow(/Not authorized to update this board/);
  });

  it('reports canEdit=false for a community role on a private board', async () => {
    const board = await socialBoardQueries.board(null, { boardUuid: privateBoardUuid }, authCtx(KILTER_LEADER));
    expect(board?.canEdit).toBe(false);
  });

  it("still lets the private board's owner edit it", async () => {
    const result = await socialBoardMutations.updateBoard(
      null,
      { input: { boardUuid: privateBoardUuid, name: 'Owner rename' } },
      authCtx(PLAIN_USER),
    );
    expect(result.name).toBe('Owner rename');
  });
});

describe('updateBoard on soft-deleted boards', () => {
  const boardDeletedAt = async (uuid: string): Promise<Date | null> => {
    const result = await db.execute(sql`SELECT deleted_at FROM user_boards WHERE uuid = ${uuid}`);
    const row = Array.from(result as Iterable<{ deleted_at: Date | null }>)[0];
    return row?.deleted_at ?? null;
  };

  beforeEach(async () => {
    await db.execute(sql`UPDATE user_boards SET deleted_at = now() WHERE uuid = ${kilterBoardUuid}`);
  });

  it('rejects moderators/gym admins resurrecting a board the owner removed', async () => {
    for (const actor of [GLOBAL_ADMIN, KILTER_LEADER, GYM_ADMIN_MEMBER]) {
      await expect(
        socialBoardMutations.updateBoard(
          null,
          { input: { boardUuid: kilterBoardUuid, name: 'resurrect' } },
          authCtx(actor),
        ),
      ).rejects.toThrow(/Board not found/);
    }
    expect(await boardDeletedAt(kilterBoardUuid)).not.toBeNull();
  });

  it('still lets the owner restore their board by editing it', async () => {
    const result = await socialBoardMutations.updateBoard(
      null,
      { input: { boardUuid: kilterBoardUuid, name: 'Restored' } },
      authCtx(SYS_OWNER),
    );
    expect(result.name).toBe('Restored');
    expect(await boardDeletedAt(kilterBoardUuid)).toBeNull();
  });
});

describe('system catalog boards are exempt from the owner-config uniqueness pre-check', () => {
  // The DB's partial unique index excludes the zero-UUID system owner (many gyms
  // legitimately share a config), so the resolver must skip its pre-check there —
  // otherwise a moderator can't fix a catalog board to a config another catalog
  // board already uses, which is the whole point of this feature.
  const SYSTEM_OWNER = '00000000-0000-0000-0000-000000000000';
  let sysBoardAUuid: string;

  beforeEach(async () => {
    await insertUser(SYSTEM_OWNER);
    sysBoardAUuid = uuidv4();
    const sysBoardBUuid = uuidv4();
    await db.execute(sql`
      INSERT INTO user_boards
        (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, is_public, created_at, updated_at)
      VALUES
        (${sysBoardAUuid}, ${sysBoardAUuid}, ${SYSTEM_OWNER}, 'kilter', 1, 10, '1,2', 'Catalog A', true, now(), now()),
        (${sysBoardBUuid}, ${sysBoardBUuid}, ${SYSTEM_OWNER}, 'kilter', 2, 11, '3,4', 'Catalog B', true, now(), now())
    `);
  });

  it('lets a moderator change a system board to a config another system board already has', async () => {
    const result = await socialBoardMutations.updateBoard(
      null,
      { input: { boardUuid: sysBoardAUuid, layoutId: 2, sizeId: 11, setIds: '3,4' } },
      authCtx(GLOBAL_ADMIN),
    );
    expect(result.layoutId).toBe(2);
    expect(result.sizeId).toBe(11);
    expect(result.setIds).toBe('3,4');
  });
});

describe('community moderators cannot delete boards/gyms or link boards', () => {
  const boardIsDeleted = async (uuid: string): Promise<boolean> => {
    const result = await db.execute(sql`SELECT deleted_at FROM user_boards WHERE uuid = ${uuid}`);
    const row = Array.from(result as Iterable<{ deleted_at: Date | null }>)[0];
    return row?.deleted_at != null;
  };

  it('rejects a moderator deleting a board they do not own (delete stays owner-only)', async () => {
    await expect(
      socialBoardMutations.deleteBoard(null, { boardUuid: kilterBoardUuid }, authCtx(GLOBAL_ADMIN)),
    ).rejects.toThrow();
    expect(await boardIsDeleted(kilterBoardUuid)).toBe(false);
  });

  it('rejects a moderator deleting a gym they do not own', async () => {
    await expect(
      socialGymMutations.deleteGym(null, { gymUuid: kilterGymUuid }, authCtx(GLOBAL_ADMIN)),
    ).rejects.toThrow();
  });

  it('rejects a moderator linking their own board into a gym they do not own/admin', async () => {
    const adminBoardUuid = uuidv4();
    await db.execute(sql`
      INSERT INTO user_boards
        (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, is_public, created_at, updated_at)
      VALUES (${adminBoardUuid}, ${adminBoardUuid}, ${GLOBAL_ADMIN}, 'kilter', 3, 3, '7,8', 'Admin board', true, now(), now())
    `);
    await expect(
      socialGymMutations.linkBoardToGym(
        null,
        { input: { boardUuid: adminBoardUuid, gymUuid: kilterGymUuid } },
        authCtx(GLOBAL_ADMIN),
      ),
    ).rejects.toThrow(/Not authorized: must be gym owner or admin/);
  });
});
