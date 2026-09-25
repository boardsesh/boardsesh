import type { HoldStat } from '@boardsesh/shared-schema';
import { V_GRADE_COLORS } from '@boardsesh/board-constants/grade-colors';
import { difficultyIdToVNumber } from '@boardsesh/board-constants/grade-conversion';

/**
 * What the heatmap colours a hold by in the play drawer:
 * - `climbs` — how many of the matched climbs use it (the default);
 * - `startsFinishes` — how many of them start or finish on it;
 * - `grade` — the average grade of those climbs, pulled toward the board's
 *   mean when only a few climbs use the hold.
 */
export type HeatmapMode = 'climbs' | 'startsFinishes' | 'grade';

export const HEATMAP_MODES: readonly HeatmapMode[] = ['climbs', 'startsFinishes', 'grade'];

/**
 * The count a hold is ranked by. The three drawer modes, plus the four the
 * create board follows as the setter switches brush (`starts` for the Start
 * brush, and so on). `grade` is the one that is not a count.
 */
export type HeatMetric = HeatmapMode | 'starts' | 'hands' | 'feet' | 'finishes';

/**
 * Lower edge of each of the five buckets, as a mid-rank percentile. Nothing is
 * drawn below the first edge: the coldest fifth of the board is the wall
 * itself, and colouring it is what turned v1 into a sheet of orange.
 */
export const HEAT_BUCKET_EDGES = [0.2, 0.4, 0.6, 0.8, 0.95] as const;

/**
 * Synthetic hold-state codes for the five buckets. Any code with a colour in
 * `hold_state_map` renders as a fill (the Rust parser colours whatever the map
 * names, and an unknown role gets no glyph); 900+ is clear of every board's
 * real codes (the highest today is 48).
 */
export const HEAT_BUCKET_CODES = [900, 901, 902, 903, 904] as const;

/** Grade mode: `910 + V number`, one code per grade colour (V0–V17 → 910–927). */
export const GRADE_CODE_BASE = 910;

/** Grade mode hides a hold used by fewer climbs than this. */
export const GRADE_MIN_CLIMBS = 5;

/** Grade mode's prior weight: a hold's average counts as `n` climbs against 20 at the board mean. */
export const GRADE_PRIOR_WEIGHT = 20;

/** The count `metric` ranks a hold by; 0 means the hold has nothing to show. */
export function heatMetricCount(holdStat: HoldStat, metric: Exclude<HeatMetric, 'grade'>): number {
  switch (metric) {
    case 'climbs':
      return holdStat.totalUses;
    case 'startsFinishes':
      return holdStat.startingUses + holdStat.finishUses;
    case 'starts':
      return holdStat.startingUses;
    // A hand hold is also where a climb starts and finishes: the Hand brush
    // asks "where do people put their hands", and starts and finishes are hands.
    case 'hands':
      return holdStat.handUses + holdStat.startingUses + holdStat.finishUses;
    case 'feet':
      return holdStat.footUses;
    case 'finishes':
      return holdStat.finishUses;
  }
}

/**
 * Mid-rank percentile of every value: `(values below + half the values equal) / n`.
 * Ties share one percentile, so a board where half the holds are used once
 * never splits them across buckets by accident of order.
 */
export function midRankPercentiles(values: readonly number[]): number[] {
  const total = values.length;
  if (total === 0) return [];
  const order = values.map((value, index) => ({ value, index })).sort((left, right) => left.value - right.value);
  const percentiles = new Array<number>(total);
  let groupStart = 0;
  while (groupStart < total) {
    let groupEnd = groupStart;
    while (groupEnd + 1 < total && order[groupEnd + 1].value === order[groupStart].value) groupEnd++;
    const equalCount = groupEnd - groupStart + 1;
    const percentile = (groupStart + 0.5 * equalCount) / total;
    for (let position = groupStart; position <= groupEnd; position++) percentiles[order[position].index] = percentile;
    groupStart = groupEnd + 1;
  }
  return percentiles;
}

