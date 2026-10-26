/// <reference types="node" />

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseBuildTag } from './lib/release-tags.ts';
import type { MobilePlatform } from './lib/mobile-release-policy.ts';
import {
  isReleaseTrainActive,
  mayPublishTrainRuntime,
  parseLiveStoreRuntimes,
  readMarketingVersion,
  TRAIN_LIVE_STORE_MAX_AGE_MS,
} from './lib/mobile-release-policy.ts';

/** A cut is a newly selected train version, including creation of an active train. */
export function isNewReleaseTrainCut(mainSource: string, trainSource: string, previousTrainSource?: string): boolean {
  return (
    isReleaseTrainActive(mainSource, trainSource) &&
    (previousTrainSource === undefined ||
      readMarketingVersion(previousTrainSource) !== readMarketingVersion(trainSource))
  );
}

/** Every immutable uploaded binary already contained in main is reserved for public release. */
export function isRuntimeReservedByMain(
  platform: MobilePlatform,
  runtime: string,
  mainSha: string,
  runner: typeof execFileSync = execFileSync,
  repoDir = process.cwd(),
): boolean {
  if (!/^[0-9a-f]{40}$/.test(runtime) || !/^[0-9a-f]{40}$/.test(mainSha)) {
    throw new Error('Expected full runtime and pinned main SHA');
  }
  const git = (args: string[]) =>
    String(
      runner('git', args, {
        cwd: repoDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 30_000,
      }),
    ).trim();
  const tags = git(['tag', '--list', `build-${platform}-v*-*-${runtime.slice(0, 12)}`]).split('\n');
  for (const tagName of tags) {
    const tag = parseBuildTag(tagName);
    if (!tag || tag.platform !== platform || tag.shortFp !== runtime.slice(0, 12)) continue;
    const commit = git(['rev-parse', '--verify', `${tagName}^{commit}`]);
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('Invalid immutable native build tag commit');
    try {
      git(['merge-base', '--is-ancestor', commit, mainSha]);
      return true;
    } catch (error) {
      // Exit 1 means unrelated; every other error leaves ancestry unproven.
      if ((error as { status?: unknown }).status !== 1) throw error;
    }
  }
  return false;
}

function flag(name: string): string {
  const index = process.argv.indexOf(name);
  const argument = index >= 0 ? process.argv[index + 1] : undefined;
  if (!argument || argument.startsWith('--')) throw new Error(`Missing ${name}`);
  return argument;
}

function main(): void {
  // Its own workflow step, so a refusal on age alone is visible by step name.
  if (process.argv.includes('--check-evidence')) {
    parseLiveStoreRuntimes(
      JSON.parse(process.env['LIVE_STORE_RUNTIMES'] ?? 'null'),
      Date.now(),
      TRAIN_LIVE_STORE_MAX_AGE_MS,
    );
    console.log('evidence_fresh=true');
    return;
  }
  if (process.argv.includes('--runtime')) {
    const platform = flag('--platform');
    if (platform !== 'ios' && platform !== 'android') throw new Error('Invalid platform');
    // The train guard runs as the publish job starts, so this is the age the
    // evidence had when the job took the OTA lane.
    const live = parseLiveStoreRuntimes(
      JSON.parse(process.env['LIVE_STORE_RUNTIMES'] ?? 'null'),
      Date.now(),
      TRAIN_LIVE_STORE_MAX_AGE_MS,
    );
    const runtime = flag('--runtime');
    const allowed =
      mayPublishTrainRuntime(live, platform, runtime) &&
      !isRuntimeReservedByMain(platform, runtime, flag('--main-sha'));
    console.log(`publish_${platform}=${allowed}`);
    return;
  }
  const mainSha = flag('--main-sha');
  const trainSha = flag('--train-sha');
  if (![mainSha, trainSha].every((sha) => /^[0-9a-f]{40}$/.test(sha))) throw new Error('Expected pinned commit SHAs');
  const config = (sha: string) =>
    execFileSync('git', ['show', `${sha}:packages/mobile/app.config.ts`], { encoding: 'utf8' });
  const mainSource = config(mainSha);
  const trainSource = config(trainSha);
  console.log(`train_active=${isReleaseTrainActive(mainSource, trainSource)}`);
  console.log(`train_version=${readMarketingVersion(trainSource)}`);
  if (process.argv.includes('--before-sha')) {
    const beforeSha = flag('--before-sha');
    if (!/^[0-9a-f]{40}$/.test(beforeSha)) throw new Error('Expected a pinned previous train SHA');
    const previousSource = /^0{40}$/.test(beforeSha) ? undefined : config(beforeSha);
    console.log(`train_cut=${isNewReleaseTrainCut(mainSource, trainSource, previousSource)}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
