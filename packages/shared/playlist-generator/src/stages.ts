// A workout as an ordered list of stages, and the carrier that tracks which
// queue items belong to which stage once the plan has been filled with climbs.
// Pure TS and JSON-serialisable: plans and runs are persisted by the apps.

import { generateWarmUp, generateWorkoutPlan } from './generate';
import { pacingForOptions, type WorkoutStagePacing } from './pacing';
import type { GeneratorGradeScale, GeneratorOptions, PlannedClimbSlot, WarmUpType, WorkoutType } from './types';

// Stage kinds use the partner API block type names (docs/partner-api.md, "Blocks"),
// so a partner block maps onto a stage without renames.
export type WorkoutStageKind = 'warmUp' | WorkoutType;

// A record so a kind added to the union fails to compile until it is listed here.
// Key order is the kinds' display and test order: WORKOUT_STAGE_KINDS is built from it.
const STAGE_KIND_FLAGS: Record<WorkoutStageKind, true> = {
  warmUp: true,
  volume: true,
  pyramid: true,
  ladder: true,
  gradeFocus: true,
  onTheMinute: true,
  fourByFour: true,
  limitBouldering: true,
};

/** Every stage kind this bundle can run, for checking persisted data. */
export const WORKOUT_STAGE_KINDS = Object.keys(STAGE_KIND_FLAGS) as readonly WorkoutStageKind[];

/** True for a stage kind this bundle knows. A run written by a newer bundle can hold one it does not. */
export const isWorkoutStageKind = (kind: unknown): kind is WorkoutStageKind =>
  typeof kind === 'string' && Object.hasOwn(STAGE_KIND_FLAGS, kind);

/** Warm-up length for a warm-up stage. `'none'` is expressed by leaving the stage out. */
export type WarmUpStageType = Exclude<WarmUpType, 'none'>;

/**
 * The climb filters one stage's climbs are fetched with. The generator plans
 * grades only, so these never change a stage's slots; the app reads them when
 * it fills the slots with climbs. On a workout stage they win over the copies
 * its `options` carry.
 */
export type WorkoutStageFilters = Pick<
  GeneratorOptions,
  | 'climbBias'
  | 'minAscents'
  | 'minRating'
  | 'onlyTallClimbs'
  | 'onlyWideClimbs'
  | 'skipSent'
  | 'skipTried'
  | 'onlyBenchmarks'
>;

/**
 * Climbs stepping up to a target grade: its own `targetGrade` when set
 * (partner `warmUp` blocks carry their own range), else the grade of the first
 * workout stage after it. The app's warm-ups never set one. With neither, after
 * the last workout stage, it steps back down from where that stage ends
 * instead: a cool-down.
 */
export type WarmUpStage = {
  id: string;
  kind: 'warmUp';
  warmUpType: WarmUpStageType;
  targetGrade?: number;
  filters?: WorkoutStageFilters;
};

/** Generator options for one workout type, with warm-up handled by its own stage. */
export type StageGeneratorOptions<Kind extends WorkoutType = WorkoutType> = Extract<
  GeneratorOptions,
  { type: Kind }
> & {
  warmUp: 'none';
};

type WorkoutStageByKind = {
  [Kind in WorkoutType]: {
    id: string;
    kind: Kind;
    options: StageGeneratorOptions<Kind>;
    filters?: WorkoutStageFilters;
  };
};

/** A main-set stage. `kind` always equals `options.type`. */
export type WorkoutMainStage = WorkoutStageByKind[WorkoutType];

export type WorkoutStage = WarmUpStage | WorkoutMainStage;

export type WorkoutPlan = { stages: WorkoutStage[] };

export type StagedSlot = PlannedClimbSlot & { stageId: string };

export type StageIdFactory = (stagePosition: number) => string;

export const isWarmUpStage = (stage: WorkoutStage): stage is WarmUpStage => stage.kind === 'warmUp';

// Persisted data can drift from the types; a workout stage only counts when its
// kind still names the generator its options are for.
const isRunnableMainStage = (stage: WorkoutStage | undefined): stage is WorkoutMainStage =>
  stage !== undefined && !isWarmUpStage(stage) && stage.kind === stage.options.type;

