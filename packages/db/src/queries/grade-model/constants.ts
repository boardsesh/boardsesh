/**
 * Boardsesh grade model — versions and thresholds.
 *
 * Full model spec, data rationale, and the adversarial-review findings behind
 * every number here: docs/boardsesh-grade.md. Bump MODEL_VERSION on any change
 * to the blend/tier/hysteresis logic; COEFF versions are stamped per weekly
 * refit by the refresh job.
 */

/** Blend/tier/hysteresis logic version, stored on every published row. */
export const GRADE_MODEL_VERSION = 'v1.1'; // v1.1: per-climb isotonic angle constraint

/**
 * Boards whose upstream `difficulty_average` is a live crowd mean (fractional,
 * moves with ascents). MoonBoard is deliberately absent: its feed carries only
 * integer labels (average == display == benchmark byte-for-byte), so there is
 * no crowd signal to model — the UI shows "not standardized yet" instead.
 */
export const CROWD_MEAN_BOARDS = ['kilter', 'tension', 'grasshopper', 'decoy', 'soill', 'touchstone'] as const;

/**
 * Boards that get a cross-board `universal_grade`. Tension is the anchor
 * (offset 0; the only curated benchmark set with independent community
 * validation, drift −0.04 ± 0.18). Kilter links via shared-user paired grades.
 * Small boards have no anchor — they publish a within-board grade only.
 */
export const ANCHOR_BOARD = 'tension';
export const UNIVERSAL_BOARDS = ['kilter', 'tension'] as const;

/** Confidence tiers surfaced to the UI. */
export const CONFIDENCE = {
  confirmed: 'confirmed',
  provisional: 'provisional',
  setterOnly: 'setter_only',
} as const;
export type ConfidenceTier = (typeof CONFIDENCE)[keyof typeof CONFIDENCE];

/** Tier boundaries on the raw ascent count (what users see as "sends"). */
export const CONFIRMED_MIN_ASCENTS = 20;
export const PROVISIONAL_MIN_ASCENTS = 3;
/** `confirmed` additionally requires the posterior SD at or under this. */
export const CONFIRMED_MAX_POST_SD = 0.35;

/**
 * Publish hysteresis: a recomputed grade only overwrites the surfaced one when
 * it moves at least this many grade points, or the confidence tier changes.
 * The ≥20-ascent head is already stable (p90 lifetime drift 0.28), so this
 * kills nightly jitter without hiding real movement.
 */
export const PUBLISH_HYSTERESIS_GRADE = 0.5;

/**
 * Fallback echo fraction: the share of logged grades that are quick-log
 * auto-copies of the displayed grade rather than opinions (measured ~0.85 on
 * Kilter/Tension from boardsesh_ticks). Effective evidence is discounted to
 * n·(1−λ). Per-board values are estimated weekly; this is the prior/fallback
 * when a board has too few graded ticks to measure.
 */
export const DEFAULT_ECHO_FRACTION = 0.85;
/** Echo fraction is only trusted from at least this many graded ticks. */
export const ECHO_MIN_GRADED_TICKS = 500;
/** Clamp so a pathological estimate can't zero out or fully trust the crowd. */
export const ECHO_FRACTION_CLAMP: readonly [number, number] = [0.2, 0.95];

/** Fallback within-climb SD of genuinely expressed grades (grade points). */
export const DEFAULT_SIGMA_WITHIN = 0.9;
/** Fallback between-climb prior variance τ² when a pool is too thin. */
export const DEFAULT_TAU_SQUARED = 1.0;
/** τ² is clamped here so shrinkage never becomes degenerate. */
export const TAU_SQUARED_CLAMP: readonly [number, number] = [0.05, 4.0];

/** Grade bands (display-difficulty buckets) used for σ_within and the angle surface. */
export const GRADE_BANDS = [
  { key: 'v0-2', min: 0, max: 15 },
  { key: 'v3-5', min: 16, max: 20 },
  { key: 'v6-8', min: 21, max: 24 },
  { key: 'v9+', min: 25, max: 99 },
] as const;
export type GradeBandKey = (typeof GRADE_BANDS)[number]['key'];

/** Angle-surface cells need this many climb observations to be trusted. */
export const ANGLE_CELL_MIN_CLIMBS = 30;
/** Multi-angle fitting: a climb contributes when ≥2 angles have ≥ this many ascents. */
export const ANGLE_FIT_MIN_ASCENTS = 10;

/** Cross-board offset estimation (Kilter ↔ Tension shared users). */
export const OFFSET_MIN_GRADED_SENDS_PER_BOARD = 10;
/** Leave-one-user-out instability above this blocks publishing universal grades. */
export const OFFSET_LOO_MAX_DELTA = 0.5;

/** Gates (see docs/boardsesh-grade.md → Validation gates). */
export const GATE_TAIL_MAE_IMPROVEMENT = 0.2; // aspirational improvement bar, reported not enforced
export const GATE_BACKTEST_REGRESSION_TOLERANCE = 0.01; // shrunk MAE may not exceed raw by more than this
export const GATE_NO_SHOCK_MAX_MOVE = 1.0; // no ≥50-ascent climb moves further than this from its raw mean
export const GATE_NO_SHOCK_MIN_ASCENTS = 50;
export const GATE_RESIDUAL_PAIRED_GAP = 0.3; // shared-user Kilter/Tension gap after offset
