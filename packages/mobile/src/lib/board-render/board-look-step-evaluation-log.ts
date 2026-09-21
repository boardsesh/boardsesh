import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../analytics';
import { getPreference, setPreference } from '../preference-store';
import { isSettledBoardLookReason, type BoardLookStepReason } from './board-look-step-decision';

/**
 * Device-wide marker for "this device has already reported what the board-look
 * gate would do". AsyncStorage, like the step's own seen flag, and deliberately
 * not user-scoped: the question is how many DEVICES the step would reach.
 */
const LOGGED_KEY = 'boardLookStepEvaluationLogged';

/**
 * Sends `Board Look Step Evaluated` at most once per device (#5654).
 *
 * While the gate evaluates without presenting, nothing ever marks the step
 * seen, so nearly every climber would qualify again on every launch. One event
 * per device answers "how many would get it" without a launch's worth of noise.
 * Only a settled verdict (`isSettledBoardLookReason`) spends that one report.
 *
 * The marker is written BEFORE the event is sent: a crash in between loses one
 * report, which is cheaper than a device that reports on every launch because
 * its write keeps failing. A failed storage read reports nothing, for the same
 * reason.
 */
export async function reportBoardLookStepEvaluationOnce(reason: BoardLookStepReason): Promise<void> {
  if (!isSettledBoardLookReason(reason)) return;
  try {
    if ((await getPreference<boolean>(LOGGED_KEY)) === true) return;
    await setPreference(LOGGED_KEY, true);
  } catch {
    return;
  }
  track(SHARED_EVENTS.BoardLookStepEvaluated, {
    outcome: reason === 'never_asked' ? 'would_present' : 'skipped',
    reason,
  });
}
