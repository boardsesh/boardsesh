import { GraphQLError } from 'graphql';
import { and, eq, isNull } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { SPRAY_SET, spraySizeIdForLayout } from '@boardsesh/board-config';
import { aliveHolds } from '@boardsesh/db/queries';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { viewerCanSeeSprayWall } from '../board/spray-walls';

/**
 * What `saveClimb` / `updateClimb` have to know that no other board needs.
 *
 * SW-03 shipped a blanket `assertClimbWriteBoardIsNotSpray` gate because `spray`
 * became a real `BoardName` before anything said who owned a wall. This module is
 * what replaced it, and the rules it holds are what the gate was standing in for:
 *
 *  1. **The wall has to exist and the caller has to be able to see it.** A
 *     `layoutId` alone is not authorization — without this check any signed-in
 *     caller could publish climbs into a stranger's private wall. Note it is
 *     VIEW access, not edit: setting a climb on a gym's spray wall is what a gym
 *     member is there to do, and only the wall's holds are the owner's alone.
 *  2. **A setter grade is required to publish.** `getBoardCapabilities('spray')`
 *     answers `crowdGrade: false`: there is no consensus grade to converge on
 *     because a home wall has a handful of climbers, so a published climb with no
 *     grade would stay ungraded forever.
 *  3. **Every hold has to be alive on the current version.** A climb set on a
 *     hold that came off in an earlier reset is a climb nobody can do, and
 *     `missing_hold_count` exists to describe holds that came off AFTER the climb
 *     was set — not ones that were never there.
 *  4. **The denormalised columns are authoritative at write time.** Same reason
 *     as Woods: `populateDenormalizedColumns` derives them from
 *     `board_placements` and `board_product_sizes` geometry that, for a wall,
 *     describes a photograph rather than a board, so the honest values are the
 *     ones written here.
 */

type DrizzleExecutor = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export const SPRAY_CLIMB_CODES = {
  wallNotFound: 'SPRAY_WALL_NOT_FOUND',
  gradeRequired: 'SPRAY_CLIMB_GRADE_REQUIRED',
  holdNotAlive: 'SPRAY_WALL_HOLD_NOT_ALIVE',
} as const;

/** True for the one board type these rules apply to. Keeps the string literal in one place. */
export function isSprayBoard(boardType: string): boolean {
  return boardType === 'spray';
}

/** The wall a spray climb is being written against, and how it is published. */
export type SprayClimbTarget = {
  wallId: number;
  layoutId: number;
  /** Always `[layoutId]` — a wall has exactly one size, itself. */
  compatibleSizeIds: number[];
  /** Always `[1]` — the one synthetic "Holds" set every wall carries. */
  requiredSetIds: number[];
  /**
   * The PUBLISHED version's number, or null when the wall has nothing published.
   *
   * This is the generation a climb is set against, and it is what the alive-holds
   * check reads. A wall with nothing published has no holds a climber can reach,
   * so every climb write against it is refused hold by hold — which is the honest
   * outcome: the owner has not finished setting the wall up.
   */
  publishedVersionNumber: number | null;
  /**
   * Whether a `climb.created` feed event may be published for this climb.
   *
   * PUBLIC walls only (epic decision 2026-09-14: private-wall ticks are the
   * owner's logbook alone). A feed event carries the climb name and the wall's
   * layout id to every follower, so firing one for a private wall would announce
   * the existence of somebody's home wall to people who cannot open it.
   */
  publishesFeedEvents: boolean;
};

/**
 * The wall behind a spray climb write, when the caller may see it.
 *
 * A wall the caller cannot see is reported as "not found", not "forbidden": the
 * two are deliberately indistinguishable everywhere a wall is read, because
 * confirming that a layout id IS a wall somebody owns is itself a leak.
 */
