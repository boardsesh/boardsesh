/// <reference types="node" />

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_PATH = resolve(REPO_ROOT, '.github', 'workflows', 'production-deploy.yml');
const workflow = readFileSync(WORKFLOW_PATH, 'utf8');

function jobBlock(jobName: string): string {
  const jobsStart = workflow.indexOf('\njobs:\n');
  const start = workflow.indexOf(`\n  ${jobName}:\n`, jobsStart);
  const remainingWorkflow = workflow.slice(start + 1);
  const nextJobOffset = remainingWorkflow.search(/\n  [a-zA-Z0-9_-]+:\n/);
  expect(jobsStart).toBeGreaterThanOrEqual(0);
  expect(start).toBeGreaterThan(jobsStart);
  return nextJobOffset >= 0 ? workflow.slice(start, start + 1 + nextJobOffset) : workflow.slice(start);
}

function runReleaseGate(overrides: Record<string, string>): { status: number; state: string | undefined } {
  const gate = jobBlock('release-gate');
  const runBlock = gate.match(/        run: \|\n([\s\S]*)/)?.[1];
  expect(runBlock).toBeDefined();
  const shellScript = (runBlock ?? '')
    .split('\n')
    .map((line) => line.replace(/^ {10}/, ''))
    .join('\n');
  const outputDirectory = mkdtempSync(resolve(tmpdir(), 'boardsesh-release-gate-'));
  const outputPath = resolve(outputDirectory, 'github-output');
  const result = spawnSync('bash', ['-c', shellScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_OUTPUT: outputPath,
      DETECT_RESULT: 'success',
      SUPERSEDED: 'false',
      ROLLBACK_CHECK_RESULT: 'success',
      ROLLBACK_ACTIVE: 'false',
      WEB_CHANGED: 'false',
      BACKEND_CHANGED: 'false',
      APP_CHANGED: 'false',
      OTA_CHANGED: 'false',
      MIGRATION_REQUIRED: 'false',
      APP_WEB_HELD: 'false',
      BUILD_WEB_RESULT: 'skipped',
      BUILD_BACKEND_RESULT: 'skipped',
      MIGRATE_RESULT: 'skipped',
      DEPLOY_WEB_RESULT: 'skipped',
      DEPLOY_BACKEND_RESULT: 'skipped',
      DEPLOY_APP_WEB_RESULT: 'skipped',
      OTA_RESULT: 'skipped',
      OTA_CONFIGURED: 'false',
      OTA_ALL_SUCCESS: 'false',
      OTA_ANY_SUCCESS: 'false',
      OTA_PLATFORM: 'all',
      ...overrides,
    },
  });
  const output = readFileSync(outputPath, 'utf8');
  rmSync(outputDirectory, { recursive: true, force: true });
  return {
    status: result.status ?? 1,
    state: output
      .split('\n')
      .find((line) => line.startsWith('state='))
      ?.slice('state='.length),
  };
}

