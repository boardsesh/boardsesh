import { sql, type SQL } from 'drizzle-orm';
import { boardClimbStats } from '@boardsesh/db/schema';

/**
 * The grade half of the `board_climb_stats` ON CONFLICT SET that both Kilter
 * Grips writers ship — the catalog sync (catalog-sync.ts) and the stats repair
 * (stats-repair.ts). One definition, because the three expressions only make
 * sense together and drifting them apart is invisible until a grade is lost.
 *
 * Grips is authoritative when it supplies a grade and silent when it does not:
 * a Kilter-origin canonical clobbers with the Grips value, while an
 * Aurora-origin canonical (no Grips display row → excluded is NULL) keeps what
 * is stored. Hence COALESCE rather than a bare `excluded.*`.
 *
 * tick_graded_at rides along (#4798). The marker means "the stored
 * display_difficulty was written from Boardsesh ticks", so it has to survive
 * exactly as long as that grade does: an incoming NULL keeps our grade AND our
 * marker, so a later tick can still refresh it and a delete can still clear it;
 * an incoming grade takes over and clears the marker.
 *
 * Emphatically NOT a timestamp comparison. Both writers stamp
 * upstream_synced_at on EVERY pass, so asking whether tick_graded_at is newer
 * than upstream_synced_at froze any grade we owned the first time a pass shipped
 * no display difficulty — the row kept our grade but could never be updated or
 * cleared again. Provenance lives in the marker's presence, not in clock order.
 *
 * Existing-side refs are table-qualified: a bare column name is ambiguous
 * between the target row and `excluded` inside ON CONFLICT.
 */
export function kilterStatsGradeConflictSet(): {
  displayDifficulty: SQL;
  difficultyAverage: SQL;
  tickGradedAt: SQL;
} {
  return {
    displayDifficulty: sql`COALESCE(excluded.display_difficulty, ${boardClimbStats.displayDifficulty})`,
    difficultyAverage: sql`COALESCE(excluded.difficulty_average, ${boardClimbStats.difficultyAverage})`,
    tickGradedAt: sql`CASE WHEN excluded.display_difficulty IS NULL THEN ${boardClimbStats.tickGradedAt} ELSE NULL END`,
  };
}
