/// <reference types="node" />

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { minimumPublishJobTimeoutMinutes, SELF_HOSTED_PUBLISH_JOB_OVERHEAD_MINUTES } from './lib/mobile-publish-retry';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_DIR = resolve(REPO_ROOT, '.github', 'workflows');
const production = readFileSync(resolve(WORKFLOW_DIR, 'mobile-ota-production.yml'), 'utf8');
const productionDeploy = readFileSync(resolve(WORKFLOW_DIR, 'production-deploy.yml'), 'utf8');
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

function runOtaResultStep(overrides: Record<string, string>): Record<string, string> {
  const resultStep = stepBlock(production, 'Record OTA result');
  const runBlock = resultStep.match(/        run: \|\n([\s\S]*)/)?.[1];
  expect(runBlock).toBeDefined();
  const shellScript = (runBlock ?? '')
    .split('\n')
    .map((line) => line.replace(/^ {10}/, ''))
    .join('\n');
  const runnerTemp = mkdtempSync(resolve(tmpdir(), 'boardsesh-ota-result-'));
  const outputPath = resolve(runnerTemp, 'github-output');
  const result = spawnSync('bash', ['-c', shellScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_OUTPUT: outputPath,
      RUNNER_TEMP: runnerTemp,
      GATE_CONFIGURED: 'true',
      ALL_SUCCESS: 'true',
      ANY_SUCCESS: 'true',
      IOS_OUTCOME: 'success',
      ANDROID_OUTCOME: 'success',
      HEALTH_OUTCOME: 'skipped',
      CHANGELOG_CHANGED: 'false',
      CHANGELOG_PUSH_OUTCOME: 'skipped',
      ...overrides,
    },
  });
  expect(result.status, result.stderr).toBe(0);
  const outputs = Object.fromEntries(
    readFileSync(outputPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const separatorIndex = line.indexOf('=');
        return [line.slice(0, separatorIndex), line.slice(separatorIndex + 1)];
      }),
  );
  rmSync(runnerTemp, { recursive: true, force: true });
  return outputs;
}

