import { sql, type SQL } from 'drizzle-orm';
import {
  GATE_BENCHMARK_MAX_COVERAGE,
  GATE_BENCHMARK_MIN_COVERAGE,
  GATE_BENCHMARK_MIN_ROWS,
  GATE_BENCHMARK_REGRESSION_TOLERANCE,
  GATE_BENCHMARK_SEGMENT_MIN_ROWS,
  GATE_BENCHMARK_SEGMENT_TOLERANCE,
  STAGE2_DEECHO_MAX_MOVE,
  TENSION_BENCHMARK_HOLDOUT_MODULUS,
  TENSION_BENCHMARK_HOLDOUT_REMAINDER,
} from './constants';
import { gradeBandForDifficulty } from './blend';
import type { GateResult } from './types';

export interface TensionBenchmarkHoldoutRow {
  climb_uuid: string;
  angle: number;
  display_difficulty: number;
  benchmark_difficulty: number;
  ascensionist_count: number;
}

export interface TensionBenchmarkPrediction {
  climbUuid: string;
  angle: number;
  displayDifficulty: number;
  benchmarkDifficulty: number;
  ascensionistCount: number;
  stage1Grade: number | null;
  stage1Low: number | null;
  stage1High: number | null;
  stage2Grade: number | null;
  stage2Low: number | null;
  stage2High: number | null;
}

export function buildTensionBenchmarkHoldoutPredicate(): SQL {
  return sql`
    s.board_type = 'tension'
    AND s.benchmark_difficulty IS NOT NULL
    AND ABS(('x' || SUBSTR(md5(s.climb_uuid || ':' || s.angle::text), 1, 8))::bit(32)::int)
      % ${TENSION_BENCHMARK_HOLDOUT_MODULUS} = ${TENSION_BENCHMARK_HOLDOUT_REMAINDER}
  `;
}

export function buildTensionBenchmarkHoldoutSql(): SQL {
  return sql`
    SELECT s.climb_uuid,
           s.angle,
           s.display_difficulty,
           s.benchmark_difficulty,
           COALESCE(s.ascensionist_count, 0)::int AS ascensionist_count
    FROM board_climb_stats s
    JOIN board_climbs bc ON bc.board_type = s.board_type AND bc.uuid = s.climb_uuid
    WHERE s.board_type = 'tension'
      AND s.benchmark_difficulty IS NOT NULL
      AND s.display_difficulty IS NOT NULL
      AND bc.is_listed = true
      AND COALESCE(bc.is_draft, false) = false
      AND ${buildTensionBenchmarkHoldoutPredicate()}
  `;
}

function finiteNumber(value: number | null): value is number {
  return value !== null && Number.isFinite(value);
}

function meanAbsoluteError(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + Math.abs(value), 0) / values.length;
}

function bootstrapImprovementLowerBound(improvements: number[]): number {
  if (improvements.length === 0) return 0;
  let seed = 3543;
  const samples: number[] = [];
  for (let sampleIndex = 0; sampleIndex < 200; sampleIndex++) {
    let sum = 0;
    for (let drawIndex = 0; drawIndex < improvements.length; drawIndex++) {
      seed = (1664525 * seed + 1013904223) >>> 0;
      const pickedIndex = seed % improvements.length;
      sum += improvements[pickedIndex];
    }
    samples.push(sum / improvements.length);
  }
  samples.sort((left, right) => left - right);
  return samples[Math.floor(samples.length * 0.025)] ?? 0;
}

