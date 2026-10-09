/// <reference types="node" />

import { otaReleasePolicy, STABLE_CANDIDATE_BRANCH } from '../../infra/ota/config.ts';
import { parseStageReceipt } from '../mobile-ota-promote.ts';
import type { StageReceipt } from '../mobile-ota-promote.ts';
import { object, string, UPDATE_ID } from './ota-publish-protocol.ts';
import { isDeepStrictEqual } from 'node:util';
import type { OtaPlatform } from './ota-publish-protocol.ts';
import type { RolloutHealth } from './ota-rollout.ts';

export const PLATFORMS = ['ios', 'android'] as const;
export interface StableCandidate {
  receipt: StageReceipt;
  sourceRunId: string;
  preparationRunId: string;
  preparedAt: string;
  qaPassed: boolean;
}
export interface StableRelease {
  candidate: StableCandidate;
  phase: 'starting' | 'ramping' | 'finishing' | 'reverting';
  updateIds: Partial<Record<OtaPlatform, string>>;
  /** Verified unchanged native heads, separate from owned canaries and completed finishes. */
  unchangedPlatforms: Partial<Record<OtaPlatform, string>>;
  completedPlatforms: Partial<Record<OtaPlatform, string>>;
  startedAt: string;
  stepSince: string;
  percentage: number;
  pendingPercentage: number | null;
}
export interface StableState {
  version: 1;
  candidate: StableCandidate | null;
  active: StableRelease | null;
  lastStartedDate: string | null;
  lastCompletedCommit: string | null;
  rejectedCommit: string | null;
  /** Identifies the producer of this checkpoint, not the artifact download run. */
  checkpointRunId: string;
}
export const initialStableState = (): StableState => ({
  version: 1,
  candidate: null,
  active: null,
  lastStartedDate: null,
  lastCompletedCommit: null,
  rejectedCommit: null,
  checkpointRunId: '0',
});

