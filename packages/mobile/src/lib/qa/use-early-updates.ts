import { useMemo, useState } from 'react';
import { useSetting } from '../../settings/hooks';
import {
  useEarlyUpdatesFlagState,
  useFeatureFlagsFresh,
  useFeatureFlagsResolved,
  type EarlyUpdatesFlagState,
} from '../../providers/feature-flags-provider';
import { useProfile } from '../graphql/hooks';
import { useOtaBranchSurfingState } from '../ota-branch-surfing-state';
import type { EarlyUpdatesSyncEnvironment } from './early-updates';
import {
  EARLY_UPDATES_OTA_BRANCH,
  otaBranchKind,
  readRunningOtaBranch,
  readRunningUpdateId,
  type OtaBranchKind,
} from './qa-surf';

/**
 * What the "Get updates early" row says. All of it comes from settings and the
 * running bundle, so drawing the row never touches the network.
 *
 * - `off`: not asked for, and not on the branch.
 * - `on`: asked for, and the phone is on the branch.
 * - `waiting`: asked for, but not on the branch yet (no network when it was
 *   switched on, or the server has no early update for this binary).
 * - `leaving`: switched off, still on the branch until a regular update the
 *   phone can launch has been fetched.
 * - `testing`: a PR preview or staging owns the phone's update branch. The
 *   switch is not offered, because flipping it would drop the tester's preview.
 */
export type EarlyUpdatesRowState = 'off' | 'on' | 'waiting' | 'leaving' | 'testing';

export function earlyUpdatesRowState(input: {
  choice: boolean;
  pinnedBranch: string | null;
  runningBranchKind: OtaBranchKind;
  /**
   * A recorded preview pin turned out to be dead (its branch is gone) and could
   * not be dropped: the phone is running the regular track's update under it.
   * Nobody is testing anything, so the switch is offered as usual.
   */
  stalePreviewPin: boolean;
}): EarlyUpdatesRowState {
  const pinnedKind = otaBranchKind(input.pinnedBranch);
  const testing = (kind: OtaBranchKind) => kind === 'preview' || kind === 'staging';
  if (testing(input.runningBranchKind)) return 'testing';
  if (testing(pinnedKind) && !input.stalePreviewPin) return 'testing';
  const pinnedEarly = input.pinnedBranch === EARLY_UPDATES_OTA_BRANCH;
  if (input.choice) return pinnedEarly ? 'on' : 'waiting';
  return pinnedEarly ? 'leaving' : 'off';
}

/**
 * Whether a preview exit should take this phone to early updates.
 *
 * The choice, unless the flag SAYS off. A flag with no value yet is not a
 * reason to send a member to production: that is the state of a cold start
 * before PostHog answers, exactly when a tester may be leaving a preview.
 */
export function isEarlyUpdatesMember(choice: boolean, flag: EarlyUpdatesFlagState): boolean {
  return choice && flag !== 'off';
}

export function useEarlyUpdatesMember(): boolean {
  const [choice] = useSetting('earlyUpdates');
  return isEarlyUpdatesMember(choice, useEarlyUpdatesFlagState());
}

// The account that was signed in the first time anyone asked, this launch. The
// flag is per account and the pin is per phone, so an `off` is only acted on
// for the account the launch started with. Signing out, or in as someone else,
// re-evaluates the flag for a different identity mid-session; moving the phone
// off the track for that is left to the next launch.
let launchUserId: string | undefined;

/** Test seam: forget who the launch started with. */
export function resetEarlyUpdatesIdentityForTests(): void {
  launchUserId = undefined;
}

/** The inputs `syncEarlyUpdates` cannot read for itself, reference-stable between changes. */
export function useEarlyUpdatesSyncEnvironment(): EarlyUpdatesSyncEnvironment {
  const { surfingBuild, ready: surfingReady } = useOtaBranchSurfingState();
  const flagsResolved = useFeatureFlagsResolved();
  const flagsFresh = useFeatureFlagsFresh();
  const flag = useEarlyUpdatesFlagState();
  const { data: profile } = useProfile();
  const userId = profile?.id;
  if (userId !== undefined && launchUserId === undefined) launchUserId = userId;
  const flagOffConfirmed = flagsFresh && userId !== undefined && userId === launchUserId;

  return useMemo(
    () => ({ surfingBuild, surfingReady, flagsResolved, flag, flagOffConfirmed }),
    [surfingBuild, surfingReady, flagsResolved, flag, flagOffConfirmed],
  );
}

export type EarlyUpdatesRow = {
  /** Offer the section: a build that can surf, with the feature turned on. */
  show: boolean;
  state: EarlyUpdatesRowState;
  environment: EarlyUpdatesSyncEnvironment;
};

/** What the More screen needs to draw the "Get updates early" section. */
export function useEarlyUpdatesRow(): EarlyUpdatesRow {
  const environment = useEarlyUpdatesSyncEnvironment();
  const [choice] = useSetting('earlyUpdates');
  const [pinnedBranch] = useSetting('otaPinnedBranch');
  const [blockedUpdateId] = useSetting('otaLeaveBlockedUpdateId');
  // The running bundle cannot change without a reload.
  const [running] = useState(() => ({
    branchKind: otaBranchKind(readRunningOtaBranch()),
    updateId: readRunningUpdateId(),
  }));

  return {
    show: environment.surfingBuild && environment.flag === 'on',
    state: earlyUpdatesRowState({
      choice,
      pinnedBranch,
      runningBranchKind: running.branchKind,
      stalePreviewPin: blockedUpdateId !== null && blockedUpdateId === running.updateId,
    }),
    environment,
  };
}
