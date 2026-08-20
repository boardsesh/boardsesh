/**
 * Boardsesh grade model — versions and thresholds.
 *
 * Full model spec, data rationale, and the adversarial-review findings behind
 * every number here: docs/boardsesh-grade.md. Bump MODEL_VERSION on any change
 * to the blend/tier/hysteresis logic; COEFF versions are stamped per weekly
 * refit by the refresh job.
 */

/** Blend/tier/hysteresis logic version, stored on every published row. */
export const GRADE_MODEL_VERSION = 'v2.0'; // v2.0: capped Stage 2 rater/behavior evidence + benchmark gates

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

/**
 * Confidence tiers surfaced to the UI.
 *
 * `crossAngleEstimate` marks a row for an angle a climb has NO ascents at,
 * projected from the climb's other angles through the angle surface (see
 * `buildProjectedAngleObservations` in cross-angle-estimate.ts). The nightly
 * refresh job computes and persists these rows into `board_climb_grades`
 * itself (`computeBoard`'s `projectUnclimbedAngles` pass) — resolvers just
 * read them back like any other row. It carries a real grade and a real 95%
 * band, so it must not be conflated with `setter_only` ("no independent
 * evidence at all, here's the setter's number").
 */
export const CONFIDENCE = {
  confirmed: 'confirmed',
  provisional: 'provisional',
  setterOnly: 'setter_only',
  crossAngleEstimate: 'cross_angle_estimate',
} as const;
export type ConfidenceTier = (typeof CONFIDENCE)[keyof typeof CONFIDENCE];

const CONFIDENCE_TIERS = new Set<string>(Object.values(CONFIDENCE));

/**
 * Narrow a raw DB `confidence` value to the {@link ConfidenceTier} union.
 *
 * `board_climb_grades.confidence` is a text column; under a LEFT JOIN it comes
 * back as `string | null`, yet every output site types/validates it as the tier
 * union. Run each surfaced value through this so an unknown/future tier is
 * WITHHELD (returned as `null`) instead of propagating: a stray tier would
 * otherwise fail party-mode round-trip `ClimbInput` zod validation (the
 * `boardseshConfidence` field is a strict enum) and reject the whole queue item.
 * `null` degrades cleanly to the legacy grade display. Ship a new tier by
 * extending {@link CONFIDENCE} and the zod enum in
 * packages/backend/src/validation/schemas/climbs.ts together.
 */
export function toConfidenceTier(value: string | null | undefined): ConfidenceTier | null {
  return value != null && CONFIDENCE_TIERS.has(value) ? (value as ConfidenceTier) : null;
}

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
 * Kilter upstream has a small tail of confirmed rows whose display grade is
 * clearly mixed-scale or corrupted. Keep the computed grade but never call that
 * row confirmed when its rounded universal grade is outside this display delta.
 */
export const KILTER_DISPLAY_DELTA_HYGIENE_BOARD = 'kilter';
export const KILTER_DISPLAY_DELTA_MIN = -3;
export const KILTER_DISPLAY_DELTA_MAX = 1;

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

/** Stage 2 evidence caps. These keep per-user ticks from overpowering the upstream aggregate they often feed. */
export const STAGE2_DEECHO_MAX_MOVE = 0.75;
export const STAGE2_RATER_MAX_MOVE = 0.5;
export const STAGE2_RATER_MAX_EFFECTIVE_N = 5;
export const STAGE2_BEHAVIOR_MAX_MOVE = 0.35;
export const STAGE2_BEHAVIOR_MAX_EFFECTIVE_N = 2;
export const STAGE2_USER_BIAS_PRIOR_WEIGHT = 12;
export const STAGE2_USER_BIAS_MIN_EFFECTIVE_N = 3;
export const STAGE2_USER_BIAS_MAX_ABS = 1;
export const STAGE2_SYNCED_NON_ECHO_WEIGHT = 0.25;

