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

function matchingTarget(live: ActiveRollout[], target: RolloutTarget): ActiveRollout[] {
  const matching = live.filter((rollout) => target.platform === 'all' || rollout.platform === target.platform);
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

function noLiveRollout(target: RolloutTarget): Error {
  return new Error(
    `No live rollout on "${target.branch}" runtime ${target.runtimeVersion} for platform ${target.platform}.`,
  );
}

/**
 * Apply `write` to each targeted rollout, re-reading before every write.
 *
 * The server has one write endpoint per branch and runtime version, and the
 * dashboard calls it once with the first platform's update id. Whether that one
 * call acts on every platform of the runtime version is not something the bundle
 * shows. So a rollout that has vanished, or already shows the wanted state, is
 * skipped only AFTER this run has written something: then it is this run's own
 * effect. Vanishing before the first write is somebody else's change, and the
 * caller is told instead of being handed a success it did not earn.
 */
async function writeEach(
  client: XpremAdminClient,
  target: RolloutTarget,
  planned: ActiveRollout[],
  alreadyDone: (current: ActiveRollout) => boolean,
  write: (current: ActiveRollout) => Promise<void>,
): Promise<ActiveRollout[]> {
  const written: ActiveRollout[] = [];
  for (const rollout of planned) {
    const current = (await readRollout(client, target.branch, target.runtimeVersion)).find((candidate) =>
      sameId(candidate.updateId, rollout.updateId),
    );
    if (!current) {
      if (written.length > 0) continue;
      throw new Error(
        `Update ${rollout.updateId} stopped rolling out on "${target.branch}" before anything was written. Nothing was changed.`,
      );
    }
    if (alreadyDone(current)) continue;
    await write(current);
    written.push(current);
  }
  return written;
}

/** Raise a rollout to `percentage`, or finish it with 100. */
export async function setRolloutPercentage(
  client: XpremAdminClient,
  target: RolloutTarget,
  percentage: number,
): Promise<ActiveRollout[]> {
  if (!Number.isInteger(percentage) || percentage < 1 || percentage > 100) {
    throw new Error('A rollout percentage is a whole number from 1 to 100.');
  }
  const targeted = matchingTarget(await readRollout(client, target.branch, target.runtimeVersion), target);
  if (targeted.length === 0) throw noLiveRollout(target);
  const lowered = targeted.filter((rollout) => rollout.percentage > percentage);
  if (lowered.length > 0) {
    throw new Error(
      `A rollout cannot be decreased: ${lowered.map((rollout) => `${rollout.platform} is at ${rollout.percentage}%`).join(', ')}.`,
    );
  }
  const changed = await writeEach(
    client,
    target,
    targeted,
    (current) => current.percentage === percentage,
    (current) => client.setUpdateRolloutPercentage(target.branch, target.runtimeVersion, percentage, current.updateId),
  );
  return changed.map((rollout) => ({ ...rollout, percentage }));
}

/**
 * Revert a rollout: the server republishes the previous update as a new one.
 *
 * With `allowNone`, finding nothing live is an empty result and not an error.
 * There is one read behind that answer, so a rollout that ended between a
 * caller's own check and this call cannot turn a clean no-op into a failure.
 */
export async function revertRollout(
  client: XpremAdminClient,
  target: RolloutTarget,
  options: { allowNone?: boolean } = {},
): Promise<ActiveRollout[]> {
  const targeted = matchingTarget(await readRollout(client, target.branch, target.runtimeVersion), target);
  if (targeted.length === 0) {
    if (options.allowNone) return [];
    throw noLiveRollout(target);
  }
  try {
    return await writeEach(
      client,
      target,
      targeted,
      () => false,
      (current) => client.revertUpdateRollout(target.branch, target.runtimeVersion, current.updateId),
    );
  } catch (error) {
    // It ended between the read above and the write: with allowNone that is the
    // state the caller asked for. Confirm it with a fresh read before saying so.
    if (!options.allowNone) throw error;
    const stillLive = matchingTarget(await readRollout(client, target.branch, target.runtimeVersion), target);
    if (stillLive.length > 0) throw error;
    return [];
  }
}

export type CanaryVerdict = 'healthy' | 'unhealthy' | 'insufficient-evidence';

export interface CanaryJudgement {
  verdict: CanaryVerdict;
  reason: string;
}

interface JudgedCohort {
  judged: number;
  faulty: number;
  ratePercent: number;
}

/**
 * A cohort's numbers, or null when they cannot be trusted: a count that is not a
 * finite non-negative number, or more faulty devices than devices on the update.
 */
function judgedCohort(health: XpremUpdateHealth | null): JudgedCohort | null {
  if (!health) return null;
  const counts = [health.devicesOnUpdate, health.successfulDevices, health.faultyDevices];
  if (counts.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) return null;
  if (health.faultyDevices > health.devicesOnUpdate) return null;
  const judged = health.successfulDevices + health.faultyDevices;
  return {
    judged,
    faulty: health.faultyDevices,
    ratePercent: judged === 0 ? 0 : (100 * health.faultyDevices) / judged,
  };
}

/**
 * Judge one platform's canary against the update it is replacing.
 *
 * Three answers, and the middle one matters most: "not enough evidence" is never
 * read as healthy. A fleet of about 450 devices a day puts a few dozen on a
 * canary per platform, so "unsure" is the common case and finishing on it would
 * make the canary decorative.
 *
 * The rules, in order:
 *   1. Numbers that cannot be trusted are not evidence.
 *   2. The allowed faulty rate is the control's rate plus a margin, capped at an
 *      absolute maximum. A control with fewer reporting devices than the evidence
 *      floor counts as 0%: one faulty device out of one is a 100% baseline that
 *      would pass any canary, and so would a control that is itself broken.
 *   3. Below the evidence floor the only possible verdicts are "not enough" and,
 *      on enough faulty devices at a rate far above anything normal, "unhealthy".
 *   4. At or above the floor: over the allowed rate on enough faulty devices is
 *      unhealthy; over it on too few is "not enough"; otherwise healthy.
 */
export function judgeCanary(
  canary: XpremUpdateHealth | null,
  control: XpremUpdateHealth | null,
  policy: OtaHealthPolicy,
): CanaryJudgement {
  const thresholds = [
    policy.evidenceFloorDevicesPerPlatform,
    policy.minFaultyDevicesToFail,
    policy.maxFaultyRateOverControlPercent,
    policy.maxFaultyRatePercent,
    policy.smallSampleFaultyRatePercent,
  ];
  if (thresholds.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
    return { verdict: 'insufficient-evidence', reason: 'The health policy holds a value that is not a number.' };
  }
  if (!canary) {
    return { verdict: 'insufficient-evidence', reason: 'The server reports no health for the canary update.' };
  }
  const cohort = judgedCohort(canary);
  if (!cohort) {
    return {
      verdict: 'insufficient-evidence',
      reason: 'The canary health counts are not usable numbers, or report more faulty devices than devices.',
    };
  }
  const controlCohort = judgedCohort(control);
  const controlIsUsable = controlCohort !== null && controlCohort.judged >= policy.evidenceFloorDevicesPerPlatform;
  const controlRate = controlIsUsable ? controlCohort.ratePercent : 0;
  const allowedRate = Math.min(controlRate + policy.maxFaultyRateOverControlPercent, policy.maxFaultyRatePercent);
  const baseline = controlIsUsable ? `control at ${controlRate.toFixed(1)}%` : 'no usable control';
  const rates =
    `${cohort.ratePercent.toFixed(1)}% faulty (${cohort.faulty} of ${cohort.judged}) ` +
    `against an allowed ${allowedRate.toFixed(1)}% (${baseline})`;
  const enoughFaulty = cohort.faulty >= policy.minFaultyDevicesToFail;

  if (cohort.judged < policy.evidenceFloorDevicesPerPlatform) {
    if (enoughFaulty && cohort.ratePercent >= policy.smallSampleFaultyRatePercent) {
      return { verdict: 'unhealthy', reason: `Canary is ${rates}, on a small sample.` };
    }
    return {
      verdict: 'insufficient-evidence',
      reason: `${cohort.judged} device(s) have reported on the canary; ${policy.evidenceFloorDevicesPerPlatform} are needed.`,
    };
  }
  if (cohort.ratePercent > allowedRate) {
    return enoughFaulty
      ? { verdict: 'unhealthy', reason: `Canary is ${rates}.` }
      : {
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
