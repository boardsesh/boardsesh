import { useEffect, useRef } from 'react';
import { reportHandledError } from '../../lib/error-reporting';
import { useOtaBranchSurfingState } from '../../lib/ota-branch-surfing-state';
import {
  applyEarlyUpdatesPin,
  clearEarlyUpdatesPinForFlag,
  decideEarlyUpdatesLaunch,
} from '../../lib/qa/early-updates';
import { otaBranchKind, readRunningOtaBranch } from '../../lib/qa/qa-surf';
import { useEarlyUpdatesFlagState, useFeatureFlagsResolved } from '../../providers/feature-flags-provider';
import { getSetting } from '../../settings';

/**
 * Keeps a member's early-updates pin in place across launches. Renders nothing.
 *
 * The pin is a native header override nothing can read back, and other code
 * clears it for good reasons of its own (a failed surf restoring, the one-time
 * channel migration). So once per launch this re-applies it from the stored
 * choice. It only ever sets or clears request headers: no update check, no
 * download, no reload, no network. What the headers select arrives the next
 * time the app opens.
 *
 * Waits for the feature flags and for the surfing migration; the policy is
 * `decideEarlyUpdatesLaunch`. The stored choice is read inside the effect, not
 * subscribed to, because the switch in More applies its own pin. Subscribing
 * would run this a second time behind every flip.
 */
export function EarlyUpdatesLaunchSync() {
  const flagsResolved = useFeatureFlagsResolved();
  const flag = useEarlyUpdatesFlagState();
  const { surfingBuild, ready: surfingReady } = useOtaBranchSurfingState();
  // Once per launch. A flag that resolves late (stale cache first, the real
  // answer a moment after) re-runs the effect, and the pin is idempotent, but
  // there is no reason to write the same headers twice.
  const pinnedRef = useRef(false);

  useEffect(() => {
    const action = decideEarlyUpdatesLaunch({
      surfingBuild,
      surfingReady,
      flagsResolved,
      flag,
      member: getSetting('earlyUpdates'),
      pinClearedByFlag: getSetting('earlyUpdatesPinClearedByFlag'),
      runningBranchKind: otaBranchKind(readRunningOtaBranch()),
    });
    if (action !== 'pin' && action !== 'clear') return;
    if (action === 'pin' && pinnedRef.current) return;

    try {
      if (action === 'pin') {
        applyEarlyUpdatesPin();
      } else {
        clearEarlyUpdatesPinForFlag();
      }
      pinnedRef.current = action === 'pin';
    } catch (error) {
      // A launch-time header write must never become a visible error. The
      // choice is still stored, so the next launch tries again.
      reportHandledError(error, { tags: { source: 'ota', op: `early-updates-${action}` } });
    }
  }, [surfingBuild, surfingReady, flagsResolved, flag]);

  return null;
}
