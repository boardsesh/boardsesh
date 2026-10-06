import { and, asc, eq, inArray } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import type { Database } from '../../../db/client';
import { SYSTEM_BOARD_OWNER_ID } from '../board-presence/shared';
import { lockWallForWrite, purgeSprayWallFeedItems } from '../board/spray-walls';
import { lockSprayWallAccount } from '../../../services/spray-account-lock';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Retain inaccessible wall identities for other climbers' logs, never a live transferred wall. */
export async function deleteAccountSprayWalls(tx: Transaction, userId: string): Promise<number[]> {
  // No users-row UPDATE lock: a version writer already holding a wall lock
  // needs FK KEY SHARE on its creator, which would reverse the lock order.
  await lockSprayWallAccount(tx, userId);
  const [account] = await tx
    .select({ id: dbSchema.users.id })
    .from(dbSchema.users)
    .where(eq(dbSchema.users.id, userId))
    .limit(1);
  if (!account) return [];
  const walls = await tx
    .select({
      id: dbSchema.sprayWalls.id,
      layoutId: dbSchema.sprayWalls.layoutId,
      boardUuid: dbSchema.sprayWalls.boardUuid,
    })
    .from(dbSchema.sprayWalls)
    .innerJoin(dbSchema.userBoards, eq(dbSchema.userBoards.uuid, dbSchema.sprayWalls.boardUuid))
    .where(eq(dbSchema.userBoards.ownerId, userId))
    .orderBy(asc(dbSchema.sprayWalls.id));
  if (walls.length === 0) return [];

  const [systemOwner] = await tx
    .select({ id: dbSchema.users.id })
    .from(dbSchema.users)
    .where(eq(dbSchema.users.id, SYSTEM_BOARD_OWNER_ID))
    .limit(1);
  if (!systemOwner || userId === SYSTEM_BOARD_OWNER_ID)
    throw new Error('Spray wall deletion requires the existing system owner');

  const deletedAt = new Date();
  for (const wall of walls) {
    await lockWallForWrite(tx, wall.id);
    // A concurrent owner change must not make us delete someone else's wall.
    const [ownedBoard] = await tx
      .select({ uuid: dbSchema.userBoards.uuid })
      .from(dbSchema.userBoards)
      .where(and(eq(dbSchema.userBoards.uuid, wall.boardUuid), eq(dbSchema.userBoards.ownerId, userId)))
      .for('update');
    if (!ownedBoard) continue;
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
  return detached.map((wall) => wall.id);
}
