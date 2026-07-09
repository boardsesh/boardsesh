import { sql, type SQL } from 'drizzle-orm';
import {
  STAGE2_SYNCED_NON_ECHO_WEIGHT,
  STAGE2_USER_BIAS_MAX_ABS,
  STAGE2_USER_BIAS_MIN_EFFECTIVE_N,
  STAGE2_USER_BIAS_PRIOR_WEIGHT,
} from './constants';
import type { RaterModelCoefficient, Stage2Evidence } from './types';
import { buildTensionBenchmarkHoldoutPredicate } from './deherded';

export interface RaterSampleRow {
  board_type: string;
  user_id: string;
  climb_uuid: string;
  layout_id?: number | null;
  hold_fingerprint?: string | null;
  angle: number;
  origin: string;
  difficulty: number;
  display_difficulty: number;
  difficulty_average: number;
  gym_id: number | null;
  board_id: number | null;
}

export type Stage2EvidenceMap = Map<string, Stage2Evidence>;

export function stage2EvidenceKey(boardType: string, climbUuid: string, angle: number): string {
  return `${boardType}\u0000${climbUuid}\u0000${angle}`;
}

export function stage2LeaveoutKey(
  sample: Pick<RaterSampleRow, 'board_type' | 'climb_uuid' | 'layout_id' | 'hold_fingerprint' | 'angle'>,
): string {
  if (sample.layout_id !== null && sample.layout_id !== undefined && sample.hold_fingerprint) {
    return `${sample.board_type}\u0000${sample.layout_id}\u0000${sample.hold_fingerprint}\u0000${numeric(sample.angle)}`;
  }
  return stage2EvidenceKey(sample.board_type, sample.climb_uuid, numeric(sample.angle));
}

interface Stage2SampleSqlOptions {
  excludeTensionBenchmarkHoldout?: boolean;
}

/**
 * Latest graded opinion per user/canonical-climb/angle. Tension benchmark
 * holdout rows are excluded from fitting; benchmark grades may only be used as
 * validation targets.
 */
export function buildRaterSampleSql(options: Stage2SampleSqlOptions = { excludeTensionBenchmarkHoldout: true }): SQL {
  const excludeHoldout = options.excludeTensionBenchmarkHoldout ?? true;
  return sql`
    SELECT DISTINCT ON (t.user_id, t.board_type, COALESCE(a.canonical_uuid, t.climb_uuid), t.angle)
           t.board_type,
           t.user_id,
           COALESCE(a.canonical_uuid, t.climb_uuid) AS climb_uuid,
           bc.layout_id,
           bc.hold_fingerprint,
           t.angle,
           t.origin,
           t.difficulty,
           s.display_difficulty,
           s.difficulty_average,
           ub.gym_id,
           t.board_id
    FROM boardsesh_ticks t
    LEFT JOIN board_climb_aliases a
      ON a.board_type = t.board_type AND a.alias_uuid = t.climb_uuid
    JOIN board_climb_stats s
      ON s.board_type = t.board_type
     AND s.climb_uuid = COALESCE(a.canonical_uuid, t.climb_uuid)
     AND s.angle = t.angle
    JOIN board_climbs bc
      ON bc.board_type = s.board_type AND bc.uuid = s.climb_uuid
    LEFT JOIN user_boards ub ON ub.id = t.board_id
    WHERE t.difficulty IS NOT NULL
      AND t.status IN ('flash', 'send')
      AND s.difficulty_average IS NOT NULL
      AND s.display_difficulty IS NOT NULL
      AND bc.is_listed = true
      AND COALESCE(bc.is_draft, false) = false
      AND (${excludeHoldout ? sql`NOT (${buildTensionBenchmarkHoldoutPredicate()})` : sql`true`})
    ORDER BY t.user_id, t.board_type, COALESCE(a.canonical_uuid, t.climb_uuid), t.angle, t.climbed_at DESC
  `;
}

function numeric(value: number | string): number {
  return typeof value === 'number' ? value : Number(value);
}

function raterWeight(sample: RaterSampleRow): number {
  const isNative = sample.origin === 'native';
  const isExactDisplayEcho = numeric(sample.difficulty) === Math.round(numeric(sample.display_difficulty));
  if (isNative) return 1;
  return isExactDisplayEcho ? 0 : STAGE2_SYNCED_NON_ECHO_WEIGHT;
}

export function raterLocationKey(sample: Pick<RaterSampleRow, 'user_id' | 'gym_id' | 'board_id'>): string {
  if (sample.gym_id !== null) return `${sample.user_id}:gym:${sample.gym_id}`;
  if (sample.board_id !== null) return `${sample.user_id}:board:${sample.board_id}`;
  return `${sample.user_id}:unknown`;
}

