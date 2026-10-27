import type {
  DerivedWorkout,
  DerivedWorkoutClimb,
  DerivedWorkoutStage,
  DerivedWorkoutTally,
  SessionWorkoutPlan,
  SessionWorkoutPlanItem,
  SessionWorkoutPlanStage,
  SessionWorkoutTick,
  SessionWorkoutTickMapEntry,
  WorkoutHeadline,
} from './types';

const WARM_UP_KIND = 'warmUp';

const toMillis = (climbedAt: string | Date): number => {
  const millis = climbedAt instanceof Date ? climbedAt.getTime() : Date.parse(climbedAt);
  return Number.isNaN(millis) ? 0 : millis;
};

/** Mirror only splits two climbs when both sides say which way round they were. */
const sameMirror = (item: SessionWorkoutPlanItem, tick: SessionWorkoutTick): boolean =>
  item.isMirror === undefined || tick.isMirror === undefined || tick.isMirror === null
    ? true
    : item.isMirror === tick.isMirror;

/** Counts in ticks: the blocks' `sent` add up to the session's sends when every tick is on the plan. */
export function tallyWorkoutClimbs(climbs: ReadonlyArray<DerivedWorkoutClimb>): DerivedWorkoutTally {
  const tally: DerivedWorkoutTally = { sent: 0, attempts: 0, skipped: 0, climbs: climbs.length };
  for (const climb of climbs) {
    if (climb.skipped) tally.skipped += 1;
    for (const rep of climb.reps) {
      if (rep === 'attempt') tally.attempts += 1;
      else tally.sent += 1;
    }
  }
  return tally;
}

function deriveStage(stage: SessionWorkoutPlanStage, climbs: DerivedWorkoutClimb[]): DerivedWorkoutStage {
  const derived: DerivedWorkoutStage = {
    id: stage.id,
    kind: stage.kind,
    isCoolDown: stage.coolDown === true,
    climbs,
    tally: tallyWorkoutClimbs(climbs),
  };
  if (stage.targetGrade !== undefined) derived.targetGrade = stage.targetGrade;
  const { pacing } = stage;
  if (pacing?.mode === 'onTheMinute') derived.intervalSeconds = pacing.restSeconds;
  if (pacing?.mode === 'afterTick') derived.restSeconds = pacing.restSeconds;
  // A 4x4: one climb per set, done for every rep.
  if (pacing?.repsPerSet !== undefined) {
    derived.repsPerSet = pacing.repsPerSet;
    derived.sets = climbs.length;
  }
  return derived;
}

/**
 * What each block of a workout came to, from the OWNER's ticks in the session.
 *
 * A tick listed in `tickMap` goes to that queue item. Any other tick goes to
 * an item with the same climb and angle (and mirror, when both say): the first
 * one, in plan order, that still has room (a 4x4 climb until it holds
 * `repsPerSet` reps, any other climb until it holds one), else the last one.
 * So a climb queued twice fills its first slot before its second. A tick
 * matching no item counts as off plan. Ticks are placed in time order
 * (`climbedAt`, ties in input order) and reps keep that order. Every stage of
 * the plan is kept, a stage with no ticks included.
 */
