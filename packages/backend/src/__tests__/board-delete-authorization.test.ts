import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { and, eq, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { rowsFromResult } from '@boardsesh/db/client';
import * as schema from '@boardsesh/db/schema';
import { db } from '../db/client';
import { socialBoardMutations, socialBoardQueries } from '../graphql/resolvers/social/boards';
import { SYSTEM_BOARD_OWNER_ID } from '../graphql/resolvers/board-presence/shared';
import { createBarrier, createValueBarrier, handleLater } from './helpers/concurrency';

const { previewTombstone } = vi.hoisted(() => ({ previewTombstone: vi.fn(async () => {}) }));
vi.mock('../services/board-queue-preview', () => ({
  publishBoardQueuePreviewTombstoneForBoard: previewTombstone,
}));

const BOARD_OWNER = 'board-delete-owner';
const GYM_OWNER = 'board-delete-gym-owner';
const GYM_ADMIN = 'board-delete-gym-admin';
const GYM_EDITOR = 'board-delete-gym-editor';
const GYM_MEMBER = 'board-delete-gym-member';
const OTHER_ADMIN = 'board-delete-other-admin';
const COMMUNITY_ADMIN = 'board-delete-community-admin';
const COMMUNITY_LEADER = 'board-delete-community-leader';
const OUTSIDER = 'board-delete-outsider';
const SCOPED_ADMIN = 'board-delete-scoped-admin';

const context = (userId: string | undefined): ConnectionContext =>
  ({ connectionId: `conn-${userId}`, userId, isAuthenticated: !!userId }) as ConnectionContext;

let gymId: number;
let otherGymId: number;
let board: typeof schema.userBoards.$inferSelect;

beforeEach(async () => {
  previewTombstone.mockClear();
  const userIds = [
    BOARD_OWNER,
    GYM_OWNER,
    GYM_ADMIN,
    GYM_EDITOR,
    GYM_MEMBER,
    OTHER_ADMIN,
    COMMUNITY_ADMIN,
    COMMUNITY_LEADER,
    OUTSIDER,
    SCOPED_ADMIN,
    SYSTEM_BOARD_OWNER_ID,
  ];
  await db
    .insert(schema.users)
    .values(userIds.map((id) => ({ id, email: `${id}@test.com`, name: id })))
    .onConflictDoNothing();
  const gymUuid = uuidv4();
  const otherGymUuid = uuidv4();
  const gyms = await db
    .insert(schema.gyms)
    .values([
      { uuid: gymUuid, slug: gymUuid, name: 'Delete test gym', ownerId: GYM_OWNER },
      { uuid: otherGymUuid, slug: otherGymUuid, name: 'Another gym', ownerId: OUTSIDER },
    ])
    .returning();
  gymId = gyms[0].id;
  otherGymId = gyms[1].id;
  await db.insert(schema.gymMembers).values([
    { gymId, userId: GYM_ADMIN, role: 'admin' },
    { gymId, userId: GYM_EDITOR, role: 'editor' },
    { gymId, userId: GYM_MEMBER, role: 'member' },
    { gymId: otherGymId, userId: OTHER_ADMIN, role: 'admin' },
  ]);
  await db
    .insert(schema.communityRoles)
    .values([
      { userId: COMMUNITY_ADMIN, role: 'admin', boardType: null },
      { userId: COMMUNITY_LEADER, role: 'community_leader', boardType: 'kilter' },
    ])
    .onConflictDoNothing();
  const boardUuid = uuidv4();
  [board] = await db
    .insert(schema.userBoards)
    .values({
      uuid: boardUuid,
      slug: boardUuid,
      name: 'Gym wall',
      ownerId: BOARD_OWNER,
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
      gymId,
      isPublic: true,
    })
    .returning();
});

async function currentBoard() {
  const [current] = await db.select().from(schema.userBoards).where(eq(schema.userBoards.id, board.id));
  return current;
}

/** Make the test board a synced (SYSTEM) board at the gym: the only kind gym staff may delete. */
async function makeSystemBoard() {
  await db.update(schema.userBoards).set({ ownerId: SYSTEM_BOARD_OWNER_ID }).where(eq(schema.userBoards.id, board.id));
}

async function moderationEvents() {
  return db.select().from(schema.boardModerationEvents).where(eq(schema.boardModerationEvents.boardId, board.id));
}

describe('deleteBoard authority', () => {
  // COMMUNITY_ADMIN holds a global (boardType null) admin role.
  it.each([BOARD_OWNER, COMMUNITY_ADMIN])(
    "allows %s on a climber's board and freezes the soft-deleted board",
    async (userId) => {
      expect(await socialBoardMutations.deleteBoard(null, { boardUuid: board.uuid }, context(userId))).toBe(true);
      const deletedBoard = await currentBoard();
      expect(deletedBoard.deletedAt).toBeInstanceOf(Date);
      expect(deletedBoard.syncFrozenAt).toEqual(deletedBoard.deletedAt);
      expect(previewTombstone).toHaveBeenCalledWith(board.id);
    },
  );

  it.each([GYM_OWNER, GYM_ADMIN, COMMUNITY_ADMIN])('allows %s on a synced board at the gym', async (userId) => {
    await makeSystemBoard();
    expect(await socialBoardMutations.deleteBoard(null, { boardUuid: board.uuid }, context(userId))).toBe(true);
    const deletedBoard = await currentBoard();
    expect(deletedBoard.deletedAt).toBeInstanceOf(Date);
    expect(deletedBoard.syncFrozenAt).toEqual(deletedBoard.deletedAt);
  });

  it.each([GYM_OWNER, GYM_ADMIN, GYM_EDITOR, GYM_MEMBER, OTHER_ADMIN, COMMUNITY_LEADER, OUTSIDER])(
    "denies %s on a climber's board without changing it",
    async (userId) => {
      await expect(socialBoardMutations.deleteBoard(null, { boardUuid: board.uuid }, context(userId))).rejects.toThrow(
        'Not authorized to delete this board',
      );
      expect((await currentBoard()).deletedAt).toBeNull();
      expect(previewTombstone).not.toHaveBeenCalled();
      expect(await moderationEvents()).toEqual([]);
    },
  );

  it.each([GYM_EDITOR, GYM_MEMBER, OTHER_ADMIN, COMMUNITY_LEADER, OUTSIDER])(
    'denies %s on a synced board at the gym',
    async (userId) => {
      await makeSystemBoard();
      await expect(socialBoardMutations.deleteBoard(null, { boardUuid: board.uuid }, context(userId))).rejects.toThrow(
        'Not authorized to delete this board',
      );
      expect((await currentBoard()).deletedAt).toBeNull();
    },
  );

  it('records a staff delete with the role used, and nothing for the owner', async () => {
    await makeSystemBoard();
    await socialBoardMutations.deleteBoard(null, { boardUuid: board.uuid }, context(GYM_ADMIN));
    expect(await moderationEvents()).toEqual([
      expect.objectContaining({
        gymId,
        actorUserId: GYM_ADMIN,
        actorRole: 'gym_admin',
        action: 'deleted',
        details: { mutation: 'deleteBoard' },
      }),
    ]);
  });

  it('records a global admin delete of a climber board', async () => {
    await socialBoardMutations.deleteBoard(null, { boardUuid: board.uuid }, context(COMMUNITY_ADMIN));
    expect(await moderationEvents()).toEqual([
      expect.objectContaining({ actorUserId: COMMUNITY_ADMIN, actorRole: 'global_admin', action: 'deleted' }),
    ]);
  });

  it('records nothing when the owner deletes their own board', async () => {
    await socialBoardMutations.deleteBoard(null, { boardUuid: board.uuid }, context(BOARD_OWNER));
    expect(await moderationEvents()).toEqual([]);
  });

  it('does not let a community admin scoped to the board type delete', async () => {
    await db
      .insert(schema.communityRoles)
      .values({ userId: SCOPED_ADMIN, role: 'admin', boardType: 'kilter' })
      .onConflictDoNothing();
    await expect(
      socialBoardMutations.deleteBoard(null, { boardUuid: board.uuid }, context(SCOPED_ADMIN)),
    ).rejects.toThrow('Not authorized to delete this board');
  });

  it('denies signed-out deletion', async () => {
    await expect(
      socialBoardMutations.deleteBoard(null, { boardUuid: board.uuid }, context(undefined)),
    ).rejects.toThrow();
    expect((await currentBoard()).deletedAt).toBeNull();
  });

  it('keeps ownership sufficient for a private board without a gym', async () => {
    await db.update(schema.userBoards).set({ gymId: null, isPublic: false }).where(eq(schema.userBoards.id, board.id));
    expect(await socialBoardMutations.deleteBoard(null, { boardUuid: board.uuid }, context(BOARD_OWNER))).toBe(true);
    expect(previewTombstone).not.toHaveBeenCalled();
  });

  it('lets an admin delete a visible synced gym board whose private location hides its gym UUID', async () => {
    await makeSystemBoard();
    const [privateGym] = await db
      .update(schema.gyms)
      .set({ isPublic: false })
      .where(eq(schema.gyms.id, gymId))
      .returning({ uuid: schema.gyms.uuid });
    await db.update(schema.userBoards).set({ hideLocation: true }).where(eq(schema.userBoards.id, board.id));

    const gymBoards = await socialBoardQueries.gymBoards(null, { gymUuid: privateGym.uuid }, context(GYM_ADMIN));
    expect(gymBoards.find((gymBoard) => gymBoard.uuid === board.uuid)).toMatchObject({
      uuid: board.uuid,
      isPublic: true,
      gymUuid: null,
    });

    expect(await socialBoardMutations.deleteBoard(null, { boardUuid: board.uuid }, context(GYM_ADMIN))).toBe(true);
    expect((await currentBoard()).deletedAt).toBeInstanceOf(Date);
  });

  it.each([GYM_OWNER, GYM_ADMIN])('denies %s after the linked gym is deleted', async (userId) => {
    await makeSystemBoard();
    await db.update(schema.gyms).set({ deletedAt: new Date() }).where(eq(schema.gyms.id, gymId));
    await expect(socialBoardMutations.deleteBoard(null, { boardUuid: board.uuid }, context(userId))).rejects.toThrow(
      'Not authorized',
    );
    expect((await currentBoard()).deletedAt).toBeNull();
  });

  it('denies an admin after membership revocation', async () => {
    await makeSystemBoard();
    await db
      .delete(schema.gymMembers)
      .where(and(eq(schema.gymMembers.gymId, gymId), eq(schema.gymMembers.userId, GYM_ADMIN)));
    await expect(socialBoardMutations.deleteBoard(null, { boardUuid: board.uuid }, context(GYM_ADMIN))).rejects.toThrow(
      'Not authorized',
    );
    expect((await currentBoard()).deletedAt).toBeNull();
  });

  it('does not let admin status reveal or delete a private board by UUID', async () => {
    await db.update(schema.userBoards).set({ isPublic: false }).where(eq(schema.userBoards.id, board.id));
    await expect(
      socialBoardMutations.deleteBoard(null, { boardUuid: board.uuid }, context(COMMUNITY_ADMIN)),
    ).rejects.toThrow('Board not found');
    expect((await currentBoard()).deletedAt).toBeNull();
    expect(previewTombstone).not.toHaveBeenCalled();
  });

  it("does not let gym authority delete a climber's private board", async () => {
    await db.update(schema.userBoards).set({ isPublic: false }).where(eq(schema.userBoards.id, board.id));
    await expect(socialBoardMutations.deleteBoard(null, { boardUuid: board.uuid }, context(GYM_ADMIN))).rejects.toThrow(
      'Not authorized to delete this board',
    );
    expect((await currentBoard()).deletedAt).toBeNull();
  });

  it('honors an approved grant without publishing on the private preview channel', async () => {
    await db.insert(schema.resourcePrivacy).values({
      kind: 'board',
      resourceId: board.uuid,
      ownerId: BOARD_OWNER,
      audience: 'invite_only',
    });
    await db.insert(schema.resourceGrants).values({
      kind: 'board',
      resourceId: board.uuid,
      userId: COMMUNITY_ADMIN,
      status: 'approved',
    });
    expect(await socialBoardMutations.deleteBoard(null, { boardUuid: board.uuid }, context(COMMUNITY_ADMIN))).toBe(
      true,
    );
    expect(previewTombstone).not.toHaveBeenCalled();
  });

  it('retracts a system-owned board preview when the linked gym owner deletes it', async () => {
    await db
      .update(schema.userBoards)
      .set({ ownerId: SYSTEM_BOARD_OWNER_ID, isPublic: false })
      .where(eq(schema.userBoards.id, board.id));
    expect(await socialBoardMutations.deleteBoard(null, { boardUuid: board.uuid }, context(GYM_OWNER))).toBe(true);
    expect(previewTombstone).toHaveBeenCalledWith(board.id);
  });

  it.each(['missing', 'deleted'] as const)('rejects a %s board', async (state) => {
    if (state === 'deleted') {
      await db.update(schema.userBoards).set({ deletedAt: new Date() }).where(eq(schema.userBoards.id, board.id));
    }
    await expect(
      socialBoardMutations.deleteBoard(
        null,
        { boardUuid: state === 'missing' ? uuidv4() : board.uuid },
        context(GYM_OWNER),
      ),
    ).rejects.toThrow('Board not found');
    expect(previewTombstone).not.toHaveBeenCalled();
  });

  it('leaves climbs and logged ascents intact', async () => {
    const climbUuid = uuidv4();
    await db.insert(schema.boardClimbs).values({ uuid: climbUuid, boardType: 'kilter', layoutId: 1, name: 'Keep me' });
    await db.insert(schema.boardseshTicks).values({
      uuid: uuidv4(),
      userId: BOARD_OWNER,
      boardType: 'kilter',
      boardId: board.id,
      climbUuid,
      angle: 40,
      status: 'send',
      climbedAt: new Date().toISOString(),
    });
    const priorTicks = await db.select().from(schema.boardseshTicks).where(eq(schema.boardseshTicks.boardId, board.id));
    const priorClimbs = await db.select().from(schema.boardClimbs).where(eq(schema.boardClimbs.uuid, climbUuid));
    await socialBoardMutations.deleteBoard(null, { boardUuid: board.uuid }, context(COMMUNITY_ADMIN));
    expect(await db.select().from(schema.boardseshTicks).where(eq(schema.boardseshTicks.boardId, board.id))).toEqual(
      priorTicks,
    );
    expect(await db.select().from(schema.boardClimbs).where(eq(schema.boardClimbs.uuid, climbUuid))).toEqual(
      priorClimbs,
    );
  });
});

describe('deleteBoard concurrent authorization changes', () => {
  it.each(['unlink', 'move', 'demote'] as const)('rejects stale gym authority after %s', async (change) => {
    // A synced board: the only kind gym authority may delete.
    await makeSystemBoard();
    const holdingPid = createValueBarrier<number>();
    const releaseWrite = createBarrier();
    const writer = db.transaction(async (tx) => {
      const [backend] = rowsFromResult<{ pid: number }>(await tx.execute(sql`SELECT pg_backend_pid() AS pid`));
      await tx
        .update(schema.userBoards)
        .set({ gymId: change === 'unlink' ? null : change === 'move' ? otherGymId : gymId })
        .where(eq(schema.userBoards.id, board.id));
      if (change === 'demote') {
        await tx
          .update(schema.gymMembers)
          .set({ role: 'editor' })
          .where(and(eq(schema.gymMembers.gymId, gymId), eq(schema.gymMembers.userId, GYM_ADMIN)));
      }
      holdingPid.release(backend.pid);
      await releaseWrite.promise;
    });
    handleLater(writer);
    const blockerPid = await holdingPid.promise;
    const deletion = socialBoardMutations.deleteBoard(null, { boardUuid: board.uuid }, context(GYM_ADMIN));
    handleLater(deletion);
    try {
      await vi.waitFor(
        async () => {
          const [activity] = rowsFromResult<{ blocked: boolean }>(
            await db.execute(sql`
              SELECT EXISTS (
                SELECT 1 FROM pg_stat_activity
                WHERE ${blockerPid} = ANY(pg_blocking_pids(pid)) AND wait_event_type = 'Lock'
              ) AS blocked
            `),
          );
          expect(activity.blocked).toBe(true);
        },
        { timeout: 5000, interval: 20 },
      );
    } finally {
      releaseWrite.release();
      await writer;
    }
    await expect(deletion).rejects.toThrow('Not authorized');
    expect((await currentBoard()).deletedAt).toBeNull();
    expect(previewTombstone).not.toHaveBeenCalled();
  });
});
