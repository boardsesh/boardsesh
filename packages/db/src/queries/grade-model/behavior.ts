import { sql, type SQL } from 'drizzle-orm';
import {
  BEHAVIOR_MAX_BUCKET_TOP_USER_SHARE,
  BEHAVIOR_MAX_TOP_USER_SHARE,
  BEHAVIOR_MIN_BUCKET_USERS,
  BEHAVIOR_MIN_OUTCOMES,
  BEHAVIOR_MIN_USERS,
} from './constants';
import type { BehaviorModelCoefficient, BehaviorOutcomeBucket, Stage2Evidence } from './types';
import { type Stage2EvidenceMap, stage2EvidenceKey, stage2LeaveoutKey } from './raters';
import { buildTensionBenchmarkHoldoutPredicate } from './deherded';

const BEHAVIOR_SUCCESS_WEIGHT = 0.25;
const BEHAVIOR_ATTEMPT_WEIGHT = 0.1;
const USER_ABILITY_PRIOR_WEIGHT = 10;
const MIN_USER_SUCCESS_OUTCOMES = 3;
const MIN_OUTCOME_BUCKET_SUPPORT = 30;

export interface BehaviorSampleRow {
  board_type: string;
  user_id: string;
  climb_uuid: string;
  layout_id?: number | null;
  hold_fingerprint?: string | null;
  angle: number;
  status: 'flash' | 'send' | 'attempt';
  attempt_count: number;
  difficulty_average: number;
  ascensionist_count: number;
}

interface Stage2SampleSqlOptions {
  excludeTensionBenchmarkHoldout?: boolean;
}

/**
 * Latest native outcome per user/canonical-climb/angle. Behavior uses only
 * Boardsesh-native events because imported/synced failures and flashes are
 * already shaped by external logging UX and are not first-exposure-like.
 */
export function buildBehaviorSampleSql(
  options: Stage2SampleSqlOptions = { excludeTensionBenchmarkHoldout: true },
): SQL {
  const excludeHoldout = options.excludeTensionBenchmarkHoldout ?? true;
  return sql`
    SELECT DISTINCT ON (t.user_id, t.board_type, COALESCE(a.canonical_uuid, t.climb_uuid), t.angle)
           t.board_type,
           t.user_id,
           COALESCE(a.canonical_uuid, t.climb_uuid) AS climb_uuid,
           bc.layout_id,
           bc.hold_fingerprint,
           t.angle,
           t.status,
           t.attempt_count,
           s.difficulty_average,
           COALESCE(s.ascensionist_count, 0)::int AS ascensionist_count
    FROM boardsesh_ticks t
    LEFT JOIN board_climb_aliases a
      ON a.board_type = t.board_type AND a.alias_uuid = t.climb_uuid
    JOIN board_climb_stats s
      ON s.board_type = t.board_type
     AND s.climb_uuid = COALESCE(a.canonical_uuid, t.climb_uuid)
     AND s.angle = t.angle
    JOIN board_climbs bc
      ON bc.board_type = s.board_type AND bc.uuid = s.climb_uuid
    WHERE t.origin = 'native'
      AND s.difficulty_average IS NOT NULL
      AND bc.is_listed = true
      AND COALESCE(bc.is_draft, false) = false
      AND (${excludeHoldout ? sql`NOT (${buildTensionBenchmarkHoldoutPredicate()})` : sql`true`})
    ORDER BY t.user_id, t.board_type, COALESCE(a.canonical_uuid, t.climb_uuid), t.angle, t.climbed_at DESC
  `;
}

function numeric(value: number | string): number {
  return typeof value === 'number' ? value : Number(value);
}

export function behaviorOutcomeBucket(
  sample: Pick<BehaviorSampleRow, 'status' | 'attempt_count'>,
): BehaviorOutcomeBucket {
  const attempts = Math.max(1, numeric(sample.attempt_count));
  if (sample.status === 'flash') return 'flash';
  if (sample.status === 'send') return attempts <= 3 ? 'send_2_3' : 'send_4_plus';
  return attempts <= 3 ? 'attempt_1_3' : 'attempt_4_plus';
}

