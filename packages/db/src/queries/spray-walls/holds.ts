import { and, asc, eq, getTableColumns, gt, isNull, lte, or, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { alias } from 'drizzle-orm/pg-core';
import { sprayWallHolds, sprayWallVersions } from '../../schema/app/spray-walls';
import { rowsOf } from '../util/rows';
import type { SprayWallHold } from '../../schema/app/spray-walls';

type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/**
 * The holds on a wall, ordered by hold id.
 *
 * With no `versionNumber` this is the wall as it stands today: every row whose
 * `removed_version_id` is still NULL. With one, it is the wall as it stood at
 * that version — installed at or before it, and not yet removed by it — which
 * is what renders a climb set two resets ago on the photo it was set against.
 *
 * A hold is never updated in place and never deleted, so "as it stood" is a
 * range test rather than a history replay.
 */
export async function aliveHolds(db: DrizzleDb, wallId: number, versionNumber?: number): Promise<SprayWallHold[]> {
  const holdColumns = getTableColumns(sprayWallHolds);

  if (versionNumber === undefined) {
    return db
      .select()
      .from(sprayWallHolds)
      .where(and(eq(sprayWallHolds.wallId, wallId), isNull(sprayWallHolds.removedVersionId)))
      .orderBy(asc(sprayWallHolds.holdId));
  }

  const installedVersion = alias(sprayWallVersions, 'installed_version');
  const removedVersion = alias(sprayWallVersions, 'removed_version');

  return db
    .select(holdColumns)
    .from(sprayWallHolds)
    .innerJoin(installedVersion, eq(installedVersion.id, sprayWallHolds.installedVersionId))
    .leftJoin(removedVersion, eq(removedVersion.id, sprayWallHolds.removedVersionId))
    .where(
      and(
        eq(sprayWallHolds.wallId, wallId),
        lte(installedVersion.versionNumber, versionNumber),
        or(isNull(sprayWallHolds.removedVersionId), gt(removedVersion.versionNumber, versionNumber)),
      ),
    )
    .orderBy(asc(sprayWallHolds.holdId));
}

/**
 * Re-materialise `board_climbs.missing_hold_count` for every climb on a wall.
 *
 * Run it after a reset commits. A climb's count is how many of its holds now
 * carry a `removed_version_id` — so an intact climb lands on 0, and a climb that
 * lost two holds lands on 2 and can be badged, filtered and offered a remix
 * without a join the mobile SQLite mirror cannot make (it has no
 * `board_climb_holds` table).
 *
 * Two deliberate details:
 *
 *   - `updated_at` is stamped so the offline sync cursor
 *     (`board_type, updated_at, sync_seq`) ships the change. Without it, a reset
 *     would fix the badge on the server and never reach a phone.
 *   - the `IS DISTINCT FROM` guard means only climbs whose count actually moved
 *     are written. Rewriting every climb on the wall with an identical number
 *     would re-ship the whole partition to every offline client after each
 *     reset — the same cost migration 0146's trigger guards exist to avoid.
 *
 * Returns how many climbs changed.
 */
export async function recomputeMissingHoldCounts(db: DrizzleDb, wallId: number): Promise<number> {
  const missingForClimb = sql`(
    SELECT count(*)
    FROM board_climb_holds h
    JOIN spray_wall_holds s ON s.hold_id = h.hold_id AND s.wall_id = ${wallId}
    WHERE h.climb_uuid = board_climbs.uuid
      AND h.board_type = 'spray'
      AND s.removed_version_id IS NOT NULL
  )`;

  const updated = await db.execute(sql`
    UPDATE board_climbs
    SET missing_hold_count = ${missingForClimb},
        updated_at = now()
    WHERE board_type = 'spray'
      AND layout_id = (SELECT layout_id FROM spray_walls WHERE id = ${wallId})
      AND missing_hold_count IS DISTINCT FROM ${missingForClimb}
    RETURNING uuid
  `);

  return rowsOf<{ uuid: string }>(updated).length;
}
