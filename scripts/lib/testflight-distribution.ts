/// <reference types="node" />

import { parseBuildTag } from './release-tags';
import { objectFields, type TestflightBuildReceipt } from './testflight-build';
import { getSupersededNativeStampShas } from '../mobile-native-release';

/** Refresh authority before retiring uploads; a failed refresh must fail closed. */
export function readSupersededTestflightSources(
  execute: (binary: string, argumentsList: string[]) => string,
  readLineage = getSupersededNativeStampShas,
  directory = process.cwd(),
): ReadonlySet<string> {
  execute('git', [
    '-C',
    directory,
    '-c',
    'credential.helper=',
    '-c',
    'credential.helper=!gh auth git-credential',
    'fetch',
    '--quiet',
    '--no-tags',
    'origin',
    '+refs/heads/main:refs/remotes/origin/main',
  ]);
  return new Set(readLineage(directory));
}

export const DISTRIBUTION_WORKFLOW = '.github/workflows/ios-testflight-distribute.yml';
export const DISTRIBUTION_STATUSES = [
  'ready-for-testing',
  'pending-beta-review',
  'approved-awaiting-availability',
  'deferred-beta-review',
  'deferred-processing',
  'terminal-failure',
] as const;
export type DistributionStatus = (typeof DISTRIBUTION_STATUSES)[number];

export type DistributionResult = {
  schemaVersion: 1;
  sourceRunId: string;
  sourceRunAttempt: number;
  sourceSha: string;
  buildTag: string;
  version: string;
  buildNumber: string;
  distributionRunId: string;
  distributionRunAttempt: number;
  checkedAt: string;
  status: DistributionStatus;
  buildId: string | null;
  groupId: string | null;
  externalBuildState: string | null;
};

const POSITIVE_INTEGER = /^[1-9]\d*$/;
const SHA = /^[0-9a-f]{40}$/;

export function parseDistributionResult(input: unknown): DistributionResult {
  const result = objectFields(input);
  const build = typeof result.buildTag === 'string' ? parseBuildTag(result.buildTag) : null;
  if (
    result.schemaVersion !== 1 ||
    typeof result.sourceRunId !== 'string' ||
    !POSITIVE_INTEGER.test(result.sourceRunId) ||
    !Number.isSafeInteger(result.sourceRunAttempt) ||
    Number(result.sourceRunAttempt) <= 0 ||
    typeof result.sourceSha !== 'string' ||
    !SHA.test(result.sourceSha) ||
    build?.platform !== 'ios' ||
    build.version !== result.version ||
    String(build.buildNumber) !== result.buildNumber ||
    typeof result.distributionRunId !== 'string' ||
    !POSITIVE_INTEGER.test(result.distributionRunId) ||
    !Number.isSafeInteger(result.distributionRunAttempt) ||
    Number(result.distributionRunAttempt) <= 0 ||
    typeof result.checkedAt !== 'string' ||
    !Number.isFinite(Date.parse(result.checkedAt)) ||
    !DISTRIBUTION_STATUSES.includes(result.status as DistributionStatus) ||
    ['buildId', 'groupId', 'externalBuildState'].some(
      (field) => result[field] !== null && typeof result[field] !== 'string',
    )
  )
    throw new Error('Invalid TestFlight distribution result.');
  return result as DistributionResult;
}

export function latestUploadedIosBuild(
  tags: readonly { name: string; sha: string }[],
  supersededSources: ReadonlySet<string> = new Set(),
): { name: string; sha: string } | null {
  const builds = tags.flatMap((tag) => {
    const parsed = parseBuildTag(tag.name);
    if (parsed?.platform !== 'ios' || !SHA.test(tag.sha) || supersededSources.has(tag.sha)) return [];
    return [{ tag, parsed }];
  });
  builds.sort((left, right) => {
    const leftVersion = left.parsed.version.split('.').map(Number);
    const rightVersion = right.parsed.version.split('.').map(Number);
    for (let index = 0; index < 3; index += 1) {
      const difference = rightVersion[index] - leftVersion[index];
      if (difference) return difference;
    }
    return right.parsed.buildNumber - left.parsed.buildNumber;
  });
  if (
    builds.length > 1 &&
    builds[0].parsed.version === builds[1].parsed.version &&
    builds[0].parsed.buildNumber === builds[1].parsed.buildNumber
  )
    throw new Error('Ambiguous newest uploaded iOS build.');
  return builds[0]?.tag ?? null;
}

/** Rerunning an old workflow creates a newer outcome without changing its run ID. */
export function retryableDistribution(
  latestBuild: { name: string; sha: string },
  results: readonly DistributionResult[],
): DistributionResult | null {
  const newest = results
    .filter((result) => result.buildTag === latestBuild.name && result.sourceSha === latestBuild.sha)
    .sort(
      (left, right) =>
        Date.parse(right.checkedAt) - Date.parse(left.checkedAt) ||
        right.distributionRunAttempt - left.distributionRunAttempt ||
        Number(right.distributionRunId) - Number(left.distributionRunId),
    )[0];
  return newest && (newest.status === 'deferred-beta-review' || newest.status === 'deferred-processing')
    ? newest
    : null;
}

export function createDistributionResult(
  receipt: TestflightBuildReceipt,
  identity: { sourceRunAttempt: number; distributionRunId: string; distributionRunAttempt: number; checkedAt: string },
  laneReceipt?: unknown,
): DistributionResult {
  const lane = laneReceipt === undefined ? {} : objectFields(laneReceipt);
  if (laneReceipt !== undefined && (lane.version !== receipt.version || lane.buildNumber !== receipt.buildNumber))
    throw new Error('Distribution lane returned a different version or build.');
  return parseDistributionResult({
    schemaVersion: 1,
    sourceRunId: receipt.sourceRunId,
    sourceSha: receipt.sourceSha,
    buildTag: receipt.buildTag,
    version: receipt.version,
    buildNumber: receipt.buildNumber,
    ...identity,
    status: lane.status ?? 'terminal-failure',
    buildId: lane.buildId ?? null,
    groupId: lane.groupId ?? null,
    externalBuildState: lane.externalBuildState ?? null,
  });
}