/** Bucket 0–4 for a percentile, or null below the first edge (not drawn). */
export function heatBucketIndex(percentile: number): number | null {
  if (!Number.isFinite(percentile) || percentile < HEAT_BUCKET_EDGES[0]) return null;
  let bucket = 0;
  for (let index = 1; index < HEAT_BUCKET_EDGES.length; index++) {
    if (percentile >= HEAT_BUCKET_EDGES[index]) bucket = index;
  }
  return bucket;
}

/**
 * Grade mode's per-hold estimate: `(n·avg + k·μ) / (n + k)`. A hold three
 * climbs use lands near the board mean instead of claiming V12 because one of
 * the three is.
 */
export function shrunkDifficulty(
  averageDifficulty: number,
  climbCount: number,
  boardMeanDifficulty: number,
  priorWeight = GRADE_PRIOR_WEIGHT,
): number {
  return (climbCount * averageDifficulty + priorWeight * boardMeanDifficulty) / (climbCount + priorWeight);
}

/** The app's grade colour for a difficulty id, or null off the grade table. */
export function gradeColorForDifficulty(difficulty: number): { vNumber: number; color: string } | null {
  const vNumber = difficultyIdToVNumber(difficulty);
  if (vNumber === null) return null;
  const color = V_GRADE_COLORS[`V${vNumber}`];
  return color ? { vNumber, color } : null;
}

/** One hold the heatmap draws. `bucket` is 0–4 (for grade mode: by how many climbs use it). */
export type HeatCell = {
  holdId: number;
  bucket: number;
  code: number;
  color: string;
};

export type HeatLegend =
  | {
      kind: 'count';
      /**
       * The real count at the bottom of each bucket (the smallest value that
       * landed in it), or null for a bucket nothing landed in. Non-decreasing.
       */
      edgeValues: (number | null)[];
      /** The largest count on the board: the top of the last bucket. */
      total: number;
    }
  | {
      kind: 'grade';
      /** Easiest and hardest V number drawn, or null when nothing is. */
      lowVNumber: number | null;
      highVNumber: number | null;
      /** Five grade colours spanning low → high, for the legend swatches. */
      swatches: string[];
    };

export type HeatLayer = {
  cells: HeatCell[];
  /** Code → colour for every code `cells` uses, ready for `extraHoldStates`. */
  codeColors: Record<number, { color: string }>;
  legend: HeatLegend;
};

export type BuildHeatLayerParams = {
  statsByHoldId: ReadonlyMap<number, HoldStat>;
  /** The holds this board can draw, in any order. Stats for other ids are ignored. */
  holdIds: readonly number[];
  metric: HeatMetric;
  /** `theme.heatRamp`, few → many. */
  ramp: readonly string[];
  /**
   * Holds that keep their own mark (painted on the create board). Ranked with
   * the rest, so painting a hold never recolours its neighbours, but not drawn.
   */
  skipHoldIds?: ReadonlySet<number>;
};

const EMPTY_COUNT_LEGEND: HeatLegend = { kind: 'count', edgeValues: [null, null, null, null, null], total: 0 };

/**
 * Pure: which holds the heatmap draws, in which colour, and what the legend
 * says. Counts are ranked (mid-rank percentile) and bucketed, so each bucket
 * holds about a fifth of the used holds whatever the board's distribution —
 * v1's `log1p(v)/log1p(max)` put ~90% of a board in the top two buckets.
 */
export function buildHeatLayer({ statsByHoldId, holdIds, metric, ramp, skipHoldIds }: BuildHeatLayerParams): HeatLayer {
  if (metric === 'grade') return buildGradeLayer(statsByHoldId, holdIds, skipHoldIds);

  const ranked: { holdId: number; value: number }[] = [];
  for (const holdId of holdIds) {
    const holdStat = statsByHoldId.get(holdId);
    if (!holdStat) continue;
    const value = heatMetricCount(holdStat, metric);
    if (value > 0) ranked.push({ holdId, value });
  }
  if (ranked.length === 0) return { cells: [], codeColors: {}, legend: EMPTY_COUNT_LEGEND };

  const percentiles = midRankPercentiles(ranked.map((entry) => entry.value));
  const edgeValues: (number | null)[] = [null, null, null, null, null];
  let total = 0;
  const cells: HeatCell[] = [];
  const codeColors: Record<number, { color: string }> = {};
  ranked.forEach(({ holdId, value }, index) => {
    if (value > total) total = value;
    const bucket = heatBucketIndex(percentiles[index]);
    if (bucket === null) return;
    const lowest = edgeValues[bucket];
    if (lowest === null || value < lowest) edgeValues[bucket] = value;
    if (skipHoldIds?.has(holdId)) return;
    const code = HEAT_BUCKET_CODES[bucket];
    const color = ramp[bucket] ?? ramp[ramp.length - 1];
    codeColors[code] = { color };
    cells.push({ holdId, bucket, code, color });
  });
  return { cells, codeColors, legend: { kind: 'count', edgeValues, total } };
}

