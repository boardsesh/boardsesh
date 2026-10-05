// "Get updates early": a phone that opts in follows the early-updates OTA branch
// (`EARLY_UPDATES_OTA_BRANCH`), which receives every merge to main ahead of the
// daily stable release. See docs/mobile-ota-updates.md → "Early updates".
//
// Two pieces of state, kept apart on purpose:
//
// - the CHOICE (`earlyUpdates` setting): what the climber asked for. The switch
//   writes it at once, online or not.
// - the PIN (`otaPinnedBranch` setting, written by qa-surf.ts): the branch the
//   phone's update requests actually name.
//
// `syncEarlyUpdates` moves the pin towards the choice. It needs the network,
// because a pin may only be kept once an update downloaded under it is on disk
// (the rule at the top of the pin section in qa-surf.ts), so it can fail, and
// when it does the pin stays where it was and the next launch tries again.
//
// WHAT A COLD START LAUNCHES, for every state this file can leave a phone in.
// "Stamped for X" means downloaded while X was pinned, the only updates
// expo-updates will launch while X is pinned.
//
// | choice | pin record | on disk                      | cold start launches            |
// | ------ | ---------- | ---------------------------- | ------------------------------ |
// | off    | none       | regular updates, or none     | newest regular update, or the  |
// |        |            |                              | embedded bundle                |
// | on     | none       | same (join is waiting for a  | the same: the phone is simply  |
// |        |            | network, the flag, or the    | on the regular track until the |
// |        |            | server to offer the branch)  | join lands                     |
// | on     | pr-beta    | at least one update stamped  | newest update stamped pr-beta  |
// |        |            | pr-beta (join guarantees it) |                                |
// | off    | pr-beta    | same (leave is waiting for a | newest update stamped pr-beta  |
// |        |            | network)                     | until the leave lands          |
// | any    | pr-<n> or  | whatever the tester's surf   | not ours: this file stands     |
// |        | pr-staging | downloaded                   | down and leaves the pin alone  |
//
// No row has a pin without an update stamped for it, so none of them blocks the
// splash screen or emergency-launches. Two things outside this file still can,
// and both exist for a tester's preview pin today: the app killed in the middle
// of a switch (header written, download not finished), and a store update to a
// new binary while pinned (the pin survives, the updates on disk are for the old
// runtime). Online, either one costs a blocking download at that launch; offline
// it is an emergency launch of the embedded bundle. The sync below repairs the
// pin on the launch after.

import { track } from '../analytics';
import { EARLY_UPDATES_TOGGLED_EVENT } from '../ota-telemetry';
import { getSetting, setSetting } from '../../settings';
import type { EarlyUpdatesFlagState } from '../../providers/feature-flags-provider';
import {
  EARLY_UPDATES_OTA_BRANCH,
  fetchQaBranches,
  joinEarlyUpdatesTrack,
  leaveForProductionTrack,
  otaBranchKind,
  readIsEmergencyLaunch,
  readOtaPinnedBranch,
  readRunningOtaBranch,
  runPinChangeExclusively,
  surfToProduction,
  type OtaBranchKind,
  type SurfOutcome,
} from './qa-surf';

export type EarlyUpdatesSyncInput = {
  /** This binary can override its update request headers at all. */
  surfingBuild: boolean;
  /** The one-time channel migration has settled, so no reload is pending. */
  surfingReady: boolean;
  /** PostHog has answered, or its 2 s ceiling has passed. */
  flagsResolved: boolean;
  flag: EarlyUpdatesFlagState;
  /** What the climber asked for. */
  choice: boolean;
  /** The branch this app last pinned; null is the build's own channel. */
  pinnedBranch: string | null;
  runningBranchKind: OtaBranchKind;
  /** This launch fell back to the embedded bundle because nothing on disk could launch. */
  emergencyLaunch: boolean;
};

/**
 * - `wait`: an input is still on its way; decide again when it lands.
 * - `join`: move to the early-updates branch.
 * - `leave`: move back to the build's own channel.
 * - `none`: the pin is where it should be, or is not ours to move.
 */
export type EarlyUpdatesSyncAction = 'wait' | 'join' | 'leave' | 'none';

function isTesterPreview(kind: OtaBranchKind): boolean {
  return kind === 'preview' || kind === 'staging';
}

/** What to do about the branch pin. Pure, so every combination is a unit test. */
export function decideEarlyUpdatesSync(input: EarlyUpdatesSyncInput): EarlyUpdatesSyncAction {
  if (!input.surfingBuild) return 'none';
  // The migration clears the override and reloads, and a switch started while
  // flags are unresolved could outrun a switch-off that is about to land.
  if (!input.surfingReady || !input.flagsResolved) return 'wait';

  const pinnedEarly = input.pinnedBranch === EARLY_UPDATES_OTA_BRANCH;
  if (pinnedEarly) {
    // Ours, so the flag going off is acted on whichever bundle is running.
    if (input.flag === 'off' || !input.choice) return 'leave';
    // Pinned, yet nothing stamped for the pin could launch. Leaving fetches a
    // regular update, so the next launch has something to start from; the
    // launch after that joins again.
    return input.emergencyLaunch ? 'leave' : 'none';
  }

  // A tester's PR or staging pin owns the header until they leave it, which
  // goes through `returnToOwnTrack`. The running bundle covers a pin older than
  // the record.
  if (isTesterPreview(otaBranchKind(input.pinnedBranch)) || isTesterPreview(input.runningBranchKind)) return 'none';

  // Only on a flag that SAYS on. No value at all is not a reason to move anyone.
  return input.choice && input.flag === 'on' ? 'join' : 'none';
}

