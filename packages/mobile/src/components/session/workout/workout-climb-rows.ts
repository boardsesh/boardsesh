// The session detail's Climbs list grouped by workout block (#6903): a section
// row per block, then the block's ticks; a 4x4 shows one row per set (climb)
// with its reps instead of one row per rep; a planned climb with no visible tick
// shows as one line saying what it came to (or "Skipped"); the owner's ticks
// that match no block go under "Off plan", and everyone else's under the crew.
// Pure, so the grouping is tested without a list.
//
// Which tick belongs where:
// - With the derivation's tick map (each climb's `tickUuids` and the view's
//   `offPlanTickUuids`, always sent by the server), by uuid only: a tick in a
//   climb's list goes to that climb, one in the off-plan list goes off plan, and
//   any other tick is someone else's. The derivation already decided whose
//   tick is whose; matching again by climb could hand a crewmate's go on the
//   same climb to the owner.
// - Without it (an older payload), only the owner's ticks (by `userId`) are
//   matched, oldest first, each to the first planned climb in plan order with the
//   same climb, angle and mirror that has fewer ticks so far than its reps. A
//   climb planned in both the warm-up and the cool-down therefore takes as many
//   ticks in the warm-up as the warm-up logged on it, and the rest go on to the
//   cool-down.

import type { SessionDetailTick } from '@boardsesh/shared-schema';
import type { SessionWorkoutView, WorkoutClimbView, WorkoutStageView } from './types';

export type WorkoutClimbsRow =
  | { type: 'block'; key: string; stage: WorkoutStageView }
  | { type: 'offPlan'; key: string; count: number }
  | { type: 'crew'; key: string; count: number }
  | { type: 'tick'; key: string; tick: SessionDetailTick }
  | {
      type: 'set';
      key: string;
      climb: WorkoutClimbView;
      setNumber: number;
      repsPerSet: number;
      /** The set's first tick: what a tap on the row opens. Null when none is visible. */
      tick: SessionDetailTick | null;
    }
  /**
   * A planned climb with no tick to list: skipped, or logged with ticks this
   * viewer can't see. Says what the block's tally counted for it.
   */
  | { type: 'climb'; key: string; climb: WorkoutClimbView };

export type WorkoutClimbsRows = {
  rows: WorkoutClimbsRow[];
  /** The ticks the rows open, in list order: the track a tap plays through. */
  orderedTicks: SessionDetailTick[];
};

type ClimbSlot = { stageIndex: number; climb: WorkoutClimbView; ticks: SessionDetailTick[] };

function isFourByFour(stage: WorkoutStageView): stage is WorkoutStageView & { repsPerSet: number } {
  return stage.kind === 'fourByFour' && typeof stage.repsPerSet === 'number' && stage.repsPerSet > 0;
}

function sameClimb(climb: WorkoutClimbView, tick: SessionDetailTick): boolean {
  if (climb.climbUuid !== tick.climbUuid || climb.angle !== tick.angle) return false;
  return climb.isMirror === undefined || climb.isMirror === tick.isMirror;
}

function byClimbedAt(left: SessionDetailTick, right: SessionDetailTick): number {
  return Date.parse(left.climbedAt) - Date.parse(right.climbedAt);
}

function hasTickMap(workout: SessionWorkoutView): boolean {
  return (
    workout.offPlanTickUuids !== undefined ||
    workout.stages.some((stage) => stage.climbs.some((climb) => climb.tickUuids !== undefined))
  );
}

/** Puts each tick on its climb, off plan, or with the crew. */
function assignTicks(
  ticks: readonly SessionDetailTick[],
  workout: SessionWorkoutView,
  slots: readonly ClimbSlot[],
): { offPlan: SessionDetailTick[]; crew: SessionDetailTick[] } {
  const offPlan: SessionDetailTick[] = [];
  const crew: SessionDetailTick[] = [];
  const sorted = [...ticks].sort(byClimbedAt);

  if (hasTickMap(workout)) {
    const slotByTickUuid = new Map<string, ClimbSlot>();
    for (const slot of slots) for (const uuid of slot.climb.tickUuids ?? []) slotByTickUuid.set(uuid, slot);
    const offPlanUuids = new Set(workout.offPlanTickUuids ?? []);
    for (const tick of sorted) {
      const slot = slotByTickUuid.get(tick.uuid);
      if (slot) slot.ticks.push(tick);
      else if (offPlanUuids.has(tick.uuid)) offPlan.push(tick);
      else crew.push(tick);
    }
    return { offPlan, crew };
  }

  for (const tick of sorted) {
    if (tick.userId !== workout.userId) {
      crew.push(tick);
      continue;
    }
    const open = slots.find((slot) => slot.ticks.length < slot.climb.reps.length && sameClimb(slot.climb, tick));
    if (open) open.ticks.push(tick);
    else offPlan.push(tick);
  }
  return { offPlan, crew };
}

export function buildWorkoutClimbRows(
  ticks: readonly SessionDetailTick[],
  workout: SessionWorkoutView,
): WorkoutClimbsRows {
  const slots: ClimbSlot[] = workout.stages.flatMap((stage, stageIndex) =>
    stage.climbs.map((climb) => ({ stageIndex, climb, ticks: [] })),
  );
  const { offPlan, crew } = assignTicks(ticks, workout, slots);

  const rows: WorkoutClimbsRow[] = [];
  const orderedTicks: SessionDetailTick[] = [];
  const pushTick = (tick: SessionDetailTick) => {
    rows.push({ type: 'tick', key: `tick-${tick.uuid}`, tick });
    orderedTicks.push(tick);
  };

  workout.stages.forEach((stage, stageIndex) => {
    rows.push({ type: 'block', key: `block-${stage.id}`, stage });
    const stageSlots = slots.filter((slot) => slot.stageIndex === stageIndex);
    if (isFourByFour(stage)) {
      stageSlots.forEach((slot, index) => {
        const firstTick = slot.ticks.at(0) ?? null;
        rows.push({
          type: 'set',
          key: `set-${stage.id}-${slot.climb.queueItemUuid}`,
          climb: slot.climb,
          setNumber: index + 1,
          repsPerSet: stage.repsPerSet,
          tick: firstTick,
        });
        if (firstTick) orderedTicks.push(firstTick);
      });
      return;
    }
    for (const slot of stageSlots) {
      if (slot.ticks.length > 0) slot.ticks.forEach(pushTick);
      else rows.push({ type: 'climb', key: `climb-${stage.id}-${slot.climb.queueItemUuid}`, climb: slot.climb });
    }
  });

  if (offPlan.length > 0) {
    rows.push({ type: 'offPlan', key: 'off-plan', count: offPlan.length });
    offPlan.forEach(pushTick);
  }
  if (crew.length > 0) {
    rows.push({ type: 'crew', key: 'crew', count: crew.length });
    crew.forEach(pushTick);
  }
  return { rows, orderedTicks };
}

/** FlashList recycles rows by type. */
export function workoutClimbsRowType(row: WorkoutClimbsRow): WorkoutClimbsRow['type'] {
  return row.type;
}

export function workoutClimbsRowKey(row: WorkoutClimbsRow): string {
  return row.key;
}
