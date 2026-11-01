/// <reference types="node" />

/** A tester build can be submitted publicly only after its source reaches main. */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseBuildTag, type Platform } from './lib/release-tags.ts';

export function selectSubmissionBuildTag(
  tagNames: readonly string[],
  platform: Platform,
  buildNumber: string,
  version?: string,
): string {
  if (!/^[1-9][0-9]*$/.test(buildNumber) || !Number.isSafeInteger(Number(buildNumber)))
    throw new Error('A submission needs an exact positive store build number.');
  if (version !== undefined && !/^\d+\.\d+\.\d+$/.test(version))
    throw new Error('A submission needs an exact marketing version.');
  const matches = tagNames.filter((tagName) => {
    const build = parseBuildTag(tagName);
    return (
      build?.platform === platform &&
      build.buildNumber === Number(buildNumber) &&
      (version === undefined || build.version === version)
    );
  });
  if (matches.length !== 1)
    throw new Error(`Expected one immutable ${platform} build tag for build ${buildNumber}; found ${matches.length}.`);
  return matches[0]!;
}

export function requireSubmissionMergedToMain(options: {
  platform: Platform;
  buildNumber: string;
  version?: string;
  cwd?: string;
}): { buildTag: string; buildCommit: string; mainCommit: string } {
  const git = (arguments_: string[]) =>
    execFileSync('git', arguments_, { cwd: options.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const tagNames = git(['tag', '--list', `build-${options.platform}-*`]).split('\n');
  const buildTag = selectSubmissionBuildTag(tagNames, options.platform, options.buildNumber, options.version);
  const buildCommit = git(['rev-parse', '--verify', `refs/tags/${buildTag}^{commit}`]);
  const mainCommit = git(['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}']);
  try {
    git(['merge-base', '--is-ancestor', buildCommit, mainCommit]);
  } catch {
    throw new Error(`${buildTag} has not merged into main. Merge the source into main before submitting this build.`);
  }
  return { buildTag, buildCommit, mainCommit };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const platform = process.env.SUBMISSION_PLATFORM;
    if (platform !== 'ios' && platform !== 'android') throw new Error('SUBMISSION_PLATFORM must be ios or android.');
    const surfaces = process.env.SUBMISSION_SURFACES?.split(',').map((surface) => surface.trim());
    if (platform === 'ios' && surfaces !== undefined && !surfaces.includes('default')) {
      console.log('Custom product pages only; no app-version submission.');
    } else
      console.log(
        JSON.stringify(
          requireSubmissionMergedToMain({
            platform,
            buildNumber: process.env.SUBMISSION_BUILD_NUMBER ?? '',
            ...(process.env.SUBMISSION_VERSION ? { version: process.env.SUBMISSION_VERSION } : {}),
          }),
        ),
      );
  } catch (error) {
    console.error(`[store-submission-guard] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
