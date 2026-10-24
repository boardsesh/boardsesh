/**
 * Pure counting logic behind analyze-workout-candidates.ts (#6232).
 *
 * The SQL side reduces every climb at a board/layout/angle to a tier on each
 * quality axis, so the filter grid (minAscents x minRating x benchmark) is
 * evaluated here, in memory, with no further database work.
 */
import {
  DEFAULT_GRADE_FOCUS_OPTIONS,
  DEFAULT_LADDER_OPTIONS,
  DEFAULT_PYRAMID_OPTIONS,
  DEFAULT_VOLUME_OPTIONS,
  generateWorkoutPlan,
  type GeneratorGradeScale,
  type GeneratorOptions,
} from '@boardsesh/playlist-generator';

/** The `minAscents` thresholds the workout filters can take (0 means no filter). */
export const MIN_ASCENTS_THRESHOLDS = [0, 1, 5, 10, 50, 100] as const;
/** The `minRating` thresholds (0 means no filter). */
export const MIN_RATING_THRESHOLDS = [0, 2, 3, 3.5] as const;

/** Workout defaults today (packages/shared/playlist-generator/src/types.ts). */
export const DEFAULT_MIN_ASCENTS = 5;
export const DEFAULT_MIN_RATING = 2;

/**
 * Index of the highest threshold a value meets. A missing value (no stats
 * figure) only passes the 0 threshold, which is how the server treats it:
 * `minAscents`/`minRating` of 0 add no condition, and `NULL >= n` is not true.
 */
export function tierOf(value: number | null, thresholds: readonly number[]): number {
  let tier = 0;
  if (value === null || Number.isNaN(value)) return tier;
  for (const [index, threshold] of thresholds.entries()) {
    if (value >= threshold) tier = index;
  }
  return tier;
}

export interface TierGroup {
  /** Rounded display_difficulty, the grade the preview searches on. */
  grade: number;
  ascentsTier: number;
  ratingTier: number;
  isBenchmark: boolean;
  climbs: number;
}

export interface FilterCombo {
  minAscents: number;
  minRating: number;
  benchmarksOnly: boolean;
}

export function allFilterCombos(): FilterCombo[] {
  const combos: FilterCombo[] = [];
  for (const benchmarksOnly of [false, true]) {
    for (const minRating of MIN_RATING_THRESHOLDS) {
      for (const minAscents of MIN_ASCENTS_THRESHOLDS) {
        combos.push({ minAscents, minRating, benchmarksOnly });
      }
    }
  }
  return combos;
}

/**
 * Tier index of a filter value. Groups only carry tiers, so a value that is not
 * one of the thresholds cannot be answered; `indexOf`'s -1 would pass every
 * group and quietly report the unfiltered count.
 */
function thresholdTier(name: string, value: number, thresholds: readonly number[]): number {
  const tier = thresholds.indexOf(value);
  if (tier === -1) throw new Error(`${name} ${value} is not one of the measured thresholds (${thresholds.join(', ')})`);
  return tier;
}

/** Climbs per grade that pass one filter combo. Throws for a threshold outside the measured grid. */
export function countByGrade(groups: readonly TierGroup[], combo: FilterCombo): Map<number, number> {
  const ascentsTier = thresholdTier('minAscents', combo.minAscents, MIN_ASCENTS_THRESHOLDS);
  const ratingTier = thresholdTier('minRating', combo.minRating, MIN_RATING_THRESHOLDS);
  const counts = new Map<number, number>();
  for (const group of groups) {
    if (group.ascentsTier < ascentsTier) continue;
    if (group.ratingTier < ratingTier) continue;
    if (combo.benchmarksOnly && !group.isBenchmark) continue;
    counts.set(group.grade, (counts.get(group.grade) ?? 0) + group.climbs);
  }
  return counts;
}

/**
 * A plan shape is a generator option set. The demand per grade is read off the
 * slots `generateWorkoutPlan` really produces, so the shapes cannot drift from
 * the app (the pyramid is 1/2/2 climbs on the peak and the two grades below it,
 * not one climb on five descending grades).
 */
export interface PlanShape {
  name: string;
  options: Omit<GeneratorOptions, 'targetGrade'>;
}

export const PLAN_SHAPES: readonly PlanShape[] = [
  { name: 'volume 20 at one grade', options: DEFAULT_VOLUME_OPTIONS },
  { name: 'grade focus 15', options: DEFAULT_GRADE_FOCUS_OPTIONS },
  { name: 'pyramid 5 steps x 1', options: DEFAULT_PYRAMID_OPTIONS },
  { name: 'ladder 5 steps x 2', options: DEFAULT_LADDER_OPTIONS },
];

/** Climbs the generator asks for at each grade id when aimed at `targetGrade`. */
export function planDemand(scale: GeneratorGradeScale, targetGrade: number, shape: PlanShape): Map<number, number> {
  const slots = generateWorkoutPlan({ ...shape.options, targetGrade } as GeneratorOptions, scale);
  const demand = new Map<number, number>();
  for (const slot of slots) demand.set(slot.grade, (demand.get(slot.grade) ?? 0) + 1);
  return demand;
}

/**
 * Does the plan fill when aimed at `targetGrade`? `scale` is the board's real
 * grade table (`getGradesForBoard`), including grades no climb sits on: the
 * generator walks that table, so a gap in the catalogue is a grade with demand
 * and 0 climbs.
 */
