import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vite-plus/test';
import { eq } from 'drizzle-orm';
import * as schema from '@boardsesh/db/schema';
import { resourceAccessCondition } from '@boardsesh/db/queries';
import { db } from '../db/client';
import { deleteAccountBoards } from '../graphql/resolvers/users/delete-account-boards';
import { SYSTEM_BOARD_OWNER_ID } from '../graphql/resolvers/board-presence/shared';

describe('ordinary board privacy survives account deletion', () => {
  it('retains inaccessible board parents and other climbers’ ticks after deleting the owner', async () => {
    const rollback = new Error('rollback board deletion fixture');
    try {
      await db.transaction(async (tx) => {
        const ownerId = randomUUID();
        const climberId = randomUUID();
        await tx
          .insert(schema.users)
          .values([
            { id: ownerId, email: `${ownerId}@test.invalid` },
            { id: climberId, email: `${climberId}@test.invalid` },
            { id: SYSTEM_BOARD_OWNER_ID, email: 'board-delete-system@test.invalid' },
          ])
          .onConflictDoNothing();
        const boardUuid = randomUUID();
        const [board] = await tx
          .insert(schema.userBoards)
          .values({
            uuid: boardUuid,
            slug: boardUuid,
            ownerId,
            boardType: 'kilter',
            layoutId: 1,
            sizeId: 1,
            setIds: '1',
            name: 'Private home',
            description: 'Private address',
            isPublic: false,
            latitude: 12,
            longitude: 34,
            serialNumber: 'private-device',
          })
          .returning();
        const sessionId = randomUUID();
        await tx.insert(schema.boardSessions).values({
          id: sessionId,
          createdByUserId: climberId,
          boardPath: '/kilter/1/1/1/40',
          isPublic: true,
        });
        await tx.insert(schema.sessionBoards).values({ sessionId, boardId: board.id });
        const tickUuid = randomUUID();
        await tx.insert(schema.boardseshTicks).values({
          uuid: tickUuid,
          userId: climberId,
          boardType: 'kilter',
          climbUuid: randomUUID(),
          angle: 40,
          status: 'send',
          climbedAt: new Date().toISOString(),
          boardId: board.id,
          sessionId,
        });

        await deleteAccountBoards(tx, ownerId);
        await tx.delete(schema.users).where(eq(schema.users.id, ownerId));

        const [retained] = await tx.select().from(schema.userBoards).where(eq(schema.userBoards.id, board.id));
        expect(retained).toMatchObject({
          ownerId: SYSTEM_BOARD_OWNER_ID,
          name: 'Deleted board',
          description: null,
          latitude: null,
          longitude: null,
          serialNumber: null,
          isPublic: false,
          isUnlisted: false,
          hideLocation: true,
        });
        expect(retained.deletedAt).not.toBeNull();
        const [tick] = await tx.select().from(schema.boardseshTicks).where(eq(schema.boardseshTicks.uuid, tickUuid));
        expect(tick).toMatchObject({ userId: climberId, boardId: board.id, sessionId, status: 'send' });
        const [visibility] = await tx
          .select({
            board: resourceAccessCondition('board', schema.userBoards.uuid, null),
            session: resourceAccessCondition('session', schema.boardSessions.id, null),
          })
          .from(schema.userBoards)
          .innerJoin(schema.sessionBoards, eq(schema.sessionBoards.boardId, schema.userBoards.id))
          .innerJoin(schema.boardSessions, eq(schema.boardSessions.id, schema.sessionBoards.sessionId))
          .where(eq(schema.userBoards.id, board.id));
        expect(visibility).toEqual({ board: false, session: false });
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  });
});
