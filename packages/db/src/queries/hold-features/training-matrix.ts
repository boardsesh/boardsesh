/**
 * Pure assembly of the Climb2Vec training matrix — join a graded (climb, angle)
 * stat row to its holds and each hold's generated board_hold_features. The I/O
 * (SQL + JSONL) lives in `packages/db/scripts/extract-training-matrix.ts`; this
 * module is the testable core.
 */

/** A placement's generated features, as read from board_hold_features. */
export interface HoldFeatureLite {
  placement_id: number;
  layout_id?: number | null;
  hole_id?: number | null;
  mirrored_hole_id?: number | null;
  morphology_vector?: readonly number[];
  morphology_center_distance?: number | null;
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
  board_type?: string;
  climb_uuid: string;
  angle: number;
  label: number;
  n: number;
  layout_id: number | null;
  fingerprint: string | null;
  product_id?: number | null;
  display_difficulty?: number | null;
  benchmark_difficulty?: number | null;
  local_label?: number | null;
  label_weight?: number | null;
  coeff_version?: string | null;
  physical_key?: string | null;
  physical_mirrored?: boolean;
  target_version?: string | null;
  difficulty_average?: number | null;
}

/** A hold on a climb after resolving its board-specific storage id to a placement id. */
export interface HoldLite {
  placement_id: number;
  hold_state: string;
}

/** A hold as emitted in the training matrix: role + its generated features. */
export interface TrainingHold {
  pid: number;
  /** Hold identity after whole-route mirror canonicalization. */
  modelHoldId?: number;
  holeId?: number;
  mirroredHoleId?: number;
  state: 'STARTING' | 'HAND' | 'FINISH' | 'FOOT';
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
  morph?: number[];
  morphCenterDistance?: number;
}

/** One training example: a climb at an angle, its holds, and the label. */
export interface TrainingRow {
  boardType?: string;
  climbUuid: string;
  angle: number;
  label: number;
  ascents: number;
  layoutId: number | null;
  fingerprint: string | null;
  productId?: number | null;
  displayDifficulty?: number | null;
  benchmarkDifficulty?: number | null;
  localLabel?: number | null;
  labelWeight?: number | null;
  coeffVersion?: string | null;
  targetVersion?: string | null;
  physicalKey?: string | null;
  difficultyAverage?: number | null;
  aliases?: string[];
  morphologyVersion?: string;
  morphologySourceVersion?: string;
  morphologyArtifactSha256?: string;
  extractionSnapshot?: string;
  extractedAt?: string;
  benchmarkRejectionManifestSha256?: string;
  rejectedBenchmarkPhysicalProblems?: number;
  holds: TrainingHold[];
}

export interface RejectedBenchmarkGroup {
  physicalKey: string;
  angle: number;
  benchmarkDifficulties: number[];
  aliases: string[];
}

export interface DeduplicatedTrainingRows {
  rows: TrainingRow[];
  rejectedPhysicalKeys: string[];
  rejectedBenchmarkGroups: RejectedBenchmarkGroup[];
  rejectedRows: number;
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
      ...(feature?.hole_id === undefined || feature.hole_id === null ? {} : { holeId: toNumber(feature.hole_id) }),
      ...(feature?.mirrored_hole_id === undefined ||
      feature.mirrored_hole_id === null ||
      toNumber(feature.mirrored_hole_id) <= 0
        ? {}
        : { mirroredHoleId: toNumber(feature.mirrored_hole_id) }),
      state: hold.hold_state as TrainingHold['state'],
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
      ...(feature?.morphology_vector === undefined ? {} : { morph: [...feature.morphology_vector] }),
      ...(feature?.morphology_center_distance === undefined || feature.morphology_center_distance === null
        ? {}
        : { morphCenterDistance: toNumber(feature.morphology_center_distance) }),
    });
  }
  return {
    ...(stat.board_type === undefined ? {} : { boardType: stat.board_type }),
    climbUuid: stat.climb_uuid,
    angle: toNumber(stat.angle),
    label: toNumber(stat.label),
    ascents: toNumber(stat.n),
    layoutId: stat.layout_id === null ? null : toNumber(stat.layout_id),
    fingerprint: stat.fingerprint,
    ...(stat.product_id === undefined
      ? {}
      : { productId: stat.product_id === null ? null : toNumber(stat.product_id) }),
    ...(stat.display_difficulty === undefined
      ? {}
      : {
          displayDifficulty: stat.display_difficulty === null ? null : toNumber(stat.display_difficulty),
        }),
    ...(stat.benchmark_difficulty === undefined
      ? {}
      : {
          benchmarkDifficulty: stat.benchmark_difficulty === null ? null : toNumber(stat.benchmark_difficulty),
        }),
    ...(stat.local_label === undefined
      ? {}
      : { localLabel: stat.local_label === null ? null : toNumber(stat.local_label) }),
    ...(stat.label_weight === undefined
      ? {}
      : { labelWeight: stat.label_weight === null ? null : toNumber(stat.label_weight) }),
    ...(stat.coeff_version === undefined ? {} : { coeffVersion: stat.coeff_version }),
    ...(stat.target_version === undefined ? {} : { targetVersion: stat.target_version }),
    ...(stat.physical_key === undefined ? {} : { physicalKey: stat.physical_key }),
    ...(stat.difficulty_average === undefined
      ? {}
      : {
          difficultyAverage: stat.difficulty_average === null ? null : toNumber(stat.difficulty_average),
        }),
    holds: trainingHolds,
  };
}

