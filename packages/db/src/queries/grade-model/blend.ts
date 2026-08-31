import {
  CONFIDENCE,
  CONFIRMED_MAX_POST_SD,
  CONFIRMED_MIN_ASCENTS,
  DEFAULT_ECHO_FRACTION,
  DEFAULT_SIGMA_WITHIN,
  DEFAULT_TAU_SQUARED,
  GATE_NO_SHOCK_MAX_MOVE,
  GATE_NO_SHOCK_MIN_ASCENTS,
  GRADE_BANDS,
  PROVISIONAL_MIN_ASCENTS,
  PUBLISH_HYSTERESIS_GRADE,
  TAU_SQUARED_CLAMP,
  UNIVERSAL_BOARDS,
  type ConfidenceTier,
  type GradeBandKey,
} from './constants';
import type { ClimbAngleObservation, GradeCoefficients, PosteriorGrade } from './types';

export function gradeBandForDifficulty(difficulty: number | null): GradeBandKey {
  if (difficulty === null || !Number.isFinite(difficulty)) return 'v3-5';
  for (const band of GRADE_BANDS) {
    if (difficulty >= band.min && difficulty <= band.max) return band.key;
  }
  return 'v9+';
}

function clamp(value: number, [low, high]: readonly [number, number]): number {
  return Math.min(high, Math.max(low, value));
}

/** Angle offset with band → 'all' → 0 fallback (never extrapolated). */
export function lookupAngleOffset(
  coefficients: GradeCoefficients,
  boardType: string,
  band: GradeBandKey,
  angle: number,
): number {
  const surface = coefficients.angleOffset[boardType];
  if (!surface) return 0;
  return surface[band]?.[angle] ?? surface.all?.[angle] ?? 0;
}

/** Whether an angle has fitted surface coverage for this grade band. */
export function hasAngleOffset(
  coefficients: GradeCoefficients,
  boardType: string,
  band: GradeBandKey,
  angle: number,
): boolean {
  const surface = coefficients.angleOffset[boardType];
  return surface?.[band]?.[angle] !== undefined || surface?.all?.[angle] !== undefined;
}

export function sigmaWithinFor(coefficients: GradeCoefficients, boardType: string, band: GradeBandKey): number {
  return coefficients.sigmaWithin[boardType]?.[band] ?? DEFAULT_SIGMA_WITHIN;
}

/** τ²: variance of the cross-angle prior's prediction error (see coefficients.ts). */
export function tauSquaredFor(coefficients: GradeCoefficients, boardType: string, band: GradeBandKey): number {
  const tau2 = coefficients.tauSquared[boardType]?.[band] ?? DEFAULT_TAU_SQUARED;
  return clamp(tau2, TAU_SQUARED_CLAMP);
}

export function echoFractionFor(coefficients: GradeCoefficients, boardType: string): number {
  return coefficients.echoFraction[boardType] ?? DEFAULT_ECHO_FRACTION;
}

/**
 * Effective independent-opinion count behind a crowd mean. Quick-log
 * auto-copies (λ of ascents) carry no opinion, so n·(1−λ) is what the mean's
 * standard error is really built on. Never below 1 when any ascent exists.
 */
export function effectiveN(ascensionistCount: number, echoFraction: number): number {
  if (ascensionistCount <= 0) return 0;
  return Math.max(1, ascensionistCount * (1 - echoFraction));
}

/**
 * Prior mean for one climb+angle from its *other* angles: each sibling's crowd
 * mean is mapped to the climb's angle-neutral reference via the angle surface,
 * combined weighted by effective n, then mapped to the target angle. Returns
 * null when no sibling carries crowd evidence.
 *
 * This is the only prior treated as independent evidence. The display grade is
 * NOT independent: on most boards it is literally the crowd mean (or, on
 * Kilter, a damped blend of it), and logged grades anchor to it — blending
 * toward display would just re-count the same signal and fake a tighter CI.
 */