function clampBias(value: number): number {
  return Math.min(STAGE2_USER_BIAS_MAX_ABS, Math.max(-STAGE2_USER_BIAS_MAX_ABS, value));
}

export function estimateRaterModels(samples: RaterSampleRow[]): Record<string, RaterModelCoefficient> {
  const residualsByBoardLocation = new Map<
    string,
    { boardType: string; weightedResidual: number; effectiveN: number; rawVotes: number }
  >();
  const userWeightsByBoard = new Map<string, Map<string, number>>();

  for (const sample of samples) {
    const weight = raterWeight(sample);
    if (weight <= 0) continue;
    const boardType = sample.board_type;
    const locationKey = raterLocationKey(sample);
    const accumulatorKey = `${boardType}\u0000${locationKey}`;
    const accumulator = residualsByBoardLocation.get(accumulatorKey) ?? {
      boardType,
      weightedResidual: 0,
      effectiveN: 0,
      rawVotes: 0,
    };
    accumulator.weightedResidual += (numeric(sample.difficulty) - numeric(sample.difficulty_average)) * weight;
    accumulator.effectiveN += weight;
    accumulator.rawVotes += 1;
    residualsByBoardLocation.set(accumulatorKey, accumulator);

    const boardUserWeights = userWeightsByBoard.get(boardType) ?? new Map<string, number>();
    boardUserWeights.set(sample.user_id, (boardUserWeights.get(sample.user_id) ?? 0) + weight);
    userWeightsByBoard.set(boardType, boardUserWeights);
  }

  const models: Record<string, RaterModelCoefficient> = {};
  for (const [accumulatorKey, accumulator] of residualsByBoardLocation) {
    if (accumulator.effectiveN < STAGE2_USER_BIAS_MIN_EFFECTIVE_N) continue;
    const [, locationKey] = accumulatorKey.split('\u0000');
    const shrinkage = accumulator.effectiveN / (accumulator.effectiveN + STAGE2_USER_BIAS_PRIOR_WEIGHT);
    const bias = clampBias((accumulator.weightedResidual / accumulator.effectiveN) * shrinkage);
    const model =
      models[accumulator.boardType] ??
      ({
        boardType: accumulator.boardType,
        biases: {},
        summary: { expressedVotes: 0, users: 0, locations: 0, topUserShare: 0 },
      } satisfies RaterModelCoefficient);
    model.biases[locationKey] = {
      bias,
      shrinkage,
      effectiveN: accumulator.effectiveN,
      rawVotes: accumulator.rawVotes,
      weightedResidual: accumulator.weightedResidual,
    };
    model.summary.expressedVotes += accumulator.effectiveN;
    model.summary.locations += 1;
    models[accumulator.boardType] = model;
  }

  for (const [boardType, model] of Object.entries(models)) {
    const boardUserWeights = userWeightsByBoard.get(boardType) ?? new Map<string, number>();
    let topUserWeight = 0;
    let totalUserWeight = 0;
    for (const userWeight of boardUserWeights.values()) {
      topUserWeight = Math.max(topUserWeight, userWeight);
      totalUserWeight += userWeight;
    }
    model.summary.users = boardUserWeights.size;
    model.summary.topUserShare = totalUserWeight > 0 ? topUserWeight / totalUserWeight : 0;
  }

  return models;
}

function biasExcludingTarget(
  coefficient: RaterModelCoefficient['biases'][string] | undefined,
  heldOut: { weightedResidual: number; effectiveN: number } | undefined,
): number {
  if (!coefficient) return 0;
  const effectiveN = coefficient.effectiveN - (heldOut?.effectiveN ?? 0);
  if (effectiveN < STAGE2_USER_BIAS_MIN_EFFECTIVE_N) return 0;
  const weightedResidual = coefficient.weightedResidual - (heldOut?.weightedResidual ?? 0);
  const shrinkage = effectiveN / (effectiveN + STAGE2_USER_BIAS_PRIOR_WEIGHT);
  return clampBias((weightedResidual / effectiveN) * shrinkage);
}

