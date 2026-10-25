// The one rule for changing the rest timer's cadence (#5398). The in-session
// sheet and Settings › Timers both call it, so the two can never disagree about
// what a change does to a timer that is already running.

import { getSetting, setSetting } from '../settings';
import { getEffectiveRestPacing } from '../hooks/use-effective-rest-pacing';
import { nowMs } from './clock';
import { type RestTimerMode } from './rest-timer';
import { armRestTimer, getRestTimerState } from './rest-timer-store';

/**
 * Save the cadence, and re-arm a running timer onto it.
 *
 * Choosing the cadence that is already saved does nothing: Paper's
 * SegmentedButtons (Android, web) calls back on a press of the segment that is
 * ALREADY selected, and re-arming then would restart a fixed window mid-block or
 * wipe a running after-tick rest (#5664).
 *
 * An armed timer is re-armed rather than left with a half-converted anchor:
 * `onTheMinute` needs an anchor from this instant, `afterTick` needs none until
 * the next tick, and the two cannot be reconciled by editing the existing one.
 * A caller that already tracks `armed` (the sheet, through a hook) can pass it;
 * otherwise it is read from the store. Returns whether anything changed.
 */
export function changeRestTimerMode(
  nextMode: RestTimerMode,
  sessionId: string | null,
  armed: boolean = getRestTimerState().armed,
): boolean {
  if (nextMode === getSetting('restTimerMode')) return false;
  setSetting('restTimerMode', nextMode);
  // Only the climber's own cadence is re-armed. While a stage or the crew paces
  // the timer, the saved cadence is not what runs, and re-arming would drop the
  // stage's anchor mid-block. A crew clock this app cannot run resolves as the
  // settings, yet re-arming under it would ARM the session and replace the
  // crew's clock for everyone from a phone that cannot follow it (Fable, #6757).
  const pacing = getEffectiveRestPacing();
  if (armed && pacing.source === 'settings' && getRestTimerState().crew === null) {
    armRestTimer(pacing.mode, nowMs(), sessionId);
  }
  return true;
}
