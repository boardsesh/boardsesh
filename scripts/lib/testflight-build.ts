/// <reference types="node" />

import { parseBuildTag } from './release-tags';

export const TESTFLIGHT_WORKFLOW = '.github/workflows/ios-testflight-rn.yml';
export const TESTFLIGHT_RECEIPT_ARTIFACT = 'ios-testflight-build';

export type TestflightBuildReceipt = {
  version: string;
  buildNumber: string;
  sourceSha: string;
  sourceRef: string;
  sourceRunId: string;
  buildTag: string;
  previousBuildTag: string | null;
  previousBuildSha: string | null;
};

const SHA = /^[0-9a-f]{40}$/;
const POSITIVE_INTEGER = /^[1-9]\d*$/;

export function objectFields(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('Expected an object.');
  return input as Record<string, unknown>;
}

export function parseTestflightBuildReceipt(input: unknown): TestflightBuildReceipt {
  const receipt = objectFields(input);
  for (const field of ['version', 'buildNumber', 'sourceSha', 'sourceRef', 'sourceRunId', 'buildTag'] as const) {
    if (typeof receipt[field] !== 'string') throw new Error(`Missing TestFlight receipt ${field}.`);
  }
  const { version, buildNumber, sourceSha, sourceRef, sourceRunId, buildTag, previousBuildTag, previousBuildSha } =
    receipt;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid TestFlight version.');
  if (typeof buildNumber !== 'string' || !POSITIVE_INTEGER.test(buildNumber)) throw new Error('Invalid build number.');
  if (typeof sourceRunId !== 'string' || !POSITIVE_INTEGER.test(sourceRunId)) throw new Error('Invalid source run ID.');
  if (typeof sourceSha !== 'string' || !SHA.test(sourceSha)) throw new Error('Invalid source SHA.');
  if (sourceRef !== 'main' && sourceRef !== 'release/next') throw new Error('Untrusted TestFlight source branch.');
  if (typeof buildTag !== 'string') throw new Error('Invalid build tag.');
  const parsedTag = parseBuildTag(buildTag);
  if (parsedTag?.platform !== 'ios' || parsedTag.version !== version || String(parsedTag.buildNumber) !== buildNumber) {
    throw new Error('TestFlight tag does not match the exact version and build.');
  }
  if (previousBuildTag !== null || previousBuildSha !== null) {
    if (
      typeof previousBuildTag !== 'string' ||
      parseBuildTag(previousBuildTag)?.platform !== 'ios' ||
      typeof previousBuildSha !== 'string' ||
      !SHA.test(previousBuildSha) ||
      previousBuildTag === buildTag
    ) {
      throw new Error('Invalid previous native build reference.');
    }
  }
  return {
    version,
    buildNumber,
    sourceSha,
    sourceRef,
    sourceRunId,
    buildTag,
    previousBuildTag: previousBuildTag as string | null,
    previousBuildSha: previousBuildSha as string | null,
  };
}

export type NativeBuildTag = { name: string; sha: string };

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Nearest tagged ancestor; same-commit rebuilds use their version/build order. */
export function previousNativeBuild(
  tags: readonly NativeBuildTag[],
  ancestorShas: readonly string[],
  version: string,
  buildNumber: string,
): NativeBuildTag | null {
  const ancestorOrder = new Map(ancestorShas.map((sha, index) => [sha, index]));
  const candidates = tags.flatMap((tag) => {
    const parsed = parseBuildTag(tag.name);
    const order = ancestorOrder.get(tag.sha);
    if (parsed?.platform !== 'ios' || order === undefined) return [];
    const versionOrder = compareVersions(parsed.version, version);
    if (versionOrder > 0 || (versionOrder === 0 && parsed.buildNumber >= Number(buildNumber))) return [];
    return [{ tag, parsed, order }];
  });
  candidates.sort(
    (left, right) =>
      left.order - right.order ||
      compareVersions(right.parsed.version, left.parsed.version) ||
      right.parsed.buildNumber - left.parsed.buildNumber ||
      left.tag.name.localeCompare(right.tag.name),
  );
  return candidates[0]?.tag ?? null;
}

export type TrustedTestflightRun = { id: string; attempt: number; sha: string; branch: string };

export function trustedTestflightRun(input: unknown, repository: string): TrustedTestflightRun {
  const run = objectFields(input);
  const headRepository = objectFields(run.head_repository);
  if (
    run.path !== TESTFLIGHT_WORKFLOW ||
    run.conclusion !== 'success' ||
    run.status !== 'completed' ||
    (run.event !== 'push' && run.event !== 'workflow_dispatch') ||
    headRepository.full_name !== repository ||
    (run.head_branch !== 'main' && run.head_branch !== 'release/next') ||
    typeof run.head_sha !== 'string' ||
    !SHA.test(run.head_sha) ||
    typeof run.id !== 'number' ||
    !Number.isSafeInteger(run.id) ||
    run.id <= 0 ||
    typeof run.run_attempt !== 'number' ||
    !Number.isSafeInteger(run.run_attempt) ||
    run.run_attempt <= 0
  )
    throw new Error('Source must be a successful native TestFlight run from this repository’s main or release/next.');
  return { id: String(run.id), attempt: run.run_attempt, sha: run.head_sha, branch: run.head_branch };
}

export function validateReceiptSource(receipt: TestflightBuildReceipt, run: TrustedTestflightRun): void {
  if (receipt.sourceRunId !== run.id || receipt.sourceSha !== run.sha || receipt.sourceRef !== run.branch) {
    throw new Error('TestFlight receipt does not belong to the requested native build run.');
  }
}
