import { groupSlotsBySection } from './generate';
import { stageRestSeconds, type WorkoutStagePacing } from './pacing';
import { workoutRunHasPacing, type WorkoutRun } from './stages';
import type { PlannedClimbSlot } from './types';

export type PlanSectionCount = {
  section: PlannedClimbSlot['section'];
  count: number;
};

/**
 * What a filled plan will actually start: how many of the planned climbs found
 * a climb, the grade span of the ones that did, and the run of sections they
 * fall into. Callers pass the slots the climbs were picked for, so a slot a
 * thin catalogue couldn't fill drops out of every number here. A filled slot
 * carries the grade its climb came from, which differs from the planned slot
 * with the same `index` when the climb was borrowed from a nearby grade.
 */
export type PlanFillSummary = {
  planned: number;
  filled: number;
  /** Planned slots with no climb. Never negative. */
  missing: number;
  /**
   * Filled slots whose climb is from another grade than the one planned for
   * them (matched by `index`): a grade ran short and they borrowed from a
   * nearby one.
   */
  substituted: number;
  /** Lowest and highest difficulty id among the filled slots; null when none filled. */
  lowestGrade: number | null;
  highestGrade: number | null;
  /** Consecutive runs of the filled slots, in workout order. */
  sections: PlanSectionCount[];
};

export const summarizePlanFill = (
  planned: readonly PlannedClimbSlot[],
  filled: readonly PlannedClimbSlot[],
): PlanFillSummary => {
  const grades = filled.map((slot) => slot.grade);
  const plannedGradeByIndex = new Map(planned.map((slot) => [slot.index, slot.grade]));
  const substituted = filled.filter((slot) => {
    const plannedGrade = plannedGradeByIndex.get(slot.index);
    return plannedGrade !== undefined && plannedGrade !== slot.grade;
  }).length;
  return {
    planned: planned.length,
    filled: filled.length,
    missing: Math.max(0, planned.length - filled.length),
    substituted,
    lowestGrade: grades.length > 0 ? Math.min(...grades) : null,
    highestGrade: grades.length > 0 ? Math.max(...grades) : null,
    sections: groupSlotsBySection([...filled]).map((group) => ({ section: group.section, count: group.slots.length })),
  };
};

// ---------------------------------------------------------------------------
// Time estimate (#6291): "about 25 min" under the workout preview.
// ---------------------------------------------------------------------------

/** One try on the wall, getting on and off included. */
export const ESTIMATE_SECONDS_PER_TRY = 45;

/**
 * Tries a climb takes where the stage moves on only after a send (limit
 * bouldering). The real count is the climber's; this is a typical limit climb.
 * The rest timer starts after every logged try, falls included, so the
 * stage's rest is counted after each try.
 */
export const ESTIMATE_TRIES_UNTIL_SEND = 3;

/** The rest after each climb of a stage with no pacing of its own, which runs on the climber's own rests. */
export const ESTIMATE_UNPACED_REST_SECONDS = 120;

/**
 * The time one queued climb takes, and the rest at its end (left off after the
 * workout's last climb). A 4x4 set is its reps back to back with the rest
 * between reps, then the set rest.
 */
function climbTime(pacing: WorkoutStagePacing | undefined): { seconds: number; restAfter: number } {
  if (!pacing) {
    return {
      seconds: ESTIMATE_SECONDS_PER_TRY + ESTIMATE_UNPACED_REST_SECONDS,
      restAfter: ESTIMATE_UNPACED_REST_SECONDS,
    };
  }
  // One climb per interval: the beat moves the wall whatever happened on it.
  if (pacing.mode === 'onTheMinute') return { seconds: stageRestSeconds(pacing, false), restAfter: 0 };
  if (pacing.sets !== undefined) {
    const { repsPerSet } = pacing.sets;
    const setRestSeconds = stageRestSeconds(pacing, true);
    return {
      seconds:
        repsPerSet * ESTIMATE_SECONDS_PER_TRY + (repsPerSet - 1) * stageRestSeconds(pacing, false) + setRestSeconds,
      restAfter: setRestSeconds,
    };
  }
  const restSeconds = stageRestSeconds(pacing, false);
  const tries = pacing.advanceOn === 'send' ? ESTIMATE_TRIES_UNTIL_SEND : 1;
  return { seconds: tries * (ESTIMATE_SECONDS_PER_TRY + restSeconds), restAfter: restSeconds };
}

/**
 * About how long a workout takes, in minutes, from the run Start hands over:
 * every queued climb with the rest the stage paces after it
 * (`stageRestSeconds`, so the 10 s changeover counts), one interval per climb
 * on the minute, every rep of a 4x4 set with the rests between them and the set
 * rest, and a few tries per climb, each followed by the rest (the timer starts
 * after every logged try, falls included), where the stage moves on only after
 * a send. A stage with no pacing of its own (a warm-up before a 4x4) counts a
 * two-minute rest per climb. No rest is counted after the workout's last
 * climb. Whole minutes under 10, then rounded to fives.
 *
 * Null when no stage paces the timer: an untimed workout runs entirely on the
 * climber's own rests, so a figure would only be a guess.
 */
export function estimateWorkoutMinutes(run: WorkoutRun): number | null {
  if (!workoutRunHasPacing(run)) return null;
  let totalSeconds = 0;
  let lastRestSeconds = 0;
  for (const stage of run.stages) {
    const { seconds, restAfter } = climbTime(stage.pacing);
    totalSeconds += seconds * stage.itemUuids.length;
    if (stage.itemUuids.length > 0) lastRestSeconds = restAfter;
  }
  totalSeconds -= lastRestSeconds;
  if (totalSeconds <= 0) return null;
  const minutes = totalSeconds / 60;
  return minutes < 10 ? Math.max(1, Math.round(minutes)) : Math.round(minutes / 5) * 5;
}