function behaviorWeight(bucket: BehaviorOutcomeBucket): number {
  return bucket === 'attempt_1_3' || bucket === 'attempt_4_plus' ? BEHAVIOR_ATTEMPT_WEIGHT : BEHAVIOR_SUCCESS_WEIGHT;
}

interface UserAbility {
  ability: number;
  successes: number;
}

interface UserAbilityAccumulator {
  boardType: string;
  difficultySum: number;
  successes: number;
}

function buildUserAbilityAccumulators(samples: BehaviorSampleRow[]): Map<string, UserAbilityAccumulator> {
  const userAccumulator = new Map<string, { boardType: string; difficultySum: number; successes: number }>();
  for (const sample of samples) {
    if (sample.status !== 'flash' && sample.status !== 'send') continue;
    const accumulatorKey = `${sample.board_type}\u0000${sample.user_id}`;
    const accumulator = userAccumulator.get(accumulatorKey) ?? {
      boardType: sample.board_type,
      difficultySum: 0,
      successes: 0,
    };
    accumulator.difficultySum += numeric(sample.difficulty_average);
    accumulator.successes += 1;
    userAccumulator.set(accumulatorKey, accumulator);
  }
  return userAccumulator;
}

function userAbilityFromAccumulator(
  accumulator: UserAbilityAccumulator,
  boardMeanByBoard: Map<string, number>,
): UserAbility | null {
  if (accumulator.successes < MIN_USER_SUCCESS_OUTCOMES) return null;
  const boardMean = boardMeanByBoard.get(accumulator.boardType) ?? accumulator.difficultySum / accumulator.successes;
  const rawAbility = accumulator.difficultySum / accumulator.successes;
  const shrinkage = accumulator.successes / (accumulator.successes + USER_ABILITY_PRIOR_WEIGHT);
  return {
    ability: boardMean + (rawAbility - boardMean) * shrinkage,
    successes: accumulator.successes,
  };
}

function buildUserAbilities(
  samples: BehaviorSampleRow[],
  boardMeanByBoard: Map<string, number>,
): Map<string, UserAbility> {
  const userAccumulator = buildUserAbilityAccumulators(samples);
  const userAbilities = new Map<string, UserAbility>();
  for (const [accumulatorKey, accumulator] of userAccumulator) {
    const ability = userAbilityFromAccumulator(accumulator, boardMeanByBoard);
    if (ability) userAbilities.set(accumulatorKey, ability);
  }
  return userAbilities;
}

function summarizeUserOutcomes(userOutcomes: Map<string, number>): {
  users: number;
  outcomes: number;
  topUserShare: number;
} {
  let topUserOutcomes = 0;
  let totalOutcomes = 0;
  for (const outcomes of userOutcomes.values()) {
    topUserOutcomes = Math.max(topUserOutcomes, outcomes);
    totalOutcomes += outcomes;
  }
  return {
    users: userOutcomes.size,
    outcomes: totalOutcomes,
    topUserShare: totalOutcomes > 0 ? topUserOutcomes / totalOutcomes : 0,
  };
}

interface BehaviorOffsetAccumulator {
  residualSum: number;
  outcomes: number;
  userOutcomes: Map<string, number>;
}

interface BehaviorOffsetAccumulators {
  bucketAccumulator: Map<string, BehaviorOffsetAccumulator>;
  usedUserOutcomesByBoard: Map<string, Map<string, number>>;
}

function addUserOutcome(userOutcomes: Map<string, number>, userId: string, delta: number): void {
  const next = (userOutcomes.get(userId) ?? 0) + delta;
  if (next <= 0) {
    userOutcomes.delete(userId);
  } else {
    userOutcomes.set(userId, next);
  }
}

