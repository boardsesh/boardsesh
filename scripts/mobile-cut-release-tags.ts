/// <reference types="node" />

/**
 * Cuts the release/<platform>-v<version>-<shortfp> anchor tags for App Store
 * versions that have been accepted by Apple. Driven by mobile-auto-version-bump.yml
 * after scripts/mobile-auto-version-bump.ts reports the accepted (version, build
 * number) pairs.
 *
 * For each accepted version it locates the build-<platform>-v<version>-<buildNumber>-<shortfp>
 * tag the native build workflow pushed (iOS by the store's approved build number,
 * Android by the latest build of the same marketing version — the app ships both
 * platforms at one version, and Google Play doesn't report an approved build
 * number here), then creates release/<platform>-v<version>-<shortfp> at that
 * commit. The tag is the frozen backport anchor: its <shortfp> records the
 * fingerprint an OTA must resolve to reach that release's installs. Idempotent —
 * an anchor that already exists on the remote is left untouched, so re-runs and
 * the second platform's approval are safe.
 *
 * Input: ACCEPTED_BUILDS env = JSON array of { versionString, buildNumber }.
 * DRY_RUN=true logs what it would cut without creating or pushing tags.
 *
 * Usage: bun scripts/mobile-cut-release-tags.ts
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { formatBuildTag, formatReleaseTag, pickBuildTagForVersion, type Platform } from './lib/release-tags';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLATFORMS: readonly Platform[] = ['ios', 'android'];

type AcceptedVersion = { versionString: string; buildNumber: number | null };

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

function remoteTagExists(tag: string): boolean {
  // Non-zero exit (no such tag) is expected, so swallow stderr and treat empty as absent.
  return git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`], { allowFail: true }).length > 0;
}

function emitOutput(name: string, value: string): void {
  const githubOutput = process.env['GITHUB_OUTPUT'];
  if (githubOutput) appendFileSync(githubOutput, `${name}=${value}\n`);
  console.log(`output: ${name}=${value}`);
}

export function parseAcceptedBuilds(raw: string | undefined): AcceptedVersion[] {
  if (!raw || raw.trim().length === 0) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('ACCEPTED_BUILDS must be a JSON array');
  return parsed.map((entry) => {
    const record = entry as Record<string, unknown>;
    const versionString = record.versionString;
    if (typeof versionString !== 'string') throw new Error(`Bad accepted-build entry: ${JSON.stringify(entry)}`);
    const buildNumber = typeof record.buildNumber === 'number' ? record.buildNumber : null;
    return { versionString, buildNumber };
  });
}

function main(): number {
  const dryRun = process.env['DRY_RUN'] === 'true';
  const accepted = parseAcceptedBuilds(process.env['ACCEPTED_BUILDS']);

  if (accepted.length === 0) {
    console.log('No accepted versions reported — nothing to anchor.');
    emitOutput('cut_count', '0');
    return 0;
  }

  // Refresh tags so the build-* lookups and existence checks see the latest state.
  git(['fetch', 'origin', '--tags', '--force'], { allowFail: true });
  const allTags = git(['tag', '--list']).split('\n').filter(Boolean);

  const cut: string[] = [];

  for (const { versionString, buildNumber } of accepted) {
    for (const platform of PLATFORMS) {
      // iOS: the store reports the EXACT approved build number, so anchor that build
      // (pickBuildTagForVersion is strict — it won't fall back to another build).
      // Android CAVEAT: approval is detected from App Store Connect only; there is no
      // Google Play query here. We assume the app ships both platforms at one
      // marketing version and take the latest Android build of that version. If
      // Android hasn't actually shipped that version to the store, its anchor is
      // premature — but a backport under it just reaches whatever installs hold that
      // fingerprint (and the backport re-verifies the fingerprint before publishing),
      // so it's ineffective rather than wrong. Verify the Android release actually
      // shipped before relying on an Android backport. See docs/mobile-ota-updates.md.
      const preferredBuildNumber = platform === 'ios' ? (buildNumber ?? undefined) : undefined;
      const buildTag = pickBuildTagForVersion(allTags, platform, versionString, preferredBuildNumber);
      if (!buildTag) {
        console.log(
          `No build-${platform}-v${versionString}-* tag found — skipping ${platform} anchor for ${versionString}.`,
        );
        continue;
      }

      const releaseTag = formatReleaseTag(platform, versionString, buildTag.shortFp);
      if (remoteTagExists(releaseTag)) {
        console.log(`${releaseTag} already exists — nothing to anchor.`);
        continue;
      }

      const buildTagName = formatBuildTag(platform, versionString, buildTag.buildNumber, buildTag.shortFp);
      const commit = git(['rev-list', '-n', '1', buildTagName]);
      if (!commit) {
        console.log(`::warning::Could not resolve a commit for ${buildTagName} — skipping ${releaseTag}.`);
        continue;
      }

      if (dryRun) {
        console.log(`[dry-run] would cut ${releaseTag} at ${commit.slice(0, 12)} (from ${buildTagName}).`);
        cut.push(releaseTag);
        continue;
      }

      git(['tag', releaseTag, commit], { allowFail: true }); // no-op if it already exists locally
      try {
        git(['push', 'origin', `refs/tags/${releaseTag}`]);
      } catch (error) {
        // A concurrent run may have pushed it between the check and here.
        if (!remoteTagExists(releaseTag)) throw error;
      }
      console.log(
        `::notice::Cut ${releaseTag} at ${commit.slice(0, 12)} — backport anchor for ${platform} ${versionString}.`,
      );
      cut.push(releaseTag);
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
