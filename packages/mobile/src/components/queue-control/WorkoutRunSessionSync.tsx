// Ties the workout stage map (#5379) to a session's lifetime. Renders nothing.
//
// Always mounted, but it only reads the session id, which changes on start,
// end and join. The queue subscription that prunes the run is a child mounted
// only while this session HAS a run, so climbers who never generate a workout
// pay nothing on queue changes.

import { useEffect, useMemo, useRef } from 'react';
import { useQueueData, useQueueSessionId } from '../../providers/queue-provider';
import {
  clearWorkoutRunForSession,
  hydrateWorkoutRun,
  pruneWorkoutRun,
  useWorkoutRun,
} from '../../lib/workout-run-store';

export function WorkoutRunSessionSync() {
  const { sessionId } = useQueueSessionId();
  const previousSessionIdRef = useRef<string | null>(null);
  const run = useWorkoutRun(sessionId);

  useEffect(() => {
    const previousSessionId = previousSessionIdRef.current;
    previousSessionIdRef.current = sessionId;
    // The session ended, or the climber joined another one. Only a session we
    // SAW go away counts: the id is null on a cold start until the stored
    // session is restored, and clearing then would lose the run we came back for.
    if (previousSessionId !== null && previousSessionId !== sessionId) {
      clearWorkoutRunForSession(previousSessionId);
    }
    if (sessionId !== null) void hydrateWorkoutRun(sessionId);
  }, [sessionId]);

  return run ? <WorkoutRunQueuePrune /> : null;
}

/** Drops climbs that left the queue from the run. Mounted only while a run exists. */
function WorkoutRunQueuePrune() {
  const { queue } = useQueueData();
  // One list per queue change, and a joined key so a re-render with the same
  // uuids (a climb edit, a current-climb move) does not prune again.
  const queueUuidKey = useMemo(() => queue.map((item) => item.uuid).join('\n'), [queue]);

  useEffect(() => {
    // `pruneWorkoutRun` leaves the run alone while the queue holds none of its
    // climbs (empty, or a sync from before the workout was appended).
    pruneWorkoutRun(queueUuidKey === '' ? [] : queueUuidKey.split('\n'));
  }, [queueUuidKey]);

  return null;
}