function buildBehaviorOffsetAccumulators(
  samples: BehaviorSampleRow[],
  boardMeanByBoard: Map<string, number>,
): BehaviorOffsetAccumulators {
  const userAbilityByKey = buildUserAbilities(samples, boardMeanByBoard);
  const bucketAccumulator = new Map<string, BehaviorOffsetAccumulator>();
  const usedUserOutcomesByBoard = new Map<string, Map<string, number>>();

  for (const sample of samples) {
    if (numeric(sample.ascensionist_count) < 20) continue;
    const ability = userAbilityByKey.get(`${sample.board_type}\u0000${sample.user_id}`);
    if (!ability) continue;
    const bucket = behaviorOutcomeBucket(sample);
    const accumulatorKey = `${sample.board_type}\u0000${bucket}`;
    const accumulator = bucketAccumulator.get(accumulatorKey) ?? {
      residualSum: 0,
      outcomes: 0,
      userOutcomes: new Map<string, number>(),
    };
    accumulator.residualSum += numeric(sample.difficulty_average) - ability.ability;
    accumulator.outcomes += 1;
    addUserOutcome(accumulator.userOutcomes, sample.user_id, 1);
    bucketAccumulator.set(accumulatorKey, accumulator);

    const usedBoardOutcomes = usedUserOutcomesByBoard.get(sample.board_type) ?? new Map<string, number>();
    addUserOutcome(usedBoardOutcomes, sample.user_id, 1);
    usedUserOutcomesByBoard.set(sample.board_type, usedBoardOutcomes);
  }

  return { bucketAccumulator, usedUserOutcomesByBoard };
}

function behaviorOffsetFromAccumulator(
  accumulator: BehaviorOffsetAccumulator | undefined,
  heldOut: BehaviorOffsetAccumulator | undefined,
): number | null {
  if (!accumulator) return null;
  const outcomes = accumulator.outcomes - (heldOut?.outcomes ?? 0);
  if (outcomes < MIN_OUTCOME_BUCKET_SUPPORT) return null;
  const userOutcomes = new Map(accumulator.userOutcomes);
  if (heldOut) {
    for (const [userId, heldOutcomes] of heldOut.userOutcomes) {
      addUserOutcome(userOutcomes, userId, -heldOutcomes);
    }
  }
  const bucketCoverage = summarizeUserOutcomes(userOutcomes);
  if (
    bucketCoverage.users < BEHAVIOR_MIN_BUCKET_USERS ||
    bucketCoverage.topUserShare > BEHAVIOR_MAX_BUCKET_TOP_USER_SHARE
  ) {
    return null;
  }
  const residualSum = accumulator.residualSum - (heldOut?.residualSum ?? 0);
  return residualSum / outcomes;
}

export function estimateBehaviorModels(samples: BehaviorSampleRow[]): Record<string, BehaviorModelCoefficient> {
  const boardMeanAccumulator = new Map<string, { difficultySum: number; outcomes: number }>();
  const userOutcomesByBoard = new Map<string, Map<string, number>>();
  for (const sample of samples) {
    const boardAccumulator = boardMeanAccumulator.get(sample.board_type) ?? { difficultySum: 0, outcomes: 0 };
    boardAccumulator.difficultySum += numeric(sample.difficulty_average);
    boardAccumulator.outcomes += 1;
    boardMeanAccumulator.set(sample.board_type, boardAccumulator);

    const boardUserOutcomes = userOutcomesByBoard.get(sample.board_type) ?? new Map<string, number>();
    boardUserOutcomes.set(sample.user_id, (boardUserOutcomes.get(sample.user_id) ?? 0) + 1);
    userOutcomesByBoard.set(sample.board_type, boardUserOutcomes);
  }

  const boardMeanByBoard = new Map<string, number>();
  for (const [boardType, accumulator] of boardMeanAccumulator) {
    if (accumulator.outcomes > 0) boardMeanByBoard.set(boardType, accumulator.difficultySum / accumulator.outcomes);
  }
  const { bucketAccumulator, usedUserOutcomesByBoard } = buildBehaviorOffsetAccumulators(samples, boardMeanByBoard);

  const models: Record<string, BehaviorModelCoefficient> = {};
  for (const [boardType, boardMean] of boardMeanByBoard) {
    const boardUserOutcomes = userOutcomesByBoard.get(boardType) ?? new Map<string, number>();
    const rawCoverage = summarizeUserOutcomes(boardUserOutcomes);
    const usedCoverage = summarizeUserOutcomes(usedUserOutcomesByBoard.get(boardType) ?? new Map<string, number>());
    const model: BehaviorModelCoefficient = {
      boardType,
      boardMean,
      outcomeOffset: {},
      eligible:
        usedCoverage.users >= BEHAVIOR_MIN_USERS &&
        usedCoverage.outcomes >= BEHAVIOR_MIN_OUTCOMES &&
        usedCoverage.topUserShare <= BEHAVIOR_MAX_TOP_USER_SHARE,
      summary: {
        users: rawCoverage.users,
        outcomes: rawCoverage.outcomes,
        topUserShare: rawCoverage.topUserShare,
        usedUsers: usedCoverage.users,
        usedOutcomes: 0,
        usedTopUserShare: usedCoverage.topUserShare,
      },
    };
    for (const bucket of ['flash', 'send_2_3', 'send_4_plus', 'attempt_1_3', 'attempt_4_plus'] as const) {
      const accumulator = bucketAccumulator.get(`${boardType}\u0000${bucket}`);
      if (!accumulator) continue;
      const offset = behaviorOffsetFromAccumulator(accumulator, undefined);
      if (offset === null) continue;
      model.outcomeOffset[bucket] = offset;
      model.summary.usedOutcomes += accumulator.outcomes;
    }
    models[boardType] = model;
  }

  return models;
}

