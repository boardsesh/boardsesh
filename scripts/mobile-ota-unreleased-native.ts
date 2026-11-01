/// <reference types="node" />

/** Read-only admission for immediate main OTA delivery to an unreleased native line. */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_CONFIG_PATH, readMarketingVersion } from './lib/mobile-release-version.ts';
import { parseLiveStoreRuntimes } from './lib/mobile-release-policy.ts';
import { NATIVE_STAMP_PATTERN, compareNativeVersions, requireFullSha } from './lib/native-release.ts';
import { parseReleaseTag } from './lib/release-tags.ts';
import { validateNativeStampSource } from './mobile-native-release.ts';
import { preflightStagedPromotion } from './mobile-ota-promote-staged.ts';

export function classifyUnreleasedNativeOta(options: {
  directory: string;
  stagePath: string;
  sourceSha: string;
  mainSha: string;
  liveStoreRuntimes: unknown;
  now?: number;
}): { eligible: boolean; reason: string; stampSha?: string } {
  const { directory, sourceSha, mainSha } = options;
  requireFullSha(sourceSha);
  requireFullSha(mainSha);
  const live = parseLiveStoreRuntimes(options.liveStoreRuntimes, options.now);
  const stage = preflightStagedPromotion(options.stagePath, sourceSha);
  const git = (args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  const hold = (reason: string) => ({ eligible: false, reason });
  if (!git(['rev-list', '--first-parent', mainSha]).split('\n').includes(sourceSha))
    throw new Error('OTA source must be on current main first-parent history.');
  const latestStampSha = (commit: string) =>
    git(['log', '--first-parent', '-1', '--format=%H', '--extended-regexp', `--grep=${NATIVE_STAMP_PATTERN}`, commit]);
  const stampSha = latestStampSha(sourceSha);
  if (!stampSha) return hold('No validated native release stamp at this source.');
  const stamp = validateNativeStampSource(stampSha, mainSha, directory);
  if (latestStampSha(mainSha) !== stampSha) return hold('Main has moved to another native release line.');
  const sourceVersion = readMarketingVersion(git(['show', `${sourceSha}:${APP_CONFIG_PATH}`]));
  const currentVersion = readMarketingVersion(git(['show', `${mainSha}:${APP_CONFIG_PATH}`]));
  if (sourceVersion !== stamp.version || currentVersion !== stamp.version)
    return hold('Main marketing version does not match its validated native stamp.');
  const publicRuntimes = new Set([...live.ios.protectedRuntimeVersions, ...live.android.protectedRuntimeVersions]);
  for (const platform of ['ios', 'android'] as const) {
    if (stage.exports[platform].expoConfig.version !== stamp.version)
      throw new Error(`${platform} archived marketing version differs from the native release stamp.`);
    if (stage.receipt.platforms[platform].runtimeVersion !== stamp[platform])
      return hold(`${platform} staged runtime has no matching native release stamp.`);
    if (compareNativeVersions(stamp.version, live[platform].version) <= 0)
      return hold(`${platform} publicly offers this marketing version or a newer version.`);
    if (publicRuntimes.has(stamp[platform])) return hold(`${platform} candidate runtime is already publicly offered.`);
  }
  const anchors = git(['tag', '--list', 'release/*']).split('\n');
  if (
    anchors.some((tag) => {
      const anchor = parseReleaseTag(tag);
      // Old installed binaries still accept their runtime after stores move on.
      // Conservatively protect every matching short prefix, including collisions.
      return (
        anchor &&
        (compareNativeVersions(anchor.version, stamp.version) >= 0 ||
          stamp.ios.startsWith(anchor.shortFp) ||
          stamp.android.startsWith(anchor.shortFp))
      );
    })
  )
    return hold('A public release anchor already reserves this marketing version or candidate runtime.');
  return { eligible: true, stampSha, reason: `Validated unreleased native ${stamp.version}; publish immediately.` };
}

function main(): void {
  if (process.env.GITHUB_REF !== 'refs/heads/main')
    throw new Error('Unreleased native OTA admission only runs on main.');
  const flags = process.argv.slice(2);
  const args = new Map<string, string>();
  let requireEligible = false;
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index]!;
    if (flag === '--require-eligible' && !requireEligible) {
      requireEligible = true;
      continue;
    }
    const argument = flags[++index];
    if (
      !['--stage', '--source-sha', '--live-store-runtimes'].includes(flag) ||
      !argument ||
      argument.startsWith('--') ||
      args.has(flag)
    )
      throw new Error(`Invalid or duplicate admission argument: ${flag}.`);
    args.set(flag, argument);
  }
  const sourceSha = args.get('--source-sha');
  const stagePath = args.get('--stage');
  const livePath = args.get('--live-store-runtimes');
  if (!sourceSha || !stagePath || !livePath || sourceSha !== process.env.GITHUB_SHA)
    throw new Error('Exact workflow source, archived stage and live-store evidence are required.');
  const decision = classifyUnreleasedNativeOta({
    directory: process.cwd(),
    mainSha: execFileSync('git', ['rev-parse', 'refs/remotes/origin/main'], { encoding: 'utf8' }).trim(),
    sourceSha,
    stagePath,
    liveStoreRuntimes: JSON.parse(readFileSync(livePath, 'utf8')) as unknown,
  });
  console.log(decision.reason);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `eligible=${decision.eligible}\n`);
  if (requireEligible && !decision.eligible)
    throw new Error('Native OTA is no longer eligible for immediate delivery.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : 'Unreleased native OTA admission failed.');
    process.exitCode = 1;
  }
}
