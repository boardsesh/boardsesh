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
 * Since #4798 the tick recompute writes display_difficulty, but only where
 * there is no catalog grade to protect (deriveGradeFromTicksSql below) and
 * never on a MoonBoard catalog row — so on MoonBoard a row with none of the
 * four is still provably a phantom row, not a graded angle.
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
 * "The tick recompute may write this row's grade" (#4798). Two legs, both
 * fenced off MoonBoard; ownership is OR'd in by the callers:
 *   - display_difficulty IS NULL — nothing to protect (the Woods new-angle case).
 *   - tick_graded_at IS NOT NULL — the stored grade is ours; re-deriving only
 *     refreshes it.
 *
 * The marker is the provenance, not a timestamp comparison: kilter-sync keeps an
 * existing grade via COALESCE yet restamps upstream_synced_at every pass, so
 * "marker newer than stamp" froze grades we owned. Each upstream writer sets the
 * marker in the statement that writes the grade: Aurora shared-sync sets it
 * NULL (it replaces the grade unconditionally); kilter-sync catalog-sync /
 * stats-repair and the Woods importer keep it exactly when they keep the grade
 * (CASE WHEN excluded.display_difficulty IS NULL THEN existing ELSE NULL END);
 * clear-and-reinsert importers need nothing. A graded row with a NULL marker is
 * always upstream's — 134k unstamped graded Tension rows in prod say "no stamp"
 * cannot mean "ours".
 *
 * MoonBoard fence: ungraded MoonBoard catalog rows are real, and
 * moonboard-grade-repair.ts / repair-moonboard-8c-grades.ts fill them under a
 * display_difficulty IS NULL guard; tick-grading one would make those skip it
 * and flip statsRowCarriesRealCatalogData on a row with no catalog data.
 *
 * tick_graded_at is written as now() AT TIME ZONE 'UTC': a zoneless column
 * holding UTC wall time like the upstream stamps (see sync/weekly-gate.ts).
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

/**
 * "This climb is Boardsesh-owned AND its GRADE is ours to re-derive from ticks."
 *
 * The owned leg of the recompute (`board_climbs.user_id IS NOT NULL`) is the other
 * half of the grade decision beside {@link deriveGradeFromTicksSql}: a climb a
 * Boardsesh setter created has no upstream grade to protect, so its grade is the
 * average of its ticks.
 *
 * Spray walls break that. A spray climb is an ordinary `board_climbs` row with a
 * non-null `user_id` (the wall's setter), so the owned leg matched it — and
 * `saveClimb` SEEDS the setter's own grade into `board_climb_stats`
 * (`docs/spray-walls.md`). So the first tick logged with no difficulty averaged to
 * NULL, NULLed `display_difficulty` and cleared `tick_graded_at`, and the setter's
 * grade was gone with nothing left to recover it from — the row no longer even
 * says a grade was ever derived.
 *
 * The spray fence mirrors the MoonBoard one above, and sits on the OWNED leg rather
 * than inside `deriveGradeFromTicksSql` because the two legs answer different
 * questions and only this one is wrong for spray: an UNGRADED spray climb
 * (`display_difficulty IS NULL`) still takes its grade from its ticks, which is the
 * only grade it can have.
 *
 * Everything else the owned leg decides — the plain quality AVG, the derived FA,
 * `quality_normalized` — stays TRUE for spray: those ARE Boardsesh's to compute,
 * there being no manufacturer behind a wall in somebody's garage.
 *
 * `climbTableAlias` is the `board_climbs` alias in the query it goes into.
 */
export function ownedGradeIsOursSql(climbTableAlias: string): SQL {
  const alias = sql.raw(climbTableAlias);
  return sql`(${alias}.user_id IS NOT NULL AND ${alias}.board_type <> 'spray')`;
}