export function crossAnglePriorDetailed(
  target: ClimbAngleObservation,
  siblings: readonly ClimbAngleObservation[],
  coefficients: GradeCoefficients,
): { mean: number; effectiveNTotal: number } | null {
  const echo = echoFractionFor(coefficients, target.boardType);
  let weightedSum = 0;
  let weightTotal = 0;
  for (const sibling of siblings) {
    if (sibling.angle === target.angle) continue;
    if (sibling.difficultyAverage === null || sibling.ascensionistCount <= 0) continue;
    const band = gradeBandForDifficulty(sibling.displayDifficulty ?? sibling.difficultyAverage);
    // Measured rows retain the historical zero-offset fallback. A projected
    // row must only transport evidence through cells the surface actually fit;
    // otherwise a missing cell would masquerade as a learned flat offset.
    if (target.projectedAngle === true && !hasAngleOffset(coefficients, target.boardType, band, sibling.angle)) {
      continue;
    }
    const reference =
      sibling.difficultyAverage - lookupAngleOffset(coefficients, target.boardType, band, sibling.angle);
    const weight = effectiveN(sibling.ascensionistCount, echo);
    weightedSum += reference * weight;
    weightTotal += weight;
  }
  if (weightTotal <= 0) return null;
  const referenceMean = weightedSum / weightTotal;
  const targetBand = gradeBandForDifficulty(target.displayDifficulty ?? referenceMean);
  if (target.projectedAngle === true && !hasAngleOffset(coefficients, target.boardType, targetBand, target.angle)) {
    return null;
  }
  return {
    mean: referenceMean + lookupAngleOffset(coefficients, target.boardType, targetBand, target.angle),
    effectiveNTotal: weightTotal,
  };
}

export function crossAnglePrior(
  target: ClimbAngleObservation,
  siblings: readonly ClimbAngleObservation[],
  coefficients: GradeCoefficients,
): number | null {
  return crossAnglePriorDetailed(target, siblings, coefficients)?.mean ?? null;
}

export function assignTier(ascensionistCount: number, postSd: number | null): ConfidenceTier {
  if (ascensionistCount < PROVISIONAL_MIN_ASCENTS) return CONFIDENCE.setterOnly;
  if (ascensionistCount >= CONFIRMED_MIN_ASCENTS && postSd !== null && postSd <= CONFIRMED_MAX_POST_SD) {
    return CONFIDENCE.confirmed;
  }
  return CONFIDENCE.provisional;
}

/**
 * Full posterior for one climb+angle.
 *
 * Three regimes, by what independent evidence exists:
 *  1. Crowd mean + cross-angle prior → proper EB blend with the prior's REAL
 *     variance V0 = τ² (angle-transport error) + σ²/n_eff(siblings) (the
 *     siblings' own sampling error — when the whole climb is new, its other
 *     angles are thin too and must not masquerade as head-quality evidence):
 *       shrunk = (V0·mean + se²·μ0)/(V0+se²), se² = σ²/n_eff
 *  2. Crowd mean only → the mean stands as-is with an honest SE (no fake
 *     shrinking toward display, which is the same signal — see crossAnglePrior).
 *  3. No crowd mean → cross-angle prior if present (SD √V0), else the content
 *     prior, else the display grade with no CI claim. Tier: an angle nobody has
 *     climbed (`projectedAngle`) publishes as `cross_angle_estimate`, a
 *     content-driven grade as `provisional`, a bare display pass-through as
 *     `setter_only`.
 *
 * Guard: for established rows (n ≥ GATE_NO_SHOCK_MIN_ASCENTS) the posterior is
 * clamped within GATE_NO_SHOCK_MAX_MOVE of the crowd mean — a prior must never
 * overrule a crowd that has already spoken.
 */
