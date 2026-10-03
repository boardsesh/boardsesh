import { and, eq, inArray } from 'drizzle-orm';
import { sprayWallDetections, sprayWalls, userBoards } from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { requireBoardEditAccess } from './boards';

type SprayNotificationTarget = {
  uuid: string;
  type: string;
  sprayWallName?: string | null;
  sprayWallUuid?: string | null;
  sprayVersionId?: string | null;
  isSprayReset?: boolean | null;
};

/** Batch the targets; permission checks use the same gate as editing the wall. */
export async function enrichSprayNotificationTargets(
  targets: SprayNotificationTarget[],
  recipientId: string,
): Promise<void> {
  const ids = targets.filter((target) => target.type === 'spray_wall_detection_completed').map((target) => target.uuid);
  if (!ids.length) return;
  const sources = await db
    .select({
      detectionId: sprayWallDetections.id,
      versionId: sprayWallDetections.versionId,
      wall: sprayWalls,
      board: userBoards,
    })
    .from(sprayWallDetections)
    .innerJoin(sprayWalls, eq(sprayWalls.id, sprayWallDetections.wallId))
    .innerJoin(userBoards, eq(userBoards.uuid, sprayWalls.boardUuid))
    .where(and(inArray(sprayWallDetections.id, ids), eq(sprayWallDetections.requestedBy, recipientId)));
  const sourceById = new Map(sources.map((source) => [source.detectionId, source]));
  for (const target of targets) {
    const source = sourceById.get(target.uuid);
    if (!source || source.wall.deletedAt || source.board.deletedAt || source.wall.hiddenAt) continue;
    try {
      await requireBoardEditAccess(
        { connectionId: 'spray-notifications', userId: recipientId, isAuthenticated: true },
        source.board,
      );
    } catch {
      continue;
    }
    target.sprayWallName = source.board.name;
    target.sprayWallUuid = source.wall.boardUuid;
    target.sprayVersionId = String(source.versionId);
    target.isSprayReset = source.wall.currentVersionId !== null;
  }
}
