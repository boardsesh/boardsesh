/// <reference types="node" />

/**
 * Config-as-code for the xprem control plane at updates.boardsesh.com. Reads the
 * declared state (infra/ota/config.ts), reads the live server through the same
 * admin-session API the dashboard uses (scripts/lib/xprem-admin.mts), diffs them
 * (infra/ota/plan.ts) and reports or converges the delta. Idempotent: a second
 * run with no drift is a no-op.
 *
 * What it manages:
 *   - The `production` channel: which branch it serves, and Branch Surfing.
 *   - The long-lived branches: that they exist, and that they are protected.
 *
 * What it never does: delete anything, lift protection, touch a `pr-<number>`
 * preview branch, or remap a channel while a rollout is live. Whatever is on the
 * server and not declared is printed and left alone, and so are live rollouts.
 *
 * Modes:
 *   (default)  Plan. Print the diff and exit 1 if there is drift. Never writes.
 *   --apply    Make the declared state so, then re-read and confirm.
 *
 * Usage:
 *   OTA_ADMIN_EMAIL=... OTA_ADMIN_PASSWORD=... vp run ota:apply
 *   OTA_ADMIN_EMAIL=... OTA_ADMIN_PASSWORD=... vp run ota:apply -- --apply
 *
 * Env:
 *   OTA_ADMIN_EMAIL, OTA_ADMIN_PASSWORD  (required) a dashboard admin login.
 *   OTA_BASE_URL or EXPO_UPDATES_URL     (optional) defaults to the declared server.
 *
 * Runs under bare `node --experimental-strip-types` in CI, with no install: the
 * job holds the admin login. See docs/mobile-ota-updates.md, "Managing xprem as code".
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { desiredOtaState } from '../infra/ota/config.ts';
import type { OtaDesiredState } from '../infra/ota/config.ts';
import { assertDeclarable, branchesNeedingRolloutRead, buildOtaPlan, hasDrift } from '../infra/ota/plan.ts';
import type { OtaLiveState, OtaPlan, OtaPlannedChange } from '../infra/ota/plan.ts';
import { listActiveRollouts } from './lib/ota-rollout.ts';
import { adminClientFromEnvironment, sameId } from './lib/xprem-admin.mts';
import type { XpremAdminClient } from './lib/xprem-admin.mts';

const LOG = '[ota-apply]';

export async function readLiveState(client: XpremAdminClient, desired: OtaDesiredState): Promise<OtaLiveState> {
  const [channels, branches] = await Promise.all([client.getChannels(), client.getBranches()]);
  const live = {
    channels: channels.map((channel) => ({
      name: channel.releaseChannelName,
      branchName: channel.branchName,
      branchSurfing: channel.branchSurfing,
      rollout: channel.rollout,
    })),
    branches: branches.map((branch) => ({ name: branch.branchName, protected: branch.protected })),
  };
  const updateRollouts: OtaLiveState['updateRollouts'] = [];
  for (const branch of branchesNeedingRolloutRead(desired, live)) {
    for (const rollout of await listActiveRollouts(client, branch)) {
      updateRollouts.push({
        branch: rollout.branch,
        runtimeVersion: rollout.runtimeVersion,
        platform: rollout.platform,
        updateId: String(rollout.updateId),
        percentage: rollout.percentage,
      });
    }
  }
  return { ...live, updateRollouts };
}

async function applyChange(client: XpremAdminClient, change: OtaPlannedChange): Promise<void> {
  switch (change.kind) {
    case 'create-branch':
      await client.createBranch(change.branch);
      return;
    case 'protect-branch':
      await client.setBranchProtection(change.branch, true);
      return;
    case 'create-channel':
      await client.createChannel(change.channel, change.branch);
      return;
    case 'set-branch-surfing':
      await client.setChannelBranchSurfing(change.channel, change.enabled, change.pattern);
      return;
    case 'map-channel': {
      // The mapping endpoint is addressed by ids, so read them at the moment of
      // the write: a branch this run created has an id no earlier read saw.
      const [channels, branches] = await Promise.all([client.getChannels(), client.getBranches()]);
      const channel = channels.find((candidate) => candidate.releaseChannelName === change.channel);
      const branch = branches.find((candidate) => candidate.branchName === change.branch);
      if (!channel) throw new Error(`Channel "${change.channel}" disappeared before it could be mapped.`);
      if (!branch) throw new Error(`Branch "${change.branch}" disappeared before "${change.channel}" could be mapped.`);
      if (channel.branchId !== null && sameId(channel.branchId, branch.branchId)) return;
      await client.mapChannelToBranch(channel, branch.branchId);
    }
  }
}

/** Apply every planned change in order. Stops at the first failure. */
export async function applyPlan(
  client: XpremAdminClient,
  plan: OtaPlan,
  log: (line: string) => void = console.log,
): Promise<void> {
  for (const change of plan.changes) {
    log(`${LOG} applying: ${change.summary}`);
    await applyChange(client, change);
  }
}

export function formatPlan(plan: OtaPlan): string[] {
  const lines: string[] = [];
  if (plan.changes.length === 0 && plan.blocked.length === 0) {
    lines.push(`${LOG} In sync: the server matches infra/ota/config.ts.`);
  }
  for (const change of plan.changes) lines.push(`${LOG} drift: ${change.summary}`);
  for (const blocked of plan.blocked) lines.push(`${LOG} blocked: ${blocked}`);
  for (const report of plan.reports) lines.push(`${LOG} note: ${report}`);
  return lines;
}

export function parseApplyArgs(argv: string[]): { apply: boolean } {
  let apply = false;
  for (const flag of argv) {
    if (flag === '--') continue;
    if (flag !== '--apply') throw new Error(`Unknown argument: ${flag}. Expected nothing, or --apply.`);
    apply = true;
  }
  return { apply };
}

/**
 * Plan, and with `apply` converge and re-plan. Returns the exit code: 0 in sync,
 * 1 when drift remains (in plan mode, any drift; in apply mode, whatever the
 * apply could not or would not converge).
 */
export async function runOtaApply(
  client: XpremAdminClient,
  desired: OtaDesiredState,
  options: { apply: boolean; log?: (line: string) => void },
): Promise<number> {
  const log = options.log ?? console.log;
  assertDeclarable(desired);
  const plan = buildOtaPlan(desired, await readLiveState(client, desired));
  for (const line of formatPlan(plan)) log(line);
  if (!hasDrift(plan)) return 0;
  if (!options.apply) {
    log(`${LOG} ${plan.changes.length} change(s) pending. Re-run with --apply to make them.`);
    return 1;
  }
  await applyPlan(client, plan, log);
  const after = buildOtaPlan(desired, await readLiveState(client, desired));
  if (!hasDrift(after)) {
    log(`${LOG} Applied ${plan.changes.length} change(s). The server now matches infra/ota/config.ts.`);
    return 0;
  }
  log(`${LOG} Drift remains after applying:`);
  for (const line of formatPlan(after)) log(line);
  return 1;
}

async function main(): Promise<void> {
  const args = parseApplyArgs(process.argv.slice(2));
  const client = await adminClientFromEnvironment({
    appId: desiredOtaState.appId,
    defaultBaseUrl: desiredOtaState.baseUrl,
    environment: process.env,
  });
  process.exitCode = await runOtaApply(client, desiredOtaState, args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(`${LOG} ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
