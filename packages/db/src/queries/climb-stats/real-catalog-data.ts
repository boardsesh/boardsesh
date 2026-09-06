import { sql, or, gt, isNotNull, type SQL } from 'drizzle-orm';
import { boardClimbStats } from '../../schema/boards/unified';

/**
 * "This board_climb_stats row carries real catalog data" — the single predicate
 * behind the MoonBoard wrong-angle fix (#3529).
 *
 * A stats row at a given (board_type, climb_uuid, angle) either holds something
 * only an upstream catalog could have supplied, or it holds nothing but
 * Boardsesh-derived counts. The four columns below are the ones no Boardsesh
 * code path writes on a CATALOG climb:
 *
 *   - upstream_ascensionist_count  — the manufacturer's own repeat count
 *   - display_difficulty           — the catalog grade
 *   - benchmark_difficulty         — the catalog benchmark grade
 *   - upstream_quality_average     — the manufacturer's star average
 *
 * "On a catalog climb" is the load-bearing qualifier, not decoration. One
 * Boardsesh writer does set display_difficulty / benchmark_difficulty:
 * saveMoonBoardClimb (packages/backend/src/graphql/resolvers/climbs/mutations.ts).
 * (The web saveClimb proxy was the second writer until W-25a, #4441, deleted it.)
 * It writes them only for a climb it is creating, and creates that climb with a
 * non-null board_climbs.user_id — and every consumer of this predicate consults
 * it strictly behind the user-created fence (bc.user_id IS NULL), so its rows
 * are never reached through it. If that ever stopped holding, the
 * failure direction is protective: an extra TRUE reads as "real catalog data",
 * and the fix responds by declining to move the tick or delete the row.
 *
 * The tick recompute writes exactly one of the four, and only where there is no
 * catalog grade to protect: since #4798 it fills display_difficulty on a row
 * that had none, or re-derives one it wrote itself (deriveGradeFromTicksSql
 * below). MoonBoard is fenced out of that entirely — the recompute never writes
 * display_difficulty on a MoonBoard CATALOG row, which is what keeps this
 * predicate's meaning intact there. Ungraded MoonBoard catalog rows are real
 * (moonboard-grade-repair.ts and repair-moonboard-8c-grades.ts exist precisely
 * to fill them from the Moon catalog, and both guard on
 * `display_difficulty IS NULL`), so a tick-derived grade would both make those
 * repairs skip the row forever and flip this predicate to TRUE on a row that
 * carries no catalog data at all. So a row where all four are absent is still
 * provably an artefact of a tick landing at that angle — a phantom row —
 * rather than a graded angle of the problem.
 *
 * Why the whole fix hangs on this rather than on bare row existence: under
 * MoonBoard's current identity model one physical problem is TWO board_climbs
 * rows (uuidv5 of `moonboard:{id}:{angle}`), so a tick logged from a board set
 * to the other angle strands itself at an angle the climb is not graded at, and
 * the recompute then mints a stats row there. That phantom row IS the bug — so a
 * predicate that only asked "is there a stats row at this angle?" would answer
 * "yes" for every affected climb in prod and the fix would never fire. Testing
 * for catalog data instead makes the code fix work on the existing damage, not
 * just on damage yet to be created.
 *
 * Reused verbatim by:
 *   - resolveMoonBoardTickAngle (queries/climbs/moonboard-tick-angle.ts)
 *   - both recompute seed guards (climb-stats/recompute.ts)
 *   - migration 0192_moonboard_wrong_angle_stats_cleanup.sql (statements A and B
 *     share it, so A can never strand a row B then refuses to delete)
 *
 * Keep the three copies in step. Adding a column that an upstream catalog owns
 * means adding it here, in the raw-SQL twin below, and in the migration.
 */
export function statsRowCarriesRealCatalogData(): SQL | undefined {
  return or(
    gt(sql`coalesce(${boardClimbStats.upstreamAscensionistCount}, 0)`, 0),
    isNotNull(boardClimbStats.displayDifficulty),
    isNotNull(boardClimbStats.benchmarkDifficulty),
    isNotNull(boardClimbStats.upstreamQualityAverage),
  );
}

/**
 * Raw-SQL twin of {@link statsRowCarriesRealCatalogData}, for the recompute's
 * hand-written seed statements (which cannot use the drizzle insert builder —
 * see the comment at the single-key seed).
 *
 * `tableAlias` is a SQL identifier and is interpolated raw, because a parameter
 * placeholder cannot stand in for an identifier. The literal type — not a
 * comment — is what stops a caller ever routing input into it: the union lists
 * only the aliases that actually appear at a call site, so `sql.raw` can never
 * receive a runtime-computed string. Adding an alias is a deliberate one-line
 * edit here, not something a new caller can do by accident.
 */
