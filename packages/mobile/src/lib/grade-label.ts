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

const MAX_CLIMB_STARS = 5;

/** Quality average (canonical 1-5) → integer 0-5 star count. Unrated → 0. */
export function getClimbStars(qualityAverage: number | string | null | undefined): number {
  const quality = Number(qualityAverage);
  if (!Number.isFinite(quality) || quality <= 0) return 0;
  return Math.min(MAX_CLIMB_STARS, Math.round(quality));
}
