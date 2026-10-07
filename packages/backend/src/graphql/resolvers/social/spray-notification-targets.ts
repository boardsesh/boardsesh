import { and, eq, inArray, isNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { sprayWallDetections, sprayWalls, sprayWallVersions, userBoards } from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { filterEditableBoards } from './boards';

type SprayNotificationTarget = {
  uuid: string;
  type: string;
  sprayWallName?: string | null;
  sprayWallUuid?: string | null;
  sprayVersionId?: string | null;
  sprayResetOfWallUuid?: string | null;
};

/**
 * The wall a reset clone replaces, while the clone is still unpublished. A reset
 * makes a new wall (`reset_from_wall_id`); the wizard rejoins it by the source's
 * uuid. Once the clone publishes it archives the source and is a wall in its own
 * right, so the link stops: reopening the reset would land on an archived wall.
 */
export function sprayResetSourceUuid(
  wall: Pick<typeof sprayWalls.$inferSelect, 'currentVersionId'>,
  resetSourceUuid: string | null,
): string | null {
  return wall.currentVersionId === null ? resetSourceUuid : null;
}

/** Batch the targets; permission checks use the same gate as editing the wall. */
export async function enrichSprayNotificationTargets(
  targets: SprayNotificationTarget[],
  recipientId: string,
): Promise<void> {
  const ids = targets.filter((target) => target.type === 'spray_wall_detection_completed').map((target) => target.uuid);
  if (!ids.length) return;
  const resetSource = alias(sprayWalls, 'reset_source_spray_wall');
  const sources = await db
    .select({
      detectionId: sprayWallDetections.id,
      versionId: sprayWallDetections.versionId,
      resetSourceUuid: resetSource.boardUuid,
      wall: sprayWalls,
      board: userBoards,
    })
    .from(sprayWallDetections)
    .innerJoin(sprayWalls, eq(sprayWalls.id, sprayWallDetections.wallId))
    .innerJoin(sprayWallVersions, eq(sprayWallVersions.id, sprayWallDetections.versionId))
    .innerJoin(userBoards, eq(userBoards.uuid, sprayWalls.boardUuid))
    .leftJoin(resetSource, and(eq(resetSource.id, sprayWalls.resetFromWallId), isNull(resetSource.deletedAt)))
    .where(and(inArray(sprayWallDetections.id, ids), eq(sprayWallDetections.requestedBy, recipientId)));
  const sourceById = new Map(sources.map((source) => [source.detectionId, source]));
  const uniqueBoards = [...new Map(sources.map((source) => [source.board.uuid, source.board])).values()];
  const allowedBoardUuids = new Set((await filterEditableBoards(uniqueBoards, recipientId)).map((board) => board.uuid));
  for (const target of targets) {
    const source = sourceById.get(target.uuid);
    if (
      !source ||
      source.wall.deletedAt ||
      source.board.deletedAt ||
      source.wall.hiddenAt ||
      !allowedBoardUuids.has(source.board.uuid)
    )
      continue;
    target.sprayWallName = source.board.name;
    target.sprayWallUuid = source.wall.boardUuid;
    target.sprayVersionId = String(source.versionId);
    target.sprayResetOfWallUuid = sprayResetSourceUuid(source.wall, source.resetSourceUuid);
  }
}
