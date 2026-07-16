/**
 * Pure assembly of the Climb2Vec training matrix — join a graded (climb, angle)
 * stat row to its holds and each hold's generated board_hold_features. The I/O
 * (SQL + JSONL) lives in `packages/db/scripts/extract-training-matrix.ts`; this
 * module is the testable core.
 */

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
  holds: TrainingHold[];
}

const HAND_STATES = new Set(['STARTING', 'HAND', 'FINISH']);

function toNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

/** Join a stat row to its holds and their features into one training example. */
export function buildTrainingRow(
  stat: ClimbStatLite,
  holds: readonly HoldLite[],
  featureByPlacement: ReadonlyMap<number, HoldFeatureLite>,
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
  return {
    climbUuid: stat.climb_uuid,
    angle: toNumber(stat.angle),
    label: toNumber(stat.label),
    ascents: toNumber(stat.n),
    layoutId: stat.layout_id === null ? null : toNumber(stat.layout_id),
    fingerprint: stat.fingerprint,
    holds: trainingHolds,
  };
}
