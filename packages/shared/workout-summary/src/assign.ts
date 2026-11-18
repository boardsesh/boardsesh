// Which of a session's listed ticks belongs to which climb of a workout (#6903),
// for a Climbs list grouped by block.
//
// With the server's tick uuids (each climb's `tickUuids`, the workout's
// `offPlanTickUuids`), by uuid only: a tick in a climb's list goes to that
// climb, one in the off-plan list goes off plan, as does any other owner tick
// (one logged after the answer was read); everyone else's is the crew's.
// The derivation already decided whose tick is whose; matching again by climb
// could hand a crewmate's go on the same climb to the owner.
//
// Without them (an older payload), the owner's ticks are matched back the way
// `deriveWorkoutStages` placed them, by the same rule: oldest first (ties by
// uuid), each to a climb with the same climb, angle (and mirror, when both say)
// that has room, at or after the climb the tick before it went to in plan
// order, else one with room anywhere, else the last matching one. A climb only
// takes as many ticks as it has reps. Owner ticks left over are off plan;
// everyone else's go to the crew.

import { ticksInTimeOrder } from './tick-order';
import type { SessionWorkoutRepOutcome } from './types';

/** The fields of a listed tick the matching reads. */
export type AssignableWorkoutTick = {
  uuid: string;
  userId: string;
  climbUuid: string;
  angle: number;
  isMirror?: boolean | null;
  climbedAt: string;
};

/** The fields of a workout climb the matching reads. */
export type AssignableWorkoutClimb = {
  climbUuid: string;
  angle: number;
  isMirror?: boolean | null;
  reps: ReadonlyArray<SessionWorkoutRepOutcome>;
  /** The ticks behind `reps`, when the server sent them. */
  tickUuids?: ReadonlyArray<string> | null;
};

export type AssignedWorkoutTicks<Tick> = {
  /** Per stage, per climb (in the workout's order), that climb's ticks, oldest first. */
  byClimb: Tick[][][];
  /** The owner's ticks that match no climb, oldest first. */
  offPlan: Tick[];
  /** Everyone else's ticks, oldest first. */
  crew: Tick[];
};

const sameClimb = (climb: AssignableWorkoutClimb, tick: AssignableWorkoutTick): boolean => {
  if (climb.climbUuid !== tick.climbUuid || climb.angle !== tick.angle) return false;
  if (climb.isMirror === undefined || climb.isMirror === null) return true;
  if (tick.isMirror === undefined || tick.isMirror === null) return true;
  return climb.isMirror === tick.isMirror;
};

export function assignWorkoutTicks<Tick extends AssignableWorkoutTick>(
  ticks: ReadonlyArray<Tick>,
  workout: {
    userId: string;
    /** `repsPerSet`: a 4x4 stage's reps per set, the ticks each climb holds before the next copy takes them. */
    stages: ReadonlyArray<{ climbs: ReadonlyArray<AssignableWorkoutClimb>; repsPerSet?: number | null }>;
    offPlanTickUuids?: ReadonlyArray<string> | null;
  },
): AssignedWorkoutTicks<Tick> {
  const byClimb: Tick[][][] = workout.stages.map((stage) => stage.climbs.map(() => []));
  const slots = workout.stages.flatMap((stage, stageIndex) =>
    stage.climbs.map((climb, climbIndex) => ({
      climb,
      capacity: stage.repsPerSet ?? 1,
      ticks: byClimb[stageIndex][climbIndex],
    })),
  );
  const offPlan: Tick[] = [];
  const crew: Tick[] = [];
  const sorted = ticksInTimeOrder(ticks);

  const hasTickMap =
    !!workout.offPlanTickUuids || workout.stages.some((stage) => stage.climbs.some((climb) => !!climb.tickUuids));
  if (hasTickMap) {
    const slotByTick = new Map<string, Tick[]>();
    for (const slot of slots) for (const uuid of slot.climb.tickUuids ?? []) slotByTick.set(uuid, slot.ticks);
    const offPlanUuids = new Set(workout.offPlanTickUuids ?? []);
    for (const tick of sorted) {
      const slotTicks = slotByTick.get(tick.uuid);
      if (slotTicks) slotTicks.push(tick);
      // An owner tick the answer doesn't name (logged after it was read) is off plan, not the crew's.
      else if (offPlanUuids.has(tick.uuid) || tick.userId === workout.userId) offPlan.push(tick);
      else crew.push(tick);
    }
    return { byClimb, offPlan, crew };
  }

  // The derivation's three tiers, each limited to climbs whose reps are not all
  // claimed yet: a climb with room (fewer ticks than its stage's capacity) at or
  // after the slot the last tick went to, else one with room anywhere, else the
  // last matching climb, where the derivation piles what is left over.
  let lastSlotPosition = -1;
  for (const tick of sorted) {
    if (tick.userId !== workout.userId) {
      crew.push(tick);
      continue;
    }
    type Slot = (typeof slots)[number];
    const isOpen = (slot: Slot) => slot.ticks.length < slot.climb.reps.length && sameClimb(slot.climb, tick);
    const hasRoom = (slot: Slot) => isOpen(slot) && slot.ticks.length < slot.capacity;
    let openPosition = slots.findIndex((slot, position) => position >= lastSlotPosition && hasRoom(slot));
    if (openPosition < 0) openPosition = slots.findIndex(hasRoom);
    if (openPosition < 0) {
      let lastMatching = -1;
      slots.forEach((slot, position) => {
        if (sameClimb(slot.climb, tick)) lastMatching = position;
      });
      if (lastMatching >= 0 && isOpen(slots[lastMatching])) openPosition = lastMatching;
    }
    if (openPosition < 0) {
      offPlan.push(tick);
      continue;
    }
    slots[openPosition].ticks.push(tick);
    lastSlotPosition = openPosition;
  }
  return { byClimb, offPlan, crew };
}
