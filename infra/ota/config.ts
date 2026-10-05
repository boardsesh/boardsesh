/// <reference types="node" />

// Declarative desired state for the xprem control plane at updates.boardsesh.com:
// which channel serves which branch, which branches may be surfed to, which
// branches must never be deleted, and the policy a stable release follows. Plain
// typed data, with no side effects and no API calls. scripts/ota-apply.ts reads
// it, diffs it against the live server through ./plan.ts, and (only with --apply)
// converges the delta.
//
// Why this exists: all of this was dashboard state. Nothing in the repo recorded
// that `production` must serve `production`, that surfing is limited to `pr-*`, or
// that the staging branch must outlive a cleanup run, and nothing noticed when one
// of them changed. scripts/mobile-ota-setup.ts printed the steps for a human.
//
// The Railway tool next door is the model (infra/railway/): typed desired state
// here, pure diffing in ./plan.ts, all I/O in the script.
//
// What is deliberately NOT here:
//   - Live rollouts. They are state, not configuration. The tool reports them.
//   - Per-PR preview branches (`pr-<number>`). They are created by a publish and
//     removed by scripts/ota-preview-cleanup.ts; this tool never touches one.
//   - Bundle diffing. It is a server variable, declared in infra/railway/config.ts.
//   - API keys and the admin account, which are secrets.
//
// Dependency-free with `.ts` import extensions, because the scripts that read it
// run under bare `node --experimental-strip-types` in jobs holding the admin login.

import { DEFAULT_BASE_URL, OTA_APP_ID, OTA_CHANNEL } from '../../scripts/lib/ota-branch-probe.ts';

/**
 * A per-PR preview branch: `pr-` followed by a GitHub PR number. Identical to the
 * guard in scripts/ota-preview-cleanup.ts, which is the only thing allowed to
 * delete one. `pr-beta` and `pr-staging` share the prefix so Branch Surfing's
 * single glob covers them, and do not match this.
 */
export const PREVIEW_BRANCH_PATTERN = /^pr-[1-9][0-9]*$/;

/** The branch the store fleet is served. Also the default target of every publish tool. */
export const STABLE_BRANCH = 'production';

/** The early-updates track: every merge to main, for climbers who opt in. */
export const EARLY_UPDATES_BRANCH = 'pr-beta';

/** Where main's export is staged and verified before its bytes are promoted. */
export const STAGING_BRANCH = 'pr-staging';

export interface OtaBranchDesired {
  name: string;
  /**
   * A protected branch cannot be deleted by anyone until the flag is lifted. The
   * tool sets the flag and never clears it: lifting protection is a decision to
   * make a branch deletable, which belongs in the dashboard with a human.
   */
  protected: boolean;
  reason: string;
}

export interface OtaChannelDesired {
  name: string;
  /** The branch devices on this channel are served by default. */
  branch: string;
  branchSurfing: { enabled: boolean; pattern: string };
  reason: string;
}

export interface OtaDesiredState {
  baseUrl: string;
  appId: string;
  channels: OtaChannelDesired[];
  branches: OtaBranchDesired[];
}

export const desiredOtaState: OtaDesiredState = {
  baseUrl: DEFAULT_BASE_URL,
  appId: OTA_APP_ID,
  channels: [
    {
      name: OTA_CHANNEL,
      branch: STABLE_BRANCH,
      branchSurfing: { enabled: true, pattern: 'pr-*' },
      reason:
        'Every store and TestFlight binary bakes `expo-channel-name: production` (packages/mobile/app.config.ts) ' +
        'and only `xprem-branch` can be overridden at runtime, so this one channel is the whole fleet. Surfing ' +
        'takes a single glob; `pr-*` covers the per-PR previews, `pr-staging` and `pr-beta` and nothing else.',
    },
  ],
  branches: [
    {
      name: STABLE_BRANCH,
      protected: true,
      reason: 'The branch the store fleet runs. Deleting it leaves every binary on its embedded bundle.',
    },
    {
      name: EARLY_UPDATES_BRANCH,
      protected: true,
      reason:
        'The early-updates track. It must exist before a device can be pinned to it, and a cleanup run that ' +
        'removed it would strand every climber who opted in.',
    },
    {
      name: STAGING_BRANCH,
      protected: true,
      reason:
        'Main is staged here and promoted byte for byte (scripts/mobile-ota-promote.ts). It carries the `pr-` ' +
        'prefix, so only the PR-number guard keeps a preview cleanup away from it. Protection is the second lock.',
    },
  ],
};

