// The session detail's Climbs list grouped by workout block (#6903): a section
// row per block, then the block's ticks; a 4x4 shows one row per set (climb)
// with its reps instead of one row per rep; a planned climb nobody logged shows
// as skipped; the owner's ticks that match no block go under "Off plan", and
// other climbers' ticks under the crew. Pure, so the grouping is tested
// without a list.
//
// Matching a tick to a planned climb: by its uuid when the view carries the
// stored tick map (`tickUuids`), otherwise in time order to the first planned
// climb (plan order) with the same climb, angle and mirror that still has a rep
// left to fill. Filling by rep count is what puts a climb repeated in the
// warm-up and the cool-down in the right block.

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
  | { type: 'skipped'; key: string; climb: WorkoutClimbView };

export type WorkoutClimbsRows = {
  rows: WorkoutClimbsRow[];
  /** The ticks the rows open, in list order: the track a tap plays through. */
  orderedTicks: SessionDetailTick[];
};

type ClimbSlot = { stageIndex: number; climbIndex: number; climb: WorkoutClimbView; ticks: SessionDetailTick[] };

function isFourByFour(stage: WorkoutStageView): stage is WorkoutStageView & { repsPerSet: number } {
  return stage.kind === 'fourByFour' && typeof stage.repsPerSet === 'number' && stage.repsPerSet > 0;
}

function sameClimb(slot: ClimbSlot, tick: SessionDetailTick): boolean {
  const { climb } = slot;
  if (climb.climbUuid !== tick.climbUuid || climb.angle !== tick.angle) return false;
  return climb.isMirror === undefined || climb.isMirror === tick.isMirror;
}

function byClimbedAt(left: SessionDetailTick, right: SessionDetailTick): number {
  return Date.parse(left.climbedAt) - Date.parse(right.climbedAt);
}

export function buildWorkoutClimbRows(
  ticks: readonly SessionDetailTick[],
  workout: SessionWorkoutView,
): WorkoutClimbsRows {
  const owner = workout.userId ?? null;
  const ownerTicks: SessionDetailTick[] = [];
  const crewTicks: SessionDetailTick[] = [];
  for (const tick of ticks) {
    if (owner === null || tick.userId === owner) ownerTicks.push(tick);
    else crewTicks.push(tick);
  }
  ownerTicks.sort(byClimbedAt);

  const slots: ClimbSlot[] = [];
  const slotByTickUuid = new Map<string, ClimbSlot>();
  workout.stages.forEach((stage, stageIndex) => {
    stage.climbs.forEach((climb, climbIndex) => {
      const slot: ClimbSlot = { stageIndex, climbIndex, climb, ticks: [] };
      slots.push(slot);
      for (const uuid of climb.tickUuids ?? []) slotByTickUuid.set(uuid, slot);
    });
  });

  const offPlan: SessionDetailTick[] = [];
  for (const tick of ownerTicks) {
    const mapped = slotByTickUuid.get(tick.uuid);
    if (mapped) {
      mapped.ticks.push(tick);
      continue;
    }
    const open = slots.find(
      (slot) => !slot.climb.tickUuids && slot.ticks.length < slot.climb.reps.length && sameClimb(slot, tick),
    );
    if (open) open.ticks.push(tick);
    else offPlan.push(tick);
  }

  const slotsByStage = new Map<number, ClimbSlot[]>();
  for (const slot of slots) {
    const list = slotsByStage.get(slot.stageIndex) ?? [];
    list.push(slot);
    slotsByStage.set(slot.stageIndex, list);
  }

  const rows: WorkoutClimbsRow[] = [];
  const orderedTicks: SessionDetailTick[] = [];
  const pushTick = (tick: SessionDetailTick) => {
    rows.push({ type: 'tick', key: `tick-${tick.uuid}`, tick });
    orderedTicks.push(tick);
  };

  workout.stages.forEach((stage, stageIndex) => {
    rows.push({ type: 'block', key: `block-${stage.id}`, stage });
    const stageSlots = slotsByStage.get(stageIndex) ?? [];
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
      if (slot.ticks.length > 0) {
        slot.ticks.forEach(pushTick);
      } else if (slot.climb.skipped) {
        rows.push({ type: 'skipped', key: `skipped-${stage.id}-${slot.climb.queueItemUuid}`, climb: slot.climb });
      }
    }
  });

  if (offPlan.length > 0) {
    rows.push({ type: 'offPlan', key: 'off-plan', count: offPlan.length });
    offPlan.forEach(pushTick);
  }
  if (crewTicks.length > 0) {
    rows.push({ type: 'crew', key: 'crew', count: crewTicks.length });
    crewTicks.forEach(pushTick);
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
