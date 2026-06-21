import type { ClimbStatsHistoryEntry } from '@boardsesh/graphql/operations';
import { formatGrade, type GradeDisplayFormat } from '@boardsesh/play-view';
import { BOULDER_GRADES, type BoulderGrade } from '@boardsesh/board-constants/boulder-grade-mapping';
import { getGradeColor, DEFAULT_GRADE_COLOR } from '@boardsesh/board-constants/grade-colors';

export type AngleGradeBar = {
  angle: number;
  /** Numeric difficulty (Aurora display difficulty) — drives the grade label + colour. */
  difficulty: number;
  /** Formatted grade label shown above the bar (e.g. "V6"). */
  gradeName: string;
  /** Ascensionist count (sends) at this angle — drives bar height. */
  sends: number;
};

// Round a raw step up to a friendly 1/2/5 × 10ⁿ value so axis ticks read
// 0/5/10/15 instead of 0/3/6/9.
export function niceStep(rawStep: number): number {
  if (rawStep <= 1) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  for (const multiple of [1, 2, 5]) {
    if (rawStep <= multiple * magnitude) return multiple * magnitude;
  }
  return 10 * magnitude;
}

// Integer y-scale for an ascent-count column chart: ~4–5 whole-number sections
// with the top tick strictly above the tallest bar so its top-label has headroom.
export function buildAscentScale(maxSends: number): { maxValue: number; noOfSections: number; step: number } {
  const peak = Math.max(maxSends, 1);
  const step = niceStep(Math.ceil(peak / 4));
  let noOfSections = Math.ceil(peak / step);
  if (step * noOfSections <= peak) noOfSections += 1;
  return { maxValue: step * noOfSections, noOfSections, step };
}

const GRADE_BY_ID = new Map<number, BoulderGrade>(BOULDER_GRADES.map((grade) => [grade.difficulty_id, grade]));

// Latest snapshot per angle → one grade bar; out-of-range difficulties show the rounded number.
// The grade (label + colour) comes from the difficulty; bar height comes from the ascent count.
export function buildAngleGradeBars(
  history: ClimbStatsHistoryEntry[] | undefined,
  gradeFormat: GradeDisplayFormat,
): AngleGradeBar[] {
  if (!history) return [];

  const latestByAngle = new Map<number, { entry: ClimbStatsHistoryEntry; difficulty: number }>();
  for (const entry of history) {
    const difficulty = entry.displayDifficulty ?? entry.difficultyAverage;
    if (difficulty == null) continue;
    const existing = latestByAngle.get(entry.angle);
    if (!existing || new Date(entry.createdAt).getTime() > new Date(existing.entry.createdAt).getTime()) {
      latestByAngle.set(entry.angle, { entry, difficulty });
    }
  }

  return Array.from(latestByAngle.values())
    .map(({ entry, difficulty }) => {
      const grade = GRADE_BY_ID.get(Math.round(difficulty));
      const gradeName = grade
        ? (formatGrade(grade.difficulty_name, gradeFormat) ?? grade.v_grade)
        : String(Math.round(difficulty));
      return {
        angle: entry.angle,
        difficulty,
        gradeName,
        sends: entry.ascensionistCount ?? 0,
      };
    })
    .sort((a, b) => a.angle - b.angle);
}

export type AngleStats = {
  /** Formatted grade label (e.g. "V6"), or null when this angle has no stats. */
  gradeName: string | null;
  /** Grade colour, for tinting the grade label. */
  color: string;
  /** Average quality rating (stars), or null when unrated. */
  quality: number | null;
  /** Ascensionist count (sends) at this angle. */
  sends: number;
};

// Latest snapshot per angle → grade + quality + sends, for the angle selector's
// per-angle row stats. Same latest-per-angle logic as buildAngleGradeBars, but
// keyed by angle and carrying quality/sends too. Angles with no difficulty
// snapshot still appear (gradeName null) so their quality/sends can show.
export function buildAngleStatsMap(
  history: ClimbStatsHistoryEntry[] | undefined,
  gradeFormat: GradeDisplayFormat,
): Map<number, AngleStats> {
  const result = new Map<number, AngleStats>();
  if (!history) return result;

  const latestByAngle = new Map<number, ClimbStatsHistoryEntry>();
  for (const entry of history) {
    const existing = latestByAngle.get(entry.angle);
    if (!existing || new Date(entry.createdAt).getTime() > new Date(existing.createdAt).getTime()) {
      latestByAngle.set(entry.angle, entry);
    }
  }

  for (const [angle, entry] of latestByAngle) {
    const difficulty = entry.displayDifficulty ?? entry.difficultyAverage;
    const grade = difficulty == null ? undefined : GRADE_BY_ID.get(Math.round(difficulty));
    let gradeName: string | null = null;
    if (grade) {
      gradeName = formatGrade(grade.difficulty_name, gradeFormat) ?? grade.v_grade;
    } else if (difficulty != null) {
      gradeName = String(Math.round(difficulty));
    }
    result.set(angle, {
      gradeName,
      color: getGradeColor(grade?.difficulty_name) ?? DEFAULT_GRADE_COLOR,
      quality: entry.qualityAverage,
      sends: entry.ascensionistCount ?? 0,
    });
  }

  return result;
}