const toMainStage = (options: GeneratorOptions, id: string): WorkoutMainStage => {
  switch (options.type) {
    case 'volume':
      return { id, kind: 'volume', options: { ...options, warmUp: 'none' } };
    case 'pyramid':
      return { id, kind: 'pyramid', options: { ...options, warmUp: 'none' } };
    case 'ladder':
      return { id, kind: 'ladder', options: { ...options, warmUp: 'none' } };
    case 'gradeFocus':
      return { id, kind: 'gradeFocus', options: { ...options, warmUp: 'none' } };
    case 'onTheMinute':
      return { id, kind: 'onTheMinute', options: { ...options, warmUp: 'none' } };
    case 'fourByFour':
      return { id, kind: 'fourByFour', options: { ...options, warmUp: 'none' } };
    case 'limitBouldering':
      return { id, kind: 'limitBouldering', options: { ...options, warmUp: 'none' } };
    default: {
      const exhaustiveOptions: never = options;
      return exhaustiveOptions;
    }
  }
};

/**
 * One block of a workout as the climber builds it: a warm-up, or a workout of
 * one type. A warm-up has no grade of its own; it ramps to the next workout
 * block after it, or after the last one eases off from the block before it.
 * `filters`, when set, are the block's own climb filters and pass to its stage.
 */
export type WorkoutBlockSpec = (
  | { kind: 'warmUp'; warmUpType: WarmUpStageType }
  | { kind: 'workout'; options: GeneratorOptions }
) & { filters?: WorkoutStageFilters };

/**
 * Turns an ordered list of blocks into a plan with one stage per block, in the
 * order given. A warm-up can sit anywhere and more than once; a workout block's
 * own `warmUp` is ignored, since warm-ups are blocks of their own. `makeId` is
 * required: ids must stay unique when stages are added mid-session or plans are
 * joined, so the app passes a uuid factory rather than relying on positions.
 */
export const planFromBlocks = (blocks: readonly WorkoutBlockSpec[], makeId: StageIdFactory): WorkoutPlan => {
  const stages: WorkoutStage[] = [];
  for (const block of blocks) {
    const id = makeId(stages.length);
    const stage: WorkoutStage =
      block.kind === 'warmUp' ? { id, kind: 'warmUp', warmUpType: block.warmUpType } : toMainStage(block.options, id);
    // Left off rather than set to undefined, so a plan without filters reads the same as before.
    stages.push(block.filters ? { ...stage, filters: { ...block.filters } } : stage);
  }
  return { stages };
};

/** The grade a warm-up ramps up to: its own `targetGrade`, else the first runnable workout stage after it. */
const warmUpRampTarget = (stages: readonly WorkoutStage[], stage: WarmUpStage, stagePosition: number) =>
  stage.targetGrade ?? stages.slice(stagePosition + 1).find(isRunnableMainStage)?.options.targetGrade;

/**
 * Where the warm-up at `stagePosition` takes a cool-down from: the position of
 * the nearest runnable workout stage before it, skipping warm-ups. -1 when it
 * ramps up instead (`warmUpRampTarget`) or no runnable workout stage comes
 * before it.
 */
const coolDownSourcePosition = (stages: readonly WorkoutStage[], stage: WarmUpStage, stagePosition: number): number => {
  if (warmUpRampTarget(stages, stage, stagePosition) !== undefined) return -1;
  for (let before = stagePosition - 1; before >= 0; before--) {
    if (isRunnableMainStage(stages[before])) return before;
  }
  return -1;
};

/**
 * A warm-up stage's slots. It ramps up to `warmUpRampTarget`. With nothing to
 * ramp to, it is a cool-down after the nearest workout stage before it: the
 * climbs the same warm-up would plan for the grade that stage ends on, hardest
 * first, in the `coolDown` section. That stage ends on its last planned climb,
 * capped at its target grade (a volume block's spread can end above it), so the
 * cool-down always starts below the climb before it: after a pyramid it carries
 * on down from the last step. A warm-up with no workout on either side plans
 * nothing. `slotsByStagePosition` holds what the stages before it planned.
 */