export function planFills(
  counts: ReadonlyMap<number, number>,
  scale: GeneratorGradeScale,
  targetGrade: number,
  shape: PlanShape,
): boolean {
  const demand = planDemand(scale, targetGrade, shape);
  if (demand.size === 0) return false;
  return [...demand].every(([grade, needed]) => (counts.get(grade) ?? 0) >= needed);
}

/**
 * The grades a climber realistically targets: the 10th to 90th percentile of
 * the unfiltered catalogue's grade distribution, inclusive, restricted to
 * grades on the scale. Extremes with a handful of climbs would otherwise
 * dominate every fill rate.
 */
export function coreGradeBand(groups: readonly TierGroup[]): number[] {
  const perGrade = countByGrade(groups, { minAscents: 0, minRating: 0, benchmarksOnly: false });
  const grades = [...perGrade.keys()].sort((first, second) => first - second);
  const total = grades.reduce((sum, grade) => sum + (perGrade.get(grade) ?? 0), 0);
  if (total === 0) return [];
  let running = 0;
  let low = grades[0];
  let high = grades[grades.length - 1];
  let lowSet = false;
  for (const grade of grades) {
    running += perGrade.get(grade) ?? 0;
    if (!lowSet && running / total >= 0.1) {
      low = grade;
      lowSet = true;
    }
    if (running / total >= 0.9) {
      high = grade;
      break;
    }
  }
  return grades.filter((grade) => grade >= low && grade <= high);
}

export interface ComboResult {
  combo: FilterCombo;
  totalClimbs: number;
  /** Median climbs per band grade. */
  medianPerGrade: number;
  /** Fewest climbs at any band grade. */
  minPerGrade: number;
  /** Share of band grades (0..1) where each plan shape fills. */
  fillRates: Record<string, number>;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function evaluateCombo(
  groups: readonly TierGroup[],
  band: readonly number[],
  combo: FilterCombo,
  scale: GeneratorGradeScale,
): ComboResult {
  const counts = countByGrade(groups, combo);
  const bandCounts = band.map((grade) => counts.get(grade) ?? 0);
  const fillRates: Record<string, number> = {};
  for (const shape of PLAN_SHAPES) {
    const filled = band.filter((grade) => planFills(counts, scale, grade, shape)).length;
    fillRates[shape.name] = band.length === 0 ? 0 : filled / band.length;
  }
  return {
    combo,
    totalClimbs: [...counts.values()].reduce((sum, value) => sum + value, 0),
    medianPerGrade: median(bandCounts),
    minPerGrade: bandCounts.length === 0 ? 0 : Math.min(...bandCounts),
    fillRates,
  };
}

export interface CatalogueTarget {
  boardType: string;
  layoutId: number;
  angle: number;
}

export interface CatalogueResult {
  target: CatalogueTarget;
  band: number[];
  unfilteredClimbs: number;
  benchmarkClimbs: number;
  results: ComboResult[];
}

export function evaluateCatalogue(
  target: CatalogueTarget,
  groups: readonly TierGroup[],
  scale: GeneratorGradeScale,
): CatalogueResult {
  const band = coreGradeBand(groups);
  const results = allFilterCombos().map((combo) => evaluateCombo(groups, band, combo, scale));
  const unfiltered = results.find(
    ({ combo }) => combo.minAscents === 0 && combo.minRating === 0 && !combo.benchmarksOnly,
  );
  const benchmarks = results.find(
    ({ combo }) => combo.minAscents === 0 && combo.minRating === 0 && combo.benchmarksOnly,
  );
  return {
    target,
    band,
    unfilteredClimbs: unfiltered?.totalClimbs ?? 0,
    benchmarkClimbs: benchmarks?.totalClimbs ?? 0,
    results,
  };
}

function percent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

export function findResult(catalogue: CatalogueResult, combo: FilterCombo): ComboResult | undefined {
  return catalogue.results.find(
    (result) =>
      result.combo.minAscents === combo.minAscents &&
      result.combo.minRating === combo.minRating &&
      result.combo.benchmarksOnly === combo.benchmarksOnly,
  );
}

/** One markdown row per catalogue for a given filter combo. */
export function summaryRow(catalogue: CatalogueResult, combo: FilterCombo): string {
  const result = findResult(catalogue, combo);
  if (!result) return '';
  const { boardType, layoutId, angle } = catalogue.target;
  const band = catalogue.band.length === 0 ? '-' : `${catalogue.band[0]}-${catalogue.band[catalogue.band.length - 1]}`;
  const fills = PLAN_SHAPES.map((shape) => percent(result.fillRates[shape.name] ?? 0));
  return `| ${boardType} | ${layoutId} | ${angle} | ${band} | ${result.totalClimbs} | ${result.medianPerGrade} | ${result.minPerGrade} | ${fills.join(' | ')} |`;
}

export const SUMMARY_HEADER = [
  `| board | layout | angle | core grades | climbs | median per grade | fewest per grade | ${PLAN_SHAPES.map((shape) => shape.name).join(' | ')} |`,
  `| --- | --- | --- | --- | --- | --- | --- | ${PLAN_SHAPES.map(() => '---').join(' | ')} |`,
].join('\n');
