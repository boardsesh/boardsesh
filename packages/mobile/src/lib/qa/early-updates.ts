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
// WHAT A COLD START LAUNCHES, for every state this file leaves a phone in.
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
// |        |            | network or a new update id)  | until the leave lands          |
// | any    | pr-<n> or  | whatever the tester's surf   | not ours, while the server     |
// |        | pr-staging | downloaded                   | still offers that branch       |
//
// No row has a pin without an update stamped for it. What can still put a phone
// there, by platform (the embedded bundle is why they differ; see qa-surf.ts):
//
// | situation                    | Android                       | iOS                           |
// | ---------------------------- | ----------------------------- | ----------------------------- |
// | store update to a new binary | EVERY time: nothing matches.  | launches the new embedded     |
// | while pinned                 | Online: splash blocks on a    | bundle normally (it is        |
// |                              | full download. Offline:       | inserted under the pin). It   |
// |                              | emergency launch.             | then carries the pin's stamp. |
// | app killed mid-switch        | same as above, once           | embedded bundle if it is not  |
// |                              |                               | on disk, else as Android      |
//
// Neither can be prevented from JS: the launch decision is made before any JS
// runs. After an emergency launch the sync drops the pin with no download first
// (`repair`), so an offline phone does not repeat it at every open.

import { track } from '../analytics';
import { EARLY_UPDATES_TOGGLED_EVENT } from '../ota-telemetry';
import { getSetting, setSetting } from '../../settings';
import type { EarlyUpdatesFlagState } from '../../providers/feature-flags-provider';
import {
  EARLY_UPDATES_OTA_BRANCH,
  STAGING_OTA_BRANCH,
  dropPinAfterEmergencyLaunch,
  fetchQaBranches,
  joinEarlyUpdatesTrack,
  leaveForProductionTrack,
  otaBranchKind,
  readIsEmergencyLaunch,
  readOtaPinnedBranch,
  readRunningOtaBranch,
  readRunningUpdateId,
  runPinChangeExclusively,
  surfToProduction,
  type OtaBranchKind,
  type QaBranchList,
  type SurfOutcome,
  type TrackSwitchOutcome,
} from './qa-surf';

export type EarlyUpdatesSyncInput = {
  /** This binary can override its update request headers at all. */
  surfingBuild: boolean;
  /** The one-time channel migration has settled, so no reload is pending. */
  surfingReady: boolean;
  /** PostHog has answered, or its 2 s ceiling has passed. */
  flagsResolved: boolean;
  flag: EarlyUpdatesFlagState;
  /**
   * An `off` flag may be ACTED on: it came in a fresh response this launch, for
   * the account that was signed in when the app opened, and no flag-driven
   * leave has been tried yet this launch. Hiding the row needs none of this.
   */
  flagOffConfirmed: boolean;
  /** What the climber asked for. */
  choice: boolean;
  /** The branch this app last pinned; null is the build's own channel. */
  pinnedBranch: string | null;
  runningBranch: string | null;
  /** This launch fell back to the embedded bundle and has not been repaired yet. */
  emergencyLaunch: boolean;
  /** The server switched surfing off and the unpin could not be completed. */
  leaveOwed: boolean;
  /** A leave was refused on the update that is still the one running. */
  leaveBlocked: boolean;
};

/**
 * - `wait`: an input is still on its way; decide again when it lands.
 * - `repair`: drop the pin after an emergency launch.
 * - `join`: move to the early-updates branch.
 * - `leave`: move back to the build's own channel.
 * - `check-preview`: a tester's pin is recorded but its bundle is not the one
 *   running. Ask the server whether that branch still exists.
 * - `none`: the pin is where it should be, or is not ours to move.
 */
export type EarlyUpdatesSyncAction = 'wait' | 'repair' | 'join' | 'leave' | 'check-preview' | 'none';

function isTesterPreview(kind: OtaBranchKind): boolean {
  return kind === 'preview' || kind === 'staging';
}

/** What to do about the branch pin. Pure, so every combination is a unit test. */
export function decideEarlyUpdatesSync(input: EarlyUpdatesSyncInput): EarlyUpdatesSyncAction {
  if (!input.surfingBuild) return 'none';
  // The migration clears the override and reloads.
  if (!input.surfingReady) return 'wait';
  // Before anything else, flags included: whichever pin is in place, nothing on
  // disk matched it, and leaving it there repeats the emergency launch.
  if (input.emergencyLaunch) return 'repair';
  // A switch started while flags are unresolved could outrun one about to land.
  if (!input.flagsResolved) return 'wait';

  // Refused on the update still running: trying again would write, check and
  // restore for the same answer.
  const leave = input.leaveBlocked ? 'none' : 'leave';
  // The server asked every pinned device to unpin. Whoever owns the pin.
  if (input.leaveOwed) return leave;

  if (input.pinnedBranch === EARLY_UPDATES_OTA_BRANCH) {
    // Ours, so the flag going off is acted on whichever bundle is running.
    if (!input.choice || (input.flag === 'off' && input.flagOffConfirmed)) return leave;
    return 'none';
  }

  if (isTesterPreview(otaBranchKind(input.pinnedBranch))) {
    // A tester's pin owns the header while its bundle is the one running. When
    // it is not, the pin is either waiting for its first update or its branch
    // is gone (the PR merged) and the server is serving the channel's own
    // update under it, for good. Only the server can say which.
    if (input.runningBranch === input.pinnedBranch) return 'none';
    if (!input.leaveBlocked) return 'check-preview';
    // Already found dead, and it could not be dropped: the phone runs the
    // regular track's update under it. Joining needs no leave, so a phone that
    // wants early updates still gets them.
    return input.choice && input.flag === 'on' ? 'join' : 'none';
  }
  // A preview running that the record does not know yet.
  if (isTesterPreview(otaBranchKind(input.runningBranch))) return 'none';

  // Only on a flag that SAYS on. No value at all is not a reason to move anyone.
  return input.choice && input.flag === 'on' ? 'join' : 'none';
}

