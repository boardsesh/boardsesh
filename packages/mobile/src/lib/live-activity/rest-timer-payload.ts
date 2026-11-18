// The rest timer as the Lock Screen, the Dynamic Island and the Android session
// notification draw it (#6513). Pure: no React, no I/O, `nowMs` passed in.
//
// A thin map over the session-timer snapshot (#5397), the same value the Rogue
// gym timer reads, with its fixed-window deadline from the helper the
// auto-advance scheduler counts to. So the widget can never disagree with them
// about which phase the timer is in or when its window ends.
// This file only adds what native needs on top: the signed number a frozen
// state shows, and the Android captions. The one thing left to the native side
// is time itself: a `running` payload carries its window, and the widget
// decides at render time whether that window has passed (and, for a
// fixed-window cadence, rolls on to the current one).

import type { TFunction } from 'i18next';
import type { LiveActivityRestTimerOptions } from '../../../modules/live-activity/src/index';
import { formatRestTimerElapsed, type RestTimerMode } from '../rest-timer';
import type { RestTimerState } from '../rest-timer-store';
import { buildSessionTimerSnapshot } from '../session-timer/snapshot';

export type RestTimerPayloadInput = {
  state: RestTimerState;
  targetSeconds: number | null;
  mode: RestTimerMode;
  /** The climber's "Show on Lock Screen" switch. */
  showOnLockScreen: boolean;
  /** The session the Live Activity / notification belongs to. */
  sessionId: string | null;
  nowMs: number;
  t: TFunction<'session'>;
};

/**
 * The payload to hand native, or `null` to take the timer off the Lock
 * Screen: switched off, no session, or the snapshot is `off` (disarmed, or
 * armed for a different session).
 */
export function buildRestTimerLiveActivityPayload({
  state,
  targetSeconds,
  mode,
  showOnLockScreen,
  sessionId,
  nowMs,
  t,
}: RestTimerPayloadInput): LiveActivityRestTimerOptions | null {
  // The Live Activity and the notification belong to a session. The snapshot
  // still runs for a solo climber (the gym timer follows it), so this one
  // gate is the Lock Screen's own.
  if (!showOnLockScreen || sessionId === null) return null;

  const snapshot = buildSessionTimerSnapshot({ state, pacing: { targetSeconds, mode }, sessionId, nowMs });
  if (snapshot.status === 'off') return null;

  const restSeconds = snapshot.targetSeconds;
  const base = { sessionId, targetSeconds: restSeconds, periodSeconds: null };

  if (snapshot.status === 'paused') {
    return {
      ...base,
      status: 'paused',
      startMs: null,
      deadlineMs: null,
      // The pill's number: time left (negative once over) with a rest length,
      // time since the tick without one.
      frozenSignedSeconds:
        restSeconds !== null ? restSeconds - snapshot.frozenElapsedSeconds : snapshot.frozenElapsedSeconds,
      androidCaption: t('mobile.restTimer.clockCaptionPaused'),
    };
  }

  if (snapshot.status === 'waiting') {
    return {
      ...base,
      status: 'waiting',
      startMs: null,
      deadlineMs: null,
      // Nothing to count yet, so the number is the rest length itself; a false
      // 0:00 would read as "your rest already started".
      frozenSignedSeconds: restSeconds ?? 0,
      androidCaption: t('mobile.restTimer.waitingForTick'),
    };
  }

  // Everything below is a live clock. Queue ended keeps counting exactly as
  // the pill does, on the same window as the clock it replaces; only the
  // status and caption change, and native draws it muted instead of turning
  // red past zero.
  const clock = {
    ...base,
    startMs: snapshot.cycleStartMs,
    deadlineMs: snapshot.deadlineMs,
    periodSeconds: snapshot.periodSeconds,
    frozenSignedSeconds: null,
  };

  if (snapshot.status === 'queueEnded') {
    return { ...clock, status: 'queueEnded', androidCaption: t('mobile.restTimer.queueEnded') };
  }

  // The snapshot counts up exactly when there is no rest length.
  if (restSeconds === null) {
    return { ...clock, status: 'countUp', androidCaption: t('mobile.restTimer.clockCaptionCountUp') };
  }

  return {
    ...clock,
    status: 'running',
    // A fixed window names its length. An after-tick rest gets the
    // before-the-deadline caption: Android's chronometer runs on past zero by
    // itself and the service swaps to the over caption on its own deadline
    // re-post, so the caption turns even while JS is suspended.
    androidCaption:
      snapshot.periodSeconds !== null
        ? t('mobile.restTimer.modeEvery', { length: formatRestTimerElapsed(snapshot.periodSeconds) })
        : t('mobile.restTimer.clockCaptionRest', { target: formatRestTimerElapsed(restSeconds) }),
    androidOverCaption: t('mobile.restTimer.clockCaptionOver'),
  };
}
