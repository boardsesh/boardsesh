/**
 * Projected angles: grades for angles nobody has climbed.
 *
 * The pipeline reads `board_climb_stats`, which only has a row for a climb+angle
 * with at least one ascent. So a climb that has been graded at 40° and 45° gets
 * nothing at the other thirteen angles its board supports — even though the
 * fitted grade × angle surface says exactly how much harder the same holds
 * climb at 55°. The average climb with ≥2 graded angles has real stats at only
 * about three of the ~15 angles on the wall.
 *
 * This module manufactures the missing angles as **zero-evidence observations**:
 * `difficultyAverage: null`, `ascensionistCount: 0`, `projectedAngle: true`.
 * They then flow through the existing per-climb pipeline exactly like a real
 * angle would and land in `computePosteriorGrade`'s third regime — no crowd
 * mean, so the posterior IS the cross-angle prior with SD √V0 — which is the
 * behaviour the blend already had, just never reachable before. The resulting
 * rows publish tiered `cross_angle_estimate` (see `CONFIDENCE`).
 *
 * Two things had to be added for this to be honest:
 *
 * 1. **Band selection.** σ_within, τ² and the angle surface are all fitted per
 *    GRADE BAND, and a zero-evidence observation has no display label to band
 *    it by, so `gradeBandForDifficulty(null)` silently returns the middle band
 *    — pricing a V12 projection with V3–V5 coefficients. Hence the two-pass
 *    below: a first `crossAnglePriorDetailed` call finds roughly where the
 *    climb sits, and that nominal grade is fed back as the observation's
 *    `displayDifficulty` purely so the second pass picks the right band. It
 *    never becomes evidence — regime 3 fires on the prior before the display
 *    pass-through branch is reachable.
 *
 * 2. **No self-voting in the isotonic step.** A projected angle is a *function*
 *    of the real angles, not independent evidence about them, so it carries
 *    near-zero weight in the per-climb isotonic fit (see isotonic.ts). Without
 *    that, twelve projections would outvote three real grades and the
 *    monotonicity projection would start moving published, ascent-backed rows.
 */
import {
  CONFIDENCE,
  CROSS_ANGLE_ESTIMATE_MAX_POST_SD,
  CROSS_ANGLE_ESTIMATE_MIN_SIBLINGS,
  CROWD_MEAN_BOARDS,
  PROVISIONAL_MIN_ASCENTS,
} from './constants';
import { computePosteriorGrade, crossAnglePriorDetailed, gradeBandForDifficulty, hasAngleOffset } from './blend';
import type { ClimbAngleObservation, GradeCoefficients } from './types';

/** One `board_grade_coefficients` row, before it is folded into a coefficient set. */
export interface CoefficientRowInput {
  kind: string;
  key: string;
  payload: unknown;
}

/** An empty coefficient set — every lookup falls back to its documented default. */
export function emptyGradeCoefficients(coeffVersion: string): GradeCoefficients {
  return {
    coeffVersion,
    echoFraction: {},
    sigmaWithin: {},
    tauSquared: {},
    angleOffset: {},
    boardOffset: {},
    raterModel: {},
    behaviorModel: {},
    bridgeReadiness: {},
  };
}

/**
 * Fold `board_grade_coefficients` rows into a {@link GradeCoefficients} set.
 *
 * Payload shapes are documented per `kind` on the `boardGradeCoefficients`
 * schema and the nightly job is their only producer, so the shape-by-kind casts
 * are safe. Unknown kinds are ignored.
 */
export function foldCoefficientRows(coeffVersion: string, rows: readonly CoefficientRowInput[]): GradeCoefficients {
  const coefficients = emptyGradeCoefficients(coeffVersion);
  for (const row of rows) {
    if (row.kind === 'echo_fraction') {
      coefficients.echoFraction[row.key] = (row.payload as { lambda: number }).lambda;
    } else if (row.kind === 'sigma_within') {
      coefficients.sigmaWithin[row.key] = row.payload as GradeCoefficients['sigmaWithin'][string];
    } else if (row.kind === 'tau_squared') {
      coefficients.tauSquared[row.key] = row.payload as GradeCoefficients['tauSquared'][string];
    } else if (row.kind === 'angle_offset') {
      coefficients.angleOffset[row.key] = row.payload as GradeCoefficients['angleOffset'][string];
    } else if (row.kind === 'board_offset') {
      coefficients.boardOffset[row.key] = row.payload as GradeCoefficients['boardOffset'][string];
    } else if (row.kind === 'rater_model') {
      coefficients.raterModel[row.key] = row.payload as GradeCoefficients['raterModel'][string];
    } else if (row.kind === 'behavior_model') {
      coefficients.behaviorModel[row.key] = row.payload as GradeCoefficients['behaviorModel'][string];
    } else if (row.kind === 'bridge_readiness') {
      coefficients.bridgeReadiness[row.key] = row.payload as GradeCoefficients['bridgeReadiness'][string];
    }
  }
  return coefficients;
}

/**
 * True when a board's grades rest on a crowd mean at all. MoonBoard's feed is
 * label-only (average == display == benchmark byte-for-byte), so there is
 * nothing to transport across angles — it never gets a projected row, at any
 * angle. This mirrors the pipeline's own board loop, which already only walks
 * {@link CROWD_MEAN_BOARDS}; keeping the check here too means the projection
 * can't leak onto Moon through some future caller.
 */
export function boardSupportsCrossAngleEstimate(boardType: string): boolean {
  return (CROWD_MEAN_BOARDS as readonly string[]).includes(boardType);
}

