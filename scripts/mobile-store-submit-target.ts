/// <reference types="node" />

/** Explicit manual public-store target. Never infer a release from a merge or branch head. */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { APP_CONFIG_PATH, parseSemver, readMarketingVersion } from './lib/mobile-release-version.ts';
import { parseReleaseTag } from './lib/release-tags.ts';
import { selectSubmissionBuildTag } from './mobile-store-submission-guard.ts';

export type SubmitMode = 'plan' | 'submit';
export function resolveSubmitMode(input: { eventName: string; requestedAction: string; killSwitch: string }): {
  mode: SubmitMode;
  reason: string;
} {
  if (input.eventName !== 'workflow_dispatch') throw new Error('Public store submission requires a manual dispatch.');
  if (input.requestedAction !== 'plan' && input.requestedAction !== 'submit')
    throw new Error('Dispatch action must be plan or submit.');
  if (input.killSwitch.trim().toLowerCase() === 'off')
    return { mode: 'plan', reason: 'STORE_AUTO_SUBMIT is off: store reads only.' };
  return {
    mode: input.requestedAction,
    reason:
      input.requestedAction === 'submit' ? 'Explicitly dispatched to submit this build pair.' : 'Store reads only.',
  };
}

export type SubmissionSelection = {
  releaseSha: string;
  version: string;
  iosBuildNumber: string;
  androidVersionCode: string;
};
export type SubmitTarget = SubmissionSelection & { iosBuildTag: string; androidBuildTag: string };
export type TargetRuntime = {
  appConfigAt(sha: string): string;
  tagNames(): string[];
  tagCommit(tag: string): string;
  isAncestor(sha: string, descendant: string): boolean;
};

export function resolveSubmitTarget(runtime: TargetRuntime, selection: SubmissionSelection): SubmitTarget {
  if (!/^[0-9a-f]{40}$/.test(selection.releaseSha)) throw new Error('release_sha must be a full commit SHA.');
  parseSemver(selection.version);
  if (!runtime.isAncestor(selection.releaseSha, 'refs/remotes/origin/main'))
    throw new Error('The selected release commit must be in main history.');
  if (readMarketingVersion(runtime.appConfigAt(selection.releaseSha)) !== selection.version)
    throw new Error('The selected marketing version does not match the release commit.');
  const tagNames = runtime.tagNames();
  const iosBuildTag = selectSubmissionBuildTag(tagNames, 'ios', selection.iosBuildNumber, selection.version);
  const androidBuildTag = selectSubmissionBuildTag(
    tagNames,
    'android',
    selection.androidVersionCode,
    selection.version,
  );
  for (const tag of [iosBuildTag, androidBuildTag]) {
    if (!runtime.isAncestor(runtime.tagCommit(tag), selection.releaseSha))
      throw new Error(`${tag} is not contained in the selected release commit.`);
  }
  return { ...selection, iosBuildTag, androidBuildTag };
}

export function anchoredPlatforms(tagNames: readonly string[], version: string): { ios: boolean; android: boolean } {
  const anchors = { ios: false, android: false };
  for (const name of tagNames) {
    const tag = parseReleaseTag(name);
    if (tag?.version === version) anchors[tag.platform] = true;
  }
  return anchors;
}

export function parseLsRemoteTagNames(output: string): string[] {
  return [
    ...new Set(
      output.split('\n').flatMap((line) => {
        const ref = line.trim().split(/\s+/)[1];
        return ref?.startsWith('refs/tags/') ? [ref.slice('refs/tags/'.length).replace(/\^\{\}$/, '')] : [];
      }),
    ),
  ].sort();
}

export function createRuntime(cwd: string): TargetRuntime {
  const git = (argumentsList: string[]) =>
    execFileSync('git', argumentsList, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git(['fetch', '--quiet', '--no-tags', 'origin', 'main:refs/remotes/origin/main']);
  return {
    appConfigAt: (sha) => git(['show', `${sha}:${APP_CONFIG_PATH}`]),
    tagNames: () =>
      parseLsRemoteTagNames(git(['ls-remote', '--tags', 'origin', 'refs/tags/build-*', 'refs/tags/release/*'])),
    tagCommit: (tag) => {
      git(['fetch', '--quiet', '--no-tags', 'origin', `refs/tags/${tag}`]);
      return git(['rev-parse', 'FETCH_HEAD^{commit}']);
    },
    isAncestor: (sha, descendant) => {
      try {
        git(['merge-base', '--is-ancestor', sha, descendant]);
        return true;
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'status' in error && error.status === 1) return false;
        throw error;
      }
    },
  };
}

function main(): void {
  if (process.argv.length !== 2) throw new Error('Use the exact release inputs; positional arguments are unsupported.');
  const { mode, reason } = resolveSubmitMode({
    eventName: process.env.GITHUB_EVENT_NAME ?? '',
    requestedAction: process.env.SUBMIT_ACTION ?? '',
    killSwitch: process.env.STORE_AUTO_SUBMIT ?? '',
  });
  const runtime = createRuntime(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  const target = resolveSubmitTarget(runtime, {
    releaseSha: process.env.RELEASE_SHA ?? '',
    version: process.env.REQUESTED_VERSION ?? '',
    iosBuildNumber: process.env.IOS_BUILD_NUMBER ?? '',
    androidVersionCode: process.env.ANDROID_VERSION_CODE ?? '',
  });
  const anchors = anchoredPlatforms(runtime.tagNames(), target.version);
  const outputs = {
    proceed: String(!(anchors.ios && anchors.android)),
    mode,
    release_sha: target.releaseSha,
    version: target.version,
    ios_build_number: target.iosBuildNumber,
    android_version_code: target.androidVersionCode,
    android_version_codes: target.androidVersionCode,
    ios_build_tag: target.iosBuildTag,
    android_build_tag: target.androidBuildTag,
    ios_build_sha: runtime.tagCommit(target.iosBuildTag),
    android_build_sha: runtime.tagCommit(target.androidBuildTag),
  };
  const output = Object.entries(outputs)
    .map(([key, entry]) => `${key}=${entry}`)
    .join('\n');
  console.log(output);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${output}\n`);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Manual store submission\n\n${reason}\n\nVersion ${target.version}, iOS ${target.iosBuildNumber}, Android ${target.androidVersionCode}, source \`${target.releaseSha}\`.\n`,
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`[mobile-store-submit-target] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
