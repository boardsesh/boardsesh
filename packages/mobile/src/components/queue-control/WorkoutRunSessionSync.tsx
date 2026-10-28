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
import {
  captureAuthCredentialGeneration,
  isAuthCredentialGenerationCurrent,
  subscribeAuthCredentialGenerationChanges,
} from '../../lib/auth-store';
import { readSignedInUserIdOrNull } from '../../offline/offline-sync-adapter';
import { nowMs } from '../../lib/clock';
import { enqueueEndedSessionWorkout } from '../../offline/session-workout-outbox';
import { subscribeStoredSessionEnded } from '../../lib/ended-session-signal';

export function WorkoutRunSessionSync() {
  const { sessionId } = useQueueSessionId();
  const previousSessionIdRef = useRef<string | null>(null);
  const queryClient = useQueryClient();
  // The run that went (#6903) becomes the session's recap, for the summary
  // screen mounting right after, stamped with its account. And its last copy
  // goes to the server: only a local End sends one from `beforeEnd`, and a
  // session can also end on another phone, drop this climber, or be found over
  // after a relaunch. A copy the End already queued is skipped.
  //
  // The account comes from the stored token, never the profile query, which a
  // relaunch onto an ended session can reach before it has loaded. It is read
  // ahead (and again whenever the credentials change), so the recap is there
  // the moment the summary mounts; when it is not known yet the run waits for
  // the read. Either way the credential generation must not have moved since,
  // so a sign-out between the clear and the read keeps nothing for anybody.
  const accountRef = useRef<{ generation: number; userId: string | null } | null>(null);
  const keepRecapRef = useRef((record: WorkoutRunRecord) => {
    const endedAtMs = nowMs();
    const keep = (ownerUserId: string | null) => {
      rememberEndedWorkout(record, endedAtMs, ownerUserId);
      void enqueueEndedSessionWorkout(record, { queryClient, ownerUserId });
    };
    const known = accountRef.current;
    if (known?.userId && isAuthCredentialGenerationCurrent(known.generation)) {
      keep(known.userId);
      return;
    }
    const generation = captureAuthCredentialGeneration();
    // A failed read keeps the recap unowned (no screen shows it) and sends nothing.
    void readSignedInUserIdOrNull().then((ownerUserId) => {
      if (isAuthCredentialGenerationCurrent(generation)) keep(ownerUserId);
    });
  });

  useEffect(() => {
    let mounted = true;
    const readAccount = () => {
      const generation = captureAuthCredentialGeneration();
      // A failed read leaves it unknown: a run cleared meanwhile reads the token itself.
      void readSignedInUserIdOrNull().then((userId) => {
        if (!mounted || !isAuthCredentialGenerationCurrent(generation)) return;
        accountRef.current = { generation, userId };
      });
    };
    readAccount();
    const unsubscribe = subscribeAuthCredentialGenerationChanges(() => {
      accountRef.current = null;
      readAccount();
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    void hydrateEndedWorkouts(nowMs());
  }, []);

  // A cold start that found the stored session over never sets its id, so the
  // change below never fires for it: the restore says so instead.
  useEffect(
    () =>
      subscribeStoredSessionEnded((endedSessionId) => {
        void clearWorkoutRunForSession(endedSessionId, keepRecapRef.current);
      }),
    [],
  );

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
