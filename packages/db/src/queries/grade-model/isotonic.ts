import { GATE_NO_SHOCK_MAX_MOVE, GATE_NO_SHOCK_MIN_ASCENTS } from './constants';
import type { PosteriorGrade } from './types';

/**
 * Per-climb cross-angle coherence: the same holds at a steeper angle cannot be
 * easier, but each angle's crowd herds independently, so raw per-angle
 * posteriors can invert (The Enchiridion @30° graded a full point above @35°,
 * n=55 vs n=33 — the display grades invert too). The blend alone can't fix
 * this: with real evidence on both sides, own-angle data rightly dominates the
 * cross-angle prior.
 *
 * Fix: project each climb's grades onto "non-decreasing with angle" via
 * weighted isotonic regression (pool-adjacent-violators), weights = posterior
 * precision (1/post_sd²). Violating neighbours merge to their
 * precision-weighted mean; already-monotone climbs are untouched.
 */

/**
 * Weighted PAVA, non-decreasing. Returns the fitted values (same order as
 * input). Inputs must be sorted by the independent variable (angle).
 */
export function isotonicNonDecreasing(values: number[], weights: number[]): number[] {
  const blocks: { sum: number; weight: number; size: number }[] = [];
  for (let i = 0; i < values.length; i++) {
    const weight = weights[i] > 0 && Number.isFinite(weights[i]) ? weights[i] : 1e-6;
    blocks.push({ sum: values[i] * weight, weight, size: 1 });
    // Merge backwards while the stack violates monotonicity.
    while (blocks.length >= 2) {
      const last = blocks[blocks.length - 1];
      const prev = blocks[blocks.length - 2];
      if (prev.sum / prev.weight <= last.sum / last.weight) break;
      prev.sum += last.sum;
      prev.weight += last.weight;
      prev.size += last.size;
      blocks.pop();
    }
  }
  const fitted: number[] = [];
  for (const block of blocks) {
    const mean = block.sum / block.weight;
    for (let i = 0; i < block.size; i++) fitted.push(mean);
  }
  return fitted;
}

export interface AngleGradeRow {
  angle: number;
  posterior: PosteriorGrade;
  /** Crowd mean + count for the no-shock cap (null when no crowd evidence). */
  observedMean: number | null;
  ascensionistCount: number;
  /**
   * True for an angle nobody has climbed, whose grade was projected from this
   * same climb's other angles (see cross-angle-estimate.ts). Such a row is a
   * FUNCTION of the real angles, not independent evidence about them, so it
   * gets a vanishing weight here: it is pulled onto the monotone curve the real
   * angles define, and can never pull them. Without this a climb with three
   * real angles and twelve projections would let the projections outvote the
   * crowd 4:1 and start moving published, ascent-backed grades.
   */
  projectedAngle?: boolean;
}

/** Shift one posterior onto a shared isotonic curve while preserving its tier and interval width. */
export function alignPosteriorToCurve(posterior: PosteriorGrade, curve: PosteriorGrade | undefined): PosteriorGrade {
  if (posterior.localGrade === null || curve?.localGrade === null || curve === undefined) return posterior;
  const delta = curve.localGrade - posterior.localGrade;
  if (Math.abs(delta) < 1e-9) return posterior;
  return {
    ...posterior,
    localGrade: curve.localGrade,
    universalGrade: posterior.universalGrade === null ? null : posterior.universalGrade + delta,
    gradeLow: posterior.gradeLow === null ? null : posterior.gradeLow + delta,
    gradeHigh: posterior.gradeHigh === null ? null : posterior.gradeHigh + delta,
  };
}

/**
 * Isotonic weight for a projected angle. Not zero — a zero-weight block would
 * divide by zero when it merges — but small enough that a real neighbour's
 * fitted value is unchanged to well past display precision.
 */
const PROJECTED_ANGLE_ISOTONIC_WEIGHT = 1e-6;

/**
 * Apply the isotonic constraint to one climb's per-angle posteriors, in place
 * on copies. Rules:
 *  - Only rows with a numeric localGrade AND postSd participate (display-only
 *    pass-throughs carry no evidence and are left untouched).
 *  - Projected angles are pulled onto the curve but carry no weight in fitting
 *    it (see `AngleGradeRow.projectedAngle`).
 *  - Established rows (n ≥ GATE_NO_SHOCK_MIN_ASCENTS) never move further than
 *    GATE_NO_SHOCK_MAX_MOVE from their own crowd mean — the same promise the
 *    blend makes. A binding cap can leave a residual inversion; callers may
 *    count those via `residualInversions`.
 *  - CI bounds and universal grade shift with the mean (width unchanged).
 */
export function applyIsotonicAngleConstraint(rows: AngleGradeRow[]): {
  adjusted: PosteriorGrade[];
  /** Adjacent pairs still inverted after capping (should be rare). */
  residualInversions: number;
  /** Rows whose grade the projection moved (beyond fp noise). */
  movedRows: number;
} {
  const sorted = [...rows].sort((a, b) => a.angle - b.angle);
  const participating = sorted.filter(
    (row) => row.posterior.localGrade !== null && row.posterior.postSd !== null && row.posterior.postSd > 0,
  );
  if (participating.length < 2) {
    return { adjusted: rows.map((row) => row.posterior), residualInversions: 0, movedRows: 0 };
  }

  const values = participating.map((row) => row.posterior.localGrade as number);
  const weights = participating.map((row) =>
    row.projectedAngle === true ? PROJECTED_ANGLE_ISOTONIC_WEIGHT : 1 / (row.posterior.postSd as number) ** 2,
  );
  const fitted = isotonicNonDecreasing(values, weights);

  const adjustedByAngle = new Map<number, PosteriorGrade>();
  let movedRows = 0;
  for (let i = 0; i < participating.length; i++) {
    const row = participating[i];
    const original = row.posterior.localGrade as number;
    let target = fitted[i];
    // No-shock cap: an established crowd is never overruled by more than the
    // model-wide bound, even in the name of monotonicity.
    if (row.observedMean !== null && row.ascensionistCount >= GATE_NO_SHOCK_MIN_ASCENTS) {
      target = Math.min(
        row.observedMean + GATE_NO_SHOCK_MAX_MOVE,
        Math.max(row.observedMean - GATE_NO_SHOCK_MAX_MOVE, target),
      );
    }
    const delta = target - original;
    if (Math.abs(delta) < 1e-9) {
      adjustedByAngle.set(row.angle, row.posterior);
      continue;
    }
    movedRows += 1;
    adjustedByAngle.set(row.angle, {
      ...row.posterior,
      localGrade: target,
      universalGrade: row.posterior.universalGrade === null ? null : row.posterior.universalGrade + delta,
      gradeLow: row.posterior.gradeLow === null ? null : row.posterior.gradeLow + delta,
      gradeHigh: row.posterior.gradeHigh === null ? null : row.posterior.gradeHigh + delta,
    });
  }

  let residualInversions = 0;
  let previous: number | null = null;
  for (const row of participating) {
    const grade = (adjustedByAngle.get(row.angle) ?? row.posterior).localGrade as number;
    if (previous !== null && grade < previous - 1e-9) residualInversions += 1;
    previous = grade;
  }

  return {
    adjusted: rows.map((row) => adjustedByAngle.get(row.angle) ?? row.posterior),
    residualInversions,
    movedRows,
  };
}
