/// <reference types="node" />

import { appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compareDevNativeInputs, latestPublishedDevApk, type NativeCommandRunner } from './lib/android-dev-native';
import { runCapture } from './lib/exec';

export interface DevBuildDecision {
  shouldBuild: boolean;
  reason: string;
  releaseUrl?: string;
}

export function decideDevBuild(repoRoot: string, runner: NativeCommandRunner = runCapture): DevBuildDecision {
  const baseline = latestPublishedDevApk(repoRoot, runner);
  if (!baseline) return { shouldBuild: true, reason: 'No successfully published dev-client APK exists' };
  const head = runner('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
  if (head.status !== 0) throw new Error(`Could not read HEAD: ${head.stderr.trim()}`);
  const comparison = compareDevNativeInputs(repoRoot, head.stdout.trim(), baseline.commit, process.env, runner);
  return {
    shouldBuild: !comparison.compatible,
    reason: comparison.compatible
      ? `Native inputs match ${baseline.tag}; reuse its APK and load current JS from Metro`
      : `Android dev fingerprint changed since ${baseline.tag}`,
    releaseUrl: baseline.url,
  };
}

export function main(): number {
  try {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const decision = decideDevBuild(repoRoot);
    console.log(`::notice::${decision.reason}`);
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `should_build=${decision.shouldBuild}\nreused_release_url=${decision.shouldBuild ? '' : (decision.releaseUrl ?? '')}\n`,
      );
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `### Android dev-client\n\n${decision.reason}.\n\n${decision.releaseUrl ? `[Published APK](${decision.releaseUrl})\n` : ''}`,
      );
    }
    return 0;
  } catch (error) {
    console.error(
      `::error::Android dev-client native gate failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
