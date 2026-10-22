// Ties the workout stage map (#5379) to a session's lifetime. Renders nothing,
// and reads only the session id, which changes on start, end and join.
//
// It deliberately does NOT prune the run as climbs leave the queue. Undo in the
// queue sheet restores removed climbs under their old uuids, and a pruned run
// would bring them back with no stage. Readers ignore uuids that are not queued
// (`locateInRun`, `describeWorkoutRun`), and the run is dropped when the session
// ends or the account signs out, so keeping stale uuids costs nothing.

import { useEffect, useRef } from 'react';
import { useQueueSessionId } from '../../providers/queue-provider';
import { clearWorkoutRunForSession, hydrateWorkoutRun } from '../../lib/workout-run-store';

export function WorkoutRunSessionSync() {
  const { sessionId } = useQueueSessionId();
  const previousSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    const previousSessionId = previousSessionIdRef.current;
    previousSessionIdRef.current = sessionId;
    // The session ended, or the climber joined another one. Only a session we
    // SAW go away counts: the id is null on a cold start until the stored
    // session is restored, and clearing then would lose the run we came back for.
    if (previousSessionId !== null && previousSessionId !== sessionId) {
      void clearWorkoutRunForSession(previousSessionId);
    }
    if (sessionId !== null) void hydrateWorkoutRun(sessionId);
  }, [sessionId]);

  return null;
}