/**
 * - `joined` / `left`: the pin moved, and takes effect next time the app opens.
 * - `waiting`: the server has no early update this binary can run. Joined on a
 *   later launch.
 * - `deferred`: the switch could not be made now (offline, server trouble).
 *   Tried again on the next launch.
 * - `none`: nothing to do.
 */
export type EarlyUpdatesSyncOutcome = 'joined' | 'left' | 'waiting' | 'deferred' | 'none';

export type EarlyUpdatesSyncEnvironment = Pick<
  EarlyUpdatesSyncInput,
  'surfingBuild' | 'surfingReady' | 'flagsResolved' | 'flag'
>;

async function joinWhenOffered(): Promise<EarlyUpdatesSyncOutcome> {
  // Asked first, and never skipped: without the branch the server answers a
  // pinned request with the channel's own update, which is usually already on
  // disk under another stamp and so could not launch.
  const answer = await fetchQaBranches(undefined, { wholeList: false });
  if (answer.kind !== 'listed' || answer.list.earlyUpdates === null) return 'waiting';
  return (await joinEarlyUpdatesTrack()) === 'switched' ? 'joined' : 'waiting';
}

/**
 * Move the pin towards the choice. Never throws and never reloads: it runs in
 * the background at launch and behind the switch, and a failure only means the
 * pin stays put until the next attempt.
 */
export function syncEarlyUpdates(environment: EarlyUpdatesSyncEnvironment): Promise<EarlyUpdatesSyncOutcome> {
  // Decided INSIDE the turn, from the pin record as it is then: a tester's surf
  // that got in first has already taken the header.
  return runPinChangeExclusively(async () => {
    const action = decideEarlyUpdatesSync({
      ...environment,
      choice: getSetting('earlyUpdates'),
      pinnedBranch: readOtaPinnedBranch(),
      runningBranchKind: otaBranchKind(readRunningOtaBranch()),
      emergencyLaunch: readIsEmergencyLaunch(),
    });
    if (action === 'wait' || action === 'none') return 'none';
    try {
      if (action === 'join') return await joinWhenOffered();
      return (await leaveForProductionTrack()) === 'switched' ? 'left' : 'deferred';
    } catch {
      // Offline is the ordinary reason, at every launch of a phone with no
      // signal. Not worth an error report; the state says "waiting" instead.
      return 'deferred';
    }
  });
}

/**
 * The switch itself. Stores the choice at once, so it responds instantly and
 * works offline, then starts the sync. Resolves with how that went so the
 * screen can say when the change could not be made yet.
 */
export function setEarlyUpdatesChoice(
  enabled: boolean,
  environment: EarlyUpdatesSyncEnvironment,
): Promise<EarlyUpdatesSyncOutcome> {
  setSetting('earlyUpdates', enabled);
  track(EARLY_UPDATES_TOGGLED_EVENT, { enabled });
  return syncEarlyUpdates(environment);
}

/**
 * The server switched branch surfing off for this channel, which asks every
 * pinned device to unpin. Done as a proper leave (a regular update is fetched
 * before the pin is dropped) and for whichever pin is in place, a tester's
 * included. The choice is kept: joining asks the server for the branch first,
 * so nothing re-pins while surfing stays off, and a member is back when it is
 * on again. Nothing is written for a phone that was not pinned.
 */
export function noteBranchSurfingOff(): Promise<void> {
  return runPinChangeExclusively(async () => {
    if (readOtaPinnedBranch() === null) return;
    try {
      await leaveForProductionTrack();
    } catch {
      // Still pinned to a branch with an update on disk, which is safe. The
      // next surfing-off answer tries again.
    }
  });
}

export type OwnTrackOutcome = SurfOutcome | 'early-updates-next-launch';

/**
 * Leave a PR preview (or staging) for the track this phone normally follows.
 *
 * Everyone else goes back to the build's own channel the way they always did.
 * A member goes to early updates, with no reload: clearing the pin would put
 * them on the regular track until the launch sync moved them again. When the
 * server has no early update for this binary, the regular track IS their track
 * for now, and the launch sync joins later.
 *
 * Rejects when the switch cannot be made (offline). The preview pin is then
 * still in place and the caller says so.
 */
export async function returnToOwnTrack(member: boolean): Promise<OwnTrackOutcome> {
  if (member && (await runPinChangeExclusively(joinWhenOffered)) === 'joined') return 'early-updates-next-launch';
  return surfToProduction();
}
