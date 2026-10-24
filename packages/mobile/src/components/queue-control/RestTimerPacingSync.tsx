// Keeps the rest timer's stage pacing in step with the climb on the wall
// (#5380, #6231). Renders nothing.
//
// Two parts, so a phone with no workout pays for nothing but two cheap reads.
// The outer part reads the session id and that session's run, and writes "no
// stage" once when there is no run. The inner part mounts only while a run
// exists: it reads the queue, locates the current climb in the run ONCE per
// change and hands the result to the store. The store ignores a write that
// changes nothing, and the 1 Hz clock in the pill never sees any of this.
//
// Mounted outside the rest timer's armed gate (RestTimerRuntime), so the arm
// row and Start arm with the stage's cadence, not the climber's own.

import { useEffect, useMemo } from 'react';
import { locateInRun, type WorkoutRun } from '@boardsesh/playlist-generator';
import { useQueueData, useQueueSessionId } from '../../providers/queue-provider';
import { useWorkoutRun } from '../../lib/workout-run-store';
import { nowMs } from '../../lib/clock';
import { resolveStageRestPacing } from '../../lib/rest-timer-pacing';
import { syncRestTimerStagePacing } from '../../lib/rest-timer-effective';

export function RestTimerPacingSync() {
  const { sessionId } = useQueueSessionId();
  const run = useWorkoutRun(sessionId);
  const hasRun = sessionId !== null && run !== null;

  // The run went (session ended, signed out, every climb removed), or there
  // never was one: no stage paces the timer.
  useEffect(() => {
    if (!hasRun) syncRestTimerStagePacing(null, nowMs());
  }, [hasRun]);

  if (sessionId === null || run === null) return null;
  return <RestTimerStagePacingResolver sessionId={sessionId} run={run} />;
}

function RestTimerStagePacingResolver({ sessionId, run }: { sessionId: string; run: WorkoutRun }) {
  const { queue, currentClimbQueueItem } = useQueueData();
  const currentQueueItemUuid = currentClimbQueueItem?.uuid ?? null;
  const queueUuids = useMemo(() => queue.map((queueItem) => queueItem.uuid), [queue]);

  const stagePacing = useMemo(() => {
    const position = currentQueueItemUuid === null ? null : locateInRun(run, currentQueueItemUuid, queueUuids);
    return resolveStageRestPacing({ sessionId, run, position, queueItemUuid: currentQueueItemUuid });
  }, [sessionId, run, currentQueueItemUuid, queueUuids]);

  useEffect(() => {
    syncRestTimerStagePacing(stagePacing, nowMs());
  }, [stagePacing]);

  return null;
}
