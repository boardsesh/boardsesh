// Which of a session's listed ticks belongs to which climb of a workout (#6903),
// for a Climbs list grouped by block. The server's `sessionWorkouts` answer says
// how many reps each climb holds but not which ticks they were, so the owner's
// ticks are matched back the way `deriveWorkoutStages` placed them: oldest
// first, each to the first climb in plan order with the same climb, angle (and
// mirror, when both say) that still has fewer ticks than its reps. Owner ticks
// left over are off plan; everyone else's go to the crew.

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

const toMillis = (iso: string): number => {
  const millis = Date.parse(iso);
  return Number.isNaN(millis) ? 0 : millis;
};

export function assignWorkoutTicks<Tick extends AssignableWorkoutTick>(
  ticks: ReadonlyArray<Tick>,
  workout: { userId: string; stages: ReadonlyArray<{ climbs: ReadonlyArray<AssignableWorkoutClimb> }> },
): AssignedWorkoutTicks<Tick> {
  const byClimb: Tick[][][] = workout.stages.map((stage) => stage.climbs.map(() => []));
  const slots = workout.stages.flatMap((stage, stageIndex) =>
    stage.climbs.map((climb, climbIndex) => ({ climb, ticks: byClimb[stageIndex][climbIndex] })),
  );
  const offPlan: Tick[] = [];
  const crew: Tick[] = [];
  const sorted = ticks
    .map((tick, index) => ({ tick, index, millis: toMillis(tick.climbedAt) }))
    .sort((left, right) => left.millis - right.millis || left.index - right.index)
    .map(({ tick }) => tick);

  for (const tick of sorted) {
    if (tick.userId !== workout.userId) {
      crew.push(tick);
      continue;
    }
    const open = slots.find((slot) => slot.ticks.length < slot.climb.reps.length && sameClimb(slot.climb, tick));
    if (open) open.ticks.push(tick);
    else offPlan.push(tick);
  }
  return { byClimb, offPlan, crew };
}