/**
 * - `joined` / `left`: the pin moved, and takes effect next time the app opens.
 * - `waiting`: the server has no early update this binary can run. Joined on a
 *   later launch.
 * - `deferred`: the switch could not be made now (offline, server trouble).
 *   Tried again on the next launch.
 * - `blocked`: leaving has to wait for the regular track to publish an update
 *   this phone does not already hold under the pin's stamp.
 * - `none`: nothing to do.
 */
export type EarlyUpdatesSyncOutcome = 'joined' | 'left' | 'waiting' | 'deferred' | 'blocked' | 'none';

export type EarlyUpdatesSyncEnvironment = Pick<
  EarlyUpdatesSyncInput,
  'surfingBuild' | 'surfingReady' | 'flagsResolved' | 'flag' | 'flagOffConfirmed'
>;

// Per launch (the module is re-evaluated on a reload). An emergency launch stays
// "this launch was one" for the whole session, and a flag that flaps must not
// move a member back and forth.
let repairedThisLaunch = false;
let flagLeaveTriedThisLaunch = false;

/** Test seam: start each case from a fresh launch. */
export function resetEarlyUpdatesLaunchForTests(): void {
  repairedThisLaunch = false;
  flagLeaveTriedThisLaunch = false;
}

function leaveOutcome(outcome: TrackSwitchOutcome): EarlyUpdatesSyncOutcome {
  if (outcome === 'switched') return 'left';
  return outcome === 'blocked' ? 'blocked' : 'deferred';
}

function offersEarlyUpdates(list: QaBranchList): boolean {
  return list.earlyUpdates !== null;
}

async function joinWhenOffered(): Promise<EarlyUpdatesSyncOutcome> {
  // Asked first, and never skipped: without the branch the server answers a
  // pinned request with the channel's own update, which is usually already on
  // disk under another stamp and so could not launch.
  const answer = await fetchQaBranches();
  if (answer.kind !== 'listed' || !offersEarlyUpdates(answer.list)) return 'waiting';
  return (await joinEarlyUpdatesTrack()) === 'switched' ? 'joined' : 'waiting';
}

/**
 * A tester's pin whose bundle is not running. If the server no longer offers
 * the branch, nobody is testing it: go back to the track this phone normally
 * follows, the way leaving the preview by hand would.
 */
async function leaveVanishedPreview(pinnedBranch: string, member: boolean): Promise<EarlyUpdatesSyncOutcome> {
  const answer = await fetchQaBranches();
  // Surfing off is handled where it is noticed; an answer that proves nothing
  // changes nothing.
  if (answer.kind !== 'listed') return 'none';
  const stillOffered =
    pinnedBranch === STAGING_OTA_BRANCH
      ? answer.list.staging !== null
      : answer.list.previews.some((preview) => preview.branch === pinnedBranch);
  if (stillOffered) return 'none';
  if (member && offersEarlyUpdates(answer.list) && (await joinEarlyUpdatesTrack()) === 'switched') return 'joined';
  return leaveOutcome(await leaveForProductionTrack());
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
    const choice = getSetting('earlyUpdates');
    const pinnedBranch = readOtaPinnedBranch();
    const blockedUpdateId = getSetting('otaLeaveBlockedUpdateId');
    const action = decideEarlyUpdatesSync({
      ...environment,
      flagOffConfirmed: environment.flagOffConfirmed && !flagLeaveTriedThisLaunch,
      choice,
      pinnedBranch,
      runningBranch: readRunningOtaBranch(),
      emergencyLaunch: readIsEmergencyLaunch() && !repairedThisLaunch,
      leaveOwed: getSetting('otaLeaveOwed'),
      leaveBlocked: blockedUpdateId !== null && blockedUpdateId === readRunningUpdateId(),
    });
    if (action === 'wait' || action === 'none') return 'none';
    try {
      if (action === 'repair') {
        // Marked first: the pin is dropped before anything that can fail, and
        // the rest of this launch must decide as if it were an ordinary one.
        repairedThisLaunch = true;
        await dropPinAfterEmergencyLaunch();
        return 'left';
      }
      if (action === 'join') return await joinWhenOffered();
      if (action === 'check-preview' && pinnedBranch !== null) {
        return await leaveVanishedPreview(pinnedBranch, choice && environment.flag !== 'off');
      }
      // A leave the flag asked for, as opposed to the climber or the server.
      if (choice && !getSetting('otaLeaveOwed')) flagLeaveTriedThisLaunch = true;
      return leaveOutcome(await leaveForProductionTrack());
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
 * before the pin is dropped), for a member and a tester's preview alike, and
 * attempted even with no pin on record: a phone pinned by a build older than
 * the record has one all the same.
 *
 * When it cannot be completed now, the leave is recorded as owed and the launch
 * sync retries it. The choice is kept: joining asks the server for the branch
 * first, so nothing re-pins while surfing stays off, and a member is back when
 * it is on again.
 */
export function noteBranchSurfingOff(): Promise<void> {
  return runPinChangeExclusively(async () => {
    let completed = false;
    try {
      completed = (await leaveForProductionTrack()) === 'switched';
    } catch {
      completed = false;
    }
    if (!completed && !getSetting('otaLeaveOwed')) setSetting('otaLeaveOwed', true);
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
