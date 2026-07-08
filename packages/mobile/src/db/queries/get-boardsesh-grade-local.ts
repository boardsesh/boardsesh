import type { OfflineDatabase } from '@boardsesh/offline-sync';
import type { BoardseshGrade, BoardseshGradeAtAngle } from '@boardsesh/graphql/operations';

/**
 * On-device Boardsesh-grade reads over the synced `board_climb_grades` table,
 * used to serve the play-drawer grade section and the by-angle chart offline (and
 * local-first while online, once the board is downloaded). They return the SAME
 * shapes the `boardseshGrade` / `boardseshGradesForAngles` GraphQL ops return, so
 * the offline interceptor can drop them straight into React Query.
 *
 * `model_version` is deliberately NOT synced (the device only needs the surfaced
 * grade + band), but the GraphQL `BoardseshGrade.modelVersion` field is a non-null
 * String. We return the sentinel `'offline'` so the shape type-checks; no caller
 * renders it, and an online refresh replaces it with the real version.
 */

const OFFLINE_MODEL_VERSION = 'offline';

type GradeRow = {
  angle: number;
  local_grade: number | null;
  universal_grade: number | null;
  grade_low: number | null;
  grade_high: number | null;
  confidence: string | null;
  ascensionist_count: number | null;
  computed_at: string | null;
};

// The columns common to both GraphQL shapes (BoardseshGradeAtAngle = BoardseshGrade
// + angle). confidence/computedAt are non-null Strings in the schema and always
// present on a real synced row; the `?? ''` only guards a theoretically-null column.
function mapCommon(row: GradeRow): BoardseshGrade {
  return {
    localGrade: row.local_grade,
    universalGrade: row.universal_grade,
    gradeLow: row.grade_low,
    gradeHigh: row.grade_high,
    confidence: row.confidence ?? '',
    ascensionistCount: Number(row.ascensionist_count ?? 0),
    modelVersion: OFFLINE_MODEL_VERSION,
    computedAt: row.computed_at ?? '',
  };
}

const GRADE_COLUMNS =
  'angle, local_grade, universal_grade, grade_low, grade_high, confidence, ascensionist_count, computed_at';

/** The Boardsesh grade for one climb at one angle, or null when no row exists. */
export async function getBoardseshGradeLocal(
  db: OfflineDatabase,
  input: { boardName: string; climbUuid: string; angle: number },
): Promise<BoardseshGrade | null> {
  const row = await db.getFirstAsync<GradeRow>(
    `SELECT ${GRADE_COLUMNS} FROM board_climb_grades
     WHERE board_type = ? AND climb_uuid = ? AND angle = ? LIMIT 1`,
    [input.boardName, input.climbUuid, input.angle],
  );
  return row ? mapCommon(row) : null;
}

/** Every computed Boardsesh grade for a climb, one row per angle (ascending). */
export async function getBoardseshGradesForAnglesLocal(
  db: OfflineDatabase,
  input: { boardName: string; climbUuid: string },
): Promise<BoardseshGradeAtAngle[]> {
  const rows = await db.getAllAsync<GradeRow>(
    `SELECT ${GRADE_COLUMNS} FROM board_climb_grades
     WHERE board_type = ? AND climb_uuid = ? ORDER BY angle ASC`,
    [input.boardName, input.climbUuid],
  );
  return rows.map((row) => ({ angle: row.angle, ...mapCommon(row) }));
}
