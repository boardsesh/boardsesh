// Ties the workout stage map (#5379) to a session's lifetime. Renders nothing,
// and reads only the session id, which changes on start, end and join.
//
// It deliberately does NOT prune the run as climbs leave the queue. Undo in the
// queue sheet restores removed climbs under their old uuids, and a pruned run
// would bring them back with no stage. Readers ignore uuids that are not queued
// (`locateInRun`, `describeWorkoutRun`), and the run is dropped when the session
// ends or the account signs out, so keeping stale uuids costs nothing.

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useQueueSessionId } from '../../providers/queue-provider';
import { clearWorkoutRunForSession, hydrateWorkoutRun, type WorkoutRunRecord } from '../../lib/workout-run-store';
import { hydrateEndedWorkouts, rememberEndedWorkout } from '../../lib/ended-workout-store';
import { useProfile } from '../../lib/graphql/hooks';
import { nowMs } from '../../lib/clock';
import { enqueueEndedSessionWorkout } from '../../offline/session-workout-outbox';

export function WorkoutRunSessionSync() {
  const { sessionId } = useQueueSessionId();
  const previousSessionIdRef = useRef<string | null>(null);
  const queryClient = useQueryClient();
  const { data: profile } = useProfile();
  const viewerUserIdRef = useRef<string | null>(null);
  viewerUserIdRef.current = profile?.id ?? null;
  // The run that went (#6903) becomes the session's recap, for the summary
  // screen mounting right after, stamped with its account. And its last copy
  // goes to the server: only a local End sends one from `beforeEnd`, and a
  // session can also end on another phone, drop this climber, or be found over
  // after a relaunch. A copy the End already sent is skipped.
  const keepRecapRef = useRef((record: WorkoutRunRecord) => {
    rememberEndedWorkout(record, nowMs(), viewerUserIdRef.current);
    void enqueueEndedSessionWorkout(record, { queryClient });
  });

  useEffect(() => {
    void hydrateEndedWorkouts(nowMs());
  }, []);

  useEffect(() => {
    const previousSessionId = previousSessionIdRef.current;
    previousSessionIdRef.current = sessionId;
    // The session ended, or the climber joined another one. Only a session we
    // SAW go away counts: the id is null on a cold start until the stored
    // session is restored, and clearing then would lose the run we came back for.
    if (previousSessionId !== null && previousSessionId !== sessionId) {
      void clearWorkoutRunForSession(previousSessionId, keepRecapRef.current);
    }
    if (sessionId !== null) void hydrateWorkoutRun(sessionId);
  }, [sessionId]);

  return null;
}