/**
 * The angles allowed to anchor a projection: real observations with a crowd
 * mean and enough ascents to have left `setter_only` behind.
 *
 * The `PROVISIONAL_MIN_ASCENTS` bar is about *whether* to project, not about
 * what the projection is computed from — a 1-ascent angle may still be one of
 * `crossAnglePrior`'s weighted siblings once we've decided to go ahead, exactly
 * as it is for a real angle. The bar exists because a climb whose only other
 * angles are one-person opinions has nothing worth transporting, and a number
 * dressed as a Boardsesh grade would be worse than no number.
 */
export function anchorAngles(observations: readonly ClimbAngleObservation[]): ClimbAngleObservation[] {
  return observations.filter(
    (observation) =>
      observation.difficultyAverage !== null &&
      Number.isFinite(observation.difficultyAverage) &&
      observation.ascensionistCount >= PROVISIONAL_MIN_ASCENTS,
  );
}

/**
 * Zero-evidence observations for every board angle this climb has no stats row
 * at, ready to be appended to the climb's real observations and run through the
 * normal per-angle loop.
 *
 * Returns an empty array — no projection at all — when the board has no crowd
 * mean, when fewer than {@link CROSS_ANGLE_ESTIMATE_MIN_SIBLINGS} angles clear
 * the anchor bar, or when a particular angle's posterior band comes out wider
 * than {@link CROSS_ANGLE_ESTIMATE_MAX_POST_SD} (a projection whose 95% band
 * spans most of the grade scale is noise wearing a grade's clothes; those
 * angles are skipped individually and simply stay absent, exactly as today).
 *
 * `observations` must already carry any Stage-2 adjustment, since that is what
 * the real angles are graded from and the projection has to agree with them.
 */
export function buildProjectedAngleObservations(
  observations: readonly ClimbAngleObservation[],
  boardAngles: readonly number[],
  coefficients: GradeCoefficients,
  coveredAngles: ReadonlySet<number> = new Set(observations.map((observation) => observation.angle)),
): ClimbAngleObservation[] {
  const projected: ClimbAngleObservation[] = [];
  for (const angle of boardAngles) {
    if (coveredAngles.has(angle)) continue;
    const candidate = projectAngleObservation(observations, angle, coefficients);
    if (!candidate) continue;

    // The width check is publish POLICY, not model quality (the gate that scores
    // this projection deliberately runs without it — see
    // `evaluateZeroEvidenceProjection`). Whatever the pipeline is about to
    // compute for this observation is what gets tested, so the variance formula
    // is never restated here.
    const posterior = computePosteriorGrade(candidate, observations, coefficients);
    if (posterior.confidence !== CONFIDENCE.crossAngleEstimate) continue;
    if (posterior.localGrade === null || !Number.isFinite(posterior.localGrade)) continue;
    if (posterior.postSd === null || !Number.isFinite(posterior.postSd)) continue;
    if (posterior.postSd > CROSS_ANGLE_ESTIMATE_MAX_POST_SD) continue;

    projected.push(candidate);
  }
  return projected;
}

/**
 * Unique per-member targets when duplicate-fingerprint evidence contains angles
 * this UUID has never climbed. Pooled-only rows remain evidence, but the member
 * emits a projected target at that angle instead of both rows.
 */
export function buildMemberAngleTargets(
  pooledObservations: readonly ClimbAngleObservation[],
  projectedObservations: readonly ClimbAngleObservation[],
  memberObservedAngles: ReadonlySet<number>,
): ClimbAngleObservation[] {
  const byAngle = new Map<number, ClimbAngleObservation>();
  for (const observation of pooledObservations) {
    if (memberObservedAngles.has(observation.angle)) byAngle.set(observation.angle, observation);
  }
  for (const projection of projectedObservations) {
    if (!memberObservedAngles.has(projection.angle)) byAngle.set(projection.angle, projection);
  }
  return [...byAngle.values()].sort((left, right) => left.angle - right.angle);
}

/**
 * The zero-evidence observation for one angle, with its coefficient band
 * resolved — the two-pass described in the module doc — and no publish policy
 * applied. Returns null when the board can't be projected, when too few angles
 * clear the anchor bar, or when no sibling carries crowd evidence at all.
 *
 * Split out from {@link buildProjectedAngleObservations} so the validation gate
 * can score what the MODEL says about a held-out angle without the width cap
 * silently emptying its sample: a cap tight enough to publish nothing would
 * otherwise leave the gate with nothing to measure and hand back a vacuous pass.
 */
export function projectAngleObservation(
  observations: readonly ClimbAngleObservation[],
  angle: number,
  coefficients: GradeCoefficients,
): ClimbAngleObservation | null {
  const first = observations[0];
  if (!first || !boardSupportsCrossAngleEstimate(first.boardType)) return null;
  const coveredAnchors = anchorAngles(observations).filter((observation) => {
    if (observation.angle === angle) return false;
    const band = gradeBandForDifficulty(observation.displayDifficulty ?? observation.difficultyAverage);
    return hasAngleOffset(coefficients, first.boardType, band, observation.angle);
  });
  if (coveredAnchors.length < CROSS_ANGLE_ESTIMATE_MIN_SIBLINGS) return null;

  const bare: ClimbAngleObservation = {
    boardType: first.boardType,
    climbUuid: first.climbUuid,
    angle,
    difficultyAverage: null,
    displayDifficulty: null,
    ascensionistCount: 0,
    projectedAngle: true,
  };
  // Pass 1 — nominal grade, used only to pick the coefficient band (see the
  // module doc). Null means no sibling carried crowd evidence at all.
  const nominal = crossAnglePriorDetailed(bare, observations, coefficients);
  if (nominal === null) return null;
  return { ...bare, displayDifficulty: nominal.mean };
}