export async function requireVisibleSprayWall(layoutId: number, userId: string): Promise<SprayClimbTarget> {
  const [row] = await db
    .select({
      wall: dbSchema.sprayWalls,
      board: dbSchema.userBoards,
      publishedVersionNumber: dbSchema.sprayWallVersions.versionNumber,
    })
    .from(dbSchema.sprayWalls)
    .innerJoin(dbSchema.userBoards, eq(dbSchema.userBoards.uuid, dbSchema.sprayWalls.boardUuid))
    // LEFT, not INNER: a wall with nothing published still exists, and the caller
    // has to get "that hold is not on this wall" rather than "no such wall".
    .leftJoin(dbSchema.sprayWallVersions, eq(dbSchema.sprayWallVersions.id, dbSchema.sprayWalls.currentVersionId))
    .where(
      and(
        eq(dbSchema.sprayWalls.layoutId, layoutId),
        isNull(dbSchema.sprayWalls.deletedAt),
        isNull(dbSchema.userBoards.deletedAt),
      ),
    )
    .limit(1);

  if (!row || !(await viewerCanSeeSprayWall(row.board, userId))) {
    throw new GraphQLError('That spray wall could not be found', {
      extensions: { code: SPRAY_CLIMB_CODES.wallNotFound },
    });
  }

  return {
    wallId: row.wall.id,
    layoutId: row.wall.layoutId,
    compatibleSizeIds: [spraySizeIdForLayout(row.wall.layoutId)],
    requiredSetIds: [SPRAY_SET.id],
    publishedVersionNumber: row.publishedVersionNumber ?? null,
    publishesFeedEvents: row.board.isPublic,
  };
}

/**
 * Refuse a publish with no setter grade.
 *
 * Drafts are exempt: a draft is a work in progress, and the grade is the last
 * thing a setter decides. `updateClimb`'s draft → publish transition runs the
 * same check, which is why it lives here rather than inline in either resolver.
 */
export function assertSprayGradeOnPublish(isDraft: boolean, userGrade: string | null | undefined): void {
  if (isDraft) return;
  if (userGrade && userGrade.trim().length > 0) return;
  throw new GraphQLError('A spray wall climb needs your grade before you can publish it', {
    extensions: { code: SPRAY_CLIMB_CODES.gradeRequired },
  });
}

/**
 * Refuse a climb that uses a hold which is not on the wall right now.
 *
 * Reads `spray_wall_holds` rather than `board_placements`: the catalogue rows are
 * immutable identity and outlive a hold's removal on purpose, so a placement id
 * existing says nothing about whether the hold is still screwed to the wall.
 *
 * The set it reads is the wall as of its **PUBLISHED** version, which is the
 * generation a climb is set against. Deliberately not "every row whose
 * `removed_version_id` is NULL": that would also include holds an unpublished
 * DRAFT has drawn, so an owner mid-way through a reset could publish climbs on
 * holds nobody has put on the wall yet. A wall with nothing published has no
 * reachable holds at all and every hold is refused — the honest outcome for a
 * wall the owner has not finished setting up.
 *
 * Runs inside the caller's transaction so the check and the insert see one
 * snapshot — a reset committing between them would otherwise let a climb through
 * on a hold that had just come off.
 */
export async function assertSprayHoldsAreAlive(
  executor: DrizzleExecutor,
  target: Pick<SprayClimbTarget, 'wallId' | 'publishedVersionNumber'>,
  holdIds: number[],
): Promise<void> {
  if (holdIds.length === 0) return;

  const alive =
    target.publishedVersionNumber == null
      ? []
      : await aliveHolds(executor, target.wallId, target.publishedVersionNumber);

  const aliveIds = new Set(alive.map((row) => row.holdId));
  const missing = [...new Set(holdIds)].filter((holdId) => !aliveIds.has(holdId));

  if (missing.length > 0) {
    throw new GraphQLError(
      missing.length === 1
        ? `Hold ${missing[0]} is not on this wall`
        : `Holds ${missing.join(', ')} are not on this wall`,
      { extensions: { code: SPRAY_CLIMB_CODES.holdNotAlive, holdIds: missing } },
    );
  }
}
