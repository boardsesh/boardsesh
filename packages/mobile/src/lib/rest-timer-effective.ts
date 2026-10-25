// The two writes a workout makes to the rest timer (#5380, #6231): keeping the
// store's stage pacing in step with the climb on the wall, and arming the timer
// when a workout with a timed block starts. The resolving itself is pure and
// lives in `rest-timer-pacing.ts`; this module reads the current state and
// writes the result.

import { workoutRunHasPacing, type WorkoutRun } from '@boardsesh/playlist-generator';
import { getEffectiveRestPacing, getRestPacingSettings } from '../hooks/use-effective-rest-pacing';
import { followsAnotherMembersCrewClock } from './crew-rest-cadence';
import {
  planRestTimerPacingTransition,
  resolveEffectiveRestPacing,
  sameStagePacing,
  type RestTimerPacingTransition,
  type RestTimerStagePacing,
} from './rest-timer-pacing';
import { applyRestTimerStagePacing, armRestTimer, getRestTimerState } from './rest-timer-store';

/**
 * A workout started here (Start, or "Add a block") while a crewmate's crew
 * clock already ran (#5382): the queue items of its paced stages. The first of
 * them to reach the wall is a stage boundary whatever the crew clock was doing,
 * so the workout's pacing wins from its first climb. Keyed by queue item, not
 * stage id: "Add a block" can give its stages new ids in the merged run.
 */
let workoutStartBoundary: { sessionId: string; queueItemUuids: ReadonlySet<string> } | null = null;

/** The stage-boundary rule at a workout's start: on the minute starts its beat, a tick or send rule waits for the tick. */
function workoutStartTransition(next: RestTimerStagePacing | null): RestTimerPacingTransition | null {
  const boundary = workoutStartBoundary;
  if (boundary === null || next === null) return null;
  if (boundary.sessionId !== next.sessionId || getRestTimerState().crew?.config == null) {
    workoutStartBoundary = null;
    return null;
  }
  if (!boundary.queueItemUuids.has(next.queueItemUuid)) return null;
  workoutStartBoundary = null;
  if (next.mode === 'onTheMinute') return 'anchorNow';
  return next.advanceOn === 'deadline' ? null : 'waitForTick';
}

/**
 * Store the stage pacing of the climb now on the wall, moving an armed timer's
 * anchor (paused too) the way the change calls for (`planRestTimerPacingTransition`). A
 * no-op while the pacing is the same, so the caller can run it on every queue
 * change.
 *
 * The change is planned from what the timer ran on: a crewmate's crew clock
 * while this phone follows one (#5382), else this phone's own pacing (which a
 * clock this phone set runs, a debounce behind). Planned from the climber's
 * own settings instead, a crewmate's 1:30 grid entered by a 1:00 on-the-minute
 * stage would read as "the same interval" whenever the climber's own cadence
 * was 1:00, and keep the crewmate's beat. A workout started here over a
 * crewmate's clock is a boundary on its first paced climb
 * (`workoutStartBoundary`).
 */
export function syncRestTimerStagePacing(next: RestTimerStagePacing | null, nowMs: number): void {
  const { stagePacing: current, crew } = getRestTimerState();
  if (sameStagePacing(current, next)) return;
  const settings = getRestPacingSettings();
  const ranOn = followsAnotherMembersCrewClock() ? (crew?.config ?? null) : null;
  const planned = planRestTimerPacingTransition(
    resolveEffectiveRestPacing({ settings, stage: current, crew: ranOn }),
    resolveEffectiveRestPacing({ settings, stage: next, crew: null }),
  );
  applyRestTimerStagePacing(next, nowMs, workoutStartTransition(next) ?? planned);
}

/**
 * Start (and "Add a block") with a timed block: turn the timer on so the block
 * runs hands-free. Only when the workout has a stage that paces the timer, and
 * only when it is off, so a timer the climber already set up keeps going as it
 * is. Returns whether it armed. The cadence is the effective one; once
 * `RestTimerPacingSync` sees a paced climb on the wall it moves the anchor to
 * match (`applyRestTimerStagePacing`).
 *
 * On while a crewmate's crew clock runs (#5382): nothing is armed, but the
 * workout's first paced climb is marked as a stage boundary, so its pacing
 * goes to the crew clock with anchor NOW (on the minute) or CLEAR (a tick or
 * send rule) instead of carrying on the crewmate's beat.
 */
export function armRestTimerForWorkout(sessionId: string, run: WorkoutRun, nowMs: number): boolean {
  if (!workoutRunHasPacing(run)) return false;
  if (getRestTimerState().armed) {
    if (followsAnotherMembersCrewClock()) {
      const queueItemUuids = new Set(
        run.stages.filter((stage) => stage.pacing !== undefined).flatMap((stage) => stage.itemUuids),
      );
      workoutStartBoundary = { sessionId, queueItemUuids };
    }
    return false;
  }
  armRestTimer(getEffectiveRestPacing().mode, nowMs, sessionId);
  return true;
}

/** Test-only. */
export function resetRestTimerEffectiveForTests(): void {
  workoutStartBoundary = null;
}
