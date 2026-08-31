/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { minimumPublishJobTimeoutMinutes, SELF_HOSTED_PUBLISH_JOB_OVERHEAD_MINUTES } from './lib/mobile-publish-retry';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_DIR = resolve(REPO_ROOT, '.github', 'workflows');
const production = readFileSync(resolve(WORKFLOW_DIR, 'mobile-ota-production.yml'), 'utf8');
const backport = readFileSync(resolve(WORKFLOW_DIR, 'mobile-ota-backport.yml'), 'utf8');
const preview = readFileSync(resolve(WORKFLOW_DIR, 'mobile-ota-preview.yml'), 'utf8');

function jobBlock(workflow: string, jobName: string): string {
  const jobsStart = workflow.indexOf('\njobs:\n');
  const start = workflow.indexOf(`\n  ${jobName}:\n`, jobsStart);
  const remainingWorkflow = workflow.slice(start + 1);
  const nextJobOffset = remainingWorkflow.search(/\n  [a-zA-Z0-9_-]+:\n/);
  expect(jobsStart).toBeGreaterThanOrEqual(0);
  expect(start).toBeGreaterThan(jobsStart);
  return nextJobOffset >= 0 ? workflow.slice(start, start + 1 + nextJobOffset) : workflow.slice(start);
}

function stepBlock(workflow: string, stepName: string): string {
  const start = workflow.indexOf(`      - name: ${stepName}`);
  const nextStepOffset = workflow.slice(start + 1).indexOf('\n      - name: ');
  const end = nextStepOffset >= 0 ? start + 1 + nextStepOffset : workflow.length;
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return workflow.slice(start, end);
}

describe('production OTA workflow reliability', () => {
  it('serializes runs without cancelling an active publish and has enough retry time', () => {
    expect(production).toContain('group: mobile-ota-production');
    expect(production).toContain('cancel-in-progress: false');
    const timeout = Number(jobBlock(production, 'publish').match(/timeout-minutes: (\d+)/)?.[1]);
    // iOS then Android in one job, so the job must outlast two full backoff
    // budgets. Killed mid-backoff, the run dies by timeout and never reports
    // `s3-slowdown` or fires the failure notification.
    expect(timeout).toBeGreaterThanOrEqual(minimumPublishJobTimeoutMinutes(2));
  });

  it('keeps the job-overhead allowance above the steps it is meant to cover', () => {
    // SELF_HOSTED_PUBLISH_JOB_OVERHEAD_MINUTES is an estimate, and the source-map
    // uploads are the bulk of it. They carry their own `timeout-minutes`, so
    // raising those silently erodes the headroom every publish job's timeout is
    // derived from. Re-read them here instead of trusting the constant's comment.
    // Select by indentation rather than by position: a job-level key sits at 4
    // spaces and a step-level one at 8, so this stays correct no matter what
    // order the keys appear in.
    const publishJob = jobBlock(production, 'publish');
    const stepTimeouts = [...publishJob.matchAll(/^ {8}timeout-minutes: (\d+)$/gm)].map(([, minutes]) =>
      Number(minutes),
    );
    const stepTimeoutTotal = stepTimeouts.reduce((total, minutes) => total + minutes, 0);

    // Guard the selector itself: the job-level timeout must not be in this set,
    // otherwise the comparison below would be measuring the wrong thing.
    const jobTimeout = Number(publishJob.match(/^ {4}timeout-minutes: (\d+)$/m)?.[1]);
    expect(jobTimeout).toBeGreaterThan(0);
    expect(stepTimeouts).not.toContain(jobTimeout);

    expect(stepTimeouts.length).toBeGreaterThanOrEqual(2);
    expect(SELF_HOSTED_PUBLISH_JOB_OVERHEAD_MINUTES).toBeGreaterThan(stepTimeoutTotal);
  });

  it('attempts Android after iOS and records the aggregate result', () => {
    const ios = stepBlock(production, 'Publish iOS OTA');
    const android = stepBlock(production, 'Publish Android OTA');
    const summary = stepBlock(production, 'Summarize platform publish results');

    expect(ios).toContain("steps.generate.outcome == 'success'");
    expect(ios).toContain('continue-on-error: true');
    expect(android).toContain('if: always()');
    expect(android).toContain("steps.generate.outcome == 'success'");
    expect(android).toContain('continue-on-error: true');
    expect(summary).toContain('all_success');
    expect(summary).toContain('any_success');
    expect(summary).toContain('no automatic rollback was attempted');
    const allSuccessOutputIndex = summary.indexOf('echo "all_success=$all_success" >> "$GITHUB_OUTPUT"');
    const anySuccessOutputIndex = summary.indexOf('echo "any_success=$any_success" >> "$GITHUB_OUTPUT"');
    const failureGuardIndex = summary.indexOf('if [ "$all_success" != true ]; then');
    const failureExitIndex = summary.indexOf('exit 1', failureGuardIndex);
    const failureGuardEndIndex = summary.indexOf('\n          fi', failureGuardIndex);
    expect(allSuccessOutputIndex).toBeGreaterThanOrEqual(0);
    expect(anySuccessOutputIndex).toBeGreaterThanOrEqual(0);
    expect(failureGuardIndex).toBeGreaterThanOrEqual(0);
    expect(failureExitIndex).toBeGreaterThan(failureGuardIndex);
    expect(failureGuardEndIndex).toBeGreaterThan(failureExitIndex);
    expect(failureGuardIndex).toBeGreaterThan(allSuccessOutputIndex);
    expect(failureGuardIndex).toBeGreaterThan(anySuccessOutputIndex);
    expect(failureExitIndex).toBeGreaterThan(allSuccessOutputIndex);
    expect(failureExitIndex).toBeGreaterThan(anySuccessOutputIndex);
  });

  it('pushes the changelog and announces success only after every requested platform succeeds', () => {
    const push = stepBlock(production, 'Push changelog to main');
    const success = stepBlock(production, 'Notify deployments channel');

    expect(push).toContain("steps.publish_summary.outputs.all_success == 'true'");
    expect(push).not.toContain('if: always()');
    expect(success).toContain("steps.publish_summary.outputs.all_success == 'true'");
    expect(success).not.toContain("steps.publish_ios.outcome == 'success' ||");
  });

  it('runs the health check after any successful platform, including partial success', () => {
    const health = stepBlock(production, 'OTA health check (non-blocking)');

    expect(health).toContain('if: always()');
    expect(health).toContain("steps.publish_ios.outcome == 'success' || steps.publish_android.outcome == 'success'");
  });

  it('reruns when the self-hosted publish implementation changes', () => {
    for (const implementationPath of [
      'scripts/mobile-publish.ts',
      'scripts/lib/mobile-publish-retry.ts',
      'scripts/lib/eoas.ts',
    ]) {
      expect(production).toContain(`- '${implementationPath}'`);
      // Preview intentionally has no trigger paths filter: every synchronize
      // must run so removing the final mobile change tears down the old branch.
      expect(preview).toContain(`path === '${implementationPath}'`);
    }
  });

  it('gives the preview publish job enough time for bounded platform retries', () => {
    const timeout = Number(jobBlock(preview, 'publish').match(/timeout-minutes: (\d+)/)?.[1]);
    // Same shape as production: one job publishes both platforms sequentially.
    expect(timeout).toBeGreaterThanOrEqual(minimumPublishJobTimeoutMinutes(2));
  });
});

