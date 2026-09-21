import { useEffect } from 'react';
import { nowMs } from '../../lib/clock';
import {
  isConnectStepTreatmentLive,
  localDayKey,
  shouldShowFirstConnectPill,
} from '../../lib/onboarding/first-connect-decision';
import { recordFirstConnectPillDay, useFirstConnectSelector } from '../../lib/onboarding/first-connect-store';
import { useFirstConnectCtaEnabled } from '../../providers/feature-flags-provider';

/**
 * Whether the play view shows the connect-step pill (#5654, PR 7, treatment
 * only) instead of the bare bulb, and the bookkeeping for its three-day limit:
 * each calendar day it is actually on screen counts once.
 *
 * Reads one boolean from the connect-step store (and the kill switch), so the
 * play drawer re-renders only when the pill's answer flips, not on every write
 * to the store (the Climbs card recording its launch, for one).
 *
 * `wouldConnect` is the host's word that a tap on the bulb right now would
 * connect this phone (see `shouldShowFirstConnectPill`).
 */
export function useFirstConnectPill(wouldConnect: boolean): boolean {
  const enabled = useFirstConnectCtaEnabled();
  const today = localDayKey(nowMs());
  const visible = useFirstConnectSelector(({ device, enrolment }) =>
    shouldShowFirstConnectPill({
      treatmentLive: isConnectStepTreatmentLive({ enrolment, enabled, device }),
      today,
      pillDays: device?.pillDays ?? [],
      wouldConnect,
    }),
  );

  useEffect(() => {
    if (visible) void recordFirstConnectPillDay(today);
  }, [visible, today]);

  return visible;
}
