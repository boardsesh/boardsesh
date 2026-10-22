// A workout as an ordered list of stages, and the carrier that tracks which
// queue items belong to which stage once the plan has been filled with climbs.
// Pure TS and JSON-serialisable: plans and runs are persisted by the apps.

import { generateWarmUp, generateWorkoutPlan } from './generate';
import type { GeneratorGradeScale, GeneratorOptions, PlannedClimbSlot, WarmUpType, WorkoutType } from './types';

// Stage kinds use the partner API block type names (docs/partner-api.md, "Blocks"),
// so `onTheMinute`, `fourByFour` and `limitBouldering` can join without renames.
export type WorkoutStageKind = 'warmUp' | WorkoutType;

/** Warm-up length for a warm-up stage. `'none'` is expressed by leaving the stage out. */
export type WarmUpStageType = Exclude<WarmUpType, 'none'>;

/**
 * Climbs stepping up to a target grade: its own `targetGrade` when set
 * (partner `warmUp` blocks carry their own range), else the grade of the first
 * workout stage after it. The app's warm-ups never set one.
 */
export type WarmUpStage = {
  id: string;
  kind: 'warmUp';
  warmUpType: WarmUpStageType;
  targetGrade?: number;
};

/** Generator options for one workout type, with warm-up handled by its own stage. */
export type StageGeneratorOptions<Kind extends WorkoutType = WorkoutType> = Extract<
  GeneratorOptions,
  { type: Kind }
> & {
  warmUp: 'none';
};

type WorkoutStageByKind = {
  [Kind in WorkoutType]: { id: string; kind: Kind; options: StageGeneratorOptions<Kind> };
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
    default: {
      const exhaustiveOptions: never = options;
      return exhaustiveOptions;
    }
  }
};

/**
 * One block of a workout as the climber builds it: a warm-up, or a workout of
 * one type. A warm-up has no grade of its own; it ramps to the next workout
 * block after it.
 */
export type WorkoutBlockSpec =
  | { kind: 'warmUp'; warmUpType: WarmUpStageType }
  | { kind: 'workout'; options: GeneratorOptions };

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
    stages.push(
      block.kind === 'warmUp' ? { id, kind: 'warmUp', warmUpType: block.warmUpType } : toMainStage(block.options, id),
    );
  }
  return { stages };
};

/**
 * Generates every stage's slots in plan order. `index` runs across the whole
 * plan, so a warm-up plus one workout yields exactly what `generateWorkoutPlan`
 * yields for the same options. A warm-up stage ramps to its own `targetGrade`,
 * else to the first workout stage after it, skipping any warm-ups in between;
 * with neither it generates nothing. A workout stage whose `kind` no longer
 * matches `options.type` generates nothing rather than throwing on persisted data.
 */
export const generateStagedPlan = (plan: WorkoutPlan, grades: GeneratorGradeScale): StagedSlot[] => {
  const stagedSlots: StagedSlot[] = [];

  plan.stages.forEach((stage, stagePosition) => {
    let stageSlots: PlannedClimbSlot[];
    if (isWarmUpStage(stage)) {
      const warmUpTarget =
        stage.targetGrade ?? plan.stages.slice(stagePosition + 1).find(isRunnableMainStage)?.options.targetGrade;
      stageSlots = warmUpTarget === undefined ? [] : generateWarmUp(warmUpTarget, stage.warmUpType, grades);
    } else if (!isRunnableMainStage(stage)) {
      stageSlots = [];
    } else {
      // Force `warmUp: 'none'` in case persisted data carries an older value.
      stageSlots = generateWorkoutPlan({ ...stage.options, warmUp: 'none' }, grades);
    }

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
};

/** What a run stage says about itself, without its climbs. */
export type WorkoutRunStageIdentity = Pick<WorkoutRunStage, 'id' | 'kind' | 'targetGrade'>;

/** Stages in workout order. A stage with no items is never kept. */
export type WorkoutRun = { stages: WorkoutRunStage[] };

/**
 * Groups queue-item uuids by stage, in plan order. Entries for unknown stages
 * are dropped, and a stage id repeated in the plan is emitted once, so no two
 * run stages ever share an `itemUuids` list.
 */
export const buildWorkoutRun = (
  entries: ReadonlyArray<{ uuid: string; stageId: string }>,
  plan: WorkoutPlan,
): WorkoutRun => {
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
  for (const stage of plan.stages) {
    if (emittedStageIds.has(stage.id)) continue;
    emittedStageIds.add(stage.id);
    const itemUuids = uuidsByStageId.get(stage.id);
    if (itemUuids && itemUuids.length > 0) {
      stages.push(
        isWarmUpStage(stage)
          ? { id: stage.id, kind: stage.kind, itemUuids }
          : { id: stage.id, kind: stage.kind, itemUuids, targetGrade: stage.options.targetGrade },
      );
    }
  }
  return { stages };
};

/**
 * Adds a stage's items to the end of the run. A stage id already in the run
 * with the same kind gets the items appended to it instead; the same id with a
 * different kind is a caller bug and throws. Uuids already in the run are
 * skipped, and when nothing is left to add the same run object comes back. A
 * new stage keeps the `targetGrade` it was given.
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
    const newStage: WorkoutRunStage =
      stage.targetGrade === undefined
        ? { id: stage.id, kind: stage.kind, itemUuids: newUuids }
        : { id: stage.id, kind: stage.kind, itemUuids: newUuids, targetGrade: stage.targetGrade };
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
    if (keptUuids.length > 0) {
      stages.push({ ...runStage, itemUuids: keptUuids });
    }
  }

  return changed ? { stages } : run;
};

export type WorkoutRunPosition = {
  /** 0-based position of the current stage among the stages with queued items. */
  stageIndex: number;
  stageCount: number;
  stageId: string;
  kind: WorkoutStageKind;
  /** 1-based position of the current climb in its stage. */
  positionInStage: number;
  stageSize: number;
  /** Climbs after the current one in the same stage. */
  remainingInStage: number;
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
    return {
      stageIndex,
      stageCount: queuedStages.length,
      stageId: queuedStage.id,
      kind: queuedStage.kind,
      positionInStage: positionInStage + 1,
      stageSize: queuedStage.itemUuids.length,
      remainingInStage: queuedStage.itemUuids.length - positionInStage - 1,
    };
  }
  return null;
};
