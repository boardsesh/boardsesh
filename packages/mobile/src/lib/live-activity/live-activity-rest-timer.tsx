// Feeds the rest timer to the Lock Screen, the Dynamic Island and the Android
// session notification (#6513).
//
// PERFORMANCE CONTRACT: no per-second work. The native side draws the
// countdown with self-updating views (iOS timer text, Android chronometer), so
// JS only speaks when the snapshot changes: a rest-timer event, a settings
// change, the session's Live Activity (re)starting, the app changing state,
// and one timeout at the deadline (when an after-tick rest goes over, and when
// a fixed window rolls to the next). Mounted as its own null-render leaf so the
// rest store's events re-render this component only, never the bridge.

import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useEffectiveRestPacing } from '../../hooks/use-effective-rest-pacing';
import { useRestTimerState } from '../../hooks/use-rest-timer';
import { useSetting } from '../../settings';
import { nowMs } from '../clock';
import { sessionPresenceSupportsRestTimer, updateLiveActivityRestTimer } from './live-activity-plugin';
import { buildRestTimerLiveActivityPayload } from './rest-timer-payload';

/**
 * Re-evaluate this long after a deadline, so the recompute lands past it
 * rather than a hair before it on a timer that fired early.
 */
export const REST_TIMER_DEADLINE_SLACK_MS = 250;

type UseLiveActivityRestTimerOptions = {
  sessionId: string | null;
  /**
   * Bumped by useLiveActivity after every successful start. Native clears the
   * snapshot when a session ends or another begins, so each start re-sends it
   * even when nothing about the timer changed.
   */
  activityStartCount: number;
};

export function useLiveActivityRestTimer({ sessionId, activityStartCount }: UseLiveActivityRestTimerOptions): void {
  const { t } = useTranslation('session');
  const restState = useRestTimerState();
  // The rest the timer actually runs on (settings today; a workout stage or the
  // crew clock once those feed the resolver), so the Lock Screen matches the pill.
  const { targetSeconds, mode } = useEffectiveRestPacing();
  const [showOnLockScreen] = useSetting('restTimerShowOnLockScreen');
  // Bumped by the deadline timeout and by app-state changes: both mean "the
  // clock moved, look again", which no store event would say.
  const [clockTick, setClockTick] = useState(0);
  // `undefined` until the first send, so the mount always speaks — a `null`
  // then clears a snapshot a killed app left behind.
  const lastSentRef = useRef<string | undefined>(undefined);
  const lastStartCountRef = useRef(activityStartCount);
  // Set by the deadline timeout: the snapshot may be byte-identical (an
  // after-tick rest keeps its window), but the Lock Screen still has to redraw
  // to show the overrun, so that one recompute always sends.
  const deadlinePassedRef = useRef(false);

  useEffect(() => {
    // A binary that predates the rest timer (this JS over the air) has nothing
    // to draw it with: build no snapshots and arm no timeouts there.
    if (!sessionPresenceSupportsRestTimer) return undefined;
    const now = nowMs();
    const payload = buildRestTimerLiveActivityPayload({
      state: restState,
      targetSeconds,
      mode,
      showOnLockScreen,
      sessionId,
      nowMs: now,
      t,
    });
    const serialized = JSON.stringify(payload);
    const restarted = lastStartCountRef.current !== activityStartCount;
    lastStartCountRef.current = activityStartCount;
    const deadlinePassed = deadlinePassedRef.current;
    deadlinePassedRef.current = false;
    if (restarted || deadlinePassed || serialized !== lastSentRef.current) {
      lastSentRef.current = serialized;
      void updateLiveActivityRestTimer(payload);
    }

    // Only a live countdown (running, or queue ended still counting) has a
    // moment in the future worth waking for.
    const isLiveCountdown = payload?.status === 'running' || payload?.status === 'queueEnded';
    const deadlineMs = isLiveCountdown ? payload.deadlineMs : null;
    if (deadlineMs === null || deadlineMs <= now) return undefined;
    const timeout = setTimeout(
      () => {
        deadlinePassedRef.current = true;
        setClockTick((tick) => tick + 1);
      },
      deadlineMs - now + REST_TIMER_DEADLINE_SLACK_MS,
    );
    return () => clearTimeout(timeout);
  }, [restState, targetSeconds, mode, showOnLockScreen, sessionId, activityStartCount, clockTick, t]);

  // Going to the background is the last chance to hand native a fresh window
  // before JS stops; coming back flushes whatever moved while away.
  useEffect(() => {
    if (!sessionPresenceSupportsRestTimer) return undefined;
    const subscription = AppState.addEventListener('change', () => {
      setClockTick((tick) => tick + 1);
    });
    return () => subscription.remove();
  }, []);
}

/** Renderless host for {@link useLiveActivityRestTimer}; see the file header. */
export function LiveActivityRestTimerSync(props: UseLiveActivityRestTimerOptions): null {
  useLiveActivityRestTimer(props);
  return null;
}
