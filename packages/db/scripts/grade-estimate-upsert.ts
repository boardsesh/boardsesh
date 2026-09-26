/**
 * The shared `board_climb_grades` upsert for the two weekly MoonBoard estimate
 * jobs (refresh-moonboard-angle-estimates.ts and
 * refresh-moonboard-wide-angle-estimates.ts).
 *
 * A row is only rewritten when a value it carries actually moved. The offline
 * sync pull pages `board_climb_grades` on (computed_at, sync_seq), so stamping
 * computed_at = now() on an unchanged row makes every device that holds the
 * row download it again. Before this guard the wide-angle job re-stamped all
 * ~2.89M of its rows every Monday, and every MoonBoard device re-pulled about
 * 1.2M rows the next time it opened the app.
 *
 * coeff_version is deliberately NOT compared: both jobs mint it from the run's
 * start time, so it differs on every run and would defeat the guard. It rides
 * along only when something else changed, so it names the run that last moved
 * the row. computed_at is the sync cursor itself and follows the same rule.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { boardClimbGrades } from '../src/schema/app/climb-grades.js';

export type GradeEstimateRow = typeof boardClimbGrades.$inferInsert;
export type GradeEstimateWriter = Pick<PgDatabase<PgQueryResultHKT>, 'insert'>;

export const GRADE_ESTIMATE_UPSERT_BATCH = 500;

/**
 * Every value column the upsert overwrites. The SET list and the
 * IS DISTINCT FROM guard are both built from this one list, so a column can't
 * be written without also being compared.
 */
export const GRADE_ESTIMATE_COMPARED_COLUMNS = {
  localGrade: boardClimbGrades.localGrade,
  universalGrade: boardClimbGrades.universalGrade,
  gradeLow: boardClimbGrades.gradeLow,
  gradeHigh: boardClimbGrades.gradeHigh,
  confidence: boardClimbGrades.confidence,
  ascensionistCount: boardClimbGrades.ascensionistCount,
  contentPrior: boardClimbGrades.contentPrior,
  modelVersion: boardClimbGrades.modelVersion,
} as const;

const comparedColumns = Object.values(GRADE_ESTIMATE_COMPARED_COLUMNS);

const excludedColumn = (name: string): SQL => sql.raw(`EXCLUDED."${name}"`);

export const gradeEstimateConflictUpdate = {
  target: [boardClimbGrades.boardType, boardClimbGrades.climbUuid, boardClimbGrades.angle],
  set: {
    ...Object.fromEntries(
      Object.entries(GRADE_ESTIMATE_COMPARED_COLUMNS).map(([key, column]) => [key, excludedColumn(column.name)]),
    ),
    coeffVersion: excludedColumn(boardClimbGrades.coeffVersion.name),
    computedAt: sql`now()`,
  },
  setWhere: sql`(${sql.join(comparedColumns, sql`, `)}) IS DISTINCT FROM (${sql.join(
    comparedColumns.map((column) => excludedColumn(column.name)),
    sql`, `,
  )})`,
};

/**
 * Upsert `rows` in batches and return how many were actually inserted or
 * changed. Rows whose values already match are skipped by Postgres, so they
 * keep their computed_at and are not re-sent to devices.
 */
export async function upsertGradeEstimates(
  db: GradeEstimateWriter,
  rows: readonly GradeEstimateRow[],
  batchSize: number = GRADE_ESTIMATE_UPSERT_BATCH,
): Promise<number> {
  let written = 0;
  for (let start = 0; start < rows.length; start += batchSize) {
    const changed = await db
      .insert(boardClimbGrades)
      .values(rows.slice(start, start + batchSize))
      .onConflictDoUpdate(gradeEstimateConflictUpdate)
      .returning({ climbUuid: boardClimbGrades.climbUuid });
    written += changed.length;
  }
  return written;
}