export function buildBehaviorEvidence(
  samples: BehaviorSampleRow[],
  models: Record<string, BehaviorModelCoefficient>,
  existingEvidence: Stage2EvidenceMap,
  abilityTrainingSamples: BehaviorSampleRow[] = samples,
): Stage2EvidenceMap {
  const boardMeanByBoard = new Map<string, number>();
  for (const model of Object.values(models)) boardMeanByBoard.set(model.boardType, model.boardMean);
  const userAbilityAccumulatorByKey = buildUserAbilityAccumulators(abilityTrainingSamples);
  const heldOutSuccessByEvidenceUser = new Map<string, { difficultySum: number; successes: number }>();
  for (const sample of abilityTrainingSamples) {
    const leaveoutKey = stage2LeaveoutKey(sample);
    if (sample.status === 'flash' || sample.status === 'send') {
      const userSuccessKey = `${leaveoutKey}\u0000${sample.board_type}\u0000${sample.user_id}`;
      const evidenceUserSuccesses = heldOutSuccessByEvidenceUser.get(userSuccessKey) ?? {
        difficultySum: 0,
        successes: 0,
      };
      evidenceUserSuccesses.difficultySum += numeric(sample.difficulty_average);
      evidenceUserSuccesses.successes += 1;
      heldOutSuccessByEvidenceUser.set(userSuccessKey, evidenceUserSuccesses);
    }
  }
  const evidenceAccumulator = new Map<string, { weightedDifficulty: number; effectiveN: number }>();

  for (const sample of samples) {
    const model = models[sample.board_type];
    if (!model?.eligible) continue;
    const bucket = behaviorOutcomeBucket(sample);
    const evidenceKey = stage2EvidenceKey(sample.board_type, sample.climb_uuid, numeric(sample.angle));
    const offset = model.outcomeOffset[bucket];
    if (offset === undefined) continue;
    const fullAbilityAccumulator = userAbilityAccumulatorByKey.get(`${sample.board_type}\u0000${sample.user_id}`);
    if (!fullAbilityAccumulator) continue;
    const heldOutAbility = heldOutSuccessByEvidenceUser.get(
      `${stage2LeaveoutKey(sample)}\u0000${sample.board_type}\u0000${sample.user_id}`,
    );
    const ability = userAbilityFromAccumulator(
      {
        ...fullAbilityAccumulator,
        difficultySum: fullAbilityAccumulator.difficultySum - (heldOutAbility?.difficultySum ?? 0),
        successes: fullAbilityAccumulator.successes - (heldOutAbility?.successes ?? 0),
      },
      boardMeanByBoard,
    );
    if (!ability) continue;
    const weight = behaviorWeight(bucket);
    const accumulator = evidenceAccumulator.get(evidenceKey) ?? { weightedDifficulty: 0, effectiveN: 0 };
    accumulator.weightedDifficulty += (ability.ability + offset) * weight;
    accumulator.effectiveN += weight;
    evidenceAccumulator.set(evidenceKey, accumulator);
  }

  const evidence = new Map<string, Stage2Evidence>(existingEvidence);
  for (const [evidenceKey, accumulator] of evidenceAccumulator) {
    const current = evidence.get(evidenceKey) ?? {
      raterMean: null,
      raterEffectiveN: 0,
      behaviorMean: null,
      behaviorEffectiveN: 0,
    };
    evidence.set(evidenceKey, {
      ...current,
      behaviorMean: accumulator.effectiveN > 0 ? accumulator.weightedDifficulty / accumulator.effectiveN : null,
      behaviorEffectiveN: accumulator.effectiveN,
    });
  }
  return evidence;
}

