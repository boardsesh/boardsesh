import { and, eq, exists, inArray, isNotNull, lt } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { sprayWallDetections, sprayWalls, sprayWallVersions, userBoards } from '@boardsesh/db/schema';
import type { readSprayDetection } from '@boardsesh/db/queries';
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

/** Publication history keeps the original import kind stable after publishing or resetting. */
export function sprayVersionIsReset(
  executor: Parameters<typeof readSprayDetection>[0],
  wallId: number | typeof sprayWalls.id,
  versionNumber: number | typeof sprayWallVersions.versionNumber,
) {
  const earlierVersion = alias(sprayWallVersions, 'earlier_published_spray_version');
  return exists(
    executor
      .select({ id: earlierVersion.id })
      .from(earlierVersion)
      .where(
        and(
          eq(earlierVersion.wallId, wallId),
          lt(earlierVersion.versionNumber, versionNumber),
          isNotNull(earlierVersion.publishedAt),
        ),
      ),
  ).mapWith(Boolean);
}

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
      isReset: sprayVersionIsReset(db, sprayWalls.id, sprayWallVersions.versionNumber),
      wall: sprayWalls,
      board: userBoards,
    })
    .from(sprayWallDetections)
    .innerJoin(sprayWalls, eq(sprayWalls.id, sprayWallDetections.wallId))
    .innerJoin(sprayWallVersions, eq(sprayWallVersions.id, sprayWallDetections.versionId))
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
    target.isSprayReset = source.isReset;
  }
}
