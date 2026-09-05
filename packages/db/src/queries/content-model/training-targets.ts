import { stage2EvidenceKey, type GradeCoefficients, type Stage2EvidenceMap } from '../grade-model';
import { computeFrozenStage2Target, type FrozenStage2Target } from './stage2-target';

export const CLIMB2VEC_TARGET_VERSION = 'climb2vec-frozen-stage2-v1';

export interface ContentTrainingStat {
  boardType: string;
  climbUuid: string;
  layoutId: number | null;
  fingerprint: string | null;
  physicalKey?: string | null;
  angle: number;
  difficultyAverage: number;
  displayDifficulty: number | null;
  ascensionistCount: number;
}

interface TargetAccumulator {
  rows: ContentTrainingStat[];
  weightedObserved: number;
  observedWeight: number;
  displaySum: number;
  displayCount: number;
  ascensionistCount: number;
  raterWeighted: number;
  raterEffectiveN: number;
  behaviorWeighted: number;
  behaviorEffectiveN: number;
}

export interface FrozenTrainingTarget extends FrozenStage2Target {
  coeffVersion: string;
  targetVersion: typeof CLIMB2VEC_TARGET_VERSION;
  pooledAscensionistCount: number;
}

export interface ResolvedTrainingTarget {
  label: number;
  localLabel: number;
  labelWeight: number;
  coeffVersion: string;
  targetVersion: typeof CLIMB2VEC_TARGET_VERSION;
  pooledAscensionistCount: number;
}

export function contentTrainingStatKey(boardType: string, climbUuid: string, angle: number): string {
  return `${boardType}\u0000${climbUuid}\u0000${angle}`;
}

function targetGroupKey(stat: ContentTrainingStat): string {
  if (stat.physicalKey) {
    return `${stat.physicalKey}\u0000${stat.angle}`;
  }
  if (stat.layoutId !== null && stat.fingerprint) {
    return `${stat.boardType}\u0000${stat.layoutId}\u0000${stat.fingerprint}\u0000${stat.angle}`;
  }
  return contentTrainingStatKey(stat.boardType, stat.climbUuid, stat.angle);
}

function emptyAccumulator(): TargetAccumulator {
  return {
    rows: [],
    weightedObserved: 0,
    observedWeight: 0,
    displaySum: 0,
    displayCount: 0,
    ascensionistCount: 0,
    raterWeighted: 0,
    raterEffectiveN: 0,
    behaviorWeighted: 0,
    behaviorEffectiveN: 0,
  };
}

/**
 * Freeze one pre-posterior target per physical problem+angle. Duplicate Kilter
 * UUIDs therefore share the same label and cannot teach the content model their
 * display-anchored disagreement.
 */
