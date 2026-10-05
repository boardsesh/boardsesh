/// <reference types="node" />

/**
 * Per-update rollouts on the xprem server: finding the live ones, raising,
 * finishing and reverting them, and judging the canary they carry.
 *
 * A rollout belongs to one branch, one runtime version and one platform. iOS and
 * Android resolve different fingerprints, so one release is normally two rollouts
 * on two runtime versions, and a release train merge-back can leave one behind on
 * a runtime version nobody is publishing to any more. That is why
 * {@link listActiveRollouts} walks every runtime version of the branch and never
 * a list the caller thinks is current.
 *
 * Every write names the update it expects to act on (`expectedUpdateId`), read
 * from the server immediately before, so a rollout that was replaced between the
 * read and the write is refused by the server and not silently finished.
 *
 * Dependency-free with `.ts` import extensions: run under bare
 * `node --experimental-strip-types` by jobs that hold the admin login.
 */

import type { OtaHealthPolicy } from '../../infra/ota/config.ts';
import { mapWithConcurrency, sameId } from './xprem-admin.mts';
import type { XpremAdminClient, XpremId, XpremRolloutUpdate, XpremUpdateHealth } from './xprem-admin.mts';

/** Requests in flight while walking a branch's runtime versions. `production` has about 80. */
const ROLLOUT_READ_CONCURRENCY = 6;

export interface ActiveRollout {
  branch: string;
  runtimeVersion: string;
  platform: string;
  updateId: XpremId;
  controlUpdateId: XpremId | null;
  percentage: number;
  createdAt: string | null;
}

export type RolloutPlatform = 'ios' | 'android' | 'all';

function toActiveRollout(branch: string, runtimeVersion: string, update: XpremRolloutUpdate): ActiveRollout {
  return {
    branch,
    runtimeVersion,
    platform: update.platform,
    updateId: update.updateId,
    controlUpdateId: update.controlUpdateId,
    percentage: update.percentage,
    createdAt: update.createdAt,
  };
}

/** Live rollouts on one runtime version of a branch, one entry per platform. */
export async function readRollout(
  client: XpremAdminClient,
  branch: string,
  runtimeVersion: string,
): Promise<ActiveRollout[]> {
  const rollout = await client.getUpdateRollout(branch, runtimeVersion);
  return rollout.active ? rollout.updates.map((update) => toActiveRollout(branch, runtimeVersion, update)) : [];
}

/** Live rollouts across EVERY runtime version of a branch. */
export async function listActiveRollouts(client: XpremAdminClient, branch: string): Promise<ActiveRollout[]> {
  const runtimeVersions = await client.getRuntimeVersions(branch);
  const perRuntimeVersion = await mapWithConcurrency(runtimeVersions, ROLLOUT_READ_CONCURRENCY, (runtimeVersion) =>
    readRollout(client, branch, runtimeVersion),
  );
  return perRuntimeVersion.flat();
}

export interface RolloutTarget {
  branch: string;
  runtimeVersion: string;
  platform: RolloutPlatform;
  /** When given, the live rollout must be this update or nothing is written. */
  expectedUpdateId?: string;
}

async function targetedRollouts(client: XpremAdminClient, target: RolloutTarget): Promise<ActiveRollout[]> {
  const live = await readRollout(client, target.branch, target.runtimeVersion);
  const matching = live.filter((rollout) => target.platform === 'all' || rollout.platform === target.platform);
  if (matching.length === 0) {
    throw new Error(
      `No live rollout on "${target.branch}" runtime ${target.runtimeVersion} for platform ${target.platform}.`,
    );
  }
  const expected = target.expectedUpdateId;
  if (expected !== undefined) {
    const unexpected = matching.filter((rollout) => !sameId(rollout.updateId, expected));
    if (unexpected.length > 0) {
      throw new Error(
        `The live rollout is update ${unexpected.map((rollout) => rollout.updateId).join(', ')}, not ${expected}. Nothing was changed.`,
      );
    }
  }
  return matching;
}

