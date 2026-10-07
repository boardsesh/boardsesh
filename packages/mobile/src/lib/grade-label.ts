// Grade-id → label + quality → stars for the offline local-search path, so it
// produces the SAME `difficulty` string ("6a/V3") and `stars` count the server
// does. The id→label map is derived from the shared `BOULDER_GRADES` taxonomy
// (board-constants, re-exported by board-config) rather than re-hardcoded — same
// source the server's grade-lookup uses. getClimbStars mirrors
// packages/db/src/queries/climbs/climb-stars.ts (a tiny pure function, no shared home).

import {
  BOULDER_GRADES,
  MOONBOARD_BOULDER_GRADES,
  getBoulderGradesForBoard,
} from '@boardsesh/board-constants/boulder-grade-mapping';

const GRADE_MAP_BY_TABLE = new Map(
  [BOULDER_GRADES, MOONBOARD_BOULDER_GRADES].map((grades) => [
    grades,
    new Map<number, string>(grades.map((grade) => [grade.difficulty_id, grade.difficulty_name])),
  ]),
);

/**
 * Boulder grade label for a rounded difficulty id on `boardName`'s scale, or ''
 * when out of range / null. MoonBoard labels 16 as "6a/V2"; every other board
 * (and a missing board) as "6a/V3".
 */
export function getGradeLabel(difficultyId: number | null | undefined, boardName?: string | null): string {
  if (difficultyId === null || difficultyId === undefined) return '';
  return GRADE_MAP_BY_TABLE.get(getBoulderGradesForBoard(boardName))?.get(difficultyId) ?? '';
}

// Built from every board's table: a name never means two different ids (the
// MoonBoard table only renames 16 to "6a/V2"), so the lookup needs no board.
const ID_BY_GRADE_NAME: Record<string, number> = Object.fromEntries(
  [...BOULDER_GRADES, ...MOONBOARD_BOULDER_GRADES].map((grade) => [
    grade.difficulty_name.toLowerCase(),
    grade.difficulty_id,
  ]),
);

/**
 * The inverse of {@link getGradeLabel}: a stored grade name ("6a/V3") back to its
 * difficulty id, or null when the string is not a grade on the shared scale.
 *
 * Matched on the whole canonical name, case-insensitively — the same string the
 * server stores in `board_difficulty_grades.boulder_name`. A display label the
 * user's grade-format preference produced ("V3", "6A") deliberately does NOT
 * match: several names collapse onto one V grade, so guessing which one a climb
 * carries would re-grade it.
 */
export function getDifficultyIdForGradeName(gradeName: string | null | undefined): number | null {
  if (!gradeName) return null;
  return ID_BY_GRADE_NAME[gradeName.trim().toLowerCase()] ?? null;
}

const MAX_CLIMB_STARS = 5;

/** Quality average (canonical 1-5) → integer 0-5 star count. Unrated → 0. */
export function getClimbStars(qualityAverage: number | string | null | undefined): number {
  const quality = Number(qualityAverage);
  if (!Number.isFinite(quality) || quality <= 0) return 0;
  return Math.min(MAX_CLIMB_STARS, Math.round(quality));
}

/**
 * The board a cross-board aggregate (a session's grade spread, its hardest
 * grade) can be labelled on: the session's only board, or null when it spans
 * several and no one board's scale is right for every grade in it.
 */
export function getSoleBoardType(boardTypes: readonly string[] | null | undefined): string | null {
  return boardTypes?.length === 1 ? boardTypes[0] : null;
}
