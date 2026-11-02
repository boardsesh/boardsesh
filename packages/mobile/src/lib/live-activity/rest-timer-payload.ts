// The rest timer as the Lock Screen, the Dynamic Island and the Android session
// notification draw it (#6513). Pure: no React, no I/O, `nowMs` passed in.
//
// The phase rules are the pill's (`useRestTimerDisplay` in RestTimerPill.tsx)
// and the numbers come from the same helpers, so the widget can never disagree
// with the app about which state the timer is in or how long is left. The one
// thing left to the native side is time itself: a `running` snapshot carries
// its window, and the widget decides at render time whether that window has
// passed (and, for a fixed-window cadence, rolls on to the current one).

import type { TFunction } from 'i18next';
import type { LiveActivityRestTimerOptions } from '../../../modules/live-activity/src/index';
import { formatRestTimerElapsed, type RestTimerMode } from '../rest-timer';
import { getAutoAdvanceDeadlineMs, getRestTimerCycleElapsedSeconds } from '../rest-timer-auto-advance';
import type { RestTimerState } from '../rest-timer-store';

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
 * The snapshot to hand native, or `null` to take the timer off the Lock
 * Screen: switched off, disarmed, no session, or armed for a different session.
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
  if (!showOnLockScreen || sessionId === null || !state.armed) return null;
  // `null` is a pre-session arm that RestTimerSessionSync is about to bind to
  // this session; any other id is someone else's timer.
  if (state.armedForSessionId !== null && state.armedForSessionId !== sessionId) return null;

  const { anchorMs, isRunning, pausedElapsedSeconds, queueEnded, lastFiredDeadlineMs } = state;
  const hasTarget = targetSeconds !== null && targetSeconds > 0;
  const target = hasTarget ? targetSeconds : null;
  const elapsedSeconds = getRestTimerCycleElapsedSeconds({
    mode,
    anchorMs,
    targetSeconds,
    nowMs,
    isRunning,
    pausedElapsedSeconds,
  });
  // The pill's number: time left (negative once over) with a rest length, time
  // since the tick without one.
  const shownSeconds = target !== null ? target - elapsedSeconds : elapsedSeconds;

  const base = { sessionId, targetSeconds: target, periodSeconds: null };

  // Same precedence as the pill: paused, then waiting, then queue ended.
  if (!isRunning) {
    return {
      ...base,
      status: 'paused',
      startMs: null,
      deadlineMs: null,
      frozenSignedSeconds: shownSeconds,
      androidCaption: t('mobile.restTimer.clockCaptionPaused'),
    };
  }

  if (anchorMs === null) {
    return {
      ...base,
      status: 'waiting',
      startMs: null,
      deadlineMs: null,
      // Nothing to count yet, so the number is the rest length itself; a false
      // 0:00 would read as "your rest already started".
      frozenSignedSeconds: target ?? 0,
      androidCaption: t('mobile.restTimer.waitingForTick'),
    };
  }

  // Everything below is a live clock. Queue ended keeps counting exactly as
  // the pill does (its heartbeat ignores queueEnded), so it carries the same
  // timing as the snapshot it replaces; only the status and caption change,
  // and native draws it muted instead of turning red past zero.
  const queueEndedCaption = t('mobile.restTimer.queueEnded');

  if (target === null) {
    const countUp = { ...base, startMs: anchorMs, deadlineMs: null, frozenSignedSeconds: null };
    return queueEnded
      ? { ...countUp, status: 'queueEnded', androidCaption: queueEndedCaption }
      : { ...countUp, status: 'countUp', androidCaption: t('mobile.restTimer.clockCaptionCountUp') };
  }

  const overCaption = t('mobile.restTimer.clockCaptionOver');

  if (mode === 'onTheMinute') {
    // The beat the auto-advance scheduler is counting to, so the widget and
    // the app agree on when the window ends.
    const deadlineMs =
      getAutoAdvanceDeadlineMs({ mode, anchorMs, targetSeconds: target, nowMs, lastFiredDeadlineMs }) ??
      anchorMs + target * 1000;
    const window = {
      ...base,
      startMs: deadlineMs - target * 1000,
      deadlineMs,
      periodSeconds: target,
      frozenSignedSeconds: null,
    };
    return queueEnded
      ? { ...window, status: 'queueEnded', androidCaption: queueEndedCaption }
      : {
          ...window,
          status: 'running',
          androidCaption: t('mobile.restTimer.modeEvery', { length: formatRestTimerElapsed(target) }),
          androidOverCaption: overCaption,
        };
  }

  const rest = { ...base, startMs: anchorMs, deadlineMs: anchorMs + target * 1000, frozenSignedSeconds: null };
  return queueEnded
    ? { ...rest, status: 'queueEnded', androidCaption: queueEndedCaption }
    : {
        ...rest,
        status: 'running',
        // The before-the-deadline caption. Android's chronometer runs on past
        // zero by itself and the service swaps to the over caption on its own
        // deadline re-post, so the caption turns even while JS is suspended.
        androidCaption: t('mobile.restTimer.clockCaptionRest', { target: formatRestTimerElapsed(target) }),
        androidOverCaption: overCaption,
      };
}