export function computePosteriorGrade(
  target: ClimbAngleObservation,
  siblings: readonly ClimbAngleObservation[],
  coefficients: GradeCoefficients,
): PosteriorGrade {
  const band = gradeBandForDifficulty(target.displayDifficulty ?? target.difficultyAverage);
  const echo = echoFractionFor(coefficients, target.boardType);
  const sigma = sigmaWithinFor(coefficients, target.boardType, band);
  const tau2 = tauSquaredFor(coefficients, target.boardType, band);
  const nEff = effectiveN(target.ascensionistCount, echo);
  const prior = crossAnglePriorDetailed(target, siblings, coefficients);
  const priorVariance = prior === null ? null : tau2 + (sigma * sigma) / prior.effectiveNTotal;

  let localGrade: number | null;
  let postSd: number | null;
  let contentDriven = false;
  // Regime 3 reached with no own-angle evidence whatsoever: the posterior is
  // purely the cross-angle prior. That is the only shape a projected angle may
  // publish in — see the tier assignment below.
  let priorDriven = false;
  if (target.difficultyAverage !== null && nEff > 0) {
    const seSquared = (sigma * sigma) / nEff;
    if (prior !== null && priorVariance !== null) {
      localGrade = (priorVariance * target.difficultyAverage + seSquared * prior.mean) / (priorVariance + seSquared);
      postSd = Math.sqrt((priorVariance * seSquared) / (priorVariance + seSquared));
      if (target.ascensionistCount >= GATE_NO_SHOCK_MIN_ASCENTS) {
        localGrade = Math.min(
          target.difficultyAverage + GATE_NO_SHOCK_MAX_MOVE,
          Math.max(target.difficultyAverage - GATE_NO_SHOCK_MAX_MOVE, localGrade),
        );
      }
    } else {
      localGrade = target.difficultyAverage;
      postSd = Math.sqrt(seSquared);
    }
  } else if (prior !== null && priorVariance !== null) {
    localGrade = prior.mean;
    postSd = Math.sqrt(priorVariance);
    priorDriven = true;
  } else if (target.contentPrior != null && Number.isFinite(target.contentPrior)) {
    // Cold tail: no crowd mean, no cross-angle prior. Use the Climb2Vec geometry
    // estimate with its held-out RMSE as the CI. This branch requires
    // difficultyAverage === null, so content can never move an established crowd —
    // it only replaces the bare setter number with a geometry-informed grade.
    localGrade = target.contentPrior;
    postSd = target.contentSd != null && Number.isFinite(target.contentSd) ? target.contentSd : null;
    contentDriven = true;
  } else if (target.displayDifficulty !== null) {
    // Setter's number, no independent evidence: pass it through with no CI.
    localGrade = target.displayDifficulty;
    postSd = null;
  } else {
    return {
      localGrade: null,
      universalGrade: null,
      gradeLow: null,
      gradeHigh: null,
      confidence: CONFIDENCE.setterOnly,
      postSd: null,
    };
  }

  // Both cold-tail regimes carry model evidence and a real band, so neither may
  // take the bare `setter_only` that assignTier gives any n<3 row:
  //  - a projected angle (nobody has climbed it) publishes as
  //    `cross_angle_estimate` — a number transported from this climb's other
  //    angles, which the UI must present as an estimate, not as a grade and not
  //    as "no data";
  //  - a content-driven grade (Climb2Vec geometry) publishes as provisional.
  // A projected angle that somehow did NOT come out of the prior regime has no
  // business publishing at all; `buildProjectedAngleObservations` drops any such
  // observation by checking for this tier.
  const confidence =
    target.projectedAngle === true && priorDriven
      ? CONFIDENCE.crossAngleEstimate
      : contentDriven
        ? CONFIDENCE.provisional
        : assignTier(target.ascensionistCount, postSd);
  const offsetEntry = coefficients.boardOffset[target.boardType];
  const isUniversalBoard = (UNIVERSAL_BOARDS as readonly string[]).includes(target.boardType);
  const universalGrade = isUniversalBoard && offsetEntry ? localGrade + offsetEntry.offset : null;
  const surfaced = universalGrade ?? localGrade;
  return {
    localGrade,
    universalGrade,
    gradeLow: postSd === null ? null : surfaced - 1.96 * postSd,
    gradeHigh: postSd === null ? null : surfaced + 1.96 * postSd,
    confidence,
    postSd,
  };
}

/**
 * Publish hysteresis: keep the previously surfaced grade unless the recompute
 * moved it ≥ PUBLISH_HYSTERESIS_GRADE or the tier changed. Grades users can
 * see must not wander night to night on estimation noise.
 */
export function shouldPublish(
  previous: { localGrade: number | null; universalGrade: number | null; confidence: string } | undefined,
  next: PosteriorGrade,
): boolean {
  if (!previous) return true;
  if (previous.confidence !== next.confidence) return true;
  const previousSurfaced = previous.universalGrade ?? previous.localGrade;
  const nextSurfaced = next.universalGrade ?? next.localGrade;
  if (previousSurfaced === null || nextSurfaced === null) return previousSurfaced !== nextSurfaced;
  return Math.abs(nextSurfaced - previousSurfaced) >= PUBLISH_HYSTERESIS_GRADE;
}
