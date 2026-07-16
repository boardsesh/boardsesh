/**
 * Pure assembly of the Climb2Vec training matrix — join a graded (climb, angle)
 * stat row to its holds and each hold's generated board_hold_features. The I/O
 * (SQL + JSONL) lives in `packages/db/scripts/extract-training-matrix.ts`; this
 * module is the testable core.
 *
 * DB-free by construction: the de-echo math reuses the pure grade-model helpers
 * (`deherdCrowdMean`, `effectiveN`), so `deherdedLabel` here matches production's
 * Stage-2 de-herd (see `applyCappedStage2Evidence` in refresh-climb-grades.ts).
 */
import { effectiveN } from '../grade-model/blend.js';
import { STAGE2_DEECHO_MAX_MOVE } from '../grade-model/constants.js';
import { deherdCrowdMean } from '../grade-model/deherded.js';

/** A placement's generated features, as read from board_hold_features. */
export interface HoldFeatureLite {
  placement_id: number;
  norm_x: number | null;
  norm_y: number | null;
  edge_dist: number | null;
  neighbor_dist: number | null;
  hand_difficulty: number | null;
  foot_difficulty: number | null;
  pull_direction: number | null;
  is_kickboard: boolean;
  coarse_type: string | null;
}

/** A graded (climb, angle) row: crowd label + weight + identity. */
export interface ClimbStatLite {
  climb_uuid: string;
  angle: number;
  label: number;
  n: number;
  layout_id: number | null;
  fingerprint: string | null;
  /** display_difficulty: the anchor the crowd echoes; de-herd needs it. Null when unset. */
  display: number | null;
  /** benchmark_difficulty: setter-trusted grade held out for validation. Null for most climbs. */
  benchmark: number | null;
}

/** A hold on a climb after resolving its board-specific storage id to a placement id. */
export interface HoldLite {
  placement_id: number;
  hold_state: string;
}

/** A hold as emitted in the training matrix: role + its generated features. */
export interface TrainingHold {
  pid: number;
  role: 'hand' | 'foot';
  nx: number | null;
  ny: number | null;
  edge: number | null;
  nbr: number | null;
  hd: number | null;
  fd: number | null;
  pull: number | null;
  kb: boolean;
  footSet: boolean;
}

/** One training example: a climb at an angle, its holds, and the label. */
export interface TrainingRow {
  climbUuid: string;
  angle: number;
  label: number;
  ascents: number;
  layoutId: number | null;
  fingerprint: string | null;
  /** Which board this row came from, so mixed-board datasets stay separable. */
  board: string;
  /** Crowd mean with the echo (quick-log copies of the display grade) divided out; falls back to `label` when the de-herd can't apply. Null only when there is no observed mean. */
  deherdedLabel: number | null;
  /** Setter-trusted benchmark grade for held-out validation; null for un-benchmarked climbs. */
  benchmark: number | null;
  holds: TrainingHold[];
}

const HAND_STATES = new Set(['STARTING', 'HAND', 'FINISH']);

function toNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

/** Coerce a possibly-null / string-typed numeric column to a finite number or null. */
function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Join a stat row to its holds and their features into one training example.
 *
 * `board` tags the row; `echoFraction` is the board's quick-log echo share (λ)
 * used to de-herd the crowd label — mirror of production's Stage-2 de-herd so
 * `deherdedLabel` is train-on-able without re-running the grade pipeline.
 */
export function buildTrainingRow(
  stat: ClimbStatLite,
  holds: readonly HoldLite[],
  featureByPlacement: ReadonlyMap<number, HoldFeatureLite>,
  board: string,
  echoFraction: number,
): TrainingRow {
  const trainingHolds: TrainingHold[] = [];
  for (const hold of holds) {
    const isFoot = hold.hold_state === 'FOOT';
    const isHand = HAND_STATES.has(hold.hold_state);
    if (!isFoot && !isHand) continue; // skip malformed states
    const feature = featureByPlacement.get(toNumber(hold.placement_id));
    trainingHolds.push({
      pid: toNumber(hold.placement_id),
      role: isFoot ? 'foot' : 'hand',
      nx: feature?.norm_x ?? null,
      ny: feature?.norm_y ?? null,
      edge: feature?.edge_dist ?? null,
      nbr: feature?.neighbor_dist ?? null,
      hd: feature?.hand_difficulty ?? null,
      fd: feature?.foot_difficulty ?? null,
      pull: feature?.pull_direction ?? null,
      kb: feature?.is_kickboard ?? false,
      footSet: feature?.coarse_type === 'foot',
    });
  }

  const observedMean = toNumber(stat.label);
  const ascents = toNumber(stat.n);
  // Same de-herd as applyCappedStage2Evidence: discount the crowd count for echo,
  // divide the display-anchored delta out, cap the move. deherdCrowdMean already
  // returns `observedMean` for the non-eligible branches (thin evidence, no
  // display, no echo) and null only when the observed mean itself is missing —
  // so `.grade` reproduces production's `finite ? grade : observedMean` exactly.
  const rawEffectiveN = effectiveN(ascents, echoFraction);
  const deherded = deherdCrowdMean(
    {
      observedMean,
      displayGrade: toNumberOrNull(stat.display),
      echoFraction,
      independentWeight: rawEffectiveN,
    },
    // Same value as the option's default — spelled out only to mirror the
    // applyCappedStage2Evidence call site verbatim; every other option is default.
    { maxMoveFromObserved: STAGE2_DEECHO_MAX_MOVE },
  );

  return {
    climbUuid: stat.climb_uuid,
    angle: toNumber(stat.angle),
    label: observedMean,
    ascents,
    layoutId: stat.layout_id === null ? null : toNumber(stat.layout_id),
    fingerprint: stat.fingerprint,
    board,
    deherdedLabel: deherded.grade,
    benchmark: toNumberOrNull(stat.benchmark),
    holds: trainingHolds,
  };
}
