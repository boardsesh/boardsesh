/// <reference types="node" />

// Pure planning logic for the xprem apply tool: diff desired against live and
// decide what may be converged and what may only be reported. No I/O and no
// globals. Unit-tested in scripts/ota-apply.test.ts; the I/O lives in
// scripts/ota-apply.ts.
//
// The safety rules are encoded here and not in the apply layer, so they are
// testable without a server and a caller cannot bypass them:
//
//   1. Never delete. No planned change removes a channel, a branch or an update.
//   2. Never touch a per-PR preview branch. A declaration that names one is
//      rejected, and a live one is counted and otherwise ignored.
//   3. Anything live that the config does not declare is reported and left alone.
//   4. Never loosen. Protection is set and never cleared.
//   5. A channel is not remapped while a rollout is live on it or on either branch
//      involved: moving the fleet's branch mid-canary would leave the rollout
//      judging devices that are no longer served it.

import { PREVIEW_BRANCH_PATTERN } from './config.ts';
import type { OtaDesiredState } from './config.ts';

export interface LiveChannel {
  name: string;
  /** The branch the channel serves, or null for an unmapped channel. */
  branchName: string | null;
  branchSurfing: { enabled: boolean; pattern: string } | null;
  /** A channel-level rollout towards another branch, when one is live. */
  rollout: { percentage: number; rolloutBranchName: string } | null;
}

export interface LiveBranch {
  name: string;
  protected: boolean;
}

/** One platform's live per-update rollout on a branch and runtime version. */
export interface LiveUpdateRollout {
  branch: string;
  runtimeVersion: string;
  platform: string;
  updateId: string;
  percentage: number;
}

export interface OtaLiveState {
  channels: LiveChannel[];
  branches: LiveBranch[];
  /**
   * Live per-update rollouts on the branches the plan needs to reason about
   * (see {@link branchesNeedingRolloutRead}).
   */
  updateRollouts: LiveUpdateRollout[];
}

export type OtaPlannedChange =
  | { kind: 'create-branch'; branch: string; summary: string }
  | { kind: 'protect-branch'; branch: string; summary: string }
  | { kind: 'create-channel'; channel: string; branch: string; summary: string }
  | { kind: 'map-channel'; channel: string; branch: string; summary: string }
  | { kind: 'set-branch-surfing'; channel: string; enabled: boolean; pattern: string; summary: string };

export interface OtaPlan {
  /** Drift the tool will converge with --apply, in the order it must be applied. */
  changes: OtaPlannedChange[];
  /** Drift the tool refuses to converge right now, with the reason. */
  blocked: string[];
  /** Live state the config does not declare, and live rollouts. Informational: never drift. */
  reports: string[];
}

/** True when the plan holds drift, converged or blocked. Reports alone are not drift. */
export function hasDrift(plan: OtaPlan): boolean {
  return plan.changes.length > 0 || plan.blocked.length > 0;
}

/**
 * Reject a declaration this tool must never act on, before anything is read from
 * the server. A typo that declared `pr-123` would otherwise have the tool create
 * and protect a branch the preview cleanup is entitled to delete.
 */
export function assertDeclarable(desired: OtaDesiredState): void {
  const declared = new Set<string>();
  for (const branch of desired.branches) {
    if (PREVIEW_BRANCH_PATTERN.test(branch.name)) {
      throw new Error(`Branch "${branch.name}" is a per-PR preview branch and cannot be declared.`);
    }
    if (declared.has(branch.name)) throw new Error(`Branch "${branch.name}" is declared twice.`);
    declared.add(branch.name);
  }
  const channels = new Set<string>();
  for (const channel of desired.channels) {
    if (channels.has(channel.name)) throw new Error(`Channel "${channel.name}" is declared twice.`);
    channels.add(channel.name);
    if (!declared.has(channel.branch)) {
      throw new Error(`Channel "${channel.name}" maps to "${channel.branch}", which is not a declared branch.`);
    }
    if (channel.branchSurfing.pattern.trim() === '') {
      // The server refuses an empty pattern, and the dashboard cannot toggle one.
      throw new Error(`Channel "${channel.name}" declares an empty Branch Surfing pattern.`);
    }
  }
}

/**
 * The branches whose rollouts must be read before a plan can be trusted: every
 * declared branch, plus whatever a declared channel serves today (the branch a
 * remap would move the fleet away from).
 */
export function branchesNeedingRolloutRead(
  desired: OtaDesiredState,
  live: Pick<OtaLiveState, 'channels' | 'branches'>,
): string[] {
  const existing = new Set(live.branches.map((branch) => branch.name));
  const wanted = new Set(desired.branches.map((branch) => branch.name));
  for (const channel of desired.channels) {
    const mapped = live.channels.find((candidate) => candidate.name === channel.name)?.branchName;
    if (mapped) wanted.add(mapped);
  }
  return [...wanted].filter((branch) => existing.has(branch)).sort();
}

function describeRollout(rollout: LiveUpdateRollout): string {
  return (
    `Live rollout on "${rollout.branch}" (${rollout.platform}, runtime ${rollout.runtimeVersion}): ` +
    `update ${rollout.updateId} at ${rollout.percentage}%.`
  );
}