export function buildFrozenTrainingTargets(
  stats: readonly ContentTrainingStat[],
  coefficients: GradeCoefficients,
  evidenceByClimbAngle: Stage2EvidenceMap,
): Map<string, FrozenTrainingTarget> {
  const accumulators = new Map<string, TargetAccumulator>();

  for (const stat of stats) {
    const groupKey = targetGroupKey(stat);
    const accumulator = accumulators.get(groupKey) ?? emptyAccumulator();
    const observedWeight = Math.max(1, stat.ascensionistCount);
    accumulator.rows.push(stat);
    accumulator.weightedObserved += stat.difficultyAverage * observedWeight;
    accumulator.observedWeight += observedWeight;
    accumulator.ascensionistCount += Math.max(0, stat.ascensionistCount);
    if (stat.displayDifficulty !== null && Number.isFinite(stat.displayDifficulty)) {
      accumulator.displaySum += stat.displayDifficulty;
      accumulator.displayCount += 1;
    }

    const evidence = evidenceByClimbAngle.get(stage2EvidenceKey(stat.boardType, stat.climbUuid, stat.angle));
    if (evidence?.raterMean !== null && evidence?.raterMean !== undefined && evidence.raterEffectiveN > 0) {
      accumulator.raterWeighted += evidence.raterMean * evidence.raterEffectiveN;
      accumulator.raterEffectiveN += evidence.raterEffectiveN;
    }
    if (evidence?.behaviorMean !== null && evidence?.behaviorMean !== undefined && evidence.behaviorEffectiveN > 0) {
      accumulator.behaviorWeighted += evidence.behaviorMean * evidence.behaviorEffectiveN;
      accumulator.behaviorEffectiveN += evidence.behaviorEffectiveN;
    }
    accumulators.set(groupKey, accumulator);
  }

  const targets = new Map<string, FrozenTrainingTarget>();
  for (const accumulator of accumulators.values()) {
    const first = accumulator.rows[0];
    if (!first || accumulator.observedWeight <= 0) continue;
    const target = computeFrozenStage2Target(
      {
        boardType: first.boardType,
        observedMean: accumulator.weightedObserved / accumulator.observedWeight,
        displayGrade: accumulator.displayCount > 0 ? accumulator.displaySum / accumulator.displayCount : null,
        ascensionistCount: accumulator.ascensionistCount,
        evidence:
          accumulator.raterEffectiveN > 0 || accumulator.behaviorEffectiveN > 0
            ? {
                raterMean:
                  accumulator.raterEffectiveN > 0 ? accumulator.raterWeighted / accumulator.raterEffectiveN : null,
                raterEffectiveN: accumulator.raterEffectiveN,
                behaviorMean:
                  accumulator.behaviorEffectiveN > 0
                    ? accumulator.behaviorWeighted / accumulator.behaviorEffectiveN
                    : null,
                behaviorEffectiveN: accumulator.behaviorEffectiveN,
              }
            : undefined,
      },
      coefficients,
    );

    for (const stat of accumulator.rows) {
      targets.set(contentTrainingStatKey(stat.boardType, stat.climbUuid, stat.angle), {
        ...target,
        coeffVersion: coefficients.coeffVersion,
        targetVersion: CLIMB2VEC_TARGET_VERSION,
        pooledAscensionistCount: accumulator.ascensionistCount,
      });
    }
  }
  return targets;
}

/**
 * Resolve one exported Stage-3 answer row. Curated Tension benchmarks are
 * retained even when their crowd target is absent or below the training
 * threshold; the splitter seals them before any fit.
 */
export function resolveTrainingTarget(input: {
  boardType: string;
  ascensionistCount: number;
  benchmarkDifficulty: number | null;
  minimumAscents: number;
  coefficients: GradeCoefficients;
  target: FrozenTrainingTarget | undefined;
}): ResolvedTrainingTarget | null {
  const { target } = input;
  if (target && target.pooledAscensionistCount >= input.minimumAscents) {
    if ((input.boardType === 'kilter' || input.boardType === 'tension') && target.universalGrade === null) {
      throw new Error(
        `Frozen coefficients ${target.coeffVersion} do not universalize ${input.boardType}; ` +
          'the shared Stage-3 model cannot mix local board scales.',
      );
    }
    return {
      label: target.universalGrade ?? target.localGrade,
      localLabel: target.localGrade,
      labelWeight: target.signalWeight,
      coeffVersion: target.coeffVersion,
      targetVersion: target.targetVersion,
      pooledAscensionistCount: target.pooledAscensionistCount,
    };
  }

  if (input.boardType !== 'tension' || input.benchmarkDifficulty === null) return null;
  if (!Number.isFinite(input.benchmarkDifficulty)) {
    throw new Error('Tension benchmark difficulty must be finite.');
  }
  return {
    // This row is never fitted. Run 7 uses benchmarkDifficulty as its answer
    // key; a finite label preserves the shared JSONL schema.
    label: input.benchmarkDifficulty,
    localLabel: input.benchmarkDifficulty,
    labelWeight: 0,
    coeffVersion: input.coefficients.coeffVersion,
    targetVersion: CLIMB2VEC_TARGET_VERSION,
    pooledAscensionistCount: target?.pooledAscensionistCount ?? Math.max(0, input.ascensionistCount),
  };
}