/**
 * Raise a rollout to `percentage`, or finish it with 100.
 *
 * The server has one write endpoint per branch and runtime version, and the
 * dashboard calls it once with the first platform's update id. Whether that one
 * call moves every platform on the runtime version is not something the bundle
 * shows, so this re-reads before each platform and skips one a previous call
 * already moved.
 */
export async function setRolloutPercentage(
  client: XpremAdminClient,
  target: RolloutTarget,
  percentage: number,
): Promise<ActiveRollout[]> {
  if (!Number.isInteger(percentage) || percentage < 1 || percentage > 100) {
    throw new Error('A rollout percentage is a whole number from 1 to 100.');
  }
  const targeted = await targetedRollouts(client, target);
  const lowered = targeted.filter((rollout) => rollout.percentage > percentage);
  if (lowered.length > 0) {
    throw new Error(
      `A rollout cannot be decreased: ${lowered.map((rollout) => `${rollout.platform} is at ${rollout.percentage}%`).join(', ')}.`,
    );
  }
  const changed: ActiveRollout[] = [];
  for (const planned of targeted) {
    const current = (await readRollout(client, target.branch, target.runtimeVersion)).find((rollout) =>
      sameId(rollout.updateId, planned.updateId),
    );
    // Gone means an earlier call in this loop finished it; equal means it was raised.
    if (!current || current.percentage === percentage) continue;
    await client.setUpdateRolloutPercentage(target.branch, target.runtimeVersion, percentage, current.updateId);
    changed.push({ ...current, percentage });
  }
  return changed;
}

/** Revert a rollout: the server republishes the previous update as a new one. */
export async function revertRollout(client: XpremAdminClient, target: RolloutTarget): Promise<ActiveRollout[]> {
  const targeted = await targetedRollouts(client, target);
  const reverted: ActiveRollout[] = [];
  for (const planned of targeted) {
    const current = (await readRollout(client, target.branch, target.runtimeVersion)).find((rollout) =>
      sameId(rollout.updateId, planned.updateId),
    );
    if (!current) continue;
    await client.revertUpdateRollout(target.branch, target.runtimeVersion, current.updateId);
    reverted.push(current);
  }
  return reverted;
}

export type CanaryVerdict = 'healthy' | 'unhealthy' | 'insufficient-evidence';

export interface CanaryJudgement {
  verdict: CanaryVerdict;
  reason: string;
}

function faultyRatePercent(health: XpremUpdateHealth | null): number {
  if (!health) return 0;
  const judged = health.successfulDevices + health.faultyDevices;
  return judged === 0 ? 0 : (100 * health.faultyDevices) / judged;
}

/**
 * Judge one platform's canary against the update it is replacing.
 *
 * Three answers, and the middle one matters most: "not enough evidence" is never
 * read as healthy. A fleet of about 450 devices a day puts a few dozen on a
 * canary per platform, so "unsure" is the common case and finishing on it would
 * make the canary decorative.
 *
 * Unhealthy is the one verdict allowed below the evidence floor. A crash-looping
 * update falls back to the embedded bundle, so its devices stop counting as "on
 * the update" and the floor might never be reached: three faulty devices out of
 * four is already an answer.
 *
 * A missing control (the first update on a runtime version) is treated as a 0%
 * faulty rate, which makes the margin an absolute cap.
 */
