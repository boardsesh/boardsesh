// The two writes a workout makes to the rest timer (#5380, #6231): keeping the
// store's stage pacing in step with the climb on the wall, and arming the timer
// when a workout with a timed block starts. The resolving itself is pure and
// lives in `rest-timer-pacing.ts`; this module reads the current state and
// writes the result.

import { workoutRunHasPacing, type WorkoutRun } from '@boardsesh/playlist-generator';
import { getEffectiveRestPacing, getRestPacingSettings } from '../hooks/use-effective-rest-pacing';
import {
  planRestTimerPacingTransition,
  resolveEffectiveRestPacing,
  sameStagePacing,
  type RestTimerStagePacing,
} from './rest-timer-pacing';
import { applyRestTimerStagePacing, armRestTimer, getRestTimerState } from './rest-timer-store';

/**
 * Store the stage pacing of the climb now on the wall, moving an armed timer's
 * anchor (paused too) the way the change calls for (`planRestTimerPacingTransition`). A
 * no-op while the pacing is the same, so the caller can run it on every queue
 * change.
 */
export function syncRestTimerStagePacing(next: RestTimerStagePacing | null, nowMs: number): void {
  const current = getRestTimerState().stagePacing;
  if (sameStagePacing(current, next)) return;
  const settings = getRestPacingSettings();
  const transition = planRestTimerPacingTransition(
    resolveEffectiveRestPacing({ settings, stage: current, crew: null }),
    resolveEffectiveRestPacing({ settings, stage: next, crew: null }),
  );
  applyRestTimerStagePacing(next, nowMs, transition);
}

/**
 * Start (and "Add a block") with a timed block: turn the timer on so the block
 * runs hands-free. Only when the workout has a stage that paces the timer, and
 * only when it is off, so a timer the climber already set up keeps going as it
 * is. Returns whether it armed. The cadence is the effective one; once
 * `RestTimerPacingSync` sees a paced climb on the wall it moves the anchor to
 * match (`applyRestTimerStagePacing`).
 */
export function armRestTimerForWorkout(sessionId: string, run: WorkoutRun, nowMs: number): boolean {
  if (!workoutRunHasPacing(run) || getRestTimerState().armed) return false;
  armRestTimer(getEffectiveRestPacing().mode, nowMs, sessionId);
  return true;
}