export function buildRaterEvidence(
  samples: RaterSampleRow[],
  models: Record<string, RaterModelCoefficient>,
  biasTrainingSamples: RaterSampleRow[] = samples,
): Stage2EvidenceMap {
  const heldOutByEvidenceLocation = new Map<string, { weightedResidual: number; effectiveN: number }>();
  for (const sample of biasTrainingSamples) {
    const weight = raterWeight(sample);
    if (weight <= 0) continue;
    const leaveoutKey = stage2LeaveoutKey(sample);
    const locationKey = raterLocationKey(sample);
    const heldOutKey = `${leaveoutKey}\u0000${locationKey}`;
    const accumulator = heldOutByEvidenceLocation.get(heldOutKey) ?? { weightedResidual: 0, effectiveN: 0 };
    accumulator.weightedResidual += (numeric(sample.difficulty) - numeric(sample.difficulty_average)) * weight;
    accumulator.effectiveN += weight;
    heldOutByEvidenceLocation.set(heldOutKey, accumulator);
  }

  const evidenceAccumulator = new Map<string, { weightedDifficulty: number; effectiveN: number; rawVotes: number }>();

  for (const sample of samples) {
    const weight = raterWeight(sample);
    if (weight <= 0) continue;
    const model = models[sample.board_type];
    if (!model) continue;
    const locationKey = raterLocationKey(sample);
    const evidenceKey = stage2EvidenceKey(sample.board_type, sample.climb_uuid, numeric(sample.angle));
    const leaveoutKey = stage2LeaveoutKey(sample);
    const bias = biasExcludingTarget(
      model.biases[locationKey],
      heldOutByEvidenceLocation.get(`${leaveoutKey}\u0000${locationKey}`),
    );
    const adjustedDifficulty = numeric(sample.difficulty) - bias;
    const accumulator = evidenceAccumulator.get(evidenceKey) ?? { weightedDifficulty: 0, effectiveN: 0, rawVotes: 0 };
    accumulator.weightedDifficulty += adjustedDifficulty * weight;
    accumulator.effectiveN += weight;
    accumulator.rawVotes += 1;
    evidenceAccumulator.set(evidenceKey, accumulator);
  }

  const evidence = new Map<string, Stage2Evidence>();
  for (const [evidenceKey, accumulator] of evidenceAccumulator) {
    evidence.set(evidenceKey, {
      raterMean: accumulator.effectiveN > 0 ? accumulator.weightedDifficulty / accumulator.effectiveN : null,
      raterEffectiveN: accumulator.effectiveN,
      behaviorMean: null,
      behaviorEffectiveN: 0,
    });
  }
  return evidence;
}

export interface RaterOpinion {
  raterId: string;
  /** The grade the user explicitly logged, on the board's ordinal grade scale. */
  difficulty: number | null;
  /** Independent reference grade to compare against, usually a held-out/posterior grade. */
  referenceGrade: number | null;
  /** Displayed grade at logging time when available; used only to identify echoes. */
  displayDifficulty: number | null;
  /** Tick provenance, for example 'native', 'aurora_pull', or 'kilter_pull'. */
  origin: string | null;
}

export interface RaterModelOptions {
  /** Synced exact-display echoes are likely quick-log auto-fills. */
  syncedEchoWeight: number;
  /** Native exact-display echoes are opt-in agreement and keep full weight by default. */
  nativeEchoWeight: number;
  nonEchoWeight: number;
  /** Synced non-echo grades are opinions, but still come from an anchored upstream flow. */
  syncedNonEchoWeight: number;
  minEffectiveWeight: number;
  /** Zero-centered ridge prior, in effective-opinion units. */
  priorWeight: number;
  maxAbsBias: number;
}

export interface RaterBiasEstimate {
  raterId: string;
  /** Positive means the rater logs grades harder than the reference. */
  bias: number;
  effectiveWeight: number;
  opinionCount: number;
}

export interface BiasAdjustedGradeEstimate {
  grade: number;
  effectiveWeight: number;
  opinionCount: number;
  meanBiasApplied: number;
  weightedSd: number | null;
}

export const DEFAULT_RATER_MODEL_OPTIONS: Readonly<RaterModelOptions> = {
  syncedEchoWeight: 0,
  nativeEchoWeight: 1,
  nonEchoWeight: 1,
  syncedNonEchoWeight: STAGE2_SYNCED_NON_ECHO_WEIGHT,
  minEffectiveWeight: STAGE2_USER_BIAS_MIN_EFFECTIVE_N,
  priorWeight: STAGE2_USER_BIAS_PRIOR_WEIGHT,
  maxAbsBias: STAGE2_USER_BIAS_MAX_ABS,
};

function resolveRaterOptions(options: Partial<RaterModelOptions> | undefined): RaterModelOptions {
  return { ...DEFAULT_RATER_MODEL_OPTIONS, ...options };
}

function isFiniteGrade(gradeNumber: number | null): gradeNumber is number {
  return gradeNumber !== null && Number.isFinite(gradeNumber);
}

function clampMagnitude(gradeDelta: number, maxAbsMagnitude: number): number {
  return Math.min(maxAbsMagnitude, Math.max(-maxAbsMagnitude, gradeDelta));
}