describe('backport OTA workflow upload pressure', () => {
  it('stays manual-only while publishing through the shared wrapper', () => {
    expect(backport).toContain('on:\n  workflow_dispatch:');
    expect(backport).not.toContain('on:\n  push:');
    expect(backport).toContain('vp run mobile:publish -- --channel production');
  });

  it('shares the production lane and limits the platform matrix to one publish', () => {
    expect(backport).toContain('group: mobile-ota-production');
    expect(backport).toContain('cancel-in-progress: false');
    expect(backport).toContain('max-parallel: 1');
    const timeout = Number(jobBlock(backport, 'backport').match(/timeout-minutes: (\d+)/)?.[1]);
    // `max-parallel: 1` over a platform matrix, so each job publishes one
    // platform and needs one backoff budget rather than two.
    expect(timeout).toBeGreaterThanOrEqual(minimumPublishJobTimeoutMinutes(1));
  });

  it('checks out the release anchor before the package-manager-neutral install', () => {
    const anchorPosition = backport.indexOf('- name: Locate the release anchor and prepare the hotfix tree');
    const installPosition = backport.indexOf('- name: Install Node.js dependencies (workspace root)');
    const install = stepBlock(backport, 'Install Node.js dependencies (workspace root)');

    expect(anchorPosition).toBeGreaterThanOrEqual(0);
    expect(installPosition).toBeGreaterThan(anchorPosition);
    expect(install).toContain('run: vp install --frozen-lockfile');
    expect(install).not.toContain('pnpm install');
    expect(backport).toContain('a frozen pre-pnpm anchor still installs with its');
    expect(backport).toContain('pinned Bun version');
  });

  it('overlays every trusted helper required by production publish and source-map upload', () => {
    const snapshot = stepBlock(backport, 'Snapshot trusted OTA publish tooling');
    const overlay = stepBlock(backport, 'Overlay trusted OTA publish tooling');
    const gitAddLine = overlay.split('\n').find((line) => line.trimStart().startsWith('git add '));

    for (const implementationPath of [
      'scripts/mobile-publish.ts',
      'scripts/lib/eoas.ts',
      'scripts/lib/mobile-publish-retry.ts',
      'scripts/mobile-upload-sourcemaps.ts',
    ]) {
      expect(snapshot).toContain(implementationPath);
      expect(overlay).toContain(implementationPath);
      expect(gitAddLine).toContain(implementationPath);
    }
  });
});
