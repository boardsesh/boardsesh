// Ties the rest timer's arm to a session's lifetime, and gives it an anchor on a
// cold start. Renders nothing. Mounted only while armed (see RestTimerRuntime),
// so the session query below costs nothing for the climbers who never use this.

import { useEffect } from 'react';
import { useQueueSessionId } from '../../providers/queue-provider';
import { useSessionDetail } from '../../lib/graphql/hooks/use-session-detail';
import { useStoredUserId } from '../../hooks/use-current-user-id';
import { getSetting } from '../../settings';
import { nowMs } from '../../lib/clock';
import { getNewerTickAt, getLatestUserSessionTickAt } from '../../lib/rest-timer-hydration';
import {
  bindRestTimerToSession,
  disarmRestTimer,
  getRestTimerState,
  noteRestTimerTick,
} from '../../lib/rest-timer-store';

export function RestTimerSessionSync() {
  const { sessionId } = useQueueSessionId();
  const { userId } = useStoredUserId(true);
  const { data: sessionDetail } = useSessionDetail(sessionId ?? undefined);

  // Arm → start → the arm follows you in. Session ends, or you join a different
  // one, and the arm goes with it: a timer bound to a session nobody is in would
  // keep counting against a rest that is over.
  useEffect(() => {
    const { armed, armedForSessionId } = getRestTimerState();
    if (!armed) return;

    if (sessionId === null) {
      // Only tear down an arm that HAD a session. A pre-session arm legitimately
      // has none yet, and solo climbers never get one at all.
      if (armedForSessionId !== null) disarmRestTimer();
      return;
    }

    if (armedForSessionId === null) {
      bindRestTimerToSession(sessionId);
      return;
    }

    if (armedForSessionId !== sessionId) disarmRestTimer();
  }, [sessionId]);

  // Cold start mid-rest: the store is empty but the session already knows when
  // your last tick landed. `getNewerTickAt` is what stops a stale server read
  // rewinding a live local anchor.
  useEffect(() => {
    const state = getRestTimerState();
    if (!state.armed || !sessionId) return;

    const hydratedTickAt = getLatestUserSessionTickAt(sessionDetail?.ticks, userId);
    if (!hydratedTickAt) return;

    const newerTickAt = getNewerTickAt(state.lastTickAt, hydratedTickAt);
    if (!newerTickAt || newerTickAt === state.lastTickAt) return;

    noteRestTimerTick(newerTickAt, getSetting('restTimerMode'), nowMs());
  }, [sessionDetail, sessionId, userId]);

  return null;
}