const warmUpStageSlots = (
  stages: readonly WorkoutStage[],
  stagePosition: number,
  stage: WarmUpStage,
  slotsByStagePosition: readonly (readonly PlannedClimbSlot[])[],
  grades: GeneratorGradeScale,
): PlannedClimbSlot[] => {
  const rampTarget = warmUpRampTarget(stages, stage, stagePosition);
  if (rampTarget !== undefined) return generateWarmUp(rampTarget, stage.warmUpType, grades);

  const sourcePosition = coolDownSourcePosition(stages, stage, stagePosition);
  const source = stages[sourcePosition];
  if (!isRunnableMainStage(source)) return [];
  const sourceSlots = slotsByStagePosition[sourcePosition] ?? [];
  const lastSourceSlot = sourceSlots[sourceSlots.length - 1];
  const easeOffFrom = lastSourceSlot
    ? Math.min(source.options.targetGrade, lastSourceSlot.grade)
    : source.options.targetGrade;
  return generateWarmUp(easeOffFrom, stage.warmUpType, grades)
    .reverse()
    .map((slot, index): PlannedClimbSlot => ({ ...slot, section: 'coolDown', index }));
};

/**
 * Generates every stage's slots in plan order. `index` runs across the whole
 * plan, so a warm-up plus one workout yields exactly what `generateWorkoutPlan`
 * yields for the same options. A warm-up stage ramps to its own `targetGrade`,
 * else to the first workout stage after it, skipping any warm-ups in between;
 * after the last workout stage it steps back down from where the nearest one
 * before it ends (a cool-down), and with no workout stage at all it generates
 * nothing. A workout stage whose `kind` no longer matches `options.type`
 * generates nothing rather than throwing on persisted data.
 */
export const generateStagedPlan = (plan: WorkoutPlan, grades: GeneratorGradeScale): StagedSlot[] => {
  const stagedSlots: StagedSlot[] = [];
  // Each stage's own slots, so a cool-down reads what the stage before it
  // actually planned: a volume block's spread is random.
  const slotsByStagePosition: PlannedClimbSlot[][] = [];

  plan.stages.forEach((stage, stagePosition) => {
    let stageSlots: PlannedClimbSlot[];
    if (isWarmUpStage(stage)) {
      stageSlots = warmUpStageSlots(plan.stages, stagePosition, stage, slotsByStagePosition, grades);
    } else if (!isRunnableMainStage(stage)) {
      stageSlots = [];
    } else {
      // Force `warmUp: 'none'` in case persisted data carries an older value.
      stageSlots = generateWorkoutPlan({ ...stage.options, warmUp: 'none' }, grades);
    }
    slotsByStagePosition.push(stageSlots);

    const indexOffset = stagedSlots.length;
    for (const slot of stageSlots) {
      stagedSlots.push({ ...slot, index: indexOffset + slot.index, stageId: stage.id });
    }
  });

  return stagedSlots;
};

// ---------------------------------------------------------------------------
// Run carrier: which queue items belong to which stage.
// ---------------------------------------------------------------------------

export type WorkoutRunStage = {
  id: string;
  kind: WorkoutStageKind;
  itemUuids: string[];
  /**
   * The grade a workout stage was built around, so a block added mid-session
   * can start where the last one left off. Absent on warm-up stages and on runs
   * stored before it existed.
   */
  targetGrade?: number;
  /**
   * The climb filters the stage's climbs were fetched with, so a block added
   * mid-session can fetch the same kind of climbs. Absent on runs stored before
   * it existed and on stages planned without filters.
   */
  filters?: WorkoutStageFilters;
  /**
   * How the rest timer runs during this stage, from its block's options
   * (`pacingForOptions`), a 4x4's reps per set included. Absent on every untimed
   * stage: the climber's own rest settings apply.
   */
  pacing?: WorkoutStagePacing;
  /**
   * Set on a warm-up stage planned as a cool-down (`generateStagedPlan`), so it
   * reads "Cool-down" however the queue is reordered or extended later.
   */
  coolDown?: true;
};

/** What a run stage says about itself, without its climbs. */
export type WorkoutRunStageIdentity = Pick<
  WorkoutRunStage,
  'id' | 'kind' | 'targetGrade' | 'filters' | 'pacing' | 'coolDown'
>;

/** Stages in workout order. A stage with no items is never kept. */
export type WorkoutRun = { stages: WorkoutRunStage[] };

/** One queued climb of a plan: its queue-item uuid and its stage. */
export type WorkoutRunEntry = { uuid: string; stageId: string };