describe('production OTA workflow reliability', () => {
  it('is reusable-only and inherits the unified production deployment lane', () => {
    expect(production).toContain('on:\n  workflow_call:');
    expect(production).not.toContain('\n  push:');
    expect(production).not.toContain('\n  workflow_dispatch:');
    expect(production).not.toContain('\nconcurrency:');
    expect(productionDeploy).toContain('group: production-deploy');
    expect(productionDeploy).toContain('queue: max');
    expect(productionDeploy).toContain('cancel-in-progress: false');
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

  it('checks out and bounds the changelog at the exact deployed commit', () => {
    expect(production).toContain('commit_sha:');
    expect(production).toContain('changelog_base_sha:');
    expect(production).toContain('changelog_snapshot_sha:');
    expect(production).toContain('ref: ${{ inputs.commit_sha }}');
    expect(production).toContain('CHANGELOG_THROUGH_SHA: ${{ inputs.commit_sha }}');
    expect(production).toContain('INPUT_CHANGELOG_BASE_SHA: ${{ inputs.changelog_base_sha }}');
    expect(production).toContain('INPUT_CHANGELOG_SNAPSHOT_SHA: ${{ inputs.changelog_snapshot_sha }}');
    expect(productionDeploy).toContain(
      'changelog_snapshot_sha: ${{ needs.detect-changes.outputs.changelog_snapshot_sha }}',
    );
    expect(production).not.toContain('github.event.before');
    expect(production).toContain('contents: read\n  pull-requests: read');
  });

  it('keeps release provenance separate from the queued-run changelog snapshot', () => {
    const verify = stepBlock(production, 'Verify requested release range');
    const generate = stepBlock(production, 'Generate changelog and commit');

    expect(verify).toContain('production-deploy-baseline.mjs changelog-snapshot');
    expect(verify).toContain('CURRENT_MAIN_SHA="$SNAPSHOT_SHA"');
    expect(generate).toContain(
      'git show "$INPUT_CHANGELOG_SNAPSHOT_SHA:packages/mobile/src/data/changelog.generated.json"',
    );
    expect(generate).toContain('CHANGELOG_THROUGH_SHA: ${{ inputs.commit_sha }}');
    expect(generate).not.toContain(
      'git show "$INPUT_CHANGELOG_BASE_SHA:packages/mobile/src/data/changelog.generated.json"',
    );
  });

  it('keeps Production environment secrets in the called job and forwards only caller-visible credentials', () => {
    const publish = jobBlock(production, 'publish');
    const caller = jobBlock(productionDeploy, 'publish-mobile-ota');

    expect(publish).toContain('environment: Production');
    expect(publish).toContain('EOO_TOKEN: ${{ secrets.EOO_TOKEN }}');
    expect(publish).toContain('GOOGLE_MAPS_API_KEY: ${{ secrets.GOOGLE_MAPS_API_KEY }}');
    expect(publish).toContain('POSTHOG_PERSONAL_API_KEY: ${{ secrets.POSTHOG_PERSONAL_API_KEY }}');
    expect(publish).not.toContain('vars.POSTHOG_PERSONAL_API_KEY');
    expect(caller).toContain('EOO_TOKEN: ${{ secrets.EOO_TOKEN }}');
    expect(caller).toContain('OTA_PUSH_APP_PRIVATE_KEY: ${{ secrets.OTA_PUSH_APP_PRIVATE_KEY }}');
    expect(caller).not.toContain('secrets: inherit');
    expect(caller).not.toContain('GOOGLE_MAPS_API_KEY:');
    expect(caller).not.toContain('POSTHOG_PERSONAL_API_KEY:');
    expect(caller).toContain('pull-requests: read');
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

  it('always identifies the exact deployed commit in the default OTA message', () => {
    for (const stepName of ['Publish iOS OTA', 'Publish Android OTA']) {
      const publishStep = stepBlock(production, stepName);
      expect(publishStep).toContain('publish_message=$(git log -1 --pretty=\'%h %s\' "$INPUT_COMMIT_SHA")');
      expect(publishStep).toContain('--message "$publish_message"');
    }
  });

  it('resolves the deployed hash and subject after HEAD moves to a generated commit', () => {
    const repositoryDirectory = mkdtempSync(resolve(tmpdir(), 'boardsesh-ota-message-'));
    const runGit = (...arguments_: string[]) => {
      const result = spawnSync('git', arguments_, {
        cwd: repositoryDirectory,
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };

    try {
      runGit('init', '--quiet');
      runGit('config', 'user.name', 'Test Bot');
      runGit('config', 'user.email', 'test@example.com');
      writeFileSync(resolve(repositoryDirectory, 'release.txt'), 'deployed\n');
      runGit('add', 'release.txt');
      runGit('commit', '--quiet', '-m', 'fix: deployed behavior');
      const deployedSha = runGit('rev-parse', 'HEAD');

      writeFileSync(resolve(repositoryDirectory, 'CHANGELOG.md'), 'generated\n');
      runGit('add', 'CHANGELOG.md');
      runGit('commit', '--quiet', '-m', 'chore(changelog): refresh from merged PRs [skip ci]');

      const publishStep = stepBlock(production, 'Publish iOS OTA');
      const fallbackBlock = publishStep.match(
        /          publish_message=\$INPUT_MESSAGE\n          if \[ -z "\$publish_message" \]; then\n          +publish_message=.*\n          fi/,
      )?.[0];
      expect(fallbackBlock).toBeDefined();
      const shellScript = `${(fallbackBlock ?? '').replace(/^ {10}/gm, '')}\nprintf '%s' "$publish_message"`;
      const result = spawnSync('bash', ['-c', shellScript], {
        cwd: repositoryDirectory,
        encoding: 'utf8',
        env: { ...process.env, INPUT_COMMIT_SHA: deployedSha, INPUT_MESSAGE: '' },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(runGit('log', '-1', '--pretty=%h %s', deployedSha));
      expect(result.stdout).not.toContain('refresh from merged PRs');
    } finally {
      rmSync(repositoryDirectory, { recursive: true, force: true });
    }
  });

  it('pushes the changelog and permits the parent success notice only after the release gate passes', () => {
    const mint = stepBlock(production, 'Mint push token');
    const push = stepBlock(production, 'Push changelog to main');
    const success = jobBlock(productionDeploy, 'notify-success');

    expect(mint).toContain("github.ref == 'refs/heads/main'");
    expect(push).toContain('id: push_changelog');
    expect(push).toContain("github.ref == 'refs/heads/main'");
    expect(push).toContain("steps.publish_summary.outputs.all_success == 'true'");
    expect(push).not.toContain('if: always()');
    expect(production).toContain('value: ${{ jobs.publish.outputs.changelog_synced }}');
    expect(production).toContain('changelog_synced: ${{ steps.result.outputs.changelog_synced }}');
    expect(success).toContain("needs.release-gate.result == 'success'");
    expect(success).toContain("needs.release-gate.outputs.state == 'promoted'");
    expect(success).toContain("needs.release-gate.outputs.state == 'release-held'");
    expect(success).toContain('OTA_IOS_OUTCOME');
    expect(success).toContain('OTA_ANDROID_OUTCOME');
  });

  it.each([
    ['unchanged generation with a skipped push', 'false', 'skipped', 'true'],
    ['changed generation with a successful push', 'true', 'success', 'true'],
    ['changed generation with a skipped push', 'true', 'skipped', 'false'],
    ['changed generation with a failed push', 'true', 'failure', 'false'],
  ])('reports changelog synchronization for %s', (_description, changed, pushOutcome, expectedSynced) => {
    expect(
      runOtaResultStep({
        CHANGELOG_CHANGED: changed,
        CHANGELOG_PUSH_OUTCOME: pushOutcome,
      }).changelog_synced,
    ).toBe(expectedSynced);
  });

  it('runs the health check after any successful platform, including partial success', () => {
    const health = stepBlock(production, 'OTA health check (non-blocking)');

    expect(health).toContain('if: always()');
    expect(health).toContain("steps.publish_ios.outcome == 'success' || steps.publish_android.outcome == 'success'");
  });

  it('returns publish and health outcomes instead of posting duplicate deploy notifications', () => {
    expect(production).toContain('health_status:');
    expect(production).toContain('changelog_synced:');
    expect(production).toContain('changelog_summary_base64:');
    expect(production).toContain('name: Record OTA result');
    expect(production).not.toContain('name: Notify deployments channel');
    expect(production).not.toContain('name: Notify deployments channel of failure');
    expect(production).not.toContain('name: Notify OTA health to Discord');
  });

  it('reruns when the self-hosted publish implementation changes', () => {
    for (const implementationPath of [
      'scripts/mobile-publish.ts',
      'scripts/lib/mobile-publish-retry.ts',
      'scripts/lib/eoas.ts',
    ]) {
      expect(productionDeploy).toContain(implementationPath);
      expect(preview).toContain(`- '${implementationPath}'`);
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
    expect(backport).toContain('group: production-deploy');
    expect(backport).toContain('queue: max');
    expect(backport).toContain('cancel-in-progress: false');
    expect(backport).toContain('max-parallel: 1');
    const timeout = Number(jobBlock(backport, 'backport').match(/timeout-minutes: (\d+)/)?.[1]);
    // `max-parallel: 1` over a platform matrix, so each job publishes one
    // platform and needs one backoff budget rather than two.
    expect(timeout).toBeGreaterThanOrEqual(minimumPublishJobTimeoutMinutes(1));
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
