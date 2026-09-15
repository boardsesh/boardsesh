/**
 * EXPERIMENTAL (branch: experiment/moonboard-boardsesh-grade) — MoonBoard
 * wide-angle grade estimate.
 *
 * The `moonboard-wide-angles` feature flag lets a MoonBoard problem be climbed
 * (and BLE-controlled) at any angle in MOONBOARD_WIDE_ANGLES (0°-70°, 5° steps),
 * not just Moon's own catalog angles (25°/40°). Almost nobody has logged real
 * ascents there yet — at the time this was written, one lone board_climb_stats
 * row exists at a non-25/40 angle in the whole catalog — so neither the
 * same-board angle transpose (moonboard-angle-model.ts, needs real evidence at
 * both 25° AND 40°) nor the main empirical-Bayes model's cross-angle prior
 * (needs real evidence at 2+ angles per climb) has anything to project from.
 *
 * This module trades same-board accuracy for immediate coverage: it borrows
 * another crowd-mean board's FITTED angle-effect SHAPE (the per-grade-band,
 * per-angle offset table `estimateAngleSurface` already computes for
 * Kilter/Tension/etc — see coefficients.ts) and applies it, as a relative
 * shift, to MoonBoard's own real (or same-board-transposed) grade at 25° or
 * 40°. The absolute grade LEVEL is still MoonBoard's own; only the SHAPE of
 * "how much harder does it get at a steeper angle" is borrowed.
 *
 * Validated by proxy (no real MoonBoard wide-angle data to validate against
 * directly): using Kilter's fitted shape to predict TENSION's own real
 * held-out angles beats assuming no angle effect by 18.7% (MAE 0.926 vs 1.139,
 * n=12,108) — cross-board shape transfer is a real, if imperfect, signal, not
 * a leap of faith. Expect this to be visibly rougher than same-board
 * estimates; it exists to answer "something" rather than "nothing" for an
 * angle nobody has climbed on this board yet.
 */
import { hasAngleOffset, lookupAngleOffset, gradeBandForDifficulty } from './blend';
import type { GradeCoefficients } from './types';

/** Preference order for whose angle-effect shape to borrow — most data first. */
export const MOONBOARD_WIDE_ANGLE_SHAPE_BOARDS = ['kilter', 'tension'] as const;

/** Half-width of the published ± band. Wider than the same-board transpose's
 * cap (MOONBOARD_ANGLE_MAX_BAND_HALF_WIDTH = 2) to reflect the extra
 * uncertainty of borrowing another board's shape rather than MoonBoard's own
 * dual-angle data. */
export const MOONBOARD_WIDE_ANGLE_BAND_HALF_WIDTH = 3;

export interface MoonboardWideAngleAnchor {
  angle: number;
  grade: number;
  /** True when `grade` is an ascent-backed real value; false when it is
   *  itself already a same-board transposed estimate. Anchors on a real value
   *  when one is available, so this estimate never compounds atop another. */
  isReal: boolean;
}

export interface MoonboardWideAngleEstimate {
  grade: number;
  /** Which anchor angle (25 or 40) supplied the known grade. */
  anchorAngle: number;
  /** Which board's angle-effect shape supplied the offset. */
  shapeBoard: string;
  halfBand: number;
}

/**
 * Pick the better of two known anchors (MoonBoard's real-or-transposed grade
 * at 25° and at 40°) for projecting onto `targetAngle`: prefer a REAL grade
 * over a transposed one (never estimate atop an estimate when a real value is
 * available), then prefer whichever angle is numerically closer to the
 * target (less extrapolation through the borrowed shape).
 */
export function pickWideAngleAnchor(
  anchors: readonly MoonboardWideAngleAnchor[],
  targetAngle: number,
): MoonboardWideAngleAnchor | null {
  const real = anchors.filter((anchor) => anchor.isReal);
  const pool = real.length > 0 ? real : anchors;
  if (pool.length === 0) return null;
  return pool.reduce((best, candidate) =>
    Math.abs(candidate.angle - targetAngle) < Math.abs(best.angle - targetAngle) ? candidate : best,
  );
}

/**
 * Project a MoonBoard climb's known grade at `anchor.angle` onto
 * `targetAngle`, using the first shape-source board (in
 * MOONBOARD_WIDE_ANGLE_SHAPE_BOARDS order) whose fitted angle surface covers
 * BOTH angles for this grade band. Returns null when no shape source covers
 * this band/angle pair at all — never a number invented from nothing.
 */
export function estimateMoonboardGradeAtWideAngle(
  anchor: MoonboardWideAngleAnchor,
  targetAngle: number,
  coefficients: GradeCoefficients,
): MoonboardWideAngleEstimate | null {
  const band = gradeBandForDifficulty(anchor.grade);
  for (const shapeBoard of MOONBOARD_WIDE_ANGLE_SHAPE_BOARDS) {
    if (!hasAngleOffset(coefficients, shapeBoard, band, anchor.angle)) continue;
    if (!hasAngleOffset(coefficients, shapeBoard, band, targetAngle)) continue;
    const fromOffset = lookupAngleOffset(coefficients, shapeBoard, band, anchor.angle);
    const toOffset = lookupAngleOffset(coefficients, shapeBoard, band, targetAngle);
    const grade = anchor.grade + (toOffset - fromOffset);
    return {
      grade: Math.round(grade),
      anchorAngle: anchor.angle,
      shapeBoard,
      halfBand: MOONBOARD_WIDE_ANGLE_BAND_HALF_WIDTH,
    };
  }
  return null;
}
