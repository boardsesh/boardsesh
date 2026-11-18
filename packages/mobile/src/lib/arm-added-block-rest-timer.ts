// The rest-timer rule for climbs added to a session that is already running:
// "Add a block", and a partner app's workout added to this session. Its own
// module so both callers share the one rule, and so a test can watch the arm
// it makes without stubbing the rule away.

import type { WorkoutRun } from '@boardsesh/playlist-generator';
import { armRestTimerForWorkout } from './rest-timer-effective';
import { isWorkoutRunPendingStart } from './workout-run-store';

/**
 * Arms the rest timer on the added block's own pacing (`blockRun`, not the whole
 * run: adding a volume block to a workout that once had a 4x4 must not turn back
 * on a timer the climber switched off). Never while the session's workout is
 * still waiting for its Start: Start arms it then, for the whole run. True when
 * it armed.
 */
export function armRestTimerForAddedBlock(sessionId: string, blockRun: WorkoutRun, nowMs: number): boolean {
  if (isWorkoutRunPendingStart(sessionId)) return false;
  return armRestTimerForWorkout(sessionId, blockRun, nowMs);
}