export function isDisplayEcho(opinion: RaterOpinion): boolean {
  return isFiniteGrade(opinion.difficulty) && isFiniteGrade(opinion.displayDifficulty)
    ? opinion.difficulty === Math.round(opinion.displayDifficulty)
    : false;
}

export function isSyncedDisplayEcho(opinion: RaterOpinion): boolean {
  return isDisplayEcho(opinion) && opinion.origin !== 'native';
}

export function raterOpinionWeight(opinion: RaterOpinion, options?: Partial<RaterModelOptions>): number {
  const resolvedOptions = resolveRaterOptions(options);
  if (!isFiniteGrade(opinion.difficulty) || !isFiniteGrade(opinion.referenceGrade)) return 0;
  if (!isDisplayEcho(opinion)) {
    return Math.max(
      0,
      opinion.origin === 'native' ? resolvedOptions.nonEchoWeight : resolvedOptions.syncedNonEchoWeight,
    );
  }
  return Math.max(0, opinion.origin === 'native' ? resolvedOptions.nativeEchoWeight : resolvedOptions.syncedEchoWeight);
}

export function estimateRaterBiases(
  opinions: readonly RaterOpinion[],
  options?: Partial<RaterModelOptions>,
): Map<string, RaterBiasEstimate> {
  const resolvedOptions = resolveRaterOptions(options);
  const accumulators = new Map<
    string,
    { weightedResidualSum: number; effectiveWeight: number; opinionCount: number }
  >();

  for (const opinion of opinions) {
    const weight = raterOpinionWeight(opinion, resolvedOptions);
    if (weight <= 0 || !isFiniteGrade(opinion.difficulty) || !isFiniteGrade(opinion.referenceGrade)) continue;
    const accumulator = accumulators.get(opinion.raterId) ?? {
      weightedResidualSum: 0,
      effectiveWeight: 0,
      opinionCount: 0,
    };
    accumulator.weightedResidualSum += (opinion.difficulty - opinion.referenceGrade) * weight;
    accumulator.effectiveWeight += weight;
    accumulator.opinionCount += 1;
    accumulators.set(opinion.raterId, accumulator);
  }

  const estimates = new Map<string, RaterBiasEstimate>();
  for (const [raterId, accumulator] of accumulators) {
    if (accumulator.effectiveWeight < resolvedOptions.minEffectiveWeight) continue;
    const shrunkBias = accumulator.weightedResidualSum / (accumulator.effectiveWeight + resolvedOptions.priorWeight);
    estimates.set(raterId, {
      raterId,
      bias: clampMagnitude(shrunkBias, resolvedOptions.maxAbsBias),
      effectiveWeight: accumulator.effectiveWeight,
      opinionCount: accumulator.opinionCount,
    });
  }
  return estimates;
}

export function computeBiasAdjustedGrade(
  opinions: readonly RaterOpinion[],
  biases: ReadonlyMap<string, RaterBiasEstimate>,
  options?: Partial<RaterModelOptions>,
): BiasAdjustedGradeEstimate | null {
  const resolvedOptions = resolveRaterOptions(options);
  const adjustedGrades: Array<{ grade: number; weight: number; bias: number }> = [];

  for (const opinion of opinions) {
    const weight = raterOpinionWeight(opinion, resolvedOptions);
    if (weight <= 0 || !isFiniteGrade(opinion.difficulty)) continue;
    const bias = biases.get(opinion.raterId)?.bias ?? 0;
    adjustedGrades.push({ grade: opinion.difficulty - bias, weight, bias });
  }

  const effectiveWeight = adjustedGrades.reduce((weightTotal, adjustedGrade) => weightTotal + adjustedGrade.weight, 0);
  if (effectiveWeight <= 0) return null;

  const grade =
    adjustedGrades.reduce(
      (weightedGradeSum, adjustedGrade) => weightedGradeSum + adjustedGrade.grade * adjustedGrade.weight,
      0,
    ) / effectiveWeight;
  const meanBiasApplied =
    adjustedGrades.reduce(
      (weightedBiasSum, adjustedGrade) => weightedBiasSum + adjustedGrade.bias * adjustedGrade.weight,
      0,
    ) / effectiveWeight;
  const weightedVariance =
    adjustedGrades.length < 2
      ? null
      : adjustedGrades.reduce(
          (varianceSum, adjustedGrade) =>
            varianceSum + adjustedGrade.weight * (adjustedGrade.grade - grade) * (adjustedGrade.grade - grade),
          0,
        ) / effectiveWeight;

  return {
    grade,
    effectiveWeight,
    opinionCount: adjustedGrades.length,
    meanBiasApplied,
    weightedSd: weightedVariance === null ? null : Math.sqrt(weightedVariance),
  };
}
