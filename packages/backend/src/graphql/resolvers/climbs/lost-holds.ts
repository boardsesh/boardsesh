import { and, asc, eq, isNotNull, ne } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import * as dbSchema from '@boardsesh/db/schema';
import { dbRead } from '../../../db/client';

/** The parent fields `Climb.lostHolds` reads. Nothing else on a climb matters here. */
export type ClimbLostHoldsParent = {
  uuid?: string | null;
  boardType?: string | null;
  missingHoldCount?: number | null;
};

/** One lost hold, shaped exactly like `SprayWallHold` on the wire. */
export type GraphQLLostHold = {
  id: number;
  cx: number;
  cy: number;
  r: number;
  outline: number[] | null;
  installedVersion: number;
  removedVersion: number | null;
  movedFromHoldId: number | null;
  source: 'MANUAL' | 'AUTO';
  confidence: number | null;
};

/**
 * The holds a climb was set on that a reset has since taken off the wall.
 *
 * Spray walls only, and only for a climb that has actually lost something:
 * `missing_hold_count` is already materialised on the climb row, so it answers
 * the common cases for free.
 *
 *   - a catalogue board never loses holds, so `null` without a query;
 *   - `0` is an intact climb — `[]`, again without a query;
 *   - `null`/absent is UNKNOWN (a legacy row, or a producer that did not project
 *     the column). Unknown is not "none": guessing either way here would draw
 *     ghost rings on an intact climb or hide real ones, so it stays null and the
 *     client keeps whatever it already renders.
 *
 * The rows come from `board_climb_holds` joined onto the wall's hold history. A
 * hold counts as lost only when the version that removed it has **landed**
 * (`status <> 'draft'`) — the same generation rule `aliveHolds` and
 * `recomputeMissingHoldCounts` apply, and for the same reason: version numbers
 * are handed out when a photo is uploaded, so a draft nobody ever published can
 * stamp `removed_version_id`. Honouring a draft's removal would show every
 * climber on the wall ghost rings for holds that are still bolted on, the moment
 * the owner started a reset and walked away — and nothing would ever take them
 * back off.
 *
 * `spray_wall_holds.hold_id` is globally unique across walls (both it and the
 * catalogue ids it doubles as come from the single `spray_hold_catalog_id_seq`
 * — see `allocateHoldIds`), so joining on `hold_id` alone cannot pick up another
 * wall's hold and no layout scope is needed on top.
 */
export async function resolveClimbLostHolds(climb: ClimbLostHoldsParent): Promise<GraphQLLostHold[] | null> {
  if (climb.boardType !== 'spray') return null;
  if (climb.missingHoldCount == null) return null;
  if (climb.missingHoldCount === 0) return [];
  if (!climb.uuid) return null;

  const installedVersion = alias(dbSchema.sprayWallVersions, 'installed_version');
  const removedVersion = alias(dbSchema.sprayWallVersions, 'removed_version');

  const rows = await dbRead
    .select({
      holdId: dbSchema.sprayWallHolds.holdId,
      cx: dbSchema.sprayWallHolds.cx,
      cy: dbSchema.sprayWallHolds.cy,
      r: dbSchema.sprayWallHolds.r,
      outline: dbSchema.sprayWallHolds.outline,
      movedFromHoldId: dbSchema.sprayWallHolds.movedFromHoldId,
      source: dbSchema.sprayWallHolds.source,
      confidence: dbSchema.sprayWallHolds.confidence,
      // `installedVersion` / `removedVersion` on the wire are version NUMBERS,
      // not row ids, so both versions are joined rather than read off the hold.
      installedVersionNumber: installedVersion.versionNumber,
      removedVersionNumber: removedVersion.versionNumber,
    })
    .from(dbSchema.boardClimbHolds)
    .innerJoin(dbSchema.sprayWallHolds, eq(dbSchema.sprayWallHolds.holdId, dbSchema.boardClimbHolds.holdId))
    .innerJoin(installedVersion, eq(installedVersion.id, dbSchema.sprayWallHolds.installedVersionId))
    .innerJoin(removedVersion, eq(removedVersion.id, dbSchema.sprayWallHolds.removedVersionId))
    .where(
      and(
        eq(dbSchema.boardClimbHolds.climbUuid, climb.uuid),
        eq(dbSchema.boardClimbHolds.boardType, 'spray'),
        isNotNull(dbSchema.sprayWallHolds.removedVersionId),
        ne(removedVersion.status, 'draft'),
      ),
    )
    // Stable output: the hold editor and the ghost overlay both read this in order.
    .orderBy(asc(dbSchema.sprayWallHolds.holdId));

  // `toGraphQLHold` in ../board/spray-walls.ts is not exported and takes a
  // version-id -> version-number Map this query has no need to build: the
  // numbers arrive from the join above. One small mapper here rather than a Map
  // assembled only to be taken apart again.
  return rows.map((row) => ({
    id: row.holdId,
    cx: row.cx,
    cy: row.cy,
    r: row.r,
    outline: row.outline ?? null,
    installedVersion: row.installedVersionNumber,
    removedVersion: row.removedVersionNumber,
    movedFromHoldId: row.movedFromHoldId ?? null,
    source: row.source === 'auto' ? ('AUTO' as const) : ('MANUAL' as const),
    confidence: row.confidence ?? null,
  }));
}
