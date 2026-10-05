// "Get updates early": a phone that opts in follows the early-updates OTA branch
// (`EARLY_UPDATES_OTA_BRANCH`), which receives every merge to main ahead of the
// daily stable release. See docs/mobile-ota-updates.md → "Early updates".
//
// Two pieces of state, and they are not the same thing. The CHOICE is the
// `earlyUpdates` setting. The PIN is a native request-header override that
// persists across launches but cannot be read back, and that other code clears
// for its own reasons: xprem restoring after a failed surf, the one-time channel
// migration. So the choice is the source of truth and the pin is re-applied from
// it at launch.

import { track } from '../analytics';
import { EARLY_UPDATES_TOGGLED_EVENT } from '../ota-telemetry';
import { getSetting, setSetting } from '../../settings';
import type { EarlyUpdatesFlagState } from '../../providers/feature-flags-provider';
import { clearOtaBranchPin, pinEarlyUpdates, surfToProduction, type OtaBranchKind, type SurfOutcome } from './qa-surf';

export type EarlyUpdatesLaunchInput = {
  /** This binary can override its update request headers at all. */
  surfingBuild: boolean;
  /** The one-time channel migration has settled, so no reload is pending. */
  surfingReady: boolean;
  /** PostHog has answered, or its 2 s ceiling has passed. */
  flagsResolved: boolean;
  flag: EarlyUpdatesFlagState;
  /** The stored choice. */
  member: boolean;
  /** The pin was already cleared once for the flag being off. */
  pinClearedByFlag: boolean;
  runningBranchKind: OtaBranchKind;
};

/**
 * - `wait`: an input is still on its way; decide again when it lands.
 * - `pin`: put the early-updates pin back.
 * - `clear`: the feature was switched off for a member; drop the pin, once.
 * - `none`: leave the headers exactly as they are.
 */
export type EarlyUpdatesLaunchAction = 'wait' | 'pin' | 'clear' | 'none';

/**
 * What to do about the branch pin at launch. Pure, so every combination is a
 * unit test. Neither action it can ask for touches the network or reloads.
 */
export function decideEarlyUpdatesLaunch(input: EarlyUpdatesLaunchInput): EarlyUpdatesLaunchAction {
  if (!input.surfingBuild) return 'none';
  // The migration clears the override and reloads. A pin written before it
  // settles would be wiped, and a pin written while flags are unresolved could
  // outrun a switch-off that is about to land.
  if (!input.surfingReady || !input.flagsResolved) return 'wait';
  if (!input.member) return 'none';
  // A tester running a PR preview or the staged bundle chose that branch after
  // joining. Their pin is theirs until they leave it, which re-pins early
  // updates (`returnToOwnTrack`).
  if (input.runningBranchKind === 'preview' || input.runningBranchKind === 'staging') return 'none';
  if (input.flag === 'on') return 'pin';
  // Only on PostHog SAYING off. No answer at all (offline, unreachable) is not
  // a reason to drop anyone from the track.
  if (input.flag === 'off') return input.pinClearedByFlag ? 'none' : 'clear';
  return 'none';
}

/** Re-apply the pin at launch. No event: nobody toggled anything. */
export function applyEarlyUpdatesPin(): void {
  pinEarlyUpdates();
  // Guarded so an ordinary launch is not a settings write, which would wake
  // every `useSetting` subscriber for nothing.
  if (getSetting('earlyUpdatesPinClearedByFlag')) setSetting('earlyUpdatesPinClearedByFlag', false);
}

/** The flag went off for a member: drop the pin and remember that we did. */
export function clearEarlyUpdatesPinForFlag(): void {
  clearOtaBranchPin();
  setSetting('earlyUpdatesPinClearedByFlag', true);
}

/**
 * The switch itself. Pins or unpins first and stores the choice only once that
 * worked, so the setting never claims a track the phone is not on. Throws what
 * the pin throws; the caller says so.
 */
export function setEarlyUpdatesMembership(enabled: boolean): void {
  if (enabled) {
    applyEarlyUpdatesPin();
  } else {
    clearOtaBranchPin();
  }
  setSetting('earlyUpdates', enabled);
  track(EARLY_UPDATES_TOGGLED_EVENT, { enabled });
}

export type OwnTrackOutcome = SurfOutcome | 'early-updates-next-launch';

/**
 * Leave a PR preview (or staging) for the track this phone normally follows.
 *
 * Everyone else goes back to the build's own channel the way they always did.
 * A member goes back to early updates, pin only: without this their pin would
 * be gone while the preview bundle kept running, and the launch re-pin stands
 * down on a preview bundle, so they would sit on the regular track until it
 * shipped something newer than the preview.
 */
export async function returnToOwnTrack(member: boolean): Promise<OwnTrackOutcome> {
  if (!member) return surfToProduction();
  pinEarlyUpdates();
  return 'early-updates-next-launch';
}