export function evaluateTensionBenchmarkHoldout(predictions: TensionBenchmarkPrediction[]): GateResult[] {
  const scored = predictions.filter(
    (prediction) => finiteNumber(prediction.stage1Grade) && finiteNumber(prediction.stage2Grade),
  );
  const displayErrors = scored.map((prediction) => prediction.displayDifficulty - prediction.benchmarkDifficulty);
  const stage1Errors = scored.map((prediction) => (prediction.stage1Grade as number) - prediction.benchmarkDifficulty);
  const stage2Errors = scored.map((prediction) => (prediction.stage2Grade as number) - prediction.benchmarkDifficulty);
  const pairedImprovements = scored.map(
    (prediction) =>
      Math.abs((prediction.stage1Grade as number) - prediction.benchmarkDifficulty) -
      Math.abs((prediction.stage2Grade as number) - prediction.benchmarkDifficulty),
  );

  const displayMae = meanAbsoluteError(displayErrors);
  const stage1Mae = meanAbsoluteError(stage1Errors);
  const stage2Mae = meanAbsoluteError(stage2Errors);
  const improvement = stage1Mae > 0 ? 1 - stage2Mae / stage1Mae : 0;
  const improvementLower95 = bootstrapImprovementLowerBound(pairedImprovements);
  const benchmarkGate: GateResult = {
    gate: 'deherded_tension_benchmark',
    passed: scored.length >= GATE_BENCHMARK_MIN_ROWS && stage2Mae <= stage1Mae + GATE_BENCHMARK_REGRESSION_TOLERANCE,
    detail:
      `holdout n=${scored.length}: Stage 2 MAE ${stage2Mae.toFixed(3)} vs Stage 1 ${stage1Mae.toFixed(3)} ` +
      `(${(improvement * 100).toFixed(1)}% vs Stage 1); display report-only MAE ${displayMae.toFixed(3)}`,
    metrics: {
      n: scored.length,
      displayMae,
      stage1Mae,
      stage2Mae,
      improvement,
      improvementLower95,
      tolerance: GATE_BENCHMARK_REGRESSION_TOLERANCE,
    },
  };

  const missingIntervalRows = scored.filter(
    (prediction) => !finiteNumber(prediction.stage2Low) || !finiteNumber(prediction.stage2High),
  ).length;
  const coveredRows = scored.filter(
    (prediction) =>
      finiteNumber(prediction.stage2Low) &&
      finiteNumber(prediction.stage2High) &&
      prediction.stage2Low <= prediction.benchmarkDifficulty &&
      prediction.benchmarkDifficulty <= prediction.stage2High,
  ).length;
  const coverage = scored.length > 0 ? coveredRows / scored.length : 0;
  const calibrationGate: GateResult = {
    gate: 'deherded_tension_calibration',
    passed:
      scored.length >= GATE_BENCHMARK_MIN_ROWS &&
      missingIntervalRows === 0 &&
      coverage >= GATE_BENCHMARK_MIN_COVERAGE &&
      coverage <= GATE_BENCHMARK_MAX_COVERAGE,
    detail:
      `holdout 95% interval coverage ${(coverage * 100).toFixed(1)}% over ${scored.length} rows` +
      (missingIntervalRows > 0 ? ` (${missingIntervalRows} missing intervals counted uncovered)` : ''),
    metrics: {
      n: scored.length,
      coveredRows,
      missingIntervalRows,
      coverage,
      minCoverage: GATE_BENCHMARK_MIN_COVERAGE,
      maxCoverage: GATE_BENCHMARK_MAX_COVERAGE,
    },
  };

  const segmentGate = evaluateBenchmarkSegments(scored);
  return [benchmarkGate, calibrationGate, segmentGate];
}

function trafficBucket(ascensionistCount: number): string {
  if (ascensionistCount >= 100) return 'traffic_100_plus';
  if (ascensionistCount >= 20) return 'traffic_20_99';
  return 'traffic_under_20';
}

function angleBucket(angle: number): string {
  return `angle_${Math.floor(angle / 10) * 10}_${Math.floor(angle / 10) * 10 + 9}`;
}

function addSegment(
  segments: Map<string, TensionBenchmarkPrediction[]>,
  key: string,
  prediction: TensionBenchmarkPrediction,
): void {
  const values = segments.get(key) ?? [];
  values.push(prediction);
  segments.set(key, values);
}

