/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

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

  // eoas records an update's message AND its commitHash from HEAD. Committing the
  // regenerated changelog before publishing made HEAD a throwaway
  // `chore(changelog)` commit, so every row on the OTA server was stamped with a
  // sha that the push step never even pushed (it resets to origin/main and commits
  // afresh) — leaving the dashboard's Message and Commit columns useless. The
  // publish must run with HEAD still on the triggering commit.
  it('publishes with HEAD on the triggering commit, committing the changelog only afterwards', () => {
    const generateIndex = production.indexOf('      - name: Generate changelog\n');
    const publishIndex = production.indexOf('      - name: Publish iOS OTA\n');
    expect(generateIndex).toBeGreaterThanOrEqual(0);
    expect(publishIndex).toBeGreaterThan(generateIndex);

    const beforePublish = production.slice(generateIndex, publishIndex);
    expect(
      beforePublish,
      'nothing may commit before the publish — it would move HEAD off the triggering commit',
    ).not.toMatch(/^\s*git commit\b/m);
    // Guard the guard: the changelog must still reach main, just later. Without
    // this, deleting the commit everywhere would satisfy the assertion above.
    expect(stepBlock(production, 'Push changelog to main')).toMatch(/^\s*git commit -m/m);
  });

  // Disabling eoas' clean-tree check removes an accidental integrity guard: a
  // stray dirtied file would otherwise be bundled into a production OTA unnoticed.
  // This step is the replacement, so it must run before the first publish.
  it('asserts the working tree carries only the regenerated changelog before publishing', () => {
    const assertion = stepBlock(production, 'Assert only the changelog is uncommitted');

    expect(assertion).toContain('git status --porcelain --untracked-files=all');
    expect(assertion).toContain('CHANGELOG.md packages/mobile/src/data/changelog.generated.json');
    expect(assertion).toContain('exit 1');
    expect(production.indexOf('      - name: Assert only the changelog is uncommitted\n')).toBeLessThan(
      production.indexOf('      - name: Publish iOS OTA\n'),
    );
  });

  // A native build dispatches a republish under the fingerprint it just shipped.
  // If main has moved to a NEW native change by the time that run gets a runner,
  // publishing would resolve the new fingerprint and ship JS assuming native code
  // the uploaded binary lacks — so the run must re-resolve and skip.
  it('re-resolves the fingerprint for a dispatched republish and lets it gate the publish', () => {
    const inputs = (parse(production) as { on: { workflow_dispatch: { inputs: Record<string, unknown> } } }).on
      .workflow_dispatch.inputs;
    expect(Object.keys(inputs)).toContain('expect_fingerprint');

    const verify = stepBlock(production, 'Verify the fingerprint still matches the build that asked for this');
    expect(verify).toContain('runtimeversion:resolve --platform "$PLATFORM"');
    expect(verify).toContain('scripts/mobile-fingerprint-match.ts');
    // A mismatch is a SKIP, not a failure: the binary is simply unreachable now
    // and a new native build is already on the way.
    expect(verify).toContain('::warning::');

    // The assertion that stops this being decorative. A resolve step whose output
    // nothing consumes would leave the guard inert while every check above passed.
    for (const stepName of ['Publish iOS OTA', 'Publish Android OTA']) {
      expect(stepBlock(production, stepName), `${stepName} must honour the fingerprint verdict`).toContain(
        "steps.expect.outputs.mismatch != 'true'",
      );
    }
  });

  // The postcondition, checked against the server rather than inferred from a
  // green publish step — the 2026-09-01 stranding had a green publish too.
  it('verifies a republished update is actually served, and is newer than the build', () => {
    const verify = stepBlock(production, 'Verify the republished update is the one the fleet will see');

    expect(verify).toContain('expo-runtime-version: $EXPECT_FINGERPRINT');
    expect(verify).toContain('createdAt');
    expect(verify).toContain('STARTED_AT');
    expect(verify).toContain('exit 1');
    expect(verify).toContain("steps.publish_summary.outputs.all_success == 'true'");
  });

  // cancel-in-progress: false protects only the RUNNING run; GitHub still cancels
  // a PENDING one when a new run queues. The republishes are dispatched per
  // platform and do not cover for each other, so a superseded pending run leaves
  // that platform's fleet stranded.
  it('queues runs in the shared production lane instead of superseding pending ones', () => {
    for (const [name, source] of [
      ['mobile-ota-production.yml', production],
      ['mobile-ota-backport.yml', backport],
    ] as const) {
      // Read the PARSED concurrency block, not the workflow text: both files
      // explain `queue: max` in a comment right above the setting, so a
      // `toContain('queue: max')` stays green when the setting itself is deleted.
      const { concurrency } = parse(source) as {
        concurrency: { group?: string; queue?: string; 'cancel-in-progress'?: boolean };
      };
      expect(concurrency.group, `${name} must share the production lane`).toBe('mobile-ota-production');
      expect(concurrency.queue, `${name} shares the lane, so it must queue too`).toBe('max');
      expect(concurrency['cancel-in-progress']).toBe(false);
    }
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

  it('keeps the branch-teardown admin creds unreachable from the preview publish', () => {
    // An `environment:` exposes that environment's WHOLE secret set to every step of
    // the job, and `publish` checks out PR head and runs PR-author code. The retired
    // `ota-preview` environment carried OTA_ADMIN_*, which can delete ANY branch,
    // `production` included — and a same-repo pull_request runs the PR's own copy of
    // the workflow, so reaching them was one diff away.
    const publishJob = jobBlock(preview, 'publish');
    expect(publishJob, 'publish must declare no environment').not.toMatch(/^ {4}environment:/m);
    expect(publishJob, 'the admin creds must be unreachable from PR-author code').not.toContain('OTA_ADMIN_');
  });

  it('fails the preview publish loudly when the Android maps key is missing', () => {
    // GOOGLE_MAPS_API_KEY is repo-level and perturbs the resolved android.config. An
    // empty value still exits 0 from eoas and publishes under a runtimeVersion no
    // shipped binary has — a green, invisible preview. Assert on the presence FLAG, not
    // the secret: a second `GOOGLE_MAPS_API_KEY:` literal would break the parity test's
    // "Android step only" count.
    const publishJob = jobBlock(preview, 'publish');
    expect(publishJob).toContain("HAS_MAPS_KEY: ${{ secrets.GOOGLE_MAPS_API_KEY != '' }}");
    expect(publishJob).toMatch(/if \[ "\$HAS_MAPS_KEY" != 'true' \]; then/);

    // ...and it must run BEFORE the PR tree is checked out. A misconfigured repo secret
    // is a config error, not a per-PR condition: failing after ~10 minutes of installs
    // teaches nobody anything, and the point of the guard is to stop short of running
    // PR-author code at all. A step reorder would silently defeat that.
    const guardAt = publishJob.indexOf('- name: Assert the Android maps key is present');
    const checkoutAt = publishJob.indexOf('uses: actions/checkout');
    expect(guardAt, 'the maps-key guard step must exist').toBeGreaterThan(-1);
    expect(checkoutAt, 'the publish job must check out the PR tree').toBeGreaterThan(-1);
    expect(guardAt, 'the maps-key guard must precede the PR-head checkout').toBeLessThan(checkoutAt);
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