export type BehaviorTickStatus = 'flash' | 'send' | 'attempt';

export interface BehaviorObservation {
  raterId: string;
  status: BehaviorTickStatus;
  /** Attempts used for sends; ignored for flashes, optional for failed attempts. */
  attemptCount: number | null;
  /** Reference grade for ability fitting, when the climb has a trusted grade. */
  referenceGrade: number | null;
}

export interface BehaviorModelOptions {
  flashProbability: number;
  sendProbability: number;
  sendAttemptPenalty: number;
  minSendProbability: number;
  attemptProbability: number;
  flashWeight: number;
  sendWeight: number;
  attemptWeight: number;
  minEffectiveWeight: number;
  /** Shrinks ability toward the reference grades the climber sampled. */
  priorWeight: number;
  probabilityClamp: readonly [number, number];
}

export interface BehaviorAbilityEstimate {
  raterId: string;
  ability: number;
  effectiveWeight: number;
  observationCount: number;
}

export interface BehaviorDifficultyEstimate {
  grade: number;
  effectiveWeight: number;
  observationCount: number;
  weightedSd: number | null;
}

export const DEFAULT_BEHAVIOR_HELPER_OPTIONS: Readonly<BehaviorModelOptions> = {
  flashProbability: 0.85,
  sendProbability: 0.65,
  sendAttemptPenalty: 0.05,
  minSendProbability: 0.45,
  attemptProbability: 0.2,
  flashWeight: 1,
  sendWeight: 1,
  attemptWeight: 0.5,
  minEffectiveWeight: 3,
  priorWeight: 2,
  probabilityClamp: [0.02, 0.98],
};

function resolveBehaviorOptions(options: Partial<BehaviorModelOptions> | undefined): BehaviorModelOptions {
  return { ...DEFAULT_BEHAVIOR_HELPER_OPTIONS, ...options };
}

function isFiniteGrade(gradeNumber: number | null): gradeNumber is number {
  return gradeNumber !== null && Number.isFinite(gradeNumber);
}

function clampProbability(probability: number, [low, high]: readonly [number, number]): number {
  return Math.min(high, Math.max(low, probability));
}

export function logitProbability(probability: number, options?: Partial<BehaviorModelOptions>): number {
  const resolvedOptions = resolveBehaviorOptions(options);
  const clampedProbability = clampProbability(probability, resolvedOptions.probabilityClamp);
  return Math.log(clampedProbability / (1 - clampedProbability));
}

export function behaviorOutcomeProbability(
  status: BehaviorTickStatus,
  attemptCount: number | null,
  options?: Partial<BehaviorModelOptions>,
): number {
  const resolvedOptions = resolveBehaviorOptions(options);
  if (status === 'flash') return clampProbability(resolvedOptions.flashProbability, resolvedOptions.probabilityClamp);
  if (status === 'attempt')
    return clampProbability(resolvedOptions.attemptProbability, resolvedOptions.probabilityClamp);
  const countedAttempts = attemptCount !== null && Number.isFinite(attemptCount) ? Math.max(2, attemptCount) : 2;
  const sendProbability =
    resolvedOptions.sendProbability - Math.max(0, countedAttempts - 2) * resolvedOptions.sendAttemptPenalty;
  return clampProbability(
    Math.max(resolvedOptions.minSendProbability, sendProbability),
    resolvedOptions.probabilityClamp,
  );
}