function evaluateBenchmarkSegments(scored: TensionBenchmarkPrediction[]): GateResult {
  const segments = new Map<string, TensionBenchmarkPrediction[]>();
  for (const prediction of scored) {
    addSegment(segments, `band_${gradeBandForDifficulty(prediction.displayDifficulty)}`, prediction);
    addSegment(segments, angleBucket(prediction.angle), prediction);
    addSegment(segments, trafficBucket(prediction.ascensionistCount), prediction);
  }

  let checkedSegments = 0;
  let violations = 0;
  let worstRegression = 0;
  let worstSegment = '';
  for (const [segmentKey, segmentRows] of segments) {
    if (segmentRows.length < GATE_BENCHMARK_SEGMENT_MIN_ROWS) continue;
    checkedSegments += 1;
    const stage1Mae = meanAbsoluteError(
      segmentRows.map((prediction) => (prediction.stage1Grade as number) - prediction.benchmarkDifficulty),
    );
    const stage2Mae = meanAbsoluteError(
      segmentRows.map((prediction) => (prediction.stage2Grade as number) - prediction.benchmarkDifficulty),
    );
    const regression = stage2Mae - stage1Mae;
    if (regression > worstRegression) {
      worstRegression = regression;
      worstSegment = segmentKey;
    }
    if (regression > GATE_BENCHMARK_SEGMENT_TOLERANCE) violations += 1;
  }

  return {
    gate: 'deherded_segment_no_regression',
    passed: violations === 0 && checkedSegments > 0,
    detail:
      `${violations} of ${checkedSegments} benchmark segments regressed by > ${GATE_BENCHMARK_SEGMENT_TOLERANCE} MAE` +
      (worstSegment ? `; worst=${worstSegment} Δ=${worstRegression.toFixed(3)}` : ''),
    metrics: {
      checkedSegments,
      violations,
      worstRegression,
      tolerance: GATE_BENCHMARK_SEGMENT_TOLERANCE,
      minRows: GATE_BENCHMARK_SEGMENT_MIN_ROWS,
    },
  };
}

export interface DeherdCrowdInput {
  observedMean: number | null;
  displayGrade: number | null;
  echoFraction: number;
  independentWeight: number;
}

export interface DeherdCrowdOptions {
  minIndependentWeight: number;
  maxMoveFromObserved: number;
  maxMoveFromDisplay: number;
  echoFractionClamp: readonly [number, number];
}

export interface DeherdCrowdResult {
  grade: number | null;
  eligible: boolean;
  capped: boolean;
  reason: 'missing_observed_mean' | 'missing_display_grade' | 'thin_evidence' | 'no_echo' | null;
  rawDeltaFromDisplay: number | null;
  deherdedDeltaFromDisplay: number | null;
}

export interface DeherdedGradeSignal {
  name: string;
  grade: number | null;
  standardError: number | null;
  weight?: number | null;
}

export interface DeherdedSignalBlend {
  grade: number;
  totalWeight: number;
  signalCount: number;
}

export interface DeherdedBenchmarkRow {
  benchmarkGrade: number | null;
  rawGrade: number | null;
  deherdedGrade: number | null;
  weight?: number | null;
}

export interface DeherdedBenchmarkSummary {
  rows: number;
  rawMae: number;
  deherdedMae: number;
  improvement: number;
  passedNoRegression: boolean;
}

export const DEFAULT_DEHERD_CROWD_OPTIONS: Readonly<DeherdCrowdOptions> = {
  minIndependentWeight: 3,
  maxMoveFromObserved: STAGE2_DEECHO_MAX_MOVE,
  maxMoveFromDisplay: 4,
  echoFractionClamp: [0, 0.95],
};

function resolveDeherdOptions(options: Partial<DeherdCrowdOptions> | undefined): DeherdCrowdOptions {
  return { ...DEFAULT_DEHERD_CROWD_OPTIONS, ...options };
}

function clampNumber(gradeNumber: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, gradeNumber));
}