export function judgeCanary(
  canary: XpremUpdateHealth | null,
  control: XpremUpdateHealth | null,
  policy: OtaHealthPolicy,
): CanaryJudgement {
  if (!canary) {
    return { verdict: 'insufficient-evidence', reason: 'The server reports no health for the canary update.' };
  }
  const judged = canary.successfulDevices + canary.faultyDevices;
  const canaryRate = faultyRatePercent(canary);
  const allowedRate = faultyRatePercent(control) + policy.maxFaultyRateOverControlPercent;
  const rates = `${canaryRate.toFixed(1)}% faulty (${canary.faultyDevices} of ${judged}) against an allowed ${allowedRate.toFixed(1)}%`;
  const overMargin = canaryRate > allowedRate;

  if (overMargin && canary.faultyDevices >= policy.minFaultyDevicesToFail) {
    return { verdict: 'unhealthy', reason: `Canary is ${rates}.` };
  }
  if (judged < policy.evidenceFloorDevicesPerPlatform) {
    return {
      verdict: 'insufficient-evidence',
      reason: `${judged} device(s) have reported on the canary; ${policy.evidenceFloorDevicesPerPlatform} are needed.`,
    };
  }
  if (overMargin) {
    return {
      verdict: 'insufficient-evidence',
      reason: `Canary is ${rates}, on fewer than ${policy.minFaultyDevicesToFail} faulty devices.`,
    };
  }
  return { verdict: 'healthy', reason: `Canary is ${rates}.` };
}

export interface RolloutHealth {
  rollout: ActiveRollout;
  canaryUpdateUUID: string | null;
  controlUpdateUUID: string | null;
  canary: XpremUpdateHealth | null;
  control: XpremUpdateHealth | null;
  /** Launch and JS issue counts from the newest history point. Reported, not judged. */
  canaryIssues: { updateIssues: number; runtimeIssues: number } | null;
  judgement: CanaryJudgement;
}

/** Health for explicit update UUIDs, judged the same way a live rollout is. */
export async function readUpdateHealth(
  client: XpremAdminClient,
  canaryUpdateUUID: string,
  controlUpdateUUID: string | null,
  policy: OtaHealthPolicy,
): Promise<Omit<RolloutHealth, 'rollout'>> {
  const updateUUIDs = controlUpdateUUID ? [canaryUpdateUUID, controlUpdateUUID] : [canaryUpdateUUID];
  const [health, history] = await Promise.all([
    client.getUpdateHealth(updateUUIDs),
    client.getUpdateHealthHistory([canaryUpdateUUID]),
  ]);
  const canary = health[canaryUpdateUUID] ?? null;
  const control = controlUpdateUUID ? (health[controlUpdateUUID] ?? null) : null;
  const issues = history.latest[canaryUpdateUUID];
  return {
    canaryUpdateUUID,
    controlUpdateUUID,
    canary,
    control,
    canaryIssues: issues ? { updateIssues: issues.updateIssues, runtimeIssues: issues.runtimeIssues } : null,
    judgement: judgeCanary(canary, control, policy),
  };
}

/**
 * Health for every platform of a live rollout. The rollout names numeric update
 * ids; health is keyed on update UUIDs, so each id is resolved through the
 * update's details first.
 */
export async function readRolloutHealth(
  client: XpremAdminClient,
  branch: string,
  runtimeVersion: string,
  policy: OtaHealthPolicy,
): Promise<RolloutHealth[]> {
  const rollouts = await readRollout(client, branch, runtimeVersion);
  const results: RolloutHealth[] = [];
  for (const rollout of rollouts) {
    const uuidOf = async (updateId: XpremId): Promise<string | null> =>
      (await client.getUpdateDetails(branch, runtimeVersion, updateId)).updateUUID;
    const canaryUpdateUUID = await uuidOf(rollout.updateId);
    const controlUpdateUUID = rollout.controlUpdateId === null ? null : await uuidOf(rollout.controlUpdateId);
    if (canaryUpdateUUID === null) {
      results.push({
        rollout,
        canaryUpdateUUID,
        controlUpdateUUID,
        canary: null,
        control: null,
        canaryIssues: null,
        judgement: {
          verdict: 'insufficient-evidence',
          reason: `Update ${rollout.updateId} has no update UUID, so its health cannot be read.`,
        },
      });
      continue;
    }
    results.push({ rollout, ...(await readUpdateHealth(client, canaryUpdateUUID, controlUpdateUUID, policy)) });
  }
  return results;
}