export type StatsTableAlias = 's';

export function statsRowCarriesRealCatalogDataSql(tableAlias: StatsTableAlias): SQL {
  const alias = sql.raw(tableAlias);
  return sql`(
    COALESCE(${alias}.upstream_ascensionist_count, 0) > 0
    OR ${alias}.display_difficulty      IS NOT NULL
    OR ${alias}.benchmark_difficulty    IS NOT NULL
    OR ${alias}.upstream_quality_average IS NOT NULL
  )`;
}

/**
 * "The tick recompute may write this row's grade" — nothing to protect, or the
 * current grade is ours and no upstream writer has touched the row since (#4798).
 *
 * Two legs, both fenced off MoonBoard:
 *   - display_difficulty IS NULL — the row carries no grade at all, so writing
 *     one destroys nothing. This is the Woods case: a catalog climb graded at
 *     the set angle, ticked at a new angle, whose seeded row would otherwise sit
 *     at NULL forever and never show up under a grade.
 *   - tick_graded_at IS NOT NULL — the grade currently stored WAS written from
 *     Boardsesh ticks, so re-deriving it only refreshes our own number.
 *
 * Marker PRESENCE, not a timestamp comparison. An earlier version asked whether
 * tick_graded_at was newer than upstream_synced_at and was wrong: kilter-sync
 * (catalog-sync.ts, stats-repair.ts) writes
 * `display_difficulty = COALESCE(excluded.display_difficulty, existing)` and
 * stamps upstream_synced_at on EVERY pass, so a pass shipping a row with no
 * grade kept our grade while making the stamp newer — permanently freezing a
 * grade we owned, unable to be refreshed by a later tick or cleared by a
 * delete. The stamp records when upstream last touched the row, which is not
 * the same question as who wrote the grade.
 *
 * So the marker is the provenance, and the upstream writers own it:
 *   - Aurora shared-sync replaces display_difficulty unconditionally
 *     (`excluded.display_difficulty`, NULL included — an empty upstream row
 *     means "no grade here"), so it sets tick_graded_at = NULL on conflict. If
 *     that nulls the grade too, the next recompute re-derives via the first leg.
 *   - kilter-sync (catalog-sync, stats-repair) and the Woods importer COALESCE
 *     the grade, so they mirror it: the marker survives exactly when the grade
 *     does — `CASE WHEN excluded.display_difficulty IS NULL THEN <existing>
 *     ELSE NULL END`.
 *   - import-aurora-board-unified.ts clears board_climb_stats and re-inserts,
 *     and the MoonBoard importers only write MoonBoard rows. Neither needs a
 *     rule: a freshly inserted row carries no marker, and MoonBoard is fenced
 *     out of both legs below anyway.
 *
 * A graded row with tick_graded_at NULL is always upstream's and is never
 * touched: 134k unstamped graded Tension rows in prod prove "no
 * upstream_synced_at" cannot be read as "ours", and every row that predates
 * this column reads correctly as upstream's.
 *
 * upstream_synced_at plays no part in this predicate any more. The write
 * convention still matters, though: the recompute stamps tick_graded_at as
 * `now() AT TIME ZONE 'UTC'` rather than bare now(), because it is a zoneless
 * `timestamp` column holding UTC wall time alongside the JS `toISOString()`
 * values the upstream writers store. Same convention, same reason, as
 * `last_synchronized_at` in packages/db/src/queries/sync/weekly-gate.ts:33-36.
 *
 * `board_type <> 'moonboard'` gates BOTH legs. MoonBoard catalog rows can be
 * legitimately ungraded, and two repair scripts fill them from the Moon
 * catalog under a `display_difficulty IS NULL` guard
 * (packages/db/scripts/moonboard-grade-repair.ts,
 * packages/db/scripts/repair-moonboard-8c-grades.ts). A tick-derived grade
 * would make both skip the row permanently, and would flip
 * statsRowCarriesRealCatalogData TRUE on a row holding no catalog data. The
 * fence is what keeps "the recompute never writes display_difficulty on a
 * MoonBoard catalog row" true. It does NOT block owned MoonBoard climbs — the
 * callers OR ownership in ahead of this, and nothing repairs a climber's own
 * problem from the Moon catalog.
 *
 * Ownership is deliberately NOT part of this — the callers OR it in
 * (`owned OR deriveGradeFromTicks`), because an owned climb re-derives its grade
 * unconditionally, stamp or no stamp, MoonBoard included.
 */
export function deriveGradeFromTicksSql(tableAlias: StatsTableAlias): SQL {
  const alias = sql.raw(tableAlias);
  return sql`(
    ${alias}.board_type <> 'moonboard'
    AND (
      ${alias}.display_difficulty IS NULL
      OR ${alias}.tick_graded_at IS NOT NULL
    )
  )`;
}
