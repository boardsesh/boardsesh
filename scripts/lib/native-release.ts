/// <reference types="node" />

import { parseBuildTag, parseReleaseTag } from './release-tags.ts';

export const NATIVE_BASELINE_TAG = 'release/native-baseline';
export const NATIVE_STAMP_MARKER = 'Native-Release: version-bump';
export const NATIVE_BASELINE_MARKER = 'Native-Release: baseline';
export const NATIVE_WORKFLOWS = [
  { platform: 'ios', file: 'ios-testflight-rn.yml', uploadStep: 'Export archive (uploads to TestFlight)' },
  { platform: 'android', file: 'android-apk-rn.yml', uploadStep: 'Upload AAB to Play internal and open beta tracks' },
] as const;
export type NativePlatform = (typeof NATIVE_WORKFLOWS)[number]['platform'];
export type NativeFingerprints = Record<NativePlatform, string>;
export type NativeReleaseMetadata = NativeFingerprints & { sourceSha: string; version?: string };
export type NativeStamp = NativeFingerprints & { sourceSha: string; version: string; sha: string };
export type TaggedNativeBuild = { tag: string; sha: string };

/** Success is remote evidence, including when a push lost its response. */
export function publishNativeBaseline(
  tagObject: string,
  runtime: { push: (tagObject: string) => void; remoteObject: () => string | null },
): void {
  requireFullSha(tagObject, 'Annotated baseline object');
  try {
    runtime.push(tagObject);
  } catch {
    /* Reconcile the remote below, never a local tag ref. */
  }
  if (runtime.remoteObject() !== tagObject)
    throw new Error(
      'Could not verify the exact annotated native baseline on origin. No baseline publication was confirmed.',
    );
}

const SHA = /^[0-9a-f]{40}$/;
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

export function requireFullSha(input: string, label = 'commit'): string {
  if (!SHA.test(input)) throw new Error(`${label} must be a full lowercase SHA.`);
  return input;
}

export function requireFingerprints(input: NativeFingerprints): NativeFingerprints {
  requireFullSha(input.ios, 'iOS fingerprint');
  requireFullSha(input.android, 'Android fingerprint');
  return input;
}

function trailer(message: string, name: string): string {
  const matches = [...message.matchAll(new RegExp(`^${name}: (.+)$`, 'gm'))];
  if (matches.length !== 1) throw new Error(`Expected exactly one ${name} trailer.`);
  return matches[0]![1]!;
}

export function parseNativeReleaseMetadata(message: string, kind: 'baseline' | 'version-bump'): NativeReleaseMetadata {
  if (trailer(message, 'Native-Release') !== kind) throw new Error(`Expected a native ${kind} record.`);
  const metadata: NativeReleaseMetadata = {
    sourceSha: requireFullSha(trailer(message, 'Native-Source')),
    ...requireFingerprints({
      ios: trailer(message, 'Native-iOS-Fingerprint'),
      android: trailer(message, 'Native-Android-Fingerprint'),
    }),
  };
  if (kind === 'version-bump') {
    const version = trailer(message, 'Native-Version');
    if (!VERSION.test(version)) throw new Error('Invalid native release version.');
    metadata.version = version;
  }
  return metadata;
}

export function nativeReleaseMessage(metadata: NativeReleaseMetadata, kind: 'baseline' | 'version-bump'): string {
  requireFullSha(metadata.sourceSha);
  requireFingerprints(metadata);
  if (kind === 'version-bump' && !VERSION.test(metadata.version ?? ''))
    throw new Error('Missing native release version.');
  return [
    kind === 'baseline' ? 'Native release baseline' : `chore(mobile): open native v${metadata.version}`,
    '',
    `Native-Release: ${kind}`,
    `Native-Source: ${metadata.sourceSha}`,
    `Native-iOS-Fingerprint: ${metadata.ios}`,
    `Native-Android-Fingerprint: ${metadata.android}`,
    ...(kind === 'version-bump' ? [`Native-Version: ${metadata.version}`] : []),
    '',
  ].join('\n');
}

export function sameNativeFingerprints(left: NativeFingerprints, right: NativeFingerprints): boolean {
  requireFingerprints(left);
  requireFingerprints(right);
  return left.ios === right.ios && left.android === right.android;
}

