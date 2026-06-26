import type { ClimbStatsHistoryEntry } from '@boardsesh/graphql/operations';
import { formatGrade, type GradeDisplayFormat } from '@boardsesh/play-view';
import { BOULDER_GRADES, type BoulderGrade } from '@boardsesh/board-constants/boulder-grade-mapping';
import { getGradeColor, DEFAULT_GRADE_COLOR } from '@boardsesh/board-constants/grade-colors';
import { formatCount } from '../../lib/format-climb-stats';

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

export type AscentChartScale = {
  /** Top of the y-axis in plotted units. */
  maxValue: number;
  noOfSections: number;
  /** Tick labels bottom→top, one per section boundary (noOfSections + 1 entries). */
  yAxisLabelTexts: string[];
  /** Maps a raw ascent count to the value plotted on the chart — identity on a
   *  linear axis, a log10 position on a log axis. */
  plot: (sends: number) => number;
  /** True when the y-axis is logarithmic. */
  isLog: boolean;
};

// A log axis only earns its keep once one angle dwarfs the rest: a climb sent
// 2,000× at 40° but twice at 15° draws the 15° bar one pixel tall on a linear
// axis. Past this peak and spread we switch to log10 so the rarely-climbed
// angles stay legible; tighter spreads keep the linear axis, since log would
// squash near-equal bars into one indistinguishable band.
const LOG_MIN_PEAK = 50;
const LOG_SPREAD_RATIO = 30;

// Y-scale for the ascents-by-angle chart. Picks a linear or log axis from the
// spread of counts and returns everything the chart needs to plot + label it.
export function buildAscentChartScale(sends: number[]): AscentChartScale {
  const counts = sends.filter((count) => count > 0);
  const peak = counts.length ? Math.max(...counts) : 0;
  const floor = counts.length ? Math.min(...counts) : 0;
  const useLog = peak >= LOG_MIN_PEAK && floor > 0 && peak / floor >= LOG_SPREAD_RATIO;

  if (useLog) {
    // One section per power of ten. Section 1 is a count of 1 (10⁰), so a single
    // ascent still draws a visible bar; the zero baseline sits below it.
    const top = Math.log10(peak) + 1;
    let noOfSections = Math.ceil(top);
    // Keep the top tick strictly above the tallest bar for top-label headroom.
    if (noOfSections <= top) noOfSections += 1;
    const yAxisLabelTexts = Array.from({ length: noOfSections + 1 }, (_, index) =>
      index === 0 ? '0' : formatCount(10 ** (index - 1)),
    );
    return {
      maxValue: noOfSections,
      noOfSections,
      yAxisLabelTexts,
      plot: (count: number) => (count > 0 ? Math.log10(count) + 1 : 0),
      isLog: true,
    };
  }

  const { maxValue, noOfSections, step } = buildAscentScale(peak);
  const yAxisLabelTexts = Array.from({ length: noOfSections + 1 }, (_, index) => formatCount(index * step));
  return { maxValue, noOfSections, yAxisLabelTexts, plot: (count: number) => count, isLog: false };
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