function buildGradeLayer(
  statsByHoldId: ReadonlyMap<number, HoldStat>,
  holdIds: readonly number[],
  skipHoldIds: ReadonlySet<number> | undefined,
): HeatLayer {
  // The board mean, weighted by climbs: every hold's average is over the same
  // climbs, so this is the grade a random hold-use lands on.
  let weightedSum = 0;
  let weight = 0;
  const graded: { holdId: number; average: number; climbCount: number }[] = [];
  for (const holdId of holdIds) {
    const holdStat = statsByHoldId.get(holdId);
    if (!holdStat || holdStat.averageDifficulty == null || holdStat.totalUses <= 0) continue;
    weightedSum += holdStat.averageDifficulty * holdStat.totalUses;
    weight += holdStat.totalUses;
    if (holdStat.totalUses >= GRADE_MIN_CLIMBS) {
      graded.push({ holdId, average: holdStat.averageDifficulty, climbCount: holdStat.totalUses });
    }
  }
  if (graded.length === 0 || weight === 0) {
    return { cells: [], codeColors: {}, legend: { kind: 'grade', lowVNumber: null, highVNumber: null, swatches: [] } };
  }
  const boardMean = weightedSum / weight;
  // Size by rank of n: the bucket says how many climbs back the colour. Every
  // shown hold is drawn (the n < 5 cut already dropped the thin ones).
  const percentiles = midRankPercentiles(graded.map((entry) => entry.climbCount));

  const cells: HeatCell[] = [];
  const codeColors: Record<number, { color: string }> = {};
  let lowVNumber: number | null = null;
  let highVNumber: number | null = null;
  graded.forEach(({ holdId, average, climbCount }, index) => {
    const grade = gradeColorForDifficulty(shrunkDifficulty(average, climbCount, boardMean));
    if (!grade) return;
    if (lowVNumber === null || grade.vNumber < lowVNumber) lowVNumber = grade.vNumber;
    if (highVNumber === null || grade.vNumber > highVNumber) highVNumber = grade.vNumber;
    if (skipHoldIds?.has(holdId)) return;
    const code = GRADE_CODE_BASE + grade.vNumber;
    codeColors[code] = { color: grade.color };
    cells.push({ holdId, bucket: heatBucketIndex(percentiles[index]) ?? 0, code, color: grade.color });
  });
  return {
    cells,
    codeColors,
    legend: { kind: 'grade', lowVNumber, highVNumber, swatches: gradeSwatches(lowVNumber, highVNumber) },
  };
}

/** Five grade colours evenly spanning `low → high` (repeats when the span is narrow). */
export function gradeSwatches(lowVNumber: number | null, highVNumber: number | null): string[] {
  if (lowVNumber === null || highVNumber === null) return [];
  const swatches: string[] = [];
  for (let step = 0; step < 5; step++) {
    const vNumber = Math.round(lowVNumber + ((highVNumber - lowVNumber) * step) / 4);
    const color = V_GRADE_COLORS[`V${vNumber}`];
    if (color) swatches.push(color);
  }
  return swatches;
}

/**
 * The frames string the renderer draws the layer from: `p{id}r{code}` per cell.
 * Sorted by hold id so the same heat always hashes to the same cache key.
 */
export function heatLayerFrames(cells: readonly HeatCell[]): string {
  return [...cells]
    .sort((left, right) => left.holdId - right.holdId)
    .map((cell) => `p${cell.holdId}r${cell.code}`)
    .join('');
}