describe('unified production deploy workflow', () => {
  it('uses one non-cancelling deployment lane for push and manual releases', () => {
    expect(workflow).toContain('push:\n    branches: [main]');
    expect(workflow).toContain('workflow_dispatch:\n    inputs:');
    expect(workflow).toContain('message:');
    expect(workflow).toContain('platform:');
    expect(workflow).toContain('changelog_base_sha:');
    expect(workflow).toContain('group: production-deploy');
    expect(workflow).toContain('queue: max');
    expect(workflow).toContain('cancel-in-progress: false');
  });

  it('forces recovery when the previous production run failed or was rollback-held', () => {
    const detect = jobBlock('detect-changes');

    expect(detect).toContain('actions: read');
    expect(detect).toContain('node scripts/production-deploy-baseline.mjs');
    expect(detect).toContain('FORCE_COMPONENTS=true');
    expect(detect).toContain('COMPONENT_BASE_SHA=$(jq');
  });

  it('keeps component detection separate from the immediate changelog snapshot base', () => {
    const detect = jobBlock('detect-changes');

    expect(detect).toContain('changelog_base_sha=$CHANGELOG_BASE_SHA');
    expect(detect).toContain('changelog_snapshot_sha=$CHANGELOG_SNAPSHOT_SHA');
    expect(detect).toContain('component_base_sha=$COMPONENT_BASE_SHA');
    expect(detect).toContain('git diff --name-only "$COMPONENT_BASE_SHA" "$DEPLOY_SHA"');
    expect(detect).not.toContain('git diff --name-only "$CHANGELOG_BASE_SHA" "$DEPLOY_SHA"');
    expect(detect).toContain('packages/mobile/src/data/changelog.generated.json)');
  });

  it('skips a stale queued SHA before any production check, build, or deploy', () => {
    const detect = jobBlock('detect-changes');
    const rollback = jobBlock('check-rollback');

    expect(detect).toContain('git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main');
    expect(detect).toContain('SUPERSEDED=$(jq');
    expect(detect).toContain('superseded=true');
    expect(rollback).toContain("needs.detect-changes.outputs.superseded != 'true'");
  });

  it('preserves operator-selected manual releases as forced exact-SHA deployments', () => {
    const detect = jobBlock('detect-changes');

    expect(detect).toContain('TARGET_SHA: ${{ github.sha }}');
    expect(detect).toContain('if [ "$EVENT_NAME" != workflow_dispatch ]; then');
    expect(detect).toContain('if [ "$EVENT_NAME" = workflow_dispatch ] || [ "$FORCE_COMPONENTS" = true ]; then');
    expect(detect).toContain('Full release: web + backend + app + OTA at $DEPLOY_SHA');
  });

  it('detects OTA changes while letting mobile-only commits skip backend and Next builds', () => {
    const detect = jobBlock('detect-changes');

    expect(detect).toContain('ota_changed: ${{ steps.changes.outputs.ota }}');
    expect(detect).toContain('deploy_sha: ${{ steps.changes.outputs.deploy_sha }}');
    expect(detect).toContain('changelog_base_sha: ${{ steps.changes.outputs.changelog_base_sha }}');
    expect(detect).toContain('packages/mobile/*)');
    expect(detect).toContain('scripts/mobile-publish.ts');
    expect(detect).toContain('scripts/lib/mobile-publish-retry.ts');
    expect(detect).toContain('.github/workflows/mobile-ota-production.yml');
    expect(detect.indexOf('packages/mobile/*)')).toBeLessThan(detect.indexOf('packages/*|Dockerfile.backend'));
  });

  it('keeps web and backend builds parallel, then migrates after every attempted build', () => {
    const buildWeb = jobBlock('build-web');
    const buildBackend = jobBlock('build-backend');
    const migrate = jobBlock('migrate');

    expect(buildWeb).toContain('needs: [detect-changes, check-rollback]');
    expect(buildBackend).toContain('needs: [detect-changes, check-rollback]');
    expect(buildWeb).not.toContain('build-backend');
    expect(buildBackend).not.toContain('build-web');
    expect(migrate).toContain('needs: [detect-changes, build-web, build-backend]');
    expect(migrate).toContain("needs.build-web.result == 'success' || needs.build-web.result == 'skipped'");
    expect(migrate).toContain("needs.build-backend.result == 'success' || needs.build-backend.result == 'skipped'");
  });

  it('verifies Railway before Vercel and app-web, then gates the exact-SHA OTA', () => {
    const buildBackend = jobBlock('build-backend');
    const backend = jobBlock('deploy-production-backend');
    const web = jobBlock('deploy-web');
    const appWeb = jobBlock('deploy-app-web');
    const ota = jobBlock('publish-mobile-ota');

    expect(buildBackend).toContain(
      "type=raw,value=production,enable=${{ github.event_name == 'workflow_dispatch' || github.ref == 'refs/heads/main' }}",
    );
    expect(backend).toContain('scripts/railway-deployment-status.mjs capture-previous');
    expect(backend).toContain('scripts/railway-deployment-status.mjs find-new');
    expect(backend).toContain('deploymentRollback');
    expect(web).toContain('deploy-production-backend');
    expect(appWeb).toContain('deploy-production-backend');
    expect(appWeb).toContain('check-rollback');
    expect(appWeb).toContain("needs.check-rollback.outputs.active != 'true'");
    expect(ota).toContain('uses: ./.github/workflows/mobile-ota-production.yml');
    expect(ota).toContain("needs.detect-changes.outputs.ota_changed == 'true'");
    expect(ota).toContain("needs.check-rollback.outputs.active != 'true'");
    expect(ota).toContain('commit_sha: ${{ needs.detect-changes.outputs.deploy_sha }}');
    expect(ota).toContain('changelog_base_sha: ${{ needs.detect-changes.outputs.changelog_base_sha }}');
    expect(ota).toContain('changelog_snapshot_sha: ${{ needs.detect-changes.outputs.changelog_snapshot_sha }}');
    expect(ota).toContain('pull-requests: read');
    expect(ota).toContain("vars.APP_WEB_DEPLOY_HOLD != ''");
  });

  it('encodes changed-versus-skipped outcomes in one final release gate', () => {
    const gate = jobBlock('release-gate');

    for (const changeFlag of ['WEB_CHANGED', 'BACKEND_CHANGED', 'APP_CHANGED', 'OTA_CHANGED']) {
      expect(gate).toContain(changeFlag);
    }
    for (const result of [
      'BUILD_WEB_RESULT',
      'BUILD_BACKEND_RESULT',
      'MIGRATE_RESULT',
      'DEPLOY_WEB_RESULT',
      'DEPLOY_BACKEND_RESULT',
      'DEPLOY_APP_WEB_RESULT',
      'OTA_RESULT',
    ]) {
      expect(gate).toContain(result);
    }
    expect(gate).toContain('rollback-active');
    expect(gate).toContain('superseded');
    expect(gate).toContain('release-held');
    expect(gate).toContain('app-web-held');
    expect(gate).toContain('app-web-held-only');
    expect(gate).toContain('unchanged component unexpectedly ran');
  });

  it('selects exactly one terminal notification and marks only globally reflected states', () => {
    const held = jobBlock('notify-app-web-held');
    const rollback = jobBlock('notify-no-promote');
    const success = jobBlock('notify-success');
    const failure = jobBlock('notify-failure');
    const marker = jobBlock('mark-production-promoted');

    expect(held).toContain("needs.release-gate.outputs.state == 'app-web-held-only'");
    expect(success).toContain("needs.release-gate.outputs.state == 'promoted'");
    expect(success).toContain("needs.release-gate.outputs.state == 'release-held'");
    expect(success).toContain("needs.mark-production-promoted.result == 'success'");
    expect(success).toContain('APP_WEB_HELD');
    expect(success).toContain('OTA_RESULT');
    expect(marker).toContain("needs.release-gate.outputs.state == 'promoted'");
    expect(marker).toContain("needs.release-gate.outputs.state == 'noop'");
    expect(marker).not.toContain('release-held');
    expect(marker).not.toContain('rollback-active');
    expect(marker).not.toContain('superseded');

    expect(rollback).toContain("needs.release-gate.outputs.state == 'rollback-active'");
    expect(failure).toContain("needs.release-gate.result == 'failure'");
    expect(failure).toContain("needs.mark-production-promoted.result == 'failure'");
    expect(failure).toContain("contains(needs.*.result, 'cancelled')");
    expect(held).toContain("needs.release-gate.result == 'success'");
    expect(success).toContain("needs.release-gate.result == 'success'");
  });

  it('executes held, rollback, partial, superseded, noop, promoted, and failure states', () => {
    expect(
      runReleaseGate({
        APP_CHANGED: 'true',
        OTA_CHANGED: 'true',
        APP_WEB_HELD: 'true',
        OTA_RESULT: 'success',
        OTA_CONFIGURED: 'true',
        OTA_ALL_SUCCESS: 'true',
        OTA_ANY_SUCCESS: 'true',
      }),
    ).toEqual({ status: 0, state: 'release-held' });

    expect(
      runReleaseGate({
        APP_CHANGED: 'true',
        APP_WEB_HELD: 'true',
      }),
    ).toEqual({ status: 0, state: 'app-web-held-only' });

    expect(
      runReleaseGate({
        ROLLBACK_ACTIVE: 'true',
        WEB_CHANGED: 'true',
        BACKEND_CHANGED: 'true',
        APP_CHANGED: 'true',
        OTA_CHANGED: 'true',
        MIGRATION_REQUIRED: 'true',
        BUILD_WEB_RESULT: 'success',
        BUILD_BACKEND_RESULT: 'success',
        MIGRATE_RESULT: 'success',
        DEPLOY_WEB_RESULT: 'success',
        DEPLOY_BACKEND_RESULT: 'success',
      }),
    ).toEqual({ status: 0, state: 'rollback-active' });

    expect(runReleaseGate({ ROLLBACK_ACTIVE: 'true' })).toEqual({
      status: 0,
      state: 'rollback-active',
    });

    expect(
      runReleaseGate({
        OTA_CHANGED: 'true',
        OTA_RESULT: 'success',
      }),
    ).toEqual({ status: 0, state: 'release-held' });

    expect(
      runReleaseGate({
        OTA_CHANGED: 'true',
        OTA_RESULT: 'success',
        OTA_CONFIGURED: 'true',
        OTA_ALL_SUCCESS: 'true',
        OTA_ANY_SUCCESS: 'true',
        OTA_PLATFORM: 'ios',
      }),
    ).toEqual({ status: 0, state: 'release-held' });

    expect(
      runReleaseGate({
        OTA_CHANGED: 'true',
        OTA_RESULT: 'success',
        OTA_CONFIGURED: 'true',
        OTA_ALL_SUCCESS: 'true',
        OTA_ANY_SUCCESS: 'true',
      }),
    ).toEqual({ status: 0, state: 'promoted' });

    expect(runReleaseGate({})).toEqual({ status: 0, state: 'noop' });

    expect(
      runReleaseGate({
        SUPERSEDED: 'true',
        ROLLBACK_CHECK_RESULT: 'skipped',
      }),
    ).toEqual({ status: 0, state: 'superseded' });

    expect(
      runReleaseGate({
        BACKEND_CHANGED: 'true',
        OTA_CHANGED: 'true',
        MIGRATION_REQUIRED: 'true',
        BUILD_BACKEND_RESULT: 'failure',
      }),
    ).toEqual({ status: 1, state: 'promoted' });
  });

  it('uses the derived changelog range and reports OTA outcome and health', () => {
    const success = jobBlock('notify-success');
    const failure = jobBlock('notify-failure');

    expect(success).toContain('needs.detect-changes.outputs.changelog_base_sha');
    expect(success).not.toContain('github.event.before');
    expect(success).toContain('OTA_RESULT');
    expect(success).toContain('OTA_HEALTH_STATUS');
    expect(success).toContain('OTA_CHANGELOG_SUMMARY_BASE64');
    expect(failure).toContain('OTA_RESULT');
    expect(failure).toContain('OTA_IOS_OUTCOME');
    expect(failure).toContain('OTA_ANDROID_OUTCOME');
    expect(failure).toContain('OTA_HEALTH_STATUS');
  });
});
