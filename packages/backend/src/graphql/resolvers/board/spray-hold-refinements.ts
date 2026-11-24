import { and, eq, inArray, isNull } from 'drizzle-orm';
import { SPRAY_SET } from '@boardsesh/board-config';
import { parseFramesToHoldEntries, populateDenormalizedColumns } from '@boardsesh/db/queries';
import * as dbSchema from '@boardsesh/db/schema';
import { fingerprintFromHolds } from '@boardsesh/kilter-sync/sync';
import type { db } from '../../../db/client';
import { afterCommit } from '../../../db/after-commit';
import { notifyClimbRevalidated } from '../../../lib/web-revalidate';

type SprayTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type SprayReadExecutor = Pick<typeof db, 'select'>;

/**
 * A saved draft correction has a fresh id, while published climbs still name
 * its predecessor. Removal warnings must include those climbs until publish.
 * Only explicit refinement links qualify; a physical move is a different hold.
 */
export async function sprayHoldUsageAncestors(
  executor: SprayReadExecutor,
  wallId: number,
  requested: readonly number[],
): Promise<Map<number, readonly number[]>> {
  if (requested.length === 0) return new Map();
  const refinements = await executor
    .select({ holdId: dbSchema.sprayWallHolds.holdId, predecessorId: dbSchema.sprayWallHolds.movedFromHoldId })
    .from(dbSchema.sprayWallHolds)
    .where(and(eq(dbSchema.sprayWallHolds.wallId, wallId), eq(dbSchema.sprayWallHolds.isRefinement, true)));
  const predecessorById = new Map(refinements.map(({ holdId, predecessorId }) => [holdId, predecessorId]));
  return new Map(
    requested.map((holdId) => {
      const ancestors = new Set([holdId]);
      let predecessor = predecessorById.get(holdId);
      while (predecessor != null && !ancestors.has(predecessor)) {
        ancestors.add(predecessor);
        predecessor = predecessorById.get(predecessor);
      }
      return [holdId, [...ancestors]] as const;
    }),
  );
}

export async function expandSprayHoldUsageIds(
  executor: SprayReadExecutor,
  wallId: number,
  requested: readonly number[],
): Promise<number[]> {
  const ancestors = await sprayHoldUsageAncestors(executor, wallId, requested);
  return [...new Set([...ancestors.values()].flat())];
}

/**
 * Publish-time only, under the wall writer lock. The geometry remains append-only;
 * current climb references move to the corrected drawing of the same hold.
 */
export async function followPublishedSprayRefinements(
  tx: SprayTransaction,
  wall: { id: number; layoutId: number },
  versionId: number,
): Promise<number> {
  const successors = await tx
    .select({ holdId: dbSchema.sprayWallHolds.holdId, predecessorId: dbSchema.sprayWallHolds.movedFromHoldId })
    .from(dbSchema.sprayWallHolds)
    .where(
      and(
        eq(dbSchema.sprayWallHolds.wallId, wall.id),
        eq(dbSchema.sprayWallHolds.installedVersionId, versionId),
        eq(dbSchema.sprayWallHolds.isRefinement, true),
        isNull(dbSchema.sprayWallHolds.removedVersionId),
      ),
    );
  const predecessorIds = successors.flatMap(({ predecessorId }) => (predecessorId == null ? [] : [predecessorId]));
  if (predecessorIds.length === 0) return 0;
  const removed = await tx
    .select({ holdId: dbSchema.sprayWallHolds.holdId })
    .from(dbSchema.sprayWallHolds)
    .where(
      and(
        eq(dbSchema.sprayWallHolds.wallId, wall.id),
        eq(dbSchema.sprayWallHolds.removedVersionId, versionId),
        inArray(dbSchema.sprayWallHolds.holdId, predecessorIds),
      ),
    );
  const removedIds = new Set(removed.map(({ holdId }) => holdId));
  const successorById = new Map(
    successors.flatMap(({ holdId, predecessorId }) =>
      predecessorId != null && removedIds.has(predecessorId) ? [[predecessorId, holdId] as const] : [],
    ),
  );
  if (successorById.size === 0) return 0;

  const affected = await tx
    .selectDistinct({ uuid: dbSchema.boardClimbs.uuid, frames: dbSchema.boardClimbs.frames })
    .from(dbSchema.boardClimbs)
    .innerJoin(dbSchema.boardClimbHolds, eq(dbSchema.boardClimbHolds.climbUuid, dbSchema.boardClimbs.uuid))
    .where(
      and(
        eq(dbSchema.boardClimbs.boardType, 'spray'),
        eq(dbSchema.boardClimbs.layoutId, wall.layoutId),
        eq(dbSchema.boardClimbHolds.boardType, 'spray'),
        inArray(dbSchema.boardClimbHolds.holdId, [...successorById.keys()]),
      ),
    );
  const affectedUuids: string[] = [];
  for (const climb of affected) {
    // Match complete placement tokens, retaining role codes and frame separators.
    const frames = (climb.frames ?? '').replace(/p(\d+)r/g, (token, placementId: string) => {
      const successorId = successorById.get(Number(placementId));
      return successorId == null ? token : `p${successorId}r`;
    });
    const entries = parseFramesToHoldEntries('spray', frames);
    const updated = await tx
      .update(dbSchema.boardClimbs)
      .set({
        frames,
        holdFingerprint: fingerprintFromHolds(entries),
        edgeLeft: null,
        edgeRight: null,
        edgeTop: null,
        edgeBottom: null,
        updatedAt: new Date(),
      })
      .where(eq(dbSchema.boardClimbs.uuid, climb.uuid))
      .returning({ uuid: dbSchema.boardClimbs.uuid });
    // Draft/account deletion does not take the wall lock. The UPDATE locks a
    // surviving row through commit, or tells us a concurrent deletion won.
    if (updated.length === 0) continue;
    affectedUuids.push(climb.uuid);
    await tx
      .delete(dbSchema.boardClimbHolds)
      .where(and(eq(dbSchema.boardClimbHolds.boardType, 'spray'), eq(dbSchema.boardClimbHolds.climbUuid, climb.uuid)));
    if (entries.length > 0) {
      await tx
        .insert(dbSchema.boardClimbHolds)
        .values(
          entries.map((entry) => ({
            boardType: 'spray',
            climbUuid: climb.uuid,
            ...entry,
          })),
        )
        .onConflictDoNothing();
    }
  }
  if (affectedUuids.length > 0) {
    await populateDenormalizedColumns(tx, 'spray', affectedUuids);
    await tx
      .update(dbSchema.boardClimbs)
      .set({
        compatibleSizeIds: [wall.layoutId],
        requiredSetIds: [SPRAY_SET.id],
      })
      .where(inArray(dbSchema.boardClimbs.uuid, affectedUuids));
    await tx
      .delete(dbSchema.boardClimbNeighbors)
      .where(
        and(
          eq(dbSchema.boardClimbNeighbors.boardType, 'spray'),
          inArray(dbSchema.boardClimbNeighbors.climbUuid, affectedUuids),
        ),
      );
  }
  afterCommit(tx, () => {
    for (const climbUuid of affectedUuids) void notifyClimbRevalidated(climbUuid);
  });
  return affectedUuids.length;
}