/**
 * Groups queue-item uuids by stage, in plan order. Entries for unknown stages
 * are dropped, and a stage id repeated in the plan is emitted once, so no two
 * run stages ever share an `itemUuids` list. A workout stage keeps the pacing
 * its options give. A warm-up the plan steps back down (a cool-down) is marked
 * `coolDown`.
 */
export const buildWorkoutRun = (entries: ReadonlyArray<WorkoutRunEntry>, plan: WorkoutPlan): WorkoutRun => {
  // Each uuid belongs to one stage: the first entry naming a stage in the plan
  // claims it, so a replayed or corrupted entry can't leave one climb in two
  // stages, and an entry for an unknown stage can't hide a valid one.
  const planStageIds = new Set(plan.stages.map((stage) => stage.id));
  const uuidsByStageId = new Map<string, string[]>();
  const claimedUuids = new Set<string>();
  for (const { uuid, stageId } of entries) {
    if (!planStageIds.has(stageId) || claimedUuids.has(uuid)) continue;
    claimedUuids.add(uuid);
    const stageUuids = uuidsByStageId.get(stageId);
    if (stageUuids) {
      stageUuids.push(uuid);
    } else {
      uuidsByStageId.set(stageId, [uuid]);
    }
  }

  const stages: WorkoutRunStage[] = [];
  const emittedStageIds = new Set<string>();
  for (const [stagePosition, stage] of plan.stages.entries()) {
    if (emittedStageIds.has(stage.id)) continue;
    emittedStageIds.add(stage.id);
    const itemUuids = uuidsByStageId.get(stage.id);
    if (!itemUuids || itemUuids.length === 0) continue;
    // Optional fields are left off rather than set to undefined, so a run
    // without them reads the same as one stored before they existed.
    const runStage: WorkoutRunStage = { id: stage.id, kind: stage.kind, itemUuids };
    if (!isWarmUpStage(stage)) {
      runStage.targetGrade = stage.options.targetGrade;
      const pacing = pacingForOptions(stage.options);
      if (pacing) runStage.pacing = pacing;
    } else if (coolDownSourcePosition(plan.stages, stage, stagePosition) >= 0) {
      runStage.coolDown = true;
    }
    if (stage.filters) runStage.filters = stage.filters;
    stages.push(runStage);
  }
  return { stages };
};

/**
 * Adds a stage's items to the end of the run. A stage id already in the run
 * with the same kind gets the items appended to it instead; the same id with a
 * different kind is a caller bug and throws. Uuids already in the run are
 * skipped, and when nothing is left to add the same run object comes back. A
 * new stage keeps the `targetGrade`, `filters`, `pacing` and `coolDown` it was
 * given; an existing stage keeps its own pacing.
 */
export const appendStageToRun = (
  run: WorkoutRun,
  stage: WorkoutRunStageIdentity,
  uuids: readonly string[],
): WorkoutRun => {
  const existingPosition = run.stages.findIndex((runStage) => runStage.id === stage.id);
  const existingStage = run.stages[existingPosition];
  if (existingStage && existingStage.kind !== stage.kind) {
    throw new Error(
      `appendStageToRun: stage id "${stage.id}" is already a ${existingStage.kind} stage, not ${stage.kind}`,
    );
  }

  const seenUuids = new Set(run.stages.flatMap((runStage) => runStage.itemUuids));
  const newUuids = uuids.filter((uuid) => {
    if (seenUuids.has(uuid)) return false;
    seenUuids.add(uuid);
    return true;
  });
  if (newUuids.length === 0) return run;

  if (existingPosition < 0) {
    const newStage: WorkoutRunStage = { id: stage.id, kind: stage.kind, itemUuids: newUuids };
    if (stage.targetGrade !== undefined) newStage.targetGrade = stage.targetGrade;
    if (stage.filters !== undefined) newStage.filters = stage.filters;
    if (stage.pacing !== undefined) newStage.pacing = stage.pacing;
    if (stage.coolDown === true) newStage.coolDown = true;
    return { stages: [...run.stages, newStage] };
  }
  return {
    stages: run.stages.map((runStage, position) =>
      position === existingPosition ? { ...runStage, itemUuids: [...runStage.itemUuids, ...newUuids] } : runStage,
    ),
  };
};

