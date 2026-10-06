import { and, asc, eq, getTableColumns, gt, isNotNull, isNull, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { alias } from 'drizzle-orm/pg-core';
import { sprayWallHolds, sprayWallVersions, sprayWalls } from '../../schema/app/spray-walls';
import { rowsOf } from '../util/rows';
import type { SprayWallHold } from '../../schema/app/spray-walls';

type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/**
 * The `version_number` of the wall's PUBLISHED version, or undefined when the
 * wall has never published one (it is still a draft, or it was deleted).
 */
async function publishedVersionNumber(db: DrizzleDb, wallId: number): Promise<number | undefined> {
  const currentVersion = alias(sprayWallVersions, 'current_version');
  const [row] = await db
    .select({ versionNumber: currentVersion.versionNumber })
    .from(sprayWalls)
    .innerJoin(currentVersion, eq(currentVersion.id, sprayWalls.currentVersionId))
    .where(and(eq(sprayWalls.id, wallId), isNotNull(sprayWalls.currentVersionId)))
    .limit(1);
  return row?.versionNumber;
}

/**
 * The holds on a wall at one version, ordered by hold id.
 *
 * With no `versionNumber` this is the wall as CLIMBERS see it: its published
 * version, resolved from `spray_walls.current_version_id`. That is deliberately
 * NOT "every row whose `removed_version_id` is NULL" — while a reset is still a
 * draft, its new holds already have rows and the holds it marks removed are only
 * removed AT the draft, so the NULL test would show climbers an unpublished
 * layout the moment the owner started editing. A wall with no published version
 * yet returns nothing, which is what an unpublished wall has to look like.
 *
 * With a `versionNumber` it is the wall as it stood then — installed at or before
 * that version, and not yet removed by it — which is what renders a climb set two
 * resets ago on the photo it was set against. Pass the draft's own number to see
 * a draft.
 *
 * A hold is never updated in place and never deleted, so "as it stood" is a range
 * test rather than a history replay.
 *
 * ## Why the range is not the version NUMBER alone
 *
 * Version numbers are dense per wall and handed out when a photo is uploaded, so
 * an ABANDONED draft still owns a number. Bounding on the number alone therefore
 * folds that draft's work into every later generation: publish v1, start a reset
 * as v2 and walk away, then start v3 and publish it, and v2's holds would come
 * back as alive at v3 — holds nobody ever screwed to the wall, which climbs could
 * then be set on. Its removals would leak the same way, hiding a hold that is
 * still there.
 *
 * So a generation only counts once it has LANDED: its installing (or removing)
 * version is no longer a draft, or it IS the version being asked about. That
 * second half is what lets the hold editor see the draft it is editing while
 * every other draft on the wall stays invisible.
 */
export async function aliveHolds(db: DrizzleDb, wallId: number, versionNumber?: number): Promise<SprayWallHold[]> {
  const targetVersion = versionNumber ?? (await publishedVersionNumber(db, wallId));
  if (targetVersion === undefined) return [];

  const installedVersion = alias(sprayWallVersions, 'installed_version');
  const removedVersion = alias(sprayWallVersions, 'removed_version');

  // A version's work counts when the version is no longer a draft, or when it is
  // the very version being asked about. Spelled out for both ends of the range,
  // because an abandoned draft's REMOVALS are as wrong as its additions.
  const installedLanded = or(ne(installedVersion.status, 'draft'), eq(installedVersion.versionNumber, targetVersion));
  // The negation, by De Morgan rather than `not(...)`: still a draft AND not the
  // version being asked about.
  const removalNeverLanded = and(eq(removedVersion.status, 'draft'), ne(removedVersion.versionNumber, targetVersion));

  return db
    .select(getTableColumns(sprayWallHolds))
    .from(sprayWallHolds)
    .innerJoin(installedVersion, eq(installedVersion.id, sprayWallHolds.installedVersionId))
    .leftJoin(removedVersion, eq(removedVersion.id, sprayWallHolds.removedVersionId))
    .where(
      and(
        eq(sprayWallHolds.wallId, wallId),
        lte(installedVersion.versionNumber, targetVersion),
        installedLanded,
        // Removed only by a generation that landed at or before the target. The
        // three ways a hold survives: nothing removed it, the removal is in the
        // future, or the removing version is a draft that never landed.
        or(
          isNull(sprayWallHolds.removedVersionId),
          gt(removedVersion.versionNumber, targetVersion),
          removalNeverLanded,
        ),
      ),
    )
    .orderBy(asc(sprayWallHolds.holdId));
}

/**
 * How many of one climb's holds are no longer on the wall, as a scalar subquery.
 *
 * The single definition of "a hold this climb has lost", shared by the wall-wide
 * recompute and the per-climb one so the two cannot drift on it. A removal only
 * counts once the version that made it LANDED (`rv.status <> 'draft'`) — the same
 * rule `aliveHolds` applies. An abandoned draft owns a version number and can
 * stamp `removed_version_id`, so a bare NOT NULL would badge every climb on the
 * wall as broken the moment an owner started a reset and walked away, and the
 * number would never come back on its own.
 */
function missingHoldCountFor(wallId: number, climbUuid: SQL): SQL {
  return sql`(
    SELECT count(*)
    FROM board_climb_holds h
    JOIN spray_wall_holds s ON s.hold_id = h.hold_id AND s.wall_id = ${wallId}
    JOIN spray_wall_versions rv ON rv.id = s.removed_version_id
    WHERE h.climb_uuid = ${climbUuid}
      AND h.board_type = 'spray'
      AND s.removed_version_id IS NOT NULL
      AND rv.status <> 'draft'
  )::integer`;
}

/**
 * Whether one climb is retired by a full reset, as a scalar subquery (#6024).
 *
 * True when at least one of the climb's holds was taken off by a LANDED version
 * the owner marked `is_full_reset`. Derived from the holds the climb uses NOW,
 * so the three cases that matter come out right with no extra bookkeeping:
 *
 *   - a full reset retires every climb that lost a hold in it, and only those;
 *   - a later partial reset changes nothing for a climb it retired, and retires
 *     nothing new;
 *   - a climb edited onto holds still on the wall uses none of the removed holds
 *     any more, so the per-climb recompute after that edit drops it to false.
 *
 * Same landed-generation rule as `missingHoldCountFor`, for the same reason: an
 * abandoned draft cannot retire anything.
 */
function retiredByResetFor(wallId: number, climbUuid: SQL): SQL {
  return sql`EXISTS (
    SELECT 1
    FROM board_climb_holds h
    JOIN spray_wall_holds s ON s.hold_id = h.hold_id AND s.wall_id = ${wallId}
    JOIN spray_wall_versions rv ON rv.id = s.removed_version_id
    WHERE h.climb_uuid = ${climbUuid}
      AND h.board_type = 'spray'
      AND rv.status <> 'draft'
      AND rv.is_full_reset
  )`;
}

/**
 * The guard both recomputes write under: only a climb whose count or retired
 * flag actually moved. The flag is compared through COALESCE because NULL (never
 * computed) and false mean the same thing; without it, the first recompute after
 * this column shipped would rewrite every climb on the wall to say "false", bump
 * `updated_at` on all of them and re-ship the whole partition to every phone.
 */
const integrityMoved = sql`(
  board_climbs.missing_hold_count IS DISTINCT FROM m.missing_hold_count
  OR COALESCE(board_climbs.retired_by_reset, false) IS DISTINCT FROM m.retired_by_reset
)`;

/**
 * Re-materialise `board_climbs.missing_hold_count` and `retired_by_reset` for
 * every climb on a wall.
 *
 * Run it when a wall version publishes. A climb's count is how many of its holds
 * now carry a `removed_version_id` — so an intact climb lands on 0, and a climb
 * that lost two holds lands on 2 and can be filtered without a join the mobile
 * SQLite mirror cannot make (it has no `board_climb_holds` table). Since the hold
 * lock, a publish that removes holds only lands on a wall with no published
 * climb, so only a draft can gain a count here.
 *
 * A removal only counts once the version that made it LANDED — the same rule
 * `aliveHolds` applies (see its own note). An abandoned draft owns a version
 * number and can stamp `removed_version_id`, so counting a bare NOT NULL would
 * badge every climb on the wall as broken the moment an owner started a hold edit
 * and walked away, and the number would never come back on its own.
 *
 * Four deliberate details:
 *
 *   - the count is computed ONCE per climb, in a `FROM (…) AS m` derived table.
 *     Written as two copies of the same correlated subquery — one for the SET and
 *     one for the guard — Postgres evaluates it twice per row.
 *   - `updated_at` is stamped so the offline sync cursor
 *     (`board_type, updated_at, sync_seq`) ships the change. Without it, a publish
 *     would fix the number on the server and never reach a phone.
 *   - the `IS DISTINCT FROM` guard means only climbs whose count actually moved
 *     are written. Rewriting every climb on the wall with an identical number
 *     would re-ship the whole partition to every offline client after each
 *     publish — the same cost migration 0146's trigger guards exist to avoid.
 *
 * Returns how many climbs changed.
 */
export async function recomputeMissingHoldCounts(db: DrizzleDb, wallId: number): Promise<number> {
  const updated = await db.execute(sql`
    UPDATE board_climbs
    SET missing_hold_count = m.missing_hold_count,
        retired_by_reset = m.retired_by_reset,
        updated_at = now()
    FROM (
      SELECT c.uuid,
        ${missingHoldCountFor(wallId, sql`c.uuid`)} AS missing_hold_count,
        ${retiredByResetFor(wallId, sql`c.uuid`)} AS retired_by_reset
      FROM board_climbs c
      WHERE c.board_type = 'spray'
        AND c.layout_id = (SELECT layout_id FROM spray_walls WHERE id = ${wallId})
    ) AS m
    WHERE board_climbs.uuid = m.uuid
      AND ${integrityMoved}
    RETURNING board_climbs.uuid
  `);

  return rowsOf<{ uuid: string }>(updated).length;
}

/**
 * Re-materialise `missing_hold_count` for ONE climb on a wall.
 *
 * The wall-wide recompute runs when a version publishes, which is when the WALL
 * moves under the climbs. This is the other direction: the climb moves under the
 * wall. A setter whose draft lost a hold edits it onto holds that are still there,
 * and `updateClimb` rewrites `board_climb_holds` — at which point the stored
 * number describes holds the climb no longer uses. Nothing else would ever
 * correct it: the wall-wide recompute only runs on the next publish, so the draft
 * would keep a count for a problem its setter had already fixed.
 *
 * Same count, same landed-generation rule, same `IS DISTINCT FROM` guard and the
 * same `updated_at` stamp as the wall-wide version — they share
 * `missingHoldCountFor` so the two cannot drift on what "removed" means.
 *
 * Returns true when the number actually moved.
 */
export async function recomputeMissingHoldCountForClimb(
  db: DrizzleDb,
  wallId: number,
  climbUuid: string,
): Promise<boolean> {
  // The count is computed ONCE, in a `FROM (…) AS m` derived table, for the same
  // reason the wall-wide version uses one: written as two copies of the same
  // correlated subquery — one for the SET and one for the `IS DISTINCT FROM`
  // guard — Postgres evaluates it twice.
  const updated = await db.execute(sql`
    UPDATE board_climbs
    SET missing_hold_count = m.missing_hold_count,
        retired_by_reset = m.retired_by_reset,
        updated_at = now()
    FROM (
      SELECT c.uuid,
        ${missingHoldCountFor(wallId, sql`c.uuid`)} AS missing_hold_count,
        ${retiredByResetFor(wallId, sql`c.uuid`)} AS retired_by_reset
      FROM board_climbs c
      WHERE c.uuid = ${climbUuid}
        AND c.board_type = 'spray'
    ) AS m
    WHERE board_climbs.uuid = m.uuid
      AND board_climbs.board_type = 'spray'
      AND ${integrityMoved}
    RETURNING board_climbs.uuid
  `);

  return rowsOf<{ uuid: string }>(updated).length > 0;
}
