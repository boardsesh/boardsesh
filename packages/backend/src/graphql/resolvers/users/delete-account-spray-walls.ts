import { and, desc, eq, inArray } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import type { Database } from '../../../db/client';
import { effectiveBoardAudience } from '../../../services/privacy';
import { SYSTEM_BOARD_OWNER_ID } from '../board-presence/shared';
import { lockWallForWrite, purgeSprayWallFeedItems } from '../board/spray-walls';
import { lockSprayWallAccount } from '../../../services/spray-account-lock';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export type DeletedAccountSprayWalls = {
  /** Spray wall ids detached from the account, for the photo purge after commit. */
  wallIds: number[];
  /** Board ids a signed-out viewer could read before deletion, for the kiosk tombstone after commit. */
  previewBoardIds: number[];
};

/** Retain inaccessible wall identities for other climbers' logs, never a live transferred wall. */
export async function deleteAccountSprayWalls(tx: Transaction, userId: string): Promise<DeletedAccountSprayWalls> {
  // No users-row UPDATE lock: a version writer already holding a wall lock
  // needs FK KEY SHARE on its creator, which would reverse the lock order.
  await lockSprayWallAccount(tx, userId);
  const [account] = await tx
    .select({ id: dbSchema.users.id })
    .from(dbSchema.users)
    .where(eq(dbSchema.users.id, userId))
    .limit(1);
  if (!account) return { wallIds: [], previewBoardIds: [] };
  const walls = await tx
    .select({
      id: dbSchema.sprayWalls.id,
      layoutId: dbSchema.sprayWalls.layoutId,
      boardUuid: dbSchema.sprayWalls.boardUuid,
    })
    .from(dbSchema.sprayWalls)
    .innerJoin(dbSchema.userBoards, eq(dbSchema.userBoards.uuid, dbSchema.sprayWalls.boardUuid))
    .where(eq(dbSchema.userBoards.ownerId, userId))
    // Highest id first. This loop holds every wall lock it takes until commit, so
    // it must take them in the one order every other two-lock path uses: a reset
    // clone's first publish holds the clone (always the higher id) and then takes
    // the wall it replaces. Ascending here would deadlock against that publish.
    .orderBy(desc(dbSchema.sprayWalls.id));
  if (walls.length === 0) return { wallIds: [], previewBoardIds: [] };

  const [systemOwner] = await tx
    .select({ id: dbSchema.users.id })
    .from(dbSchema.users)
    .where(eq(dbSchema.users.id, SYSTEM_BOARD_OWNER_ID))
    .limit(1);
  if (!systemOwner || userId === SYSTEM_BOARD_OWNER_ID)
    throw new Error('Spray wall deletion requires the existing system owner');

  const deletedAt = new Date();
  const previewBoardIds: number[] = [];
  for (const wall of walls) {
    await lockWallForWrite(tx, wall.id);
    // A concurrent owner change must not make us delete someone else's wall.
    const [ownedBoard] = await tx
      .select({
        id: dbSchema.userBoards.id,
        isPublic: dbSchema.userBoards.isPublic,
        isUnlisted: dbSchema.userBoards.isUnlisted,
        deletedAt: dbSchema.userBoards.deletedAt,
      })
      .from(dbSchema.userBoards)
      .where(and(eq(dbSchema.userBoards.uuid, wall.boardUuid), eq(dbSchema.userBoards.ownerId, userId)))
      .for('update');
    if (!ownedBoard) continue;
    const [policy] = await tx
      .select({ audience: dbSchema.resourcePrivacy.audience })
      .from(dbSchema.resourcePrivacy)
      .where(and(eq(dbSchema.resourcePrivacy.kind, 'board'), eq(dbSchema.resourcePrivacy.resourceId, wall.boardUuid)));
    const audience = effectiveBoardAudience(policy?.audience, ownedBoard);
    if (ownedBoard.deletedAt === null && (audience === 'public' || audience === 'unlisted')) {
      previewBoardIds.push(ownedBoard.id);
    }
    await purgeSprayWallFeedItems(tx, wall.layoutId);
    // Tombstone BEFORE rebinding: the deletion trigger must still find the real owner.
    await tx
      .update(dbSchema.sprayWalls)
      .set({
        deletedAt,
        updatedAt: deletedAt,
        publicPhotoKey: null,
        pendingIsPublic: null,
        pendingIsUnlisted: null,
        renderSettings: null,
        photosPurgedAt: null,
      })
      .where(eq(dbSchema.sprayWalls.id, wall.id));
    await tx
      .update(dbSchema.userBoards)
      .set({
        ownerId: SYSTEM_BOARD_OWNER_ID,
        deletedAt,
        updatedAt: deletedAt,
        name: 'Deleted wall',
        slug: `deleted-spray-wall-${wall.boardUuid}`,
        description: null,
        locationName: null,
        latitude: null,
        longitude: null,
        gymId: null,
        serialNumber: null,
        timerName: null,
        hideLocation: true,
        isPublic: false,
        isUnlisted: false,
        syncFrozenAt: deletedAt,
      })
      .where(eq(dbSchema.userBoards.uuid, wall.boardUuid));
    await tx
      .update(dbSchema.boardLayouts)
      .set({ name: 'Deleted wall' })
      .where(and(eq(dbSchema.boardLayouts.boardType, 'spray'), eq(dbSchema.boardLayouts.id, wall.layoutId)));
    await tx
      .update(dbSchema.boardProductSizes)
      .set({ name: 'Deleted wall' })
      .where(and(eq(dbSchema.boardProductSizes.boardType, 'spray'), eq(dbSchema.boardProductSizes.id, wall.layoutId)));
    await tx
      .update(dbSchema.sprayWallVersions)
      .set({ notes: null, updatedAt: deletedAt })
      .where(eq(dbSchema.sprayWallVersions.wallId, wall.id));
  }
  // Capture only the rows actually detached, including already-deleted walls.
  const detached = await tx
    .select({ id: dbSchema.sprayWalls.id })
    .from(dbSchema.sprayWalls)
    .innerJoin(dbSchema.userBoards, eq(dbSchema.userBoards.uuid, dbSchema.sprayWalls.boardUuid))
    .where(
      and(
        inArray(
          dbSchema.sprayWalls.id,
          walls.map((wall) => wall.id),
        ),
        eq(dbSchema.userBoards.ownerId, SYSTEM_BOARD_OWNER_ID),
      ),
    );
  return { wallIds: detached.map((wall) => wall.id), previewBoardIds };
}