export function compareNativeVersions(left: string, right: string): number {
  const leftParts = VERSION.exec(left);
  const rightParts = VERSION.exec(right);
  if (!leftParts || !rightParts) throw new Error('Native versions must be major.minor.patch.');
  if ([...leftParts.slice(1), ...rightParts.slice(1)].some((part) => !Number.isSafeInteger(Number(part))))
    throw new Error('Native version components must be safe integers.');
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(leftParts[index]) - Number(rightParts[index]);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Tags reserve versions before public approval; retries must never reopen one. */
export function nextNativeVersion(currentVersion: string, tagNames: readonly string[]): string {
  compareNativeVersions(currentVersion, currentVersion);
  const highest = tagNames.reduce((latest, tag) => {
    const parsed = parseBuildTag(tag) ?? parseReleaseTag(tag);
    return parsed && compareNativeVersions(parsed.version, latest) > 0 ? parsed.version : latest;
  }, currentVersion);
  const [major, minor, patch] = highest.split('.').map(Number);
  if (!Number.isSafeInteger(patch) || patch! >= Number.MAX_SAFE_INTEGER)
    throw new Error('Native patch version overflow.');
  return `${major}.${minor}.${patch! + 1}`;
}

export function replaceNativeVersion(source: string, version: string): string {
  compareNativeVersions(version, version);
  const expression = /^(\s*version\s*:\s*)(['"])(\d+\.\d+\.\d+)(\2\s*,?\s*)$/gm;
  const matches = [...source.matchAll(expression)];
  if (matches.length !== 1) throw new Error('Expected exactly one literal mobile marketing version.');
  return source.replace(
    expression,
    (_match, prefix: string, quote: string, _previous: string, suffix: string) =>
      `${prefix}${quote}${version}${suffix}`,
  );
}

export function nativeBuildRunName(platform: NativePlatform, sourceSha: string): string {
  return `${platform}:${requireFullSha(sourceSha)}`;
}

export function exactNativeBuilds(
  taggedBuilds: readonly TaggedNativeBuild[],
  platform: NativePlatform,
  stamp: Pick<NativeStamp, 'sha' | 'version' | 'ios' | 'android'>,
): TaggedNativeBuild[] {
  return taggedBuilds.filter((reference) => {
    const build = parseBuildTag(reference.tag);
    return (
      build?.platform === platform &&
      build.version === stamp.version &&
      build.shortFp === stamp[platform].slice(0, 12) &&
      reference.sha === stamp.sha
    );
  });
}

export type NativeBuildRun = {
  id: number;
  title: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
};
export type NativeRecovery = { action: 'done' | 'wait' | 'dispatch' | 'inspect'; reason: string; runId?: number };

export type PreparedNativeSnapshot = { mainSha: string; stampSha: string | null; previousStamp: NativeStamp | null };
export type NativeCoordinatorRuntime = {
  prepare: () => PreparedNativeSnapshot;
  push: (stampSha: string) => void;
  committed: (stampSha: string) => boolean;
  recover: (stamp: NativeStamp, dryRun: boolean) => void;
};

/** A rejected FF push replans; a lost success response must never consume another patch. */
export function coordinateNativeSnapshots(
  runtime: NativeCoordinatorRuntime,
  dryRun = false,
): { changed: boolean; sourceSha: string } {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const prepared = runtime.prepare();
    if (!prepared.stampSha) {
      if (prepared.previousStamp) runtime.recover(prepared.previousStamp, dryRun);
      return { changed: false, sourceSha: prepared.previousStamp?.sha ?? prepared.mainSha };
    }
    if (!dryRun) {
      try {
        runtime.push(prepared.stampSha);
      } catch {
        if (!runtime.committed(prepared.stampSha)) continue;
      }
    }
    return { changed: true, sourceSha: prepared.stampSha };
  }
  throw new Error('Main advanced during three native release attempts. The next coordinator run will replan.');
}

/** An upload that started may already have committed; only a human/readback may retry it. */
export function nativeRecoveryDecision(input: {
  platform: NativePlatform;
  stamp: NativeStamp;
  taggedBuilds: readonly TaggedNativeBuild[];
  runs: readonly NativeBuildRun[];
  uploadAttempted?: boolean;
  now: number;
}): NativeRecovery {
  if (exactNativeBuilds(input.taggedBuilds, input.platform, input.stamp).length > 0)
    return { action: 'done', reason: 'The exact stamped binary is tagged.' };
  const matching = input.runs
    .filter((run) => run.title === nativeBuildRunName(input.platform, input.stamp.sha))
    .sort((left, right) => right.id - left.id);
  const active = matching.find((run) => run.status !== 'completed');
  if (active)
    return { action: 'wait', reason: 'A build of this exact stamp is already queued or running.', runId: active.id };
  const latest = matching[0];
  if (latest && input.uploadAttempted)
    return {
      action: 'inspect',
      reason: 'An upload started without a final build tag. Reconcile that upload before rebuilding.',
      runId: latest.id,
    };
  if (latest && input.now - Date.parse(latest.createdAt) < 60 * 60_000)
    return { action: 'wait', reason: 'A deferred or failed build waits one hour before recovery.', runId: latest.id };
  return { action: 'dispatch', reason: 'No uploaded binary or active build exists for the latest stamp.' };
}
