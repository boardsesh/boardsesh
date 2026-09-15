import { GraphQLError } from 'graphql';
import { and, eq, isNull } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { SPRAY_SET, spraySizeIdForLayout } from '@boardsesh/board-config';
import { aliveHolds, populateDenormalizedColumns } from '@boardsesh/db/queries';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { lockWallForWrite, viewerCanWriteSprayClimbs } from '../board/spray-walls';

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
  multiFrame: 'SPRAY_CLIMB_MULTI_FRAME',
  remixParentNotFound: 'SPRAY_REMIX_PARENT_NOT_FOUND',
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

  if (!row || !(await viewerCanWriteSprayClimbs(row.wall, row.board, userId, presentedWallUuid))) {
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
 * Whether this wall may announce to the feed, read UNDER THE WALL LOCK.
 *
 * `SprayClimbTarget.publishesFeedEvents` is resolved before the write transaction
 * opens, and the event is published after the transaction commits and the lock is
 * released. So a concurrent `updateSprayWall` flipping the wall private — and
 * running its `feed_items` purge — can complete in that window, and the emit would
 * then insert a FRESH feed row for a now-private wall that the purge has already
 * been and gone past. The purge cannot catch what has not been written yet.
 *
 * Reading it inside the transaction, under the lock the flip also has to take,
 * serialises the two: either the flip goes first and this returns false, or this
 * goes first and the flip's purge sweeps the row it wrote.
 *
 * Takes the lock itself. `pg_advisory_xact_lock` is re-entrant within a
 * transaction, so calling it again after `assertSprayHoldsAreAlive` costs nothing
 * and means a caller with no holds to check is still serialised.
 */
export async function sprayWallMayAnnounceUnderLock(executor: DrizzleExecutor, wallId: number): Promise<boolean> {
  await lockWallForWrite(executor, wallId);
  const [row] = await executor
    .select({ isPublic: dbSchema.userBoards.isPublic })
    .from(dbSchema.sprayWalls)
    .innerJoin(dbSchema.userBoards, eq(dbSchema.userBoards.uuid, dbSchema.sprayWalls.boardUuid))
    .where(and(eq(dbSchema.sprayWalls.id, wallId), isNull(dbSchema.sprayWalls.deletedAt)))
    .limit(1);
  return row?.isPublic === true;
}

/**
 * The wall's PUBLISHED version number, read fresh.
 *
 * Separate from the copy on `SprayClimbTarget` because that one is resolved before
 * the write transaction; this is the one read under the lock.
 */
async function publishedVersionNumberFor(executor: DrizzleExecutor, wallId: number): Promise<number | null> {
  const [row] = await executor
    .select({ versionNumber: dbSchema.sprayWallVersions.versionNumber })
    .from(dbSchema.sprayWalls)
    .innerJoin(dbSchema.sprayWallVersions, eq(dbSchema.sprayWallVersions.id, dbSchema.sprayWalls.currentVersionId))
    .where(eq(dbSchema.sprayWalls.id, wallId))
    .limit(1);
  return row?.versionNumber ?? null;
}

/**
 * Refuse a multi-frame climb on a spray wall.
 *
 * `getBoardCapabilities('spray')` answers `multiFrameClimbs: false`, and nothing
 * downstream enforces it: `frames_count` takes whatever it is given and the
 * renderer would happily animate a wall that has no LEDs to animate. The
 * duplicate gate is the sharper reason — it only fires for `framesCount === 1`,
 * so a multi-frame spray climb would bypass the per-wall duplicate check
 * entirely.
 *
 * Both halves are checked because they can disagree: a client may send
 * `framesCount: 1` with a frames string holding two frames, and the string is what
 * the renderer reads.
 */
export function assertSprayClimbIsSingleFrame(framesCount: number | null | undefined, frames: string): void {
  const framesInString = frames.split(',').filter((frame) => frame.trim().length > 0).length;
  if ((framesCount ?? 1) === 1 && framesInString <= 1) return;
  throw new GraphQLError('A spray wall climb is a single frame — it has no LEDs to animate a sequence on', {
    extensions: { code: SPRAY_CLIMB_CODES.multiFrame },
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

  // Take the wall lock and RE-RESOLVE the published generation under it. The
  // `publishedVersionNumber` on `target` was read before the caller's transaction
  // opened, so a `publishSprayWallVersion` landing in between would leave this
  // validating against a generation that no longer exists — and a climb could be
  // written on holds the reset had just taken off. Locking here rather than in the
  // resolvers keeps the "check and write under one lock" rule in the same function
  // as the check it protects.
  await lockWallForWrite(executor, target.wallId);
  const publishedNow = await publishedVersionNumberFor(executor, target.wallId);

  const alive = publishedNow == null ? [] : await aliveHolds(executor, target.wallId, publishedNow);

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

/**
 * Record that a climb was remixed from another on the same wall.
 *
 * A remix is an ordinary `saveClimb` — the child is a normal climb with its own
 * ticks, grade and comments — plus this one row, which is the only record of
 * where it came from. The child's screen reads it to link back to the parent's
 * ticks and grade history, and the parent's screen reads it the other way to list
 * what has been remixed off it.
 *
 * Three things are checked, and each is a way the link could lie:
 *
 *  - the parent has to be a SPRAY climb on the SAME wall. A lineage row pointing
 *    at a Kilter climb, or at a climb on somebody else's wall, would render a
 *    "remixed from" link the viewer cannot open and that means nothing.
 *  - the wall has to have a published version. `wall_version_id` is NOT NULL and
 *    says which generation the child was set against; there is no honest value for
 *    a wall that has published nothing, and no climb can be written on one anyway.
 *  - a bad parent is a hard error, not a silently dropped row. The caller asked
 *    for a remix; saving the child with the lineage quietly missing would look
 *    like it worked and leave the link gone forever.
 *
 * Visibility is NOT re-checked here: the caller has already been through
 * `requireVisibleSprayWall` for the wall this climb is being written to, and the
 * parent is on that same wall by the check above. A wall the caller may write
 * climbs to is a wall whose climbs they may see.
 *
 * Runs in the caller's transaction, so a climb never lands without its lineage.
 */
export async function recordRemixLineage(
  executor: DrizzleExecutor,
  target: Pick<SprayClimbTarget, 'wallId' | 'layoutId'>,
  childUuid: string,
  parentUuid: string,
): Promise<void> {
  const [parent] = await executor
    .select({ uuid: dbSchema.boardClimbs.uuid })
    .from(dbSchema.boardClimbs)
    .where(
      and(
        eq(dbSchema.boardClimbs.uuid, parentUuid),
        eq(dbSchema.boardClimbs.boardType, 'spray'),
        eq(dbSchema.boardClimbs.layoutId, target.layoutId),
      ),
    )
    .limit(1);

  if (!parent) {
    throw new GraphQLError('The climb this one is remixed from is not on this wall', {
      extensions: { code: SPRAY_CLIMB_CODES.remixParentNotFound, parentUuid },
    });
  }

  // Under the wall lock, like every other read this file makes to decide a write.
  // `wall_version_id` says which generation the child was set against, and a
  // `commitSprayWallVersion` landing between this read and the caller's commit
  // would leave the lineage row naming a generation that had already been
  // superseded. `assertSprayHoldsAreAlive` takes the same lock a few lines earlier
  // in the caller — but only when the climb HAS holds, so relying on that is an
  // implicit dependency on another function's early return. `pg_advisory_xact_lock`
  // is re-entrant within a transaction, so taking it again costs nothing.
  await lockWallForWrite(executor, target.wallId);

  const [wall] = await executor
    .select({ currentVersionId: dbSchema.sprayWalls.currentVersionId })
    .from(dbSchema.sprayWalls)
    .where(and(eq(dbSchema.sprayWalls.id, target.wallId), isNull(dbSchema.sprayWalls.deletedAt)))
    .limit(1);

  if (wall?.currentVersionId == null) {
    throw new GraphQLError('This wall has no published photo, so there is nothing to remix against', {
      extensions: { code: SPRAY_CLIMB_CODES.remixParentNotFound },
    });
  }

  await executor.insert(dbSchema.sprayClimbLineage).values({
    childUuid,
    parentUuid,
    wallVersionId: wall.currentVersionId,
  });
}