const SHA = /^[a-f0-9]{40}$/;
const runId = (input: unknown): string => {
  const parsed = string(input, 'GitHub run ID');
  if (!/^\d+$/.test(parsed)) throw new Error('GitHub run ID must be decimal digits.');
  return parsed;
};
function timestamp(input: unknown): string {
  const parsed = string(input, 'Checkpoint time');
  if (!Number.isFinite(Date.parse(parsed))) throw new Error('Invalid checkpoint time.');
  return parsed;
}
function nullableSha(input: unknown): string | null {
  if (input === null) return null;
  const parsed = string(input, 'Checkpoint commit');
  if (!SHA.test(parsed)) throw new Error('Checkpoint commit must be a full SHA.');
  return parsed;
}
export function parseCandidate(input: unknown): StableCandidate {
  const parsed = object(input, 'Stable candidate');
  if (typeof parsed.qaPassed !== 'boolean') throw new Error('Candidate QA verdict must be explicit.');
  const receipt = parseStageReceipt(parsed.receipt);
  if (receipt.platforms.ios.runtimeVersion === receipt.platforms.android.runtimeVersion) {
    throw new Error(
      'Stable automation requires distinct native platform fingerprints; manage a shared runtime manually.',
    );
  }
  return {
    receipt,
    sourceRunId: runId(parsed.sourceRunId),
    preparationRunId: runId(parsed.preparationRunId),
    preparedAt: timestamp(parsed.preparedAt),
    qaPassed: parsed.qaPassed,
  };
}
export function parseStableState(input: unknown): StableState {
  const parsed = object(input, 'Stable checkpoint');
  if (parsed.version !== 1) throw new Error('Unsupported stable checkpoint version.');
  let active: StableRelease | null = null;
  if (parsed.active !== null) {
    const rawActive = object(parsed.active, 'Active release');
    const phase = rawActive.phase;
    if (!['starting', 'ramping', 'finishing', 'reverting'].includes(String(phase)))
      throw new Error('Invalid release phase.');
    const updateIds: StableRelease['updateIds'] = {};
    const rawIds = object(rawActive.updateIds, 'Owned update IDs');
    const unchangedPlatforms: StableRelease['unchangedPlatforms'] = {};
    const rawUnchanged = object(
      rawActive.unchangedPlatforms === undefined ? {} : rawActive.unchangedPlatforms,
      'Unchanged platform UUIDs',
    );
    if (Object.keys(rawUnchanged).some((platform) => !PLATFORMS.includes(platform as OtaPlatform)))
      throw new Error('Unknown unchanged platform.');
    const completedPlatforms: StableRelease['completedPlatforms'] = {};
    const rawCompleted = object(rawActive.completedPlatforms, 'Completed platform UUIDs');
    for (const platform of PLATFORMS) {
      if (rawUnchanged[platform] !== undefined) {
        const uuid = string(rawUnchanged[platform], 'Unchanged platform UUID');
        if (!UPDATE_ID.test(uuid)) throw new Error('Unchanged platform ID must be a UUID.');
        if (rawIds[platform] !== undefined || rawCompleted[platform] !== undefined)
          throw new Error('An unchanged platform cannot have an owned or completed ID.');
        unchangedPlatforms[platform] = uuid;
      }
      if (rawIds[platform] !== undefined) updateIds[platform] = runId(rawIds[platform]);
      if (rawCompleted[platform] !== undefined) {
        const uuid = string(rawCompleted[platform], 'Completed platform UUID');
        if (!UPDATE_ID.test(uuid)) throw new Error('Completed platform ID must be a UUID.');
        completedPlatforms[platform] = uuid;
      }
    }
    const percentage = rawActive.percentage;
    const pendingPercentage = rawActive.pendingPercentage;
    if (typeof percentage !== 'number' || !otaReleasePolicy.canarySteps.includes(percentage))
      throw new Error('Invalid saved rollout percentage.');
    if (
      pendingPercentage !== null &&
      (typeof pendingPercentage !== 'number' || !otaReleasePolicy.canarySteps.includes(pendingPercentage))
    ) {
      throw new Error('Invalid pending rollout percentage.');
    }
    active = {
      candidate: parseCandidate(rawActive.candidate),
      phase: phase as StableRelease['phase'],
      updateIds,
      unchangedPlatforms,
      completedPlatforms,
      startedAt: timestamp(rawActive.startedAt),
      stepSince: timestamp(rawActive.stepSince),
      percentage: percentage as number,
      pendingPercentage: pendingPercentage as number | null,
    };
    if (!active.candidate.qaPassed) throw new Error('An active release must have passed QA.');
    if (
      PLATFORMS.some(
        (platform) =>
          unchangedPlatforms[platform] &&
          unchangedPlatforms[platform] !== active!.candidate.receipt.baselineProductionUpdateIds[platform],
      )
    )
      throw new Error('Unchanged platform UUID differs from captured baseline.');
    if (
      phase !== 'starting' &&
      PLATFORMS.some(
        (platform) => !updateIds[platform] && !completedPlatforms[platform] && !unchangedPlatforms[platform],
      )
    )
      throw new Error('Active release is missing an owned platform ID.');
    if (['starting', 'ramping'].includes(String(phase)) && Object.keys(completedPlatforms).length > 0)
      throw new Error('A ramping release cannot have completed platforms.');
    if (['ramping', 'finishing'].includes(String(phase)) && PLATFORMS.every((platform) => unchangedPlatforms[platform]))
      throw new Error('An entirely unchanged release cannot ramp or finish.');
    if (phase !== 'ramping' && pendingPercentage !== null) throw new Error('Only a ramp can have a pending step.');
  }
  const lastStartedDate = parsed.lastStartedDate;
  if (
    lastStartedDate !== null &&
    (typeof lastStartedDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(lastStartedDate))
  ) {
    throw new Error('Invalid daily release date.');
  }
  return {
    version: 1,
    candidate: parsed.candidate === null ? null : parseCandidate(parsed.candidate),
    active,
    lastStartedDate,
    lastCompletedCommit: nullableSha(parsed.lastCompletedCommit),
    rejectedCommit: nullableSha(parsed.rejectedCommit),
    checkpointRunId: runId(parsed.checkpointRunId),
  };
}

export function qualifyCandidate(
  candidate: StableCandidate,
  proof: {
    sha: string;
    bootSha: string;
    branch: string;
    receipt: StageReceipt;
    smokeResult: string;
    bootResult: string;
    smokePassed: string;
    bootPassed: string;
  },
): StableCandidate {
  const sameReceipt = isDeepStrictEqual(parseStageReceipt(proof.receipt), parseStageReceipt(candidate.receipt));
  if (
    proof.sha !== candidate.receipt.commitHash ||
    proof.bootSha !== candidate.receipt.commitHash ||
    proof.branch !== STABLE_CANDIDATE_BRANCH ||
    !sameReceipt
  ) {
    throw new Error('QA must name the exact frozen SHA, branch and receipt.');
  }
  return {
    ...candidate,
    qaPassed:
      proof.smokeResult === 'success' &&
      proof.bootResult === 'success' &&
      proof.smokePassed === 'true' &&
      proof.bootPassed === 'true',
  };
}

export type StableDecision =
  | { action: 'hold'; reason: string }
  | { action: 'start' | 'resume' | 'revert' | 'finish'; reason: string }
  | { action: 'raise'; percentage: number; reason: string };

