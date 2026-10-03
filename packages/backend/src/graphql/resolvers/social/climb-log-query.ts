import { eq, sql, type SQL } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import { notAuroraTwinDuplicate, sprayReferenceVisibilityCondition } from '@boardsesh/db/queries';
import { effectiveQualityExpr } from '../shared/sql-expressions';

/**
 * The rules every "logs on one climb" reader shares: `followingClimbAscents`
 * today, the public per-climb logs resolver next (#5968). One home, so a second
 * reader imports these rather than writing its own copy.
 *
 * Two things to know before changing anything here:
 *
 * 1. The spray-wall privacy predicate lives in the CONDITIONS array, not in a
 *    resolver. A list query and a count query that both spread the same array
 *    cannot disagree, and a count without the predicate would tell a stranger
 *    that people log on a private wall.
 *
 * 2. The predicate is the REFERENCE form (`sprayReferenceVisibilityCondition`):
 *    "there is no invisible spray climb behind this tick". It keeps a spray tick
 *    whose `board_climbs` row is missing. That is safe only because deleting a
 *    wall is a soft delete that keeps its catalogue rows and climbs
 *    (docs/spray-walls.md, "Deleting a wall is a soft delete"). A future hard
 *    delete of spray climbs turns this into a leak, here and in #5968's public
 *    reader: the orphaned ticks would pass the predicate for everyone.
 */

type TicksTable = typeof dbSchema.boardseshTicks;

/**
 * WHERE conditions for the logs on one climb: board type, climb, Aurora's own
 * duplicate rows collapsed, and spray-wall visibility for the viewer.
 *
 * Pass `viewerUserId` as null for an anonymous caller, never a hopeful id: then
 * only public walls pass.
 *
 * @param ticks the ticks table, or an alias of it, so a subquery over
 *   `alias(boardseshTicks, ...)` gets the same filters.
 */
export function climbLogConditions({
  boardType,
  climbUuid,
  viewerUserId,
  ticks = dbSchema.boardseshTicks,
}: {
  boardType: string;
  climbUuid: string;
  viewerUserId: string | null;
  ticks?: TicksTable;
}): SQL[] {
  return [
    eq(ticks.boardType, boardType),
    eq(ticks.climbUuid, climbUuid),
    notAuroraTwinDuplicate(ticks),
    sprayReferenceVisibilityCondition({ boardType: ticks.boardType, climbUuid: ticks.climbUuid }, viewerUserId),
  ];
}

/**
 * True for a flash or a send. Literal enum values rather than a bound tuple, so
 * it can sit inside an aggregate's `FILTER (WHERE ...)` clause.
 */
export function sentStatusCondition(ticks: TicksTable = dbSchema.boardseshTicks): SQL {
  return sql`${ticks.status} in ('flash', 'send')`;
}

/**
 * The columns a climb-log row is built from: the tick, who logged it, and
 * `effectiveQuality`.
 *
 * Required joins: `users` (inner, on the tick's user), `userProfiles` (left) and
 * `boardClimbRatings` via `boardClimbRatingsJoinCondition` (left). All three are
 * tied to the unaliased `boardseshTicks`.
 *
 * No vote or comment-count columns on purpose. The comment count is a per-row
 * subquery (`tickCommentCountExpr`); keeping it out of the base means a paged
 * reader cannot pull it in by accident.
 */
export const climbLogBaseSelection = {
  tick: dbSchema.boardseshTicks,
  userName: dbSchema.users.name,
  userImage: dbSchema.users.image,
  userDisplayName: dbSchema.userProfiles.displayName,
  userAvatarUrl: dbSchema.userProfiles.avatarUrl,
  effectiveQuality: effectiveQualityExpr,
};

type ClimbLogBaseRow = {
  tick: typeof dbSchema.boardseshTicks.$inferSelect;
  userName: string | null;
  userImage: string | null;
  userDisplayName: string | null;
  userAvatarUrl: string | null;
  effectiveQuality: number | null;
};

/** Maps a `climbLogBaseSelection` row to the fields every climb-log item carries. */
export function toClimbLogBase({
  tick,
  userName,
  userImage,
  userDisplayName,
  userAvatarUrl,
  effectiveQuality,
}: ClimbLogBaseRow) {
  return {
    uuid: tick.uuid,
    userId: tick.userId,
    userDisplayName: userDisplayName || userName || undefined,
    userAvatarUrl: userAvatarUrl || userImage || undefined,
    climbUuid: tick.climbUuid,
    boardType: tick.boardType,
    angle: tick.angle,
    isMirror: tick.isMirror ?? false,
    status: tick.status,
    attemptCount: tick.attemptCount,
    quality: tick.quality,
    difficulty: tick.difficulty,
    isBenchmark: tick.isBenchmark ?? false,
    comment: tick.comment || '',
    climbedAt: tick.climbedAt,
    // A star rating belongs to a send. The synced rating is keyed by climb and
    // angle, so without this an attempt at a rated angle would wear the stars
    // of a send it never was.
    effectiveQuality: tick.status === 'attempt' || effectiveQuality == null ? null : Number(effectiveQuality),
  };
}
