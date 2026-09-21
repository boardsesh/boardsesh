import { useEffect } from 'react';
import { nowMs } from '../../lib/clock';
import {
  isConnectStepTreatmentLive,
  localDayKey,
  shouldShowFirstConnectPill,
} from '../../lib/onboarding/first-connect-decision';
import { recordFirstConnectPillDay, useFirstConnectSnapshot } from '../../lib/onboarding/first-connect-store';
import { useFirstConnectCtaEnabled } from '../../providers/feature-flags-provider';

/**
 * Whether the play view shows the connect-step pill (#5654, PR 7, treatment
 * only) instead of the bare bulb, and the bookkeeping for its three-day limit:
 * each calendar day it is actually on screen counts once.
 *
 * Reads the connect-step store and the kill switch only, both of which change a
 * handful of times per install, so the play drawer does not re-render for it.
 *
 * `wouldConnect` is the host's word that a tap on the bulb right now would
 * connect this phone (see `shouldShowFirstConnectPill`).
 */
export function useFirstConnectPill(wouldConnect: boolean): boolean {
  const { device, enrolment } = useFirstConnectSnapshot();
  const enabled = useFirstConnectCtaEnabled();
  const today = localDayKey(nowMs());
  const visible = shouldShowFirstConnectPill({
    treatmentLive: isConnectStepTreatmentLive({ enrolment, enabled, device }),
    today,
    pillDays: device?.pillDays ?? [],
    wouldConnect,
  });

  useEffect(() => {
    if (visible) void recordFirstConnectPillDay(today);
  }, [visible, today]);

  return visible;
}