export function deherdCrowdMean(input: DeherdCrowdInput, options?: Partial<DeherdCrowdOptions>): DeherdCrowdResult {
  const resolvedOptions = resolveDeherdOptions(options);
  if (!finiteNumber(input.observedMean)) {
    return {
      grade: null,
      eligible: false,
      capped: false,
      reason: 'missing_observed_mean',
      rawDeltaFromDisplay: null,
      deherdedDeltaFromDisplay: null,
    };
  }
  if (!finiteNumber(input.displayGrade)) {
    return {
      grade: input.observedMean,
      eligible: false,
      capped: false,
      reason: 'missing_display_grade',
      rawDeltaFromDisplay: null,
      deherdedDeltaFromDisplay: null,
    };
  }
  if (input.independentWeight < resolvedOptions.minIndependentWeight) {
    return {
      grade: input.observedMean,
      eligible: false,
      capped: false,
      reason: 'thin_evidence',
      rawDeltaFromDisplay: input.observedMean - input.displayGrade,
      deherdedDeltaFromDisplay: input.observedMean - input.displayGrade,
    };
  }

  const echoFraction = clampNumber(
    input.echoFraction,
    resolvedOptions.echoFractionClamp[0],
    resolvedOptions.echoFractionClamp[1],
  );
  if (echoFraction <= 0) {
    return {
      grade: input.observedMean,
      eligible: false,
      capped: false,
      reason: 'no_echo',
      rawDeltaFromDisplay: input.observedMean - input.displayGrade,
      deherdedDeltaFromDisplay: input.observedMean - input.displayGrade,
    };
  }

  const rawDeherdedGrade = input.displayGrade + (input.observedMean - input.displayGrade) / (1 - echoFraction);
  const observedMin = input.observedMean - resolvedOptions.maxMoveFromObserved;
  const observedMax = input.observedMean + resolvedOptions.maxMoveFromObserved;
  const displayMin = input.displayGrade - resolvedOptions.maxMoveFromDisplay;
  const displayMax = input.displayGrade + resolvedOptions.maxMoveFromDisplay;
  const cappedByObserved = clampNumber(rawDeherdedGrade, observedMin, observedMax);
  const intersectedMin = Math.max(observedMin, displayMin);
  const intersectedMax = Math.min(observedMax, displayMax);
  const cappedGrade =
    intersectedMin <= intersectedMax ? clampNumber(rawDeherdedGrade, intersectedMin, intersectedMax) : cappedByObserved;

  return {
    grade: cappedGrade,
    eligible: true,
    capped: Math.abs(cappedGrade - rawDeherdedGrade) > 1e-12,
    reason: null,
    rawDeltaFromDisplay: input.observedMean - input.displayGrade,
    deherdedDeltaFromDisplay: cappedGrade - input.displayGrade,
  };
}

export function combineDeherdedSignals(signals: readonly DeherdedGradeSignal[]): DeherdedSignalBlend | null {
  let weightedGradeSum = 0;
  let totalWeight = 0;
  let signalCount = 0;

  for (const signal of signals) {
    if (!finiteNumber(signal.grade)) continue;
    let signalWeight: number;
    if (signal.weight !== undefined && signal.weight !== null && Number.isFinite(signal.weight) && signal.weight > 0) {
      signalWeight = signal.weight;
    } else if (signal.standardError !== null && Number.isFinite(signal.standardError) && signal.standardError > 0) {
      signalWeight = 1 / (signal.standardError * signal.standardError);
    } else {
      signalWeight = 1;
    }
    weightedGradeSum += signal.grade * signalWeight;
    totalWeight += signalWeight;
    signalCount += 1;
  }

  if (totalWeight <= 0) return null;
  return { grade: weightedGradeSum / totalWeight, totalWeight, signalCount };
}

export function evaluateDeherdedBenchmark(rows: readonly DeherdedBenchmarkRow[]): DeherdedBenchmarkSummary {
  let rawAbsError = 0;
  let deherdedAbsError = 0;
  let totalWeight = 0;
  let rowCount = 0;

  for (const row of rows) {
    if (!finiteNumber(row.benchmarkGrade) || !finiteNumber(row.rawGrade) || !finiteNumber(row.deherdedGrade)) {
      continue;
    }
    const rowWeight = row.weight === undefined || row.weight === null ? 1 : row.weight;
    if (!Number.isFinite(rowWeight) || rowWeight <= 0) continue;
    rawAbsError += Math.abs(row.rawGrade - row.benchmarkGrade) * rowWeight;
    deherdedAbsError += Math.abs(row.deherdedGrade - row.benchmarkGrade) * rowWeight;
    totalWeight += rowWeight;
    rowCount += 1;
  }

  const rawMae = totalWeight > 0 ? rawAbsError / totalWeight : 0;
  const deherdedMae = totalWeight > 0 ? deherdedAbsError / totalWeight : 0;
  return {
    rows: rowCount,
    rawMae,
    deherdedMae,
    improvement: rawMae > 0 ? 1 - deherdedMae / rawMae : 0,
    passedNoRegression: deherdedMae <= rawMae + 1e-12,
  };
}
