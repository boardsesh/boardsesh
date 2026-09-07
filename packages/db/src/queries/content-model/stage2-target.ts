import {
  STAGE2_BEHAVIOR_MAX_EFFECTIVE_N,
  STAGE2_BEHAVIOR_MAX_MOVE,
  STAGE2_DEECHO_MAX_MOVE,
  STAGE2_RATER_MAX_EFFECTIVE_N,
  STAGE2_RATER_MAX_MOVE,
  deherdCrowdMean,
  echoFractionFor,
  effectiveN,
  type GradeCoefficients,
  type Stage2Evidence,
} from '../grade-model/index';

export interface FrozenStage2TargetInput {
  boardType: string;
  observedMean: number;
  displayGrade: number | null;
  ascensionistCount: number;
  evidence?: Stage2Evidence;
}

export interface FrozenStage2Target {
  /** Pre-posterior Stage 2 grade in the board's local Aurora units. */
  localGrade: number;
  /** Tension-anchored grade when the frozen coefficients contain a board offset. */
  universalGrade: number | null;
  /** Total effective signal weight used to train the content model. */
  signalWeight: number;
}

function clampDelta(delta: number, maxAbsDelta: number): number {
  return Math.min(maxAbsDelta, Math.max(-maxAbsDelta, delta));
}

function finiteNumber(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value);
}

/**
 * Reproduce the frozen Stage 2 point estimate immediately before cross-angle
 * shrinkage. This deliberately lives outside the protected production refresh
 * path: Climb2Vec needs a feedback-loop-free training target, while the nightly
 * grade implementation remains unchanged.
 */
export function computeFrozenStage2Target(
  input: FrozenStage2TargetInput,
  coefficients: GradeCoefficients,
): FrozenStage2Target {
  const echoFraction = echoFractionFor(coefficients, input.boardType);
  const rawEffectiveN = effectiveN(input.ascensionistCount, echoFraction);
  const deherded = deherdCrowdMean(
    {
      observedMean: input.observedMean,
      displayGrade: input.displayGrade,
      echoFraction,
      independentWeight: rawEffectiveN,
    },
    { maxMoveFromObserved: STAGE2_DEECHO_MAX_MOVE },
  );

  const signals: Array<{ grade: number; weight: number }> = [
    {
      grade: finiteNumber(deherded.grade) ? deherded.grade : input.observedMean,
      weight: Math.max(1, rawEffectiveN),
    },
  ];

  if (finiteNumber(input.evidence?.raterMean) && (input.evidence?.raterEffectiveN ?? 0) > 0) {
    signals.push({
      grade: input.observedMean + clampDelta(input.evidence.raterMean - input.observedMean, STAGE2_RATER_MAX_MOVE),
      weight: Math.min(STAGE2_RATER_MAX_EFFECTIVE_N, input.evidence.raterEffectiveN),
    });
  }

  if (finiteNumber(input.evidence?.behaviorMean) && (input.evidence?.behaviorEffectiveN ?? 0) > 0) {
    signals.push({
      grade:
        input.observedMean + clampDelta(input.evidence.behaviorMean - input.observedMean, STAGE2_BEHAVIOR_MAX_MOVE),
      weight: Math.min(STAGE2_BEHAVIOR_MAX_EFFECTIVE_N, input.evidence.behaviorEffectiveN),
    });
  }

  const signalWeight = signals.reduce((total, signal) => total + signal.weight, 0);
  const localGrade =
    signalWeight > 0
      ? signals.reduce((total, signal) => total + signal.grade * signal.weight, 0) / signalWeight
      : input.observedMean;
  const boardOffset = coefficients.boardOffset[input.boardType];
  const universalGrade =
    boardOffset !== undefined ? localGrade + boardOffset.offset : input.boardType === 'tension' ? localGrade : null;

  return {
    localGrade,
    universalGrade,
    signalWeight,
  };
}
