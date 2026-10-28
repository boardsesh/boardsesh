// The session detail's Climbs list grouped by workout block (#6903): a section
// row per block, then the block's ticks; a 4x4 shows one row per set (climb)
// with its reps instead of one row per rep; a planned climb with no visible tick
// shows as one line saying what it came to (or "Skipped"); the owner's ticks
// that match no block go under "Off plan", and everyone else's under the crew.
// Pure, so the grouping is tested without a list.
//
// Which tick belongs where is `assignWorkoutTicks` from `@boardsesh/workout-summary`,
// the rule web uses too: by the answer's tick uuids (each climb's `tickUuids`,
// the workout's `offPlanTickUuids`) when it has them, else the owner's ticks
// matched back by climb and angle the way the derivation placed them. An owner
// tick the answer doesn't name goes off plan, everyone else's to the crew.

import type { SessionDetailTick } from '@boardsesh/shared-schema';
import { assignWorkoutTicks, isFourByFourStage } from '@boardsesh/workout-summary';
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

export function buildWorkoutClimbRows(
  ticks: readonly SessionDetailTick[],
  workout: SessionWorkoutView,
): WorkoutClimbsRows {
  const { byClimb, offPlan, crew } = assignWorkoutTicks(ticks, workout);

  const rows: WorkoutClimbsRow[] = [];
  const orderedTicks: SessionDetailTick[] = [];
  const pushTick = (tick: SessionDetailTick) => {
    rows.push({ type: 'tick', key: `tick-${tick.uuid}`, tick });
    orderedTicks.push(tick);
  };

  workout.stages.forEach((stage, stageIndex) => {
    rows.push({ type: 'block', key: `block-${stage.id}`, stage });
    const climbTicks = byClimb[stageIndex] ?? [];
    if (isFourByFourStage(stage)) {
      stage.climbs.forEach((climb, climbIndex) => {
        const firstTick = climbTicks[climbIndex]?.at(0) ?? null;
        rows.push({
          type: 'set',
          key: `set-${stage.id}-${climb.queueItemUuid}`,
          climb,
          setNumber: climbIndex + 1,
          repsPerSet: stage.repsPerSet,
          tick: firstTick,
        });
        if (firstTick) orderedTicks.push(firstTick);
      });
      return;
    }
    stage.climbs.forEach((climb, climbIndex) => {
      const slotTicks = climbTicks[climbIndex] ?? [];
      if (slotTicks.length > 0) slotTicks.forEach(pushTick);
      else rows.push({ type: 'climb', key: `climb-${stage.id}-${climb.queueItemUuid}`, climb });
    });
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
