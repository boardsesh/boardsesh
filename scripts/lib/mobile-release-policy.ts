/// <reference types="node" />

import { parseBuildTag } from './release-tags.ts';

export type MobilePlatform = 'ios' | 'android';
export type LiveStoreRuntime = {
  version: string;
  buildNumber: number;
  runtimeVersion: string;
  buildTag: string;
  commit: string;
  protectedRuntimeVersions: string[];
};
export type LiveStoreRuntimes = {
  schemaVersion: 1;
  checkedAt: string;
  ios: LiveStoreRuntime;
  android: LiveStoreRuntime;
};

const FULL_FINGERPRINT = /^[0-9a-f]{40}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
export const LIVE_STORE_MAX_AGE_MS = 6 * 60 * 60 * 1_000;
/** Read the literal Expo marketing version without executing branch configuration. */
export function readMarketingVersion(source: string): string {
  const matches = [...source.matchAll(/^\s*version\s*:\s*(['"])(\d+\.\d+\.\d+)\1\s*,?\s*$/gm)];
  if (matches.length !== 1) throw new Error('Expected one literal mobile marketing version');
  return matches[0]![2]!;
}

function record(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Invalid live store runtime record');
  }
  return input as Record<string, unknown>;
}

export function parseLiveStoreRuntimes(
  input: unknown,
  now = Date.now(),
  maxAgeMs = LIVE_STORE_MAX_AGE_MS,
): LiveStoreRuntimes {
  const parsed = record(input);
  const checkedAt = parsed['checkedAt'];
  if (parsed['schemaVersion'] !== 1 || typeof checkedAt !== 'string' || !Number.isFinite(Date.parse(checkedAt))) {
    throw new Error('Invalid live store runtime schema or timestamp');
  }
  const age = now - Date.parse(checkedAt);
  if (age < -60_000 || age > maxAgeMs)
    throw new Error(
      `Live store runtime evidence is stale (age ${Math.floor(age / 1000)} seconds; maximum ${maxAgeMs / 1000} seconds). ` +
        'Resolve it again: re-run all jobs of this workflow run, or dispatch a new run.',
    );
  const platformRecord = (platform: MobilePlatform): LiveStoreRuntime => {
    const runtime = record(parsed[platform]);
    const { version, buildNumber, runtimeVersion, buildTag, commit, protectedRuntimeVersions } = runtime;
    if (
      typeof version !== 'string' ||
      !VERSION.test(version) ||
      !Number.isSafeInteger(buildNumber) ||
      (buildNumber as number) <= 0 ||
      typeof runtimeVersion !== 'string' ||
      !FULL_FINGERPRINT.test(runtimeVersion) ||
      typeof commit !== 'string' ||
      !FULL_FINGERPRINT.test(commit) ||
      typeof buildTag !== 'string' ||
      !Array.isArray(protectedRuntimeVersions) ||
      protectedRuntimeVersions.length === 0 ||
      !protectedRuntimeVersions.every(
        (fingerprint) => typeof fingerprint === 'string' && FULL_FINGERPRINT.test(fingerprint),
      ) ||
      !protectedRuntimeVersions.includes(runtimeVersion)
    )
      throw new Error(`Invalid ${platform} live store runtime evidence`);
    const tag = parseBuildTag(buildTag);
    if (
      !tag ||
      tag.platform !== platform ||
      tag.version !== version ||
      tag.buildNumber !== buildNumber ||
      !runtimeVersion.startsWith(tag.shortFp)
    )
      throw new Error(`Invalid ${platform} live build provenance`);
    return {
      version,
      buildNumber: buildNumber as number,
      runtimeVersion,
      buildTag,
      commit,
      protectedRuntimeVersions: [...new Set(protectedRuntimeVersions as string[])],
    };
  };
  return { schemaVersion: 1, checkedAt, ios: platformRecord('ios'), android: platformRecord('android') };
}

export function stableCandidateMatchesLiveRuntimes(
  live: LiveStoreRuntimes,
  runtimes: Readonly<Record<MobilePlatform, string>>,
): boolean {
  return (['ios', 'android'] as const).every(
    (platform) => FULL_FINGERPRINT.test(runtimes[platform]) && live[platform].runtimeVersion === runtimes[platform],
  );
}
