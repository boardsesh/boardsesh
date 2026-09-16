// Grade-id → label + quality → stars for the offline local-search path, so it
// produces the SAME `difficulty` string ("6a/V3") and `stars` count the server
// does. The id→label map is derived from the shared `BOULDER_GRADES` taxonomy
// (board-constants, re-exported by board-config) rather than re-hardcoded — same
// source the server's grade-lookup uses. getClimbStars mirrors
// packages/db/src/queries/climbs/climb-stars.ts (a tiny pure function, no shared home).

import { BOULDER_GRADES } from '@boardsesh/board-config';

const GRADE_MAP: Record<number, string> = Object.fromEntries(
  BOULDER_GRADES.map((grade) => [grade.difficulty_id, grade.difficulty_name]),
);

/** Boulder grade label for a rounded difficulty id, or '' when out of range / null. */
export function getGradeLabel(difficultyId: number | null | undefined): string {
  if (difficultyId === null || difficultyId === undefined) return '';
  return GRADE_MAP[difficultyId] ?? '';
}

const ID_BY_GRADE_NAME: Record<string, number> = Object.fromEntries(
  BOULDER_GRADES.map((grade) => [grade.difficulty_name.toLowerCase(), grade.difficulty_id]),
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
