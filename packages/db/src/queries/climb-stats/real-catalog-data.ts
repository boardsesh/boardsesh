import { sql, type SQL } from 'drizzle-orm';

/**
 * `tableAlias` is a SQL identifier and is interpolated raw, because a parameter
 * placeholder cannot stand in for an identifier. The literal type — not a
 * comment — is what stops a caller ever routing input into it: the union lists
 * only the aliases that actually appear at a call site, so `sql.raw` can never
 * receive a runtime-computed string. Adding an alias is a deliberate one-line
 * edit here, not something a new caller can do by accident.
 */
export type StatsTableAlias = 's';

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
 * display_difficulty IS NULL guard; tick-grading one would make those skip it.
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