/** De-herded Tension benchmark validation. */
export const TENSION_BENCHMARK_HOLDOUT_MODULUS = 5;
export const TENSION_BENCHMARK_HOLDOUT_REMAINDER = 0;
export const GATE_BENCHMARK_MIN_ROWS = 100;
export const GATE_BENCHMARK_REGRESSION_TOLERANCE = 0.01;
export const GATE_BENCHMARK_SEGMENT_TOLERANCE = 0.05;
export const GATE_BENCHMARK_SEGMENT_MIN_ROWS = 50;
export const GATE_BENCHMARK_MIN_COVERAGE = 0.85;
export const GATE_BENCHMARK_MAX_COVERAGE = 0.98;

/** Behavior publishing is only allowed where native outcome coverage is broad enough. */
export const BEHAVIOR_MIN_USERS = 100;
export const BEHAVIOR_MIN_OUTCOMES = 500;
export const BEHAVIOR_MAX_TOP_USER_SHARE = 0.03;
export const BEHAVIOR_MIN_BUCKET_USERS = 10;
export const BEHAVIOR_MAX_BUCKET_TOP_USER_SHARE = 0.2;

/**
 * Read-time cross-angle estimate (see cross-angle-estimate.ts).
 *
 * A climb needs this many OTHER angles carrying an ascent-backed grade before
 * its unclimbed angles get a projected number — one sibling is a single crowd's
 * opinion transported through the angle surface, which is not enough to publish
 * as a Boardsesh grade. The posterior SD cap keeps a projection whose band would
 * span most of the grade scale off the screen entirely; the reader gets the
 * plain setter grade instead, exactly as today.
 */
export const CROSS_ANGLE_ESTIMATE_MIN_SIBLINGS = 2;
/**
 * Width cap on a projected angle's posterior SD.
 *
 * Sized against the `zero_evidence_projection` gate rather than guessed. On a
 * full Kilter/Tension catalog (24.7k held-out head angles) the projection's
 * actual error is MAE 0.97 grade points — a third better than the naive "it
 * grades the same at every angle" baseline — while the posterior SD it reports
 * for itself is about 2.0, because τ² sits at its own TAU_SQUARED_CLAMP
 * ceiling; measured 95%-band coverage is 99.2%, i.e. the band is conservative,
 * not the point estimate. A cap below ~2.0 would therefore throw away accurate
 * projections to punish a known-conservative variance.
 *
 * 2.5 keeps the ceiling meaningful: τ² can never exceed 4.0, so the only way
 * past this bound is σ²/n_eff(siblings) — a climb whose other angles are
 * themselves too thin to transport. Those stay unpublished, exactly as today.
 */
export const CROSS_ANGLE_ESTIMATE_MAX_POST_SD = 2.5;

/**
 * `zero_evidence_projection` gate: hide a well-sampled angle from its own
 * climb, project it from the siblings exactly as an unclimbed angle is
 * projected, and score the result against the crowd mean we hid.
 *
 * The baseline it must beat is the naive one — the effective-n-weighted mean of
 * the sibling angles with NO angle transport — because that is what the
 * projection is FOR: if walking a grade through the fitted angle surface is no
 * better than assuming a climb grades the same at 20° and 60°, the surface is
 * decoration and the projected rows should not publish. Sample rows need this
 * many ascents so the held-out "truth" is worth scoring against.
 */
export const GATE_ZERO_EVIDENCE_MIN_ASCENTS = 20;
export const GATE_ZERO_EVIDENCE_MIN_ROWS = 100;
export const GATE_ZERO_EVIDENCE_REGRESSION_TOLERANCE = 0.01;

/** Moon bridge remains report-only until there is real paired-user coverage. */
export const MOON_BRIDGE_MIN_USERS = 50;
export const MOON_BRIDGE_MIN_SENDS_PER_BOARD = 10;
export const MOON_BRIDGE_MAX_LOO_DELTA = 0.25;
