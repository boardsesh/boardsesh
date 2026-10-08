import { and, eq, sql, type SQL } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import {
  notAuroraTwinDuplicateWithin,
  resolveCanonicalClimbUuid,
  sprayReferenceClimbExistsCondition,
  sprayReferenceVisibilityCondition,
} from '@boardsesh/db/queries';
import { db } from '../../../db/client';
import { effectiveQualityExpr } from '../shared/sql-expressions';
import { tickPrivacyCondition } from '../shared/activity-privacy';

/**
 * The rules every "logs on one climb" reader shares: `followingClimbAscents`
 * today, the public per-climb logs resolver next (#5968). One home, so a second
 * reader imports these rather than writing its own copy.
 *
 * Three things to know before changing anything here:
 *
 * 1. The spray-wall privacy predicates live in the CONDITIONS array, not in a
 *    resolver. A list query and a count query that both spread the same array
 *    cannot disagree, and a count without the predicates would tell a stranger
 *    that people log on a private wall.
 *
 * 2. Spray fails CLOSED on a missing climb row. The reference predicate
 *    (`sprayReferenceVisibilityCondition`) only says "there is no invisible
 *    spray climb behind this tick", so on its own it passes a spray tick whose
 *    `board_climbs` row is gone, for every viewer. Deleting a wall is a soft
 *    delete that keeps its climbs, but two other paths hard-delete a climb row
 *    and leave its ticks behind: `deleteDraftClimb` and account deletion (which
 *    removes the deleted user's drafts). A tick left on such a climb has no wall
 *    to check, so `sprayReferenceClimbExistsCondition` drops it. Other board
 *    types keep the lenient behaviour: an Aurora tick can legitimately arrive
 *    before its climb.
 *
 * 3. A climb is matched by its canonical uuid AND every uuid deduplicated into
 *    it (`board_climb_aliases`). `saveTick` lands new ticks on the canonical,
 *    but ticks written by a sync or before a dedup can still carry a retired
 *    uuid, and without this the climber is missing from the rows and the
 *    counts. Spray is matched on the raw uuid only: walls have no dedup
 *    aliases, and it keeps the uuid the row matched on and the uuid the privacy
 *    predicates check the same.
 */

type TicksTable = typeof dbSchema.boardseshTicks;

const SPRAY_BOARD_TYPE = 'spray';

/**
 * The uuid to hand `climbLogConditions`: the canonical uuid of whatever the
 * caller asked for, so asking with a retired uuid and asking with the canonical
 * give the same answer. One primary-key probe; a miss returns the input. A DB
 * error propagates, as `resolveCanonicalClimbUuid` documents.
 *
 * Spray climbs are returned unchanged, see point 3 in the header.
 */
export async function resolveClimbLogUuid(boardType: string, climbUuid: string): Promise<string> {
  if (boardType === SPRAY_BOARD_TYPE) return climbUuid;
  return resolveCanonicalClimbUuid(db, boardType, climbUuid);
}

/**
 * True for a tick on `canonicalClimbUuid` or on any uuid deduplicated into it.
 *
 * `= ANY(array)` over an uncorrelated subquery, not `IN (subquery)` or a join:
 * Postgres runs the alias lookup once and then probes
 * `boardsesh_ticks_climb_idx` with the handful of uuids it found.
 */
function climbUuidCondition(ticks: TicksTable, boardType: string, canonicalClimbUuid: string): SQL {
  if (boardType === SPRAY_BOARD_TYPE) return eq(ticks.climbUuid, canonicalClimbUuid);
  return sql`${ticks.climbUuid} = ANY(array_append(ARRAY(
    SELECT climb_alias.alias_uuid
    FROM board_climb_aliases climb_alias
    WHERE climb_alias.board_type = ${boardType}
      AND climb_alias.canonical_uuid = ${canonicalClimbUuid}
  ), ${canonicalClimbUuid}::text))`;
}

/**
 * WHERE conditions for the logs on one climb: board type, the climb and its
 * deduplicated uuids, Aurora's own duplicate rows collapsed, and spray-wall
 * visibility for the viewer.
 *
 * Pass `viewerUserId` as null for an anonymous caller, never a hopeful id: then
 * only public walls pass.
 *
 * @param canonicalClimbUuid from `resolveClimbLogUuid`, not the caller's raw
 *   input, or a request naming a retired uuid misses the canonical's ticks.
 * @param ticks the ticks table, or an alias of it, so a subquery over
 *   `alias(boardseshTicks, ...)` gets the same filters.
 */
export function climbLogConditions({
  boardType,
  canonicalClimbUuid,
  viewerUserId,
  ticks = dbSchema.boardseshTicks,
}: {
  boardType: string;
  canonicalClimbUuid: string;
  viewerUserId: string | null;
  ticks?: TicksTable;
}): SQL[] {
  return [
    tickPrivacyCondition(viewerUserId, ticks),
    eq(ticks.boardType, boardType),
    climbUuidCondition(ticks, boardType, canonicalClimbUuid),
    // Worked out once from this climb's own rows, not probed per row: a twin
    // of a log on this climb is a log on this climb.
    notAuroraTwinDuplicateWithin(ticks, (table) =>
      and(eq(table.boardType, boardType), climbUuidCondition(table, boardType, canonicalClimbUuid))!,
    ),
    // No author exemption: these readers list other people's logs (point 2 in
    // the header).
    sprayReferenceClimbExistsCondition({ boardType: ticks.boardType, climbUuid: ticks.climbUuid }),
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
    // The revision this log was made on, as stored on the tick.
    climbRevision: tick.climbRevision,
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
