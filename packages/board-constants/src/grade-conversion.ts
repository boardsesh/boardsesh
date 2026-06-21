/**
 * Cross-board grade conversion for the recommendation engine.
 *
 * The difficulty-id -> V-grade *scale* is identical across every Aurora board
 * and MoonBoard (see board_difficulty_grades / BOULDER_GRADES): difficulty 18
 * is "6b/V4" everywhere. MoonBoard grading nevertheless climbs hard relative to
 * Kilter/Tension, so we apply a fixed perceived-difficulty shift in V-space when
 * estimating a climber's ability from MoonBoard sends — a climber whose hardest
 * MoonBoard send is V4 climbs around V6 on Kilter.
 */
import { BOULDER_GRADES } from './boulder-grade-mapping';
import type { BoardName } from './types';

/** MoonBoard de-sandbag, in V-grades: MoonBoard V4 ≈ Kilter V6. */
export const MOONBOARD_SANDBAG_V_OFFSET = 2;

/** Parse the integer V number from a `v_grade` like "V5" -> 5. */
function parseVNumber(vGrade: string): number | null {
  const match = /^V(\d+)$/.exec(vGrade);
  return match ? Number(match[1]) : null;
}

/** Map a (possibly float) difficulty id to its V number, or null if unknown. */
export function difficultyIdToVNumber(difficultyId: number): number | null {
  const rounded = Math.round(difficultyId);
  const grade = BOULDER_GRADES.find((g) => g.difficulty_id === rounded);
  return grade ? parseVNumber(grade.v_grade) : null;
}

/**
 * A send's V number adjusted for cross-board ability comparison: MoonBoard sends
 * are shifted up by {@link MOONBOARD_SANDBAG_V_OFFSET}; every other board is
 * unchanged. Returns null when the difficulty id is outside the grade table.
 */
export function effectiveSendVNumber(boardType: BoardName | string, difficultyId: number): number | null {
  const v = difficultyIdToVNumber(difficultyId);
  if (v === null) return null;
  return boardType === 'moonboard' ? v + MOONBOARD_SANDBAG_V_OFFSET : v;
}

const V_NUMBERS = BOULDER_GRADES.map((grade) => parseVNumber(grade.v_grade)).filter(
  (value): value is number => value !== null,
);
const MIN_V = Math.min(...V_NUMBERS);
const MAX_V = Math.max(...V_NUMBERS);

/**
 * Inclusive difficulty-id band for a V band of
 * `[maxV - gradesBelow, maxV + gradesAbove]` (each V spans 1-2 ids). The lower
 * bound is the lowest difficulty id at the bottom V; the upper bound the highest
 * difficulty id at the top V. The V band is clamped to the table's range.
 * Returns null when nothing maps (e.g. a nonsensical maxV).
 */
export function gradeBandToDifficultyIds(
  maxV: number,
  gradesBelow = 3,
  gradesAbove = 1,
): { minDifficultyId: number; maxDifficultyId: number } | null {
  const lowV = Math.max(MIN_V, maxV - gradesBelow);
  const highV = Math.min(MAX_V, maxV + gradesAbove);
  if (lowV > highV) return null;

  const idsAtOrAboveLow = BOULDER_GRADES.filter((grade) => {
    const v = parseVNumber(grade.v_grade);
    return v !== null && v >= lowV;
  });
  const idsAtOrBelowHigh = BOULDER_GRADES.filter((grade) => {
    const v = parseVNumber(grade.v_grade);
    return v !== null && v <= highV;
  });
  if (idsAtOrAboveLow.length === 0 || idsAtOrBelowHigh.length === 0) return null;

  return {
    minDifficultyId: Math.min(...idsAtOrAboveLow.map((grade) => grade.difficulty_id)),
    maxDifficultyId: Math.max(...idsAtOrBelowHigh.map((grade) => grade.difficulty_id)),
  };
}