export function deriveWorkoutStages(
  plan: SessionWorkoutPlan,
  tickMap: ReadonlyArray<SessionWorkoutTickMapEntry>,
  ticks: ReadonlyArray<SessionWorkoutTick>,
): DerivedWorkout {
  const climbsByQueueItem = new Map<string, DerivedWorkoutClimb>();
  const itemsInPlanOrder: Array<{ item: SessionWorkoutPlanItem; capacity: number }> = [];
  const climbsByStage = plan.stages.map((stage) =>
    stage.items.map((item) => {
      const climb: DerivedWorkoutClimb = {
        queueItemUuid: item.queueItemUuid,
        climbUuid: item.climbUuid,
        angle: item.angle,
        reps: [],
        tickUuids: [],
        skipped: true,
      };
      if (item.isMirror !== undefined) climb.isMirror = item.isMirror;
      climbsByQueueItem.set(item.queueItemUuid, climb);
      itemsInPlanOrder.push({ item, capacity: stage.pacing?.repsPerSet ?? 1 });
      return climb;
    }),
  );

  const queueItemByTick = new Map<string, string>();
  for (const entry of tickMap) {
    if (!queueItemByTick.has(entry.tickUuid)) queueItemByTick.set(entry.tickUuid, entry.queueItemUuid);
  }

  const orderedTicks = ticks
    .map((tick, index) => ({ tick, index, millis: toMillis(tick.climbedAt) }))
    .sort((left, right) => left.millis - right.millis || left.index - right.index)
    .map(({ tick }) => tick);

  const matchByClimb = (tick: SessionWorkoutTick): DerivedWorkoutClimb | undefined => {
    const matching = itemsInPlanOrder.filter(
      ({ item }) => item.climbUuid === tick.climbUuid && item.angle === tick.angle && sameMirror(item, tick),
    );
    const withRoom = matching.find(
      ({ item, capacity }) => (climbsByQueueItem.get(item.queueItemUuid)?.reps.length ?? 0) < capacity,
    );
    const chosen = withRoom ?? matching.at(-1);
    return chosen ? climbsByQueueItem.get(chosen.item.queueItemUuid) : undefined;
  };

  const offPlanTickUuids: string[] = [];
  for (const tick of orderedTicks) {
    const mappedQueueItem = queueItemByTick.get(tick.uuid);
    // A map entry naming an item the plan doesn't hold falls back to matching by climb.
    const mappedClimb = mappedQueueItem === undefined ? undefined : climbsByQueueItem.get(mappedQueueItem);
    const climb = mappedClimb ?? matchByClimb(tick);
    if (!climb) {
      offPlanTickUuids.push(tick.uuid);
      continue;
    }
    climb.reps.push(tick.status);
    climb.tickUuids.push(tick.uuid);
    climb.skipped = false;
  }

  return {
    stages: plan.stages.map((stage, position) => deriveStage(stage, climbsByStage[position])),
    offPlan: offPlanTickUuids.length,
    offPlanTickUuids,
  };
}

/**
 * Leaves out what a viewer may not see: a climb failing `keepClimb`, or holding
 * any tick failing `keepTick`, goes with all of its reps, and the tallies are
 * counted again. A stage left with no climbs goes too. Off-plan ticks failing
 * `keepTick` stop counting.
 *
 * A climb goes whole, rather than losing just the hidden reps, so a hidden tick
 * never turns a climb the owner did into one that reads as skipped.
 */
export function restrictDerivedWorkout(
  derived: DerivedWorkout,
  keepClimb: (climb: DerivedWorkoutClimb) => boolean,
  keepTick: (tickUuid: string) => boolean,
): DerivedWorkout {
  const stages: DerivedWorkoutStage[] = [];
  for (const stage of derived.stages) {
    const climbs = stage.climbs.filter((climb) => keepClimb(climb) && climb.tickUuids.every(keepTick));
    if (climbs.length === 0 && stage.climbs.length > 0) continue;
    const restricted: DerivedWorkoutStage = { ...stage, climbs, tally: tallyWorkoutClimbs(climbs) };
    if (stage.sets !== undefined) restricted.sets = climbs.length;
    stages.push(restricted);
  }
  const offPlanTickUuids = derived.offPlanTickUuids.filter(keepTick);
  return { stages, offPlan: offPlanTickUuids.length, offPlanTickUuids };
}

/**
 * A workout's main stages, in plan order: every stage but warm-ups and
 * cool-downs, or every stage when those are all there is.
 */
export function mainWorkoutStages<Stage extends { kind: string }>(stages: ReadonlyArray<Stage>): Stage[] {
  const workoutStages = stages.filter((stage) => stage.kind !== WARM_UP_KIND);
  return workoutStages.length > 0 ? workoutStages : [...stages];
}

/**
 * The one-line description of a workout for a feed card: its main block, the
 * second one for "A + B", and how many more for "A + N more". Main blocks are
 * every stage but warm-ups and cool-downs, unless those are all there is.
 * Takes plan stages or derived ones.
 */
export function workoutHeadline(stages: ReadonlyArray<{ kind: string; targetGrade?: number | null }>): WorkoutHeadline {
  const mainStages = mainWorkoutStages(stages);
  const [first, second] = mainStages;
  const headline: WorkoutHeadline = {
    blockCount: stages.length,
    extraMainBlocks: Math.max(0, mainStages.length - 1),
  };
  if (first) headline.mainKind = first.kind;
  if (first?.targetGrade !== undefined && first.targetGrade !== null) headline.mainTargetGrade = first.targetGrade;
  if (second) headline.secondMainKind = second.kind;
  return headline;
}
