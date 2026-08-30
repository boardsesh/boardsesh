/// <reference types="node" />

/**
 * Cuts release/<platform>-v<version>-<shortfp> anchor tags for the exact binaries
 * accepted by App Store Connect and Google Play.
 *
 * For each accepted binary it locates the exact
 * build-<platform>-v<version>-<buildNumber>-<shortfp> tag the native build workflow
 * pushed, then creates release/<platform>-v<version>-<shortfp> at that
 * commit. The tag is the frozen backport anchor: its <shortfp> records the
 * fingerprint an OTA must resolve to reach that release's installs. Idempotent —
 * an anchor that already exists on the remote is left untouched, so re-runs and
 * the second platform's approval are safe.
 *
 * Input: ACCEPTED_BUILDS env = JSON array of
 * { platform, versionString, buildNumber, state }. Google versionString is null.
 * DRY_RUN=true logs what it would cut without creating or pushing tags.
 * CHECK_ONLY=true skips anchors. CANDIDATE_ONLY=true selects the highest exact
 * accepted build tag/SHA for HEAD_VERSION but makes no equivalence claim; an
 * environment-gated workflow compares real Expo fingerprints and their immutable
 * build-tag prefixes before merging. A
 * CANDIDATE_ONLY caller may also set UPLOADED_ONLY=true to select the highest
 * uniquely tagged upload per platform without fabricating store-acceptance data.
 * A conservative data-only caller may supply RELEASE_HEAD_SHA + HEAD_VERSION to
 * compare canonical native inputs without executing the release tree. Explicit
 * HEAD_IOS_FINGERPRINT + HEAD_ANDROID_FINGERPRINT remain available to trusted
 * local callers. Readiness mode emits `release_ready`; candidate mode emits
 * `candidates_found`. Both emit selected build tags and commits on success.
 *
 * Usage: tsx scripts/mobile-cut-release-tags.ts
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  formatBuildTag,
  formatReleaseTag,
  parseBuildTag,
  pickExactBuildTag,
  selectReleaseCandidate,
  selectReleaseCandidateFromEquivalentTags,
  selectHighestAcceptedBuildTags,
  type AcceptedBuildReference,
  type ReleaseCandidate,
} from './lib/release-tags';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Keep in lockstep with .github/actions/mobile-native-gate/action.yml's path
// screen. This is intentionally conservative: a lockfile change may fail closed
// even when Expo would resolve the same fingerprint, but untrusted release code is
// never installed or executed in the secret-bearing monitor job.
export const NATIVE_FINGERPRINT_INPUT_PATHS = [
  'package.json',
  'packages/mobile/package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'packages/mobile/app.config.ts',
  'packages/mobile/eas.json',
  'packages/mobile/fingerprint.config.js',
  'packages/mobile/assets',
  'packages/mobile/locales',
  'packages/mobile/plugins',
  'packages/mobile/modules',
  'packages/mobile/targets',
  'patches',
] as const;

function git(args: string[], options: { allowFail?: boolean } = {}): string {
  try {
    return execFileSync('git', args, {
      cwd: ROOT_DIR,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', options.allowFail ? 'ignore' : 'inherit'],
    }).trim();
  } catch (error) {
    if (options.allowFail) return '';
    throw error;
  }
}

function remoteTagCommit(tag: string): string | null {
  const output = git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { allowFail: true });
  const lines = output.split('\n').filter(Boolean);
  const peeled = lines.find((line) => line.endsWith(`refs/tags/${tag}^{}`));
  const direct = lines.find((line) => line.endsWith(`refs/tags/${tag}`));
  return (peeled ?? direct)?.split(/\s+/)[0] ?? null;
}

export function assertAnchorTarget(existingCommit: string | null, acceptedCommit: string, tag: string): void {
  if (existingCommit !== null && existingCommit !== acceptedCommit) {
    throw new Error(`${tag} already points to ${existingCommit}, expected exact accepted build ${acceptedCommit}`);
  }
}

function emitOutput(name: string, value: string): void {
  const githubOutput = process.env['GITHUB_OUTPUT'];
  if (githubOutput) appendFileSync(githubOutput, `${name}=${value}\n`);
  console.log(`output: ${name}=${value}`);
}

export function parseAcceptedBuilds(raw: string | undefined): AcceptedBuildReference[] {
  if (!raw || raw.trim().length === 0) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('ACCEPTED_BUILDS must be a JSON array');
  return parsed.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`Bad accepted-build entry: ${JSON.stringify(entry)}`);
    }
    const record = entry as Record<string, unknown>;
    const platform = record.platform;
    const versionString = record.versionString;
    const buildNumber = record.buildNumber;
    const state = record.state;
    if (
      (platform !== 'ios' && platform !== 'android') ||
      (typeof versionString !== 'string' && versionString !== null) ||
      !Number.isSafeInteger(buildNumber) ||
      (buildNumber as number) <= 0 ||
      typeof state !== 'string' ||
      (platform === 'ios' && (typeof versionString !== 'string' || versionString.length === 0))
    ) {
      throw new Error(`Bad accepted-build entry: ${JSON.stringify(entry)}`);
    }
    return { platform, versionString, buildNumber: buildNumber as number, state };
  });
}

export function buildTagsAsUploadedBuilds(tags: readonly string[], version: string): AcceptedBuildReference[] {
  return tags.flatMap((tagName) => {
    const tag = parseBuildTag(tagName);
    if (!tag || tag.version !== version) return [];
    return [
      {
        platform: tag.platform,
        versionString: tag.platform === 'ios' ? version : null,
        buildNumber: tag.buildNumber,
        state: 'UPLOADED_BUILD_TAG',
      },
    ];
  });
}

export function parseMarketingVersion(value: string, source: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error(`${source} must be x.y.z, got: ${value}`);
  return value;
}

function readCurrentMarketingVersion(): string {
  const override = process.env['HEAD_VERSION'];
  if (override !== undefined) return parseMarketingVersion(override, 'HEAD_VERSION');
  const appConfigPath = join(ROOT_DIR, 'packages', 'mobile', 'app.config.ts');
  const match = readFileSync(appConfigPath, 'utf8').match(/version:\s*'(\d+\.\d+\.\d+)'/);
  if (!match) throw new Error(`Could not find version field in ${appConfigPath}`);
  return parseMarketingVersion(match[1], appConfigPath);
}

function selectDataOnlyReleaseCandidate(
  allTags: readonly string[],
  acceptedBuilds: readonly AcceptedBuildReference[],
  releaseHead: string,
): ReleaseCandidate | null {
  const resolvedHead = git(['rev-parse', '--verify', `${releaseHead}^{commit}`], { allowFail: true });
  if (!resolvedHead) return null;
  const version = readCurrentMarketingVersion();
  const equivalentTags = allTags.filter((tagName) => {
    const buildTag = parseBuildTag(tagName);
    if (!buildTag || buildTag.version !== version) return false;
    const buildCommit = git(['rev-list', '-n', '1', tagName], { allowFail: true });
    if (!buildCommit) return false;
    try {
      execFileSync('git', ['diff', '--quiet', buildCommit, resolvedHead, '--', ...NATIVE_FINGERPRINT_INPUT_PATHS], {
        cwd: ROOT_DIR,
        stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  });
  return selectReleaseCandidateFromEquivalentTags(equivalentTags, acceptedBuilds, version);
}

function emitCandidate(
  candidate: ReleaseCandidate | null,
  readinessOutput: 'release_ready' | 'candidates_found',
): void {
  if (!candidate) {
    emitOutput(readinessOutput, 'false');
    return;
  }

  const iosTag = formatBuildTag(
    candidate.ios.platform,
    candidate.ios.version,
    candidate.ios.buildNumber,
    candidate.ios.shortFp,
  );
  const androidTag = formatBuildTag(
    candidate.android.platform,
    candidate.android.version,
    candidate.android.buildNumber,
    candidate.android.shortFp,
  );
  const iosCommit = git(['rev-list', '-n', '1', iosTag]);
  const androidCommit = git(['rev-list', '-n', '1', androidTag]);
  if (!iosCommit || !androidCommit) {
    emitOutput(readinessOutput, 'false');
    return;
  }

  emitOutput(readinessOutput, 'true');
  emitOutput('ios_build_tag', iosTag);
  emitOutput('ios_build_sha', iosCommit);
  emitOutput('android_build_tag', androidTag);
  emitOutput('android_build_sha', androidCommit);
}

export function shouldSkipAnchorWrites(checkOnly: boolean, candidateOnly: boolean): boolean {
  return checkOnly || candidateOnly;
}

export function readinessOutputForMode(candidateOnly: boolean): 'release_ready' | 'candidates_found' {
  return candidateOnly ? 'candidates_found' : 'release_ready';
}

export function resolveExecutionMode(env: Readonly<Record<string, string | undefined>>): {
  candidateOnly: boolean;
  checkOnly: boolean;
  readinessOutput: 'release_ready' | 'candidates_found';
  skipAnchorWrites: boolean;
} {
  const candidateOnly = env['CANDIDATE_ONLY'] === 'true';
  const checkOnly = env['CHECK_ONLY'] === 'true';
  return {
    candidateOnly,
    checkOnly,
    readinessOutput: readinessOutputForMode(candidateOnly),
    skipAnchorWrites: shouldSkipAnchorWrites(checkOnly, candidateOnly),
  };
}

function emitReleaseReadiness(
  allTags: readonly string[],
  acceptedBuilds: readonly AcceptedBuildReference[],
  candidateOnly: boolean,
): void {
  if (candidateOnly) {
    emitCandidate(
      selectHighestAcceptedBuildTags(allTags, acceptedBuilds, readCurrentMarketingVersion()),
      readinessOutputForMode(candidateOnly),
    );
    return;
  }

  const releaseHead = process.env['RELEASE_HEAD_SHA'];
  if (releaseHead) {
    emitCandidate(selectDataOnlyReleaseCandidate(allTags, acceptedBuilds, releaseHead), 'release_ready');
    return;
  }

  const iosFingerprint = process.env['HEAD_IOS_FINGERPRINT'];
  const androidFingerprint = process.env['HEAD_ANDROID_FINGERPRINT'];
  if (!iosFingerprint || !androidFingerprint) {
    emitOutput('release_ready', 'false');
    return;
  }
  emitCandidate(
    selectReleaseCandidate(allTags, acceptedBuilds, readCurrentMarketingVersion(), {
      ios: iosFingerprint,
      android: androidFingerprint,
    }),
    'release_ready',
  );
}

function main(): number {
  const dryRun = process.env['DRY_RUN'] === 'true';
  const executionMode = resolveExecutionMode(process.env);
  const uploadedOnly = process.env['UPLOADED_ONLY'] === 'true';
  if (uploadedOnly && !executionMode.candidateOnly) {
    throw new Error('UPLOADED_ONLY requires CANDIDATE_ONLY=true');
  }

  // Refresh tags so the build-* lookups and existence checks see the latest state.
  git(['fetch', 'origin', '--tags', '--force'], { allowFail: true });
  const allTags = git(['tag', '--list']).split('\n').filter(Boolean);
  const accepted = uploadedOnly
    ? buildTagsAsUploadedBuilds(allTags, readCurrentMarketingVersion())
    : parseAcceptedBuilds(process.env['ACCEPTED_BUILDS']);

  emitReleaseReadiness(allTags, accepted, executionMode.candidateOnly);

  if (accepted.length === 0) {
    console.log('No accepted builds reported — nothing to anchor.');
    emitOutput('cut_count', '0');
    return 0;
  }

  if (executionMode.skipAnchorWrites) {
    console.log('Candidate/readiness evaluation completed without cutting anchor tags.');
    emitOutput('cut_count', '0');
    return 0;
  }

  const cut: string[] = [];

  for (const { platform, versionString, buildNumber } of accepted) {
    const buildTag = pickExactBuildTag(allTags, platform, buildNumber, versionString ?? undefined);
    if (!buildTag) {
      console.log(`No unique exact build-${platform}-*-build-${buildNumber} tag found — skipping ${platform} anchor.`);
      continue;
    }

    const buildTagName = formatBuildTag(platform, buildTag.version, buildTag.buildNumber, buildTag.shortFp);
    const commit = git(['rev-list', '-n', '1', buildTagName]);
    if (!commit) {
      const releaseTag = formatReleaseTag(platform, buildTag.version, buildTag.shortFp);
      console.log(`::warning::Could not resolve a commit for ${buildTagName} — skipping ${releaseTag}.`);
      continue;
    }

    const releaseTag = formatReleaseTag(platform, buildTag.version, buildTag.shortFp);
    const existingCommit = remoteTagCommit(releaseTag);
    assertAnchorTarget(existingCommit, commit, releaseTag);
    if (existingCommit !== null) {
      console.log(`${releaseTag} already points to the exact accepted build — nothing to anchor.`);
      continue;
    }

    if (dryRun) {
      console.log(`[dry-run] would cut ${releaseTag} at ${commit.slice(0, 12)} (from ${buildTagName}).`);
      cut.push(releaseTag);
      continue;
    }

    git(['tag', releaseTag, commit]);
    let createdByThisRun = false;
    try {
      git(['push', 'origin', `refs/tags/${releaseTag}`]);
      createdByThisRun = true;
    } catch (error) {
      // A concurrent run may have pushed it between the check and here.
      const concurrentCommit = remoteTagCommit(releaseTag);
      if (!concurrentCommit) throw error;
      assertAnchorTarget(concurrentCommit, commit, releaseTag);
    }
    if (createdByThisRun) {
      // Emit immediately so a caller can safely roll back a partial multi-anchor
      // operation even if a later platform fails before the summary outputs.
      emitOutput('created_anchor', releaseTag);
      console.log(
        `::notice::Cut ${releaseTag} at ${commit.slice(0, 12)} — backport anchor for ${platform} ${buildTag.version}.`,
      );
      cut.push(releaseTag);
    } else {
      console.log(`${releaseTag} was concurrently created at the exact accepted build — leaving it untouched.`);
    }
  }

  emitOutput('cut_count', String(cut.length));
  emitOutput('cut_tags', cut.join(','));
  return 0;
}

// Only run when invoked directly (not when imported by a test).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(`[mobile-cut-release-tags] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