export interface OtaHealthPolicy {
  /**
   * Devices per platform that must have reported an outcome (successful plus
   * faulty) before a cohort's numbers are trusted. Below it a canary can be
   * called unhealthy on overwhelming evidence, never healthy; and a control this
   * small is ignored, because one faulty device out of one is a 100% baseline
   * that would wave any canary through.
   */
  evidenceFloorDevicesPerPlatform: number;
  /**
   * Faulty devices needed before a canary is called unhealthy. One faulty device
   * out of ten is 10% and is also one phone with a full disk.
   */
  minFaultyDevicesToFail: number;
  /** How far, in percentage points, the canary's faulty-device rate may sit above the control's. */
  maxFaultyRateOverControlPercent: number;
  /**
   * The faulty-device rate no canary may exceed, whatever the control shows. The
   * margin above is relative, so without this cap a control that is itself
   * broken would raise the bar for the update meant to replace it.
   */
  maxFaultyRatePercent: number;
  /**
   * The faulty-device rate at which a canary below the evidence floor is already
   * called unhealthy. High on purpose: with a handful of devices a few points
   * over the cap is noise, and a third of them failing is not.
   */
  smallSampleFaultyRatePercent: number;
}

export interface OtaReleasePolicy {
  /** Rollout percentages a canary climbs through, in order. The last one is where it soaks. */
  canarySteps: readonly number[];
  /** Hours a canary spends on a step before it may move to the next. */
  stepHours: number;
  /** Hours since the canary started before it may be finished to 100%. */
  minimumSoakHours: number;
  /** The UTC hour of the tick that finishes yesterday's canary and cuts today's. */
  dailyWindowUtcHour: number;
  health: OtaHealthPolicy;
}

/**
 * How a stable release is ramped and judged.
 *
 * Declared here rather than in repository variables so a change to a threshold is
 * a reviewed PR with a diff.
 *
 * Only `health` is read today, by `mobile-ota-rollout.ts health`. The steps, the
 * step hours, the soak and the daily window are declared policy that nothing
 * acts on until the stable-release workflow lands.
 */
export const otaReleasePolicy: OtaReleasePolicy = {
  // Ends at 50, not 100: the last step is a soak on half the fleet, and finishing
  // is a separate, judged act. About 450 devices check in a day, so the 50% step
  // is what gets a canary past the evidence floor on the smaller platform.
  canarySteps: [5, 10, 25, 50],
  // 5% at the start, 10% at 4 h, 25% at 8 h and 50% at 12 h.
  stepHours: 4,
  // Under a day, so a canary cut at one daily tick can be finished at the next
  // even when that tick starts a few minutes early; over 12 h, so it has spent at
  // least 8 h on the 50% step.
  minimumSoakHours: 20,
  // One fixed tick a day, so there is one canary a day and never two at once.
  dailyWindowUtcHour: 22,
  // Every number below is provisional. Nobody has measured the fleet's normal
  // faulty-device rate yet; set them from a week of real control cohorts.
  health: {
    // About 450 devices check in a day, so a 50% canary reaches a few dozen per
    // platform. 15 is what the smaller platform can plausibly reach in a day.
    evidenceFloorDevicesPerPlatform: 15,
    // Two faulty devices can be two unlucky phones. Three is a pattern.
    minFaultyDevicesToFail: 3,
    // Room for noise between two cohorts of a few dozen devices each.
    maxFaultyRateOverControlPercent: 2,
    // One device in twenty failing to run an update is a bad release by any
    // baseline. Also what bounds a canary when its control is unusable.
    maxFaultyRatePercent: 5,
    // Three of ten devices failing is enough to stop without waiting for fifteen.
    smallSampleFaultyRatePercent: 30,
  },
};
