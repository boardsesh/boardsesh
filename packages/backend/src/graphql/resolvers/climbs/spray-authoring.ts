import { GraphQLError } from 'graphql';
import { and, eq, isNull } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { SPRAY_SET, spraySizeIdForLayout } from '@boardsesh/board-config';
import { aliveHolds, populateDenormalizedColumns } from '@boardsesh/db/queries';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { viewerCanWriteSprayClimbs } from '../board/spray-walls';

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
  angleMismatch: 'SPRAY_CLIMB_ANGLE_MISMATCH',
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
   * The wall's fixed angle, from its `user_boards` row.
   *
   * A spray wall does not adjust — `is_angle_adjustable` is false and the angle is
   * chosen once at creation — so this is the ONLY angle its climbs and stats may
   * live at.
   */
  angle: number;
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
 *
 * The rule is `viewerCanWriteSprayClimbs`: the by-layout rule (owner, gym member,
 * public wall) plus the share-link capability. A climb write is keyed on
 * `layoutId`, and layout ids come out of a sequence, so the id alone authorizes
 * nothing — but a caller who presents the WALL'S OWN UUID has the capability an
 * unlisted wall's share link hands out, and that is the crew case the epic wants.
 * A private wall still refuses everyone but its principals.
 *
 * `presentedWallUuid` is `SaveClimbInput.sprayWallUuid` / the same field on
 * `UpdateClimbInput`. SW-10's client should send it on every spray write; it is
 * ignored when the caller is already a principal.
 */
export async function requireVisibleSprayWall(
  layoutId: number,
  userId: string,
  presentedWallUuid?: string | null,
): Promise<SprayClimbTarget> {
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

  if (!row || !(await viewerCanWriteSprayClimbs(row.board, userId, presentedWallUuid))) {
    throw new GraphQLError('That spray wall could not be found', {
      extensions: { code: SPRAY_CLIMB_CODES.wallNotFound },
    });
  }

  return {
    wallId: row.wall.id,
    layoutId: row.wall.layoutId,
    compatibleSizeIds: [spraySizeIdForLayout(row.wall.layoutId)],
    requiredSetIds: [SPRAY_SET.id],
    angle: Number(row.board.angle),
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
 * Refuse a climb set at an angle the wall is not at.
 *
 * A spray wall's angle is fixed for its life (`is_angle_adjustable` is false), so
 * there is exactly one angle its climbs can exist at. Nothing downstream would
 * complain about a mismatch — `board_climbs.angle` and `board_climb_stats.angle`
 * take whatever they are given — it would just scatter the wall's climbs across
 * angles the wall has never been at, where search (which filters by exact angle)
 * would never show them again.
 *
 * Rejected rather than silently coerced to the wall's angle: a client sending the
 * wrong number has a bug, and quietly fixing it up would hide that the angle
 * control should not have been offered at all.
 */
export function assertSprayAngleMatchesWall(target: Pick<SprayClimbTarget, 'angle'>, angle: number): void {
  if (angle === target.angle) return;
  throw new GraphQLError(`This spray wall is set at ${target.angle}°, so its climbs cannot be at ${angle}°`, {
    extensions: { code: SPRAY_CLIMB_CODES.angleMismatch, wallAngle: target.angle },
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

/**
 * Derive `board_climbs`' denormalised columns, then put the spray ones back.
 *
 * INVARIANT: on spray, `compatible_size_ids` is EXACTLY the wall's own size and
 * `required_set_ids` is EXACTLY `[1]`. Anything that runs
 * `populateDenormalizedColumns` for a spray climb must go through here, because
 * that helper's step 3 derives `compatible_size_ids` by joining every
 * `board_product_sizes` row of the board type whose edge box contains the climb's,
 * **with no layout scoping** — and on spray every wall's size row IS an edge box,
 * so the column comes out naming other walls' sizes too.
 *
 * Defence in depth rather than a live leak today: every consumer of the column
 * also filters `layout_id`, so no climb surfaces on the wrong wall. The bug would
 * be a future reader that trusted it alone. Running the helper is still worth it
 * for the edge columns it computes (the climb-search size filter reads them), so
 * the order is derive-then-re-assert rather than skip.
 *
 * Two call sites — `saveClimb` and `updateClimb` — and they used to carry a copy of
 * this each. One function so a third write path cannot be added without it.
 */
export async function populateSprayClimbColumns(
  tx: DrizzleExecutor,
  boardType: string,
  climbUuid: string,
  sprayTarget: SprayClimbTarget | null,
): Promise<void> {
  await populateDenormalizedColumns(tx, boardType, [climbUuid]);
  if (!sprayTarget) return;

  await tx
    .update(dbSchema.boardClimbs)
    .set({
      compatibleSizeIds: sprayTarget.compatibleSizeIds,
      requiredSetIds: sprayTarget.requiredSetIds,
    })
    .where(and(eq(dbSchema.boardClimbs.uuid, climbUuid), eq(dbSchema.boardClimbs.boardType, boardType)));
}