/** Pure decision: delayed ticks advance one step; an empty health answer never means healthy. */
export function decideStable(state: StableState, now: Date, health: RolloutHealth[]): StableDecision {
  const active = state.active;
  const dailyWindow = now.getUTCHours() === otaReleasePolicy.dailyWindowUtcHour;
  if (!active) {
    if (!dailyWindow) return { action: 'hold', reason: 'Outside the daily 22:00 UTC window.' };
    if (state.lastStartedDate === now.toISOString().slice(0, 10))
      return { action: 'hold', reason: 'Already started a release today.' };
    const candidate = state.candidate;
    if (!candidate?.qaPassed) return { action: 'hold', reason: 'No frozen candidate with successful blocking QA.' };
    if (
      candidate.receipt.commitHash === state.lastCompletedCommit ||
      candidate.receipt.commitHash === state.rejectedCommit
    ) {
      return { action: 'hold', reason: 'Candidate was already released or rejected.' };
    }
    const age = now.getTime() - Date.parse(candidate.preparedAt);
    if (age < 0 || age > 30 * 24 * 3600_000)
      return { action: 'hold', reason: 'Candidate receipt is expired or from the future.' };
    return { action: 'start', reason: 'Frozen candidate passed both native boots and all required smokes.' };
  }
  if (active.phase === 'starting')
    return { action: 'resume', reason: 'Resume only the update IDs recorded before upload.' };
  if (active.phase === 'reverting') return { action: 'revert', reason: 'Finish the recorded revert.' };
  // Unchanged heads are byte attestations, never fabricated canary/control cohorts.
  const participants = PLATFORMS.filter((platform) => !active.unchangedPlatforms[platform]);
  const hasAll =
    participants.length > 0 &&
    health.length === participants.length &&
    participants.every((platform) => health.filter((entry) => entry.rollout.platform === platform).length === 1);
  if (!hasAll) return { action: 'hold', reason: 'Missing a changed platform health answer.' };
  if (health.some((entry) => entry.judgement.verdict === 'unhealthy')) {
    if (
      active.phase === 'finishing' &&
      (Object.keys(active.completedPlatforms).length > 0 || health.some((entry) => entry.rollout.percentage === 100))
    ) {
      return {
        action: 'hold',
        reason:
          'Unhealthy after a partial finish: manual recovery must restore the completed platform before reverting the remaining canary.',
      };
    }
    return { action: 'revert', reason: 'A changed platform is unhealthy; revert the owned canaries.' };
  }
  const valid = health.every(
    (entry) =>
      entry.canary !== null &&
      entry.control !== null &&
      [entry.canary, entry.control].every(
        (cohort) => cohort !== null && Object.values(cohort).every((count) => Number.isFinite(count) && count >= 0),
      ),
  );
  if (!valid) return { action: 'hold', reason: 'Missing or malformed health counts; no progression.' };
  if (active.phase === 'finishing') {
    return health.every((entry) => entry.judgement.verdict === 'healthy')
      ? { action: 'finish', reason: 'Resume the recorded finish after rechecking every changed platform cohort.' }
      : { action: 'hold', reason: 'Finish needs healthy evidence on every changed platform.' };
  }
  if (active.pendingPercentage !== null)
    return {
      action: 'raise',
      percentage: active.pendingPercentage,
      reason: 'Complete the recorded step on every changed platform.',
    };
  const stepHours = (now.getTime() - Date.parse(active.stepSince)) / 3600_000;
  const index = otaReleasePolicy.canarySteps.indexOf(active.percentage);
  if (stepHours < otaReleasePolicy.stepHours)
    return { action: 'hold', reason: 'This step has not soaked for four hours.' };
  if (index < otaReleasePolicy.canarySteps.length - 1) {
    return {
      action: 'raise',
      percentage: otaReleasePolicy.canarySteps[index + 1],
      reason: 'One four-hour step elapsed; sparse valid evidence may ramp to 50%.',
    };
  }
  const totalHours = (now.getTime() - Date.parse(active.startedAt)) / 3600_000;
  if (!dailyWindow || totalHours < otaReleasePolicy.minimumSoakHours || stepHours < 8) {
    return { action: 'hold', reason: 'Finish needs the daily window, twenty total hours and eight hours at 50%.' };
  }
  if (!health.every((entry) => entry.judgement.verdict === 'healthy'))
    return { action: 'hold', reason: '50% holds until every changed platform has sufficient healthy evidence.' };
  return { action: 'finish', reason: 'Every changed platform is healthy after the full soak.' };
}

/** Baseline refresh is allowed only for the controller's just-finished canary. */
export function refreshAfterOwnFinish(
  candidate: StableCandidate,
  completed: StableRelease,
  finishedUUIDs: Record<OtaPlatform, string>,
): StableCandidate {
  const baseline = { ...candidate.receipt.baselineProductionUpdateIds };
  for (const platform of PLATFORMS) {
    if (!UPDATE_ID.test(finishedUUIDs[platform])) throw new Error('Finished update needs a native UUID.');
    if (
      candidate.receipt.platforms[platform].runtimeVersion !==
        completed.candidate.receipt.platforms[platform].runtimeVersion ||
      baseline[platform] !== completed.candidate.receipt.baselineProductionUpdateIds[platform]
    ) {
      throw new Error('Prepared baseline cannot be refreshed across an independent production change.');
    }
    baseline[platform] = finishedUUIDs[platform];
  }
  return { ...candidate, receipt: { ...candidate.receipt, baselineProductionUpdateIds: baseline } };
}