/**
 * Pool duplicate listings before Stage-3 fitting. Conflicting curated benchmark
 * answers are fatal: silently selecting one alias would make the sealed test
 * depend on UUID ordering.
 */
export function deduplicateTrainingRowsByPhysicalAngle(rows: readonly TrainingRow[]): TrainingRow[] {
  const byPhysicalAngle = new Map<string, TrainingRow[]>();
  for (const row of rows) {
    if (!row.physicalKey) throw new Error(`Stage-3 row ${row.climbUuid} has no physicalKey.`);
    const key = `${row.physicalKey}\u0000${row.angle}`;
    const group = byPhysicalAngle.get(key) ?? [];
    group.push(row);
    byPhysicalAngle.set(key, group);
  }

  const rejectedBenchmarkGroups: RejectedBenchmarkGroup[] = [];
  const rejectedPhysicalKeys = new Set<string>();
  for (const group of byPhysicalAngle.values()) {
    const ordered = [...group].sort((left, right) => left.climbUuid.localeCompare(right.climbUuid));
    const representative = ordered[0]!;
    const benchmarkDifficulties = new Set(
      ordered
        .map((row) => row.benchmarkDifficulty)
        .filter((difficulty): difficulty is number => difficulty !== null && difficulty !== undefined)
        .map(Number),
    );
    if (benchmarkDifficulties.size > 1) {
      const physicalKey = representative.physicalKey!;
      rejectedPhysicalKeys.add(physicalKey);
      rejectedBenchmarkGroups.push({
        physicalKey,
        angle: representative.angle,
        benchmarkDifficulties: [...benchmarkDifficulties].sort((left, right) => left - right),
        aliases: ordered.map((row) => row.climbUuid),
      });
    }
  }
  if (rejectedBenchmarkGroups.length > 0) {
    const first = rejectedBenchmarkGroups[0]!;
    throw new Error(
      `Conflicting benchmark grades for ${first.physicalKey} at ${first.angle}: ` +
        first.benchmarkDifficulties.join(', '),
    );
  }

  const deduplicatedRows = [...byPhysicalAngle.values()].flatMap((group) => {
    const ordered = [...group].sort((left, right) => left.climbUuid.localeCompare(right.climbUuid));
    const representative = ordered[0]!;
    if (rejectedPhysicalKeys.has(representative.physicalKey!)) return [];
    const benchmarkDifficulties = new Set(
      ordered
        .map((row) => row.benchmarkDifficulty)
        .filter((difficulty): difficulty is number => difficulty !== null && difficulty !== undefined)
        .map(Number),
    );
    const benchmarkDifficulty = [...benchmarkDifficulties][0];
    return [
      {
        ...representative,
        ...(benchmarkDifficulty === undefined ? {} : { benchmarkDifficulty }),
        aliases: ordered.map((row) => row.climbUuid),
      },
    ];
  });
  return deduplicatedRows;
}

/** Deduplicate while reporting and excluding every conflicted physical problem. */
export function deduplicateTrainingRowsWithReport(rows: readonly TrainingRow[]): DeduplicatedTrainingRows {
  const byPhysicalAngle = new Map<string, TrainingRow[]>();
  for (const row of rows) {
    if (!row.physicalKey) throw new Error(`Stage-3 row ${row.climbUuid} has no physicalKey.`);
    const key = `${row.physicalKey}\u0000${row.angle}`;
    const group = byPhysicalAngle.get(key) ?? [];
    group.push(row);
    byPhysicalAngle.set(key, group);
  }
  const rejectedBenchmarkGroups: RejectedBenchmarkGroup[] = [];
  const rejectedPhysicalKeys = new Set<string>();
  for (const group of byPhysicalAngle.values()) {
    const ordered = [...group].sort((left, right) => left.climbUuid.localeCompare(right.climbUuid));
    const representative = ordered[0]!;
    const benchmarkDifficulties = [
      ...new Set(
        ordered
          .map((row) => row.benchmarkDifficulty)
          .filter((difficulty): difficulty is number => difficulty !== null && difficulty !== undefined)
          .map(Number),
      ),
    ].sort((left, right) => left - right);
    if (benchmarkDifficulties.length <= 1) continue;
    rejectedPhysicalKeys.add(representative.physicalKey!);
    rejectedBenchmarkGroups.push({
      physicalKey: representative.physicalKey!,
      angle: representative.angle,
      benchmarkDifficulties,
      aliases: ordered.map((row) => row.climbUuid),
    });
  }

  const retainedInputRows = rows.filter((row) => !rejectedPhysicalKeys.has(row.physicalKey!));
  return {
    rows: deduplicateTrainingRowsByPhysicalAngle(retainedInputRows),
    rejectedPhysicalKeys: [...rejectedPhysicalKeys].sort(),
    rejectedBenchmarkGroups: rejectedBenchmarkGroups.sort(
      (left, right) => left.physicalKey.localeCompare(right.physicalKey) || left.angle - right.angle,
    ),
    rejectedRows: rows.length - retainedInputRows.length,
  };
}
