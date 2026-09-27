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
import { boardClimbGrades } from '../schema/app/climb-grades';

export type GradeEstimateRow = typeof boardClimbGrades.$inferInsert;
export type GradeEstimateWriter = Pick<PgDatabase<PgQueryResultHKT>, 'insert'>;

const GRADE_ESTIMATE_UPSERT_BATCH = 500;

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
 * keep their computed_at and are not re-sent to devices. `signal` is checked
 * before every statement, so an abort inside a caller's transaction rolls it
 * back within one 500-row statement.
 */
export async function upsertGradeEstimates(
  db: GradeEstimateWriter,
  rows: readonly GradeEstimateRow[],
  batchSize: number = GRADE_ESTIMATE_UPSERT_BATCH,
  signal?: AbortSignal,
): Promise<number> {
  let written = 0;
  for (let start = 0; start < rows.length; start += batchSize) {
    signal?.throwIfAborted();
    const changed = await db
      .insert(boardClimbGrades)
      .values(rows.slice(start, start + batchSize))
      .onConflictDoUpdate(gradeEstimateConflictUpdate)
      .returning({ climbUuid: boardClimbGrades.climbUuid });
    written += changed.length;
  }
  return written;
}

/**
 * Split `rows` into chunks of at most `maxRows`, never splitting one climb
 * across two chunks, so a publish that commits one chunk per transaction keeps
 * each climb's angle ladder consistent: all of a climb's rows land in the same
 * commit. Climbs keep their first-seen order (the caller's keyset order on
 * climb_uuid). A single climb with more than `maxRows` rows gets a chunk of
 * its own rather than being split.
 */
export function chunkRowsByClimb<Row extends { climbUuid: string }>(rows: readonly Row[], maxRows: number): Row[][] {
  if (!Number.isInteger(maxRows) || maxRows < 1)
    throw new Error(`chunkRowsByClimb: maxRows must be >= 1, got ${maxRows}`);
  const byClimb = new Map<string, Row[]>();
  for (const row of rows) {
    const climbRows = byClimb.get(row.climbUuid);
    if (climbRows) climbRows.push(row);
    else byClimb.set(row.climbUuid, [row]);
  }
  const chunks: Row[][] = [];
  let current: Row[] = [];
  for (const climbRows of byClimb.values()) {
    if (current.length > 0 && current.length + climbRows.length > maxRows) {
      chunks.push(current);
      current = [];
    }
    current.push(...climbRows);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
