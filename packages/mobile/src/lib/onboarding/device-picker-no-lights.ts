// The Bluetooth device picker's own "This wall has no lights", as the
// connect-step test (#5654, PR 7) hears it.

import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../analytics';
import { nowMs } from '../clock';
import { reportError } from '../error-reporting';
import { getFirstConnectSnapshot, markFirstConnectNoLightsBeforeFirstConnect } from './first-connect-store';

/**
 * Called from the picker's tap. The climber is telling us what the card's "This
 * wall has no lights" says, so the card and the pill stop offering a connect the
 * wall cannot take. Recorded for every phone that has never connected (the
 * phone's history is worth keeping in or out of the test); the event is for
 * enrolled accounts only, in both arms, like the card's.
 *
 * Heard at the tap, not inferred from the virtual hold the tap starts: the
 * Bluetooth provider also moves virtual holds around when the climber switches
 * boards, and that must never read as the climber saying the wall is dark.
 * Never throws.
 */
export function recordDevicePickerNoLights(): void {
  markFirstConnectNoLightsBeforeFirstConnect(nowMs())
    .then((recorded) => {
      if (!recorded || getFirstConnectSnapshot().enrolment === null) return;
      track(SHARED_EVENTS.BoardLightsDeclined, { surface: 'device_picker' });
    })
    .catch(reportError);
}