export function behaviorObservationWeight(status: BehaviorTickStatus, options?: Partial<BehaviorModelOptions>): number {
  const resolvedOptions = resolveBehaviorOptions(options);
  if (status === 'flash') return Math.max(0, resolvedOptions.flashWeight);
  if (status === 'send') return Math.max(0, resolvedOptions.sendWeight);
  return Math.max(0, resolvedOptions.attemptWeight);
}

export function estimateBehaviorAbilities(
  observations: readonly BehaviorObservation[],
  options?: Partial<BehaviorModelOptions>,
): Map<string, BehaviorAbilityEstimate> {
  const resolvedOptions = resolveBehaviorOptions(options);
  const accumulators = new Map<
    string,
    { impliedAbilitySum: number; referenceGradeSum: number; effectiveWeight: number; observationCount: number }
  >();

  for (const observation of observations) {
    if (!isFiniteGrade(observation.referenceGrade)) continue;
    const weight = behaviorObservationWeight(observation.status, resolvedOptions);
    if (weight <= 0) continue;
    const outcomeLogit = logitProbability(
      behaviorOutcomeProbability(observation.status, observation.attemptCount, resolvedOptions),
      resolvedOptions,
    );
    const accumulator = accumulators.get(observation.raterId) ?? {
      impliedAbilitySum: 0,
      referenceGradeSum: 0,
      effectiveWeight: 0,
      observationCount: 0,
    };
    accumulator.impliedAbilitySum += (observation.referenceGrade + outcomeLogit) * weight;
    accumulator.referenceGradeSum += observation.referenceGrade * weight;
    accumulator.effectiveWeight += weight;
    accumulator.observationCount += 1;
    accumulators.set(observation.raterId, accumulator);
  }

  const estimates = new Map<string, BehaviorAbilityEstimate>();
  for (const [raterId, accumulator] of accumulators) {
    if (accumulator.effectiveWeight < resolvedOptions.minEffectiveWeight) continue;
    const priorMean = accumulator.referenceGradeSum / accumulator.effectiveWeight;
    estimates.set(raterId, {
      raterId,
      ability:
        (accumulator.impliedAbilitySum + priorMean * resolvedOptions.priorWeight) /
        (accumulator.effectiveWeight + resolvedOptions.priorWeight),
      effectiveWeight: accumulator.effectiveWeight,
      observationCount: accumulator.observationCount,
    });
  }
  return estimates;
}

export function estimateBehaviorDifficulty(
  observations: readonly BehaviorObservation[],
  abilities: ReadonlyMap<string, BehaviorAbilityEstimate>,
  options?: Partial<BehaviorModelOptions>,
): BehaviorDifficultyEstimate | null {
  const resolvedOptions = resolveBehaviorOptions(options);
  const impliedDifficulties: Array<{ grade: number; weight: number }> = [];

  for (const observation of observations) {
    const ability = abilities.get(observation.raterId);
    if (!ability) continue;
    const weight = behaviorObservationWeight(observation.status, resolvedOptions);
    if (weight <= 0) continue;
    const outcomeLogit = logitProbability(
      behaviorOutcomeProbability(observation.status, observation.attemptCount, resolvedOptions),
      resolvedOptions,
    );
    impliedDifficulties.push({ grade: ability.ability - outcomeLogit, weight });
  }

  const effectiveWeight = impliedDifficulties.reduce(
    (weightTotal, impliedDifficulty) => weightTotal + impliedDifficulty.weight,
    0,
  );
  if (effectiveWeight <= 0) return null;

  const grade =
    impliedDifficulties.reduce(
      (weightedGradeSum, impliedDifficulty) => weightedGradeSum + impliedDifficulty.grade * impliedDifficulty.weight,
      0,
    ) / effectiveWeight;
  const weightedVariance =
    impliedDifficulties.length < 2
      ? null
      : impliedDifficulties.reduce(
          (varianceSum, impliedDifficulty) =>
            varianceSum +
            impliedDifficulty.weight * (impliedDifficulty.grade - grade) * (impliedDifficulty.grade - grade),
          0,
        ) / effectiveWeight;

  return {
    grade,
    effectiveWeight,
    observationCount: impliedDifficulties.length,
    weightedSd: weightedVariance === null ? null : Math.sqrt(weightedVariance),
  };
}