export function buildOtaPlan(desired: OtaDesiredState, live: OtaLiveState): OtaPlan {
  assertDeclarable(desired);
  const plan: OtaPlan = { changes: [], blocked: [], reports: [] };
  const liveBranches = new Map(live.branches.map((branch) => [branch.name, branch]));
  const liveChannels = new Map(live.channels.map((channel) => [channel.name, channel]));

  // Branches first: a channel can only be mapped to a branch that exists.
  for (const branch of desired.branches) {
    const current = liveBranches.get(branch.name);
    if (!current) {
      plan.changes.push({
        kind: 'create-branch',
        branch: branch.name,
        summary: `Create branch "${branch.name}".`,
      });
    }
    if (branch.protected && !current?.protected) {
      plan.changes.push({
        kind: 'protect-branch',
        branch: branch.name,
        summary: `Protect branch "${branch.name}" against deletion.`,
      });
    }
    if (!branch.protected && current?.protected) {
      plan.reports.push(
        `Branch "${branch.name}" is protected on the server and declared unprotected. Protection is never lifted from here.`,
      );
    }
  }

  for (const channel of desired.channels) {
    const current = liveChannels.get(channel.name);
    if (!current) {
      plan.changes.push({
        kind: 'create-channel',
        channel: channel.name,
        branch: channel.branch,
        summary: `Create channel "${channel.name}" serving branch "${channel.branch}".`,
      });
    } else if (current.branchName !== channel.branch) {
      const involved = new Set([channel.branch, ...(current.branchName ? [current.branchName] : [])]);
      const blocking = live.updateRollouts.filter((rollout) => involved.has(rollout.branch));
      const from = current.branchName ? `"${current.branchName}"` : 'no branch';
      if (current.rollout) {
        plan.blocked.push(
          `Channel "${channel.name}" serves ${from}, not "${channel.branch}", and will not be remapped: ` +
            `a channel rollout to "${current.rollout.rolloutBranchName}" is live at ${current.rollout.percentage}%.`,
        );
      } else if (blocking.length > 0) {
        plan.blocked.push(
          `Channel "${channel.name}" serves ${from}, not "${channel.branch}", and will not be remapped: ` +
            `${blocking.length} update rollout(s) are live on the branches involved.`,
        );
      } else {
        plan.changes.push({
          kind: 'map-channel',
          channel: channel.name,
          branch: channel.branch,
          summary: `Map channel "${channel.name}" to branch "${channel.branch}" (serves ${from} today).`,
        });
      }
    }

    const surfing = current?.branchSurfing ?? { enabled: false, pattern: '' };
    if (surfing.enabled !== channel.branchSurfing.enabled || surfing.pattern !== channel.branchSurfing.pattern) {
      const wanted = channel.branchSurfing.enabled ? 'on' : 'off';
      const found = current ? `${surfing.enabled ? 'on' : 'off'} with pattern "${surfing.pattern}"` : 'no channel';
      plan.changes.push({
        kind: 'set-branch-surfing',
        channel: channel.name,
        enabled: channel.branchSurfing.enabled,
        pattern: channel.branchSurfing.pattern,
        summary:
          `Set Branch Surfing on "${channel.name}" to ${wanted} with pattern ` +
          `"${channel.branchSurfing.pattern}" (found ${found}).`,
      });
    }
  }

  // Everything below is reported and left exactly as it is.
  const declaredBranches = new Set(desired.branches.map((branch) => branch.name));
  const declaredChannels = new Set(desired.channels.map((channel) => channel.name));
  const undeclaredBranches = live.branches.filter((branch) => !declaredBranches.has(branch.name));
  const previewBranches = undeclaredBranches.filter((branch) => PREVIEW_BRANCH_PATTERN.test(branch.name));
  for (const branch of undeclaredBranches) {
    if (!PREVIEW_BRANCH_PATTERN.test(branch.name)) {
      plan.reports.push(`Branch "${branch.name}" exists on the server and is not declared. Left alone.`);
    }
  }
  if (previewBranches.length > 0) {
    plan.reports.push(`${previewBranches.length} per-PR preview branch(es) exist. They are never touched from here.`);
  }
  const undeclaredChannels = live.channels.filter((channel) => !declaredChannels.has(channel.name));
  const previewChannels = undeclaredChannels.filter((channel) => PREVIEW_BRANCH_PATTERN.test(channel.name));
  for (const channel of undeclaredChannels) {
    if (!PREVIEW_BRANCH_PATTERN.test(channel.name)) {
      plan.reports.push(`Channel "${channel.name}" exists on the server and is not declared. Left alone.`);
    }
  }
  if (previewChannels.length > 0) {
    plan.reports.push(
      `${previewChannels.length} legacy per-PR channel(s) exist. The preview cleanup removes each with its branch.`,
    );
  }
  for (const channel of live.channels) {
    if (channel.rollout && declaredChannels.has(channel.name)) {
      plan.reports.push(
        `Live channel rollout on "${channel.name}": ${channel.rollout.percentage}% to "${channel.rollout.rolloutBranchName}".`,
      );
    }
  }
  for (const rollout of live.updateRollouts) plan.reports.push(describeRollout(rollout));

  return plan;
}
