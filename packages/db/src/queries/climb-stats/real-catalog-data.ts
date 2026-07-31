import { sql, or, gt, isNotNull, type SQL } from 'drizzle-orm';
import { boardClimbStats } from '../../schema/boards/unified';

/**
 * "This board_climb_stats row carries real catalog data" — the single predicate
 * behind the MoonBoard wrong-angle fix (#3529).
 *
 * A stats row at a given (board_type, climb_uuid, angle) either holds something
 * only an upstream catalog could have supplied, or it holds nothing but
 * Boardsesh-derived counts. The four columns below are exactly the ones no
 * Boardsesh code path can invent:
 *
 *   - upstream_ascensionist_count  — the manufacturer's own repeat count
 *   - display_difficulty           — the catalog grade
 *   - benchmark_difficulty         — the catalog benchmark grade
 *   - upstream_quality_average     — the manufacturer's star average
 *
 * The tick recompute never writes any of them (see the recompute module doc), so
 * a row where all four are absent is provably an artefact of a tick landing at
 * that angle — a phantom row — rather than a graded angle of the problem.
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
 *   - migration 0188_moonboard_wrong_angle_stats_cleanup.sql (statements A and B
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
 * placeholder cannot stand in for an identifier. The literal union type — not a
 * comment — is what stops a caller ever routing input into it.
 */
export type StatsTableAlias = 's' | 'stats';

export function statsRowCarriesRealCatalogDataSql(tableAlias: StatsTableAlias): SQL {
  const alias = sql.raw(tableAlias);
  return sql`(
    COALESCE(${alias}.upstream_ascensionist_count, 0) > 0
    OR ${alias}.display_difficulty      IS NOT NULL
    OR ${alias}.benchmark_difficulty    IS NOT NULL
    OR ${alias}.upstream_quality_average IS NOT NULL
  )`;
}