/**
 * Drops uuids that left the queue and any stage left empty. Returns the same
 * run object when nothing changed, so it is safe inside a state setter.
 *
 * An empty queue leaves the run untouched: the queue is briefly empty while it
 * hydrates or a session syncs, and pruning then would wipe the stored run.
 * Keeping stale uuids is harmless because `locateInRun` ignores unqueued ones.
 */
export const pruneRun = (run: WorkoutRun, queueUuids: readonly string[]): WorkoutRun => {
  if (queueUuids.length === 0) return run;
  const queued = new Set(queueUuids);
  let changed = false;
  const stages: WorkoutRunStage[] = [];

  for (const runStage of run.stages) {
    const keptUuids = runStage.itemUuids.filter((uuid) => queued.has(uuid));
    if (keptUuids.length === runStage.itemUuids.length) {
      stages.push(runStage);
      continue;
    }
    changed = true;
    if (keptUuids.length === 0) continue;
    stages.push({ ...runStage, itemUuids: keptUuids });
  }

  return changed ? { stages } : run;
};

/** True when any stage paces the rest timer itself (a timed block). */
export const workoutRunHasPacing = (run: WorkoutRun): boolean => run.stages.some((stage) => stage.pacing !== undefined);

export type WorkoutRunPosition = {
  /** 0-based position of the current stage among the stages with queued items. */
  stageIndex: number;
  stageCount: number;
  stageId: string;
  kind: WorkoutStageKind;
  /** 1-based position of the current climb in its stage. */
  positionInStage: number;
  stageSize: number;
  /** Climbs after the current one in the same stage. On a 4x4, a climb is a set. */
  remainingInStage: number;
  /**
   * Set only on a stage planned as a cool-down (`WorkoutRunStage.coolDown`). It
   * follows the plan, not the queue order: its climbs step down wherever they sit.
   */
  isCoolDown?: true;
};

/**
 * Where the current climb sits in the workout.
 *
 * Order comes from the queue, not from the run: climbers can reorder the queue,
 * so "3 of 5" must follow what they will actually climb next. For the same
 * reason only uuids still in the queue count, and stages with none are skipped.
 * Stages are ordered by the queue position of their first queued climb, so
 * `stageIndex` matches the order the climber sees after moving a stage around.
 * Returns null when the current uuid is not queued or belongs to no stage.
 */
export const locateInRun = (
  run: WorkoutRun,
  currentUuid: string,
  queueUuids: readonly string[],
): WorkoutRunPosition | null => {
  const queuePositionByUuid = new Map<string, number>();
  queueUuids.forEach((uuid, position) => {
    if (!queuePositionByUuid.has(uuid)) queuePositionByUuid.set(uuid, position);
  });
  if (!queuePositionByUuid.has(currentUuid)) return null;

  const queuedStages: WorkoutRunStage[] = [];
  for (const runStage of run.stages) {
    const queuedUuids = runStage.itemUuids.filter((uuid) => queuePositionByUuid.has(uuid));
    if (queuedUuids.length === 0) continue;
    queuedUuids.sort((left, right) => (queuePositionByUuid.get(left) ?? 0) - (queuePositionByUuid.get(right) ?? 0));
    queuedStages.push({ ...runStage, itemUuids: queuedUuids });
  }
  const firstQueuePosition = (queuedStage: WorkoutRunStage) => queuePositionByUuid.get(queuedStage.itemUuids[0]) ?? 0;
  queuedStages.sort((left, right) => firstQueuePosition(left) - firstQueuePosition(right));

  for (let stageIndex = 0; stageIndex < queuedStages.length; stageIndex++) {
    const queuedStage = queuedStages[stageIndex];
    const positionInStage = queuedStage.itemUuids.indexOf(currentUuid);
    if (positionInStage < 0) continue;
    const position: WorkoutRunPosition = {
      stageIndex,
      stageCount: queuedStages.length,
      stageId: queuedStage.id,
      kind: queuedStage.kind,
      positionInStage: positionInStage + 1,
      stageSize: queuedStage.itemUuids.length,
      remainingInStage: queuedStage.itemUuids.length - positionInStage - 1,
    };
    if (queuedStage.kind === 'warmUp' && queuedStage.coolDown === true) position.isCoolDown = true;
    return position;
  }
  return null;
};
