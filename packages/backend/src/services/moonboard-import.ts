import { sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { v5 as uuidv5 } from 'uuid';
import { MOONBOARD_GRADES } from '@boardsesh/board-config';
import { boardseshTicks } from '@boardsesh/db/schema';
import { recomputeClimbStatsBulk, rowsOf, type ClimbStatsKey } from '@boardsesh/db/queries';
import {
  classifyMoonBoardLogRow,
  type MoonBoardExportLogRow,
  type MoonBoardImportProgressEvent,
  type MoonBoardImportResult,
  type StrippedMoonBoardExportData,
} from '@boardsesh/shared-schema';

type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

type ResolvedMoonBoardLogRow = {
  row: MoonBoardExportLogRow;
  climbUuid: string;
  climbedAt: string;
  status: 'flash' | 'send' | 'attempt';
  attemptCount: number;
  difficulty: number;
  quality: number | null;
};

type MoonBoardResolutionRow = {
  candidateUuid: string;
  canonicalUuid: string | null;
  climbAngle: number | string | null;
  displayDifficulty: number | string | null;
};

type ExistingTickRow = {
  climbUuid: string;
  climbedOn: string;
};

type PendingInsertRow = {
  source: ResolvedMoonBoardLogRow;
  insert: {
    uuid: string;
    userId: string;
    boardType: 'moonboard';
    climbUuid: string;
    angle: 40;
    isMirror: false;
    origin: 'moonboard_import';
    status: 'flash' | 'send' | 'attempt';
    attemptCount: number;
    quality: number | null;
    difficulty: number;
    isBenchmark: false;
    comment: string;
    climbedAt: string;
  };
};

const MOONBOARD_CLIMB_UUID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const MOONBOARD_ANGLE = 40;
const INSERT_BATCH_SIZE = 100;
const GRADE_TO_DIFFICULTY_ID = new Map<string, number>(
  MOONBOARD_GRADES.flatMap((grade) => [
    [grade.value.toUpperCase(), grade.difficultyId],
    [grade.label.split('/')[0].toUpperCase(), grade.difficultyId],
  ]),
);

GRADE_TO_DIFFICULTY_ID.set('5A', 13);

export function moonBoardGradeToDifficultyId(grade: string): number | undefined {
  return GRADE_TO_DIFFICULTY_ID.get(grade.trim().toUpperCase());
}

function deterministicUuid(name: string): string {
  return uuidv5(name, MOONBOARD_CLIMB_UUID_NAMESPACE);
}

function candidateClimbUuids(problemId: number): string[] {
  return [deterministicUuid(`moonboard:${problemId}`), deterministicUuid(`moonboard:${problemId}:${MOONBOARD_ANGLE}`)];
}

function parseMoonBoardDate(date: string): string | null {
  const match = date.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const rawYear = Number(match[3]);
  const year = rawYear < 100 ? 2000 + rawYear : rawYear;
  const utcDate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));

  if (utcDate.getUTCFullYear() !== year || utcDate.getUTCMonth() !== month - 1 || utcDate.getUTCDate() !== day) {
    return null;
  }

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} 12:00:00`;
}

function importTickUuid(userId: string, row: ResolvedMoonBoardLogRow): string {
  return deterministicUuid(
    ['moonboard-import', userId, row.row.problemId, row.row.grade, row.climbedAt, row.status, row.attemptCount].join(
      ':',
    ),
  );
}

function resultCounts(): MoonBoardImportResult {
  return {
    ticks: { imported: 0, skipped: 0, failed: 0 },
    ascents: { imported: 0, skipped: 0, failed: 0 },
    attempts: { imported: 0, skipped: 0, failed: 0 },
    unresolvedClimbs: [],
    unresolvedAscentClimbs: [],
    unresolvedAttemptClimbs: [],
  };
}

function pushUnique(items: string[], item: string): void {
  if (!items.includes(item)) items.push(item);
}

function climbedOn(row: Pick<ResolvedMoonBoardLogRow, 'climbedAt'>): string {
  return row.climbedAt.slice(0, 10);
}

function existingTickDateKey(row: Pick<ResolvedMoonBoardLogRow, 'climbUuid' | 'climbedAt'>): string {
  return `${row.climbUuid}:${climbedOn(row)}`;
}

function importTickKey(
  row: Pick<ResolvedMoonBoardLogRow, 'climbUuid' | 'climbedAt' | 'status' | 'attemptCount'>,
): string {
  return `${row.climbUuid}:${row.climbedAt}:${row.status}:${row.attemptCount}`;
}

async function resolveClimbUuid(
  db: DrizzleDb,
  row: MoonBoardExportLogRow,
  difficultyId: number,
): Promise<string | null> {
  const candidates = candidateClimbUuids(row.problemId);
  const candidateSql = sql.join(
    candidates.map((candidateUuid, index) => sql`(${candidateUuid}, ${index + 1})`),
    sql`, `,
  );
  const resolutionResult = await db.execute<MoonBoardResolutionRow>(sql`
    WITH candidate_input(candidate_uuid, ordinal) AS (
      VALUES ${candidateSql}
    )
    SELECT
      candidate_input.candidate_uuid AS "candidateUuid",
      COALESCE(board_climb_aliases.canonical_uuid, board_climbs.uuid) AS "canonicalUuid",
      board_climbs.angle AS "climbAngle",
      board_climb_stats.display_difficulty AS "displayDifficulty"
    FROM candidate_input
    LEFT JOIN board_climb_aliases
      ON board_climb_aliases.board_type = 'moonboard'
     AND board_climb_aliases.alias_uuid = candidate_input.candidate_uuid
    LEFT JOIN board_climbs
      ON board_climbs.board_type = 'moonboard'
     AND board_climbs.uuid = COALESCE(board_climb_aliases.canonical_uuid, candidate_input.candidate_uuid)
    LEFT JOIN board_climb_stats
      ON board_climb_stats.board_type = 'moonboard'
     AND board_climb_stats.climb_uuid = board_climbs.uuid
     AND board_climb_stats.angle = ${MOONBOARD_ANGLE}
    ORDER BY candidate_input.ordinal
  `);

  for (const candidate of rowsOf<MoonBoardResolutionRow>(resolutionResult)) {
    if (!candidate.canonicalUuid) continue;
    const climbAngle = candidate.climbAngle == null ? null : Number(candidate.climbAngle);
    if (climbAngle != null && climbAngle !== MOONBOARD_ANGLE) continue;
    if (Number(candidate.displayDifficulty) !== difficultyId) continue;
    return candidate.canonicalUuid;
  }

  return null;
}

async function findExistingTickKeys(
  db: DrizzleDb,
  userId: string,
  rows: ResolvedMoonBoardLogRow[],
): Promise<Set<string>> {
  if (rows.length === 0) return new Set();

  const climbUuids = [...new Set(rows.map((row) => row.climbUuid))];
  const climbedOnValues = [...new Set(rows.map((row) => climbedOn(row)))];
  const climbUuidArraySql = sql.join(
    climbUuids.map((climbUuid) => sql`${climbUuid}`),
    sql`, `,
  );
  const climbedOnArraySql = sql.join(
    climbedOnValues.map((climbedOnValue) => sql`${climbedOnValue}`),
    sql`, `,
  );
  const existingResult = await db.execute<ExistingTickRow>(sql`
    SELECT
      COALESCE(board_climb_aliases.canonical_uuid, boardsesh_ticks.climb_uuid) AS "climbUuid",
      to_char(boardsesh_ticks.climbed_at::date, 'YYYY-MM-DD') AS "climbedOn"
    FROM boardsesh_ticks
    LEFT JOIN board_climb_aliases
      ON board_climb_aliases.board_type = boardsesh_ticks.board_type
     AND board_climb_aliases.alias_uuid = boardsesh_ticks.climb_uuid
    WHERE boardsesh_ticks.user_id = ${userId}
      AND boardsesh_ticks.board_type = 'moonboard'
      AND boardsesh_ticks.angle = ${MOONBOARD_ANGLE}
      AND COALESCE(board_climb_aliases.canonical_uuid, boardsesh_ticks.climb_uuid) = ANY(ARRAY[${climbUuidArraySql}]::text[])
      AND boardsesh_ticks.climbed_at::date = ANY(ARRAY[${climbedOnArraySql}]::date[])
  `);

  return new Set(rowsOf<ExistingTickRow>(existingResult).map((row) => `${row.climbUuid}:${row.climbedOn}`));
}

function countSkippedResult(result: MoonBoardImportResult, row: ResolvedMoonBoardLogRow): void {
  result.ticks.skipped += 1;
  if (row.status === 'attempt') {
    result.attempts.skipped += 1;
  } else {
    result.ascents.skipped += 1;
  }
}

function countImportedResult(result: MoonBoardImportResult, row: ResolvedMoonBoardLogRow): void {
  result.ticks.imported += 1;
  if (row.status === 'attempt') {
    result.attempts.imported += 1;
  } else {
    result.ascents.imported += 1;
  }
}

function countFailedResult(
  result: MoonBoardImportResult,
  row: MoonBoardExportLogRow,
  classification?: { status: 'flash' | 'send' | 'attempt' },
): void {
  result.ticks.failed += 1;
  if (classification?.status === 'attempt') {
    result.attempts.failed += 1;
    pushUnique(result.unresolvedAttemptClimbs, String(row.problemId));
  } else if (classification) {
    result.ascents.failed += 1;
    pushUnique(result.unresolvedAscentClimbs, String(row.problemId));
  }
  pushUnique(result.unresolvedClimbs, String(row.problemId));
}

export async function importMoonBoardExportData(
  db: DrizzleDb,
  userId: string,
  data: StrippedMoonBoardExportData,
  onEvent: (event: MoonBoardImportProgressEvent) => void,
): Promise<MoonBoardImportResult> {
  const result = resultCounts();
  const resolvedRows: ResolvedMoonBoardLogRow[] = [];

  for (let rowIndex = 0; rowIndex < data.logs.length; rowIndex += 1) {
    const row = data.logs[rowIndex];
    onEvent({ type: 'progress', step: 'resolving', current: rowIndex + 1, total: data.logs.length });

    let classification: { status: 'flash' | 'send' | 'attempt'; attemptCount: number };
    try {
      classification = classifyMoonBoardLogRow(row);
    } catch {
      countFailedResult(result, row);
      continue;
    }

    const difficultyId = moonBoardGradeToDifficultyId(row.grade);
    const climbedAt = parseMoonBoardDate(row.date);
    if (difficultyId == null || climbedAt == null) {
      countFailedResult(result, row, classification);
      continue;
    }

    const climbUuid = await resolveClimbUuid(db, row, difficultyId);
    if (!climbUuid) {
      countFailedResult(result, row, classification);
      continue;
    }

    resolvedRows.push({
      row,
      climbUuid,
      climbedAt,
      status: classification.status,
      attemptCount: classification.attemptCount,
      difficulty: difficultyId,
      quality: classification.status === 'attempt' ? null : row.rating,
    });
  }

  const existingTickDateKeys = await findExistingTickKeys(db, userId, resolvedRows);
  const claimedImportTickKeys = new Set<string>();
  const recomputeKeys = new Map<string, ClimbStatsKey>();

  for (let start = 0; start < resolvedRows.length; start += INSERT_BATCH_SIZE) {
    const batch = resolvedRows.slice(start, start + INSERT_BATCH_SIZE);
    onEvent({
      type: 'progress',
      step: 'importing',
      current: Math.min(start + batch.length, resolvedRows.length),
      total: resolvedRows.length,
    });

    const rowsToInsert: PendingInsertRow[] = [];
    for (const row of batch) {
      if (existingTickDateKeys.has(existingTickDateKey(row))) {
        countSkippedResult(result, row);
        continue;
      }

      const rowImportKey = importTickKey(row);
      if (claimedImportTickKeys.has(rowImportKey)) {
        countSkippedResult(result, row);
        continue;
      }
      claimedImportTickKeys.add(rowImportKey);

      rowsToInsert.push({
        source: row,
        insert: {
          uuid: importTickUuid(userId, row),
          userId,
          boardType: 'moonboard',
          climbUuid: row.climbUuid,
          angle: MOONBOARD_ANGLE,
          isMirror: false,
          origin: 'moonboard_import',
          status: row.status,
          attemptCount: row.attemptCount,
          quality: row.quality,
          difficulty: row.difficulty,
          isBenchmark: false,
          comment: '',
          climbedAt: row.climbedAt,
        },
      });
    }

    if (rowsToInsert.length === 0) continue;

    const insertedRows = await db
      .insert(boardseshTicks)
      .values(rowsToInsert.map((pendingRow) => pendingRow.insert))
      .onConflictDoNothing()
      .returning({
        uuid: boardseshTicks.uuid,
        climbUuid: boardseshTicks.climbUuid,
        angle: boardseshTicks.angle,
        status: boardseshTicks.status,
      });

    const uncountedInsertedIds = new Set(insertedRows.map((insertedRow) => insertedRow.uuid));

    for (const pendingRow of rowsToInsert) {
      if (!uncountedInsertedIds.has(pendingRow.insert.uuid)) {
        countSkippedResult(result, pendingRow.source);
        continue;
      }

      uncountedInsertedIds.delete(pendingRow.insert.uuid);
      countImportedResult(result, pendingRow.source);
      if (pendingRow.source.status !== 'attempt') {
        recomputeKeys.set(`${pendingRow.source.climbUuid}:${MOONBOARD_ANGLE}`, {
          boardType: 'moonboard',
          climbUuid: pendingRow.source.climbUuid,
          angle: MOONBOARD_ANGLE,
        });
      }
    }
  }

  const recomputeKeyList = [...recomputeKeys.values()];
  if (recomputeKeyList.length > 0) {
    onEvent({ type: 'progress', step: 'recomputing', message: String(recomputeKeyList.length) });
    await recomputeClimbStatsBulk(db, recomputeKeyList);
  }

  result.unresolvedClimbs.sort((first, second) => Number(first) - Number(second));
  result.unresolvedAscentClimbs.sort((first, second) => Number(first) - Number(second));
  result.unresolvedAttemptClimbs.sort((first, second) => Number(first) - Number(second));
  return result;
}
