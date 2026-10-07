import {
  BOULDER_GRADES,
  MOONBOARD_BOULDER_GRADES,
  getBoulderGradesForBoard,
} from '@boardsesh/board-constants/boulder-grade-mapping';

/**
 * Static grade lookup for converting difficulty IDs to boulder grade names.
 * Replaces the board_difficulty_grades JOIN in search queries.
 *
 * The difficulty_id values match the `difficulty` column in board_difficulty_grades,
 * and so do the names, per board: every board shares one table except MoonBoard,
 * which labels 16 as "6a/V2" (Moon converts 6A to V2; see migration 0257).
 */
const GRADE_MAP_BY_TABLE = new Map(
  [BOULDER_GRADES, MOONBOARD_BOULDER_GRADES].map((grades) => [
    grades,
    new Map<number, string>(grades.map((grade) => [grade.difficulty_id, grade.difficulty_name])),
  ]),
);

// Track warned IDs to avoid log spam
const warnedIds = new Set<number>();

/**
 * Look up the boulder grade name for a rounded difficulty ID on `boardName`'s
 * scale (the shared one when the board is missing or unknown).
 * Returns empty string if the ID is not found (e.g., null display_difficulty).
 */
export function getGradeLabel(difficultyId: number | null, boardName?: string | null): string {
  if (difficultyId === null || difficultyId === undefined) return '';
  // Callers selecting ROUND(...::numeric) are typed `number` but postgres.js
  // hands numerics back as strings ("16"). Map keys don't coerce the way the
  // old object lookup did, so normalise before the lookup.
  const numericId = Number(difficultyId);
  const label = GRADE_MAP_BY_TABLE.get(getBoulderGradesForBoard(boardName))?.get(numericId);
  if (label === undefined && !warnedIds.has(numericId)) {
    warnedIds.add(numericId);
    console.warn(`[grade-lookup] Unknown difficulty ID: ${difficultyId} — not in grade map (range 10-33)`);
  }
  return label ?? '';
}
