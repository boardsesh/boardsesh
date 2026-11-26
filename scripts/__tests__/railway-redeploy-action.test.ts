/// <reference types="node" />

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const ACTION_PATH = '.github/actions/railway-redeploy/action.yml';
const ROLLBACK_SCRIPT_PATH = 'scripts/railway-deployment-rollback.mjs';
const STATUS_SCRIPT_PATH = 'scripts/railway-deployment-status.mjs';
const actionSource = readFileSync(ACTION_PATH, 'utf8');
const rollbackScriptSource = readFileSync(ROLLBACK_SCRIPT_PATH, 'utf8');
const statusScriptSource = readFileSync(STATUS_SCRIPT_PATH, 'utf8');

/** One composite-action step selected by its exact name. */
function stepNamed(source: string, name: string): string {
  const lines = source.split('\n');
  const startIndex = lines.findIndex((line) => line.trimStart() === `- name: ${name}`);
  if (startIndex < 0) throw new Error(`missing step "${name}"`);

  const endIndex = lines.findIndex((line, index) => index > startIndex && /^ {4}- name: /.test(line));
  return lines.slice(startIndex, endIndex < 0 ? lines.length : endIndex).join('\n');
}

function runBlock(stepSource: string): string {
  const lines = stepSource.split('\n');
  const runIndex = lines.findIndex((line) => line.trim() === 'run: |');
  if (runIndex < 0) throw new Error('step has no multiline run block');
  return lines.slice(runIndex + 1).join('\n');
}

function withActionScratch(check: (folder: string) => void): void {
  const scratchRoot = join(process.cwd(), '.boardsesh', 'tmp', 'origin-cutover-action-tests');
  mkdirSync(scratchRoot, { recursive: true });
  const folder = mkdtempSync(join(scratchRoot, 'case-'));
  try {
    check(folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

describe('railway-redeploy recovery contract', () => {
  const validateStep = stepNamed(actionSource, 'Validate Railway redeploy identity');
  const triggerStep = stepNamed(actionSource, 'Trigger Railway redeploy from the configured image source');
  const waitStep = stepNamed(actionSource, 'Lock and verify the exact new Railway deployment');
  const rollbackStep = stepNamed(actionSource, 'Restore the captured Railway deployment after redeploy failure');
  const recoveryFailureStep = stepNamed(actionSource, 'Fail after verified Railway recovery');

  it('normalizes a valid mixed-case Railway service UUID before every use', () => {
    expect(validateStep).toContain('id: railway-validate');
    expect(validateStep).toContain('NORMALIZED_RAILWAY_SERVICE_ID="${RAILWAY_SERVICE_ID,,}"');
    expect(validateStep).toContain('Railway service id must be a UUID.');
    expect(validateStep).toContain('service_id=%s');
    expect(actionSource.match(/RAILWAY_SERVICE_ID: \$\{\{ inputs\.service-id \}\}/g) ?? []).toHaveLength(1);
    expect(
      actionSource.match(/RAILWAY_SERVICE_ID: \$\{\{ steps\.railway-validate\.outputs\.service_id \}\}/g) ?? [],
    ).toHaveLength(4);
    expect(rollbackStep).toContain('service-id: ${{ steps.railway-validate.outputs.service_id }}');
  });

  it('keeps backend validation working with all retained-asset inputs empty', () => {
    withActionScratch((folder) => {
      const result = spawnSync('bash', ['-c', runBlock(validateStep)], {
        encoding: 'utf8',
        env: {
          ...process.env,
          EXPECTED_IMAGE: 'ghcr.io/boardsesh/backend:production',
          RAILWAY_TOKEN: 'test-token',
          RAILWAY_SERVICE_ID: '12345678-1234-1234-1234-123456789abc',
          SERVICE_LABEL: 'backend',
          RETAINED_ASSETS_ORIGIN: '',
          EXPECTED_PREVIOUS_DEPLOYMENT_ID: '',
          EXPECTED_PREVIOUS_RELEASE: '',
          GITHUB_OUTPUT: join(folder, 'output'),
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(folder, 'output'), 'utf8')).toContain('service_id=12345678-1234-1234-1234-123456789abc');
    });
  });

  it('rejects a web origin without the verified rollback identity before CLI installation', () => {
    withActionScratch((folder) => {
      const result = spawnSync('bash', ['-c', runBlock(validateStep)], {
        encoding: 'utf8',
        env: {
          ...process.env,
          EXPECTED_IMAGE: 'ghcr.io/boardsesh/web:production',
          RAILWAY_TOKEN: 'test-token',
          RAILWAY_SERVICE_ID: '12345678-1234-1234-1234-123456789abc',
          SERVICE_LABEL: 'web',
          RETAINED_ASSETS_ORIGIN: 'https://example.up.railway.app',
          EXPECTED_PREVIOUS_DEPLOYMENT_ID: '',
          EXPECTED_PREVIOUS_RELEASE: '',
          GITHUB_OUTPUT: join(folder, 'output'),
        },
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('requires the deployment ID and release verified before alias promotion');
      expect(existsSync(join(folder, 'output'))).toBe(false);
    });
  });

  it.each([false, true])(
    'runs the captured web proof only when the promotion identity still agrees (changed=%s)',
    (changed) => {
      const proofStep = stepNamed(actionSource, 'Recheck retained assets on the captured web rollback deployment');
      expect(proofStep).toContain("if: inputs.retained-assets-origin != ''");
      expect(
        actionSource.indexOf('- name: Recheck retained assets on the captured web rollback deployment'),
      ).toBeLessThan(actionSource.indexOf('- name: Trigger Railway redeploy from the configured image source'));
      withActionScratch((folder) => {
        const called = join(folder, 'guard-called');
        writeFileSync(
          join(folder, 'node'),
          '#!/bin/bash\nprintf \'%s\\n\' "$EXPECTED_PREVIOUS_DEPLOYMENT_ID" > "$GUARD_CALLED_FILE"\n',
          { mode: 0o700 },
        );
        const capturedId = '12345678-1234-1234-1234-123456789abc';
        const result = spawnSync('bash', ['-c', runBlock(proofStep)], {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: folder + ':' + (process.env.PATH ?? ''),
            GUARD_CALLED_FILE: called,
            RAILWAY_WEB_ORIGIN: 'https://example.up.railway.app',
            EXPECTED_PREVIOUS_DEPLOYMENT_ID: capturedId,
            PROMOTION_PREVIOUS_DEPLOYMENT_ID: changed ? '87654321-1234-1234-1234-123456789abc' : capturedId,
          },
        });
        expect(result.status, result.stderr).toBe(changed ? 1 : 0);
        expect(existsSync(called)).toBe(!changed);
        if (!changed) expect(readFileSync(called, 'utf8').trim()).toBe(capturedId);
        if (changed) expect(result.stdout).toContain('no redeploy was triggered');
      });
    },
  );

  it('checks the restored web deployment before announcing verified recovery', () => {
    const recoverySmoke = stepNamed(actionSource, 'Verify retained web assets after redeploy recovery');
    expect(recoverySmoke).toContain("inputs.retained-assets-origin != ''");
    expect(recoverySmoke).toContain("steps.railway-rollback.outcome == 'success'");
    expect(recoverySmoke).toContain(
      'SMOKE_EXPECTED_DEPLOYMENT_ID: ${{ steps.railway-rollback.outputs.rollback_deployment_id }}',
    );
    expect(recoverySmoke).toContain('SMOKE_EXPECTED_RELEASE: ${{ inputs.expected-previous-release }}');
    expect(recoverySmoke).toContain('node scripts/retained-next-assets-smoke.ts');
    expect(recoveryFailureStep).toContain('RECOVERY_SMOKE_OUTCOME: ${{ steps.railway-recovery-smoke.outcome }}');
    expect(recoveryFailureStep).toContain('[ "$RECOVERY_SMOKE_OUTCOME" != "success" ]');
  });

  it('fails closed with reconciliation guidance when trigger acceptance is ambiguous', () => {
    expect(triggerStep).toContain('if timeout 60s railway redeploy');
    expect(triggerStep).toContain('railway_trigger_status=$?');
    expect(triggerStep).toContain('exit "$railway_trigger_status"');
    expect(triggerStep).toContain('may have been accepted');
    expect(triggerStep).toContain('trigger acceptance is ambiguous');
    expect(triggerStep).toContain('no automatic rollback was attempted');
    expect(triggerStep).not.toContain('continue-on-error: true');
  });

  it('delegates recovery to the shared verified rollback action', () => {
    expect(rollbackStep).toContain('uses: ./.github/actions/railway-rollback');
    expect(rollbackStep).toContain('target-deployment-id: ${{ steps.railway-capture.outputs.previous_deployment_id }}');
    expect(rollbackStep).toContain('expected-current-deployment-id: ${{ steps.railway-wait.outputs.deployment_id }}');

    // GraphQL ownership lives in the reviewed helper used by every caller.
    expect(actionSource).not.toContain('backboard.railway.com/graphql/v2');
    expect(actionSource).not.toContain('rollback_previous_deployment');
  });

  it('requires an explicit safe-recovery decision before invoking rollback', () => {
    expect(waitStep).toContain('automatic_recovery_safe=true');
    expect(rollbackStep).toContain("steps.railway-wait.outcome == 'failure'");
    expect(rollbackStep).toContain("steps.railway-wait.outputs.automatic_recovery_safe == 'true'");
    expect(rollbackStep).not.toContain("steps.railway-wait.outputs.suppress_automatic_recovery != 'true'");
    expect(recoveryFailureStep).toContain(
      'AUTOMATIC_RECOVERY_SAFE: ${{ steps.railway-wait.outputs.automatic_recovery_safe }}',
    );
    expect(recoveryFailureStep).toContain('ROLLBACK_OUTCOME: ${{ steps.railway-rollback.outcome }}');
    expect(recoveryFailureStep).toContain('if [ "$AUTOMATIC_RECOVERY_SAFE" != "true" ]');
    expect(recoveryFailureStep).toContain('elif [ "$ROLLBACK_OUTCOME" = "success" ]');
    expect(runBlock(recoveryFailureStep)).not.toContain('${{');
  });

  it('quarantines cancellation without marking automatic recovery safe', () => {
    expect(actionSource).not.toContain('suppress_automatic_recovery');
    expect(waitStep).toContain('OBSERVED_CANCELLED_DEPLOYMENT_ID=""');
    expect(waitStep).toContain('CANCELLATION_QUARANTINE_REQUESTED=false');
    expect(waitStep).toContain('if [ "$CANCELLATION_QUARANTINE_REQUESTED" = true ]');
    expect(waitStep).not.toContain('if [ -n "$OBSERVED_CANCELLED_DEPLOYMENT_ID" ]');
    const pollLoopIndex = waitStep.indexOf('for attempt in');
    const quarantineSignalResetIndex = waitStep.indexOf('CANCELLATION_QUARANTINE_REQUESTED=false');
    const findNewIndex = waitStep.indexOf('node scripts/railway-deployment-status.mjs find-new');
    expect(quarantineSignalResetIndex).toBeGreaterThan(pollLoopIndex);
    expect(quarantineSignalResetIndex).toBeLessThan(findNewIndex);
    const cancellationBranch = waitStep.match(/CANCELED\|CANCELLED\)([\s\S]*?)\n\s*;;/)?.[1];
    expect(cancellationBranch).toBeDefined();
    expect(cancellationBranch).not.toContain('automatic_recovery_safe=true');
    expect(cancellationBranch).toContain('automatic rollback is suppressed');
  });

  it('resolves a superseded cancellation to its live successor instead of failing closed', () => {
    // Railway marks a queued deployment CANCELLED when a newer one supersedes
    // it. Counting that row as a second new deployment fails an ordinary
    // redeploy closed, and quarantining it once the successor is visible sends
    // a healthy deploy to manual reconciliation (#5040).
    expect(statusScriptSource).toContain('function isSupersededCancellation(deployment)');
    expect(statusScriptSource).toContain(
      'const liveCandidates = postBaseline.filter((deployment) => !isSupersededCancellation(deployment));',
    );
    // The quarantine still holds while no successor is visible.
    expect(statusScriptSource).toContain('throw new DeploymentCancellationError(observedCancelledId);');
    // Locking a resolved successor must clear the quarantine, or the next poll
    // trips the "cannot coexist" guard.
    expect(waitStep).toContain('OBSERVED_CANCELLED_DEPLOYMENT_ID=""');
  });

  it('makes every GraphQL failure mode fatal in the shared rollback helper', () => {
    expect(rollbackScriptSource).toContain('if (!response?.ok)');
    expect(rollbackScriptSource).toContain('returned invalid JSON');
    expect(rollbackScriptSource).toContain('returned GraphQL errors');
    expect(rollbackScriptSource).toContain('if (mutationData.deploymentRollback !== true)');
    expect(rollbackScriptSource).toContain('Railway rollback mutation was not accepted');
  });

  it('never retries an ambiguously acknowledged rollback mutation', () => {
    expect(rollbackScriptSource).toContain('Never retry this mutation after an ambiguous response');
    expect(rollbackScriptSource.match(/query: ROLLBACK_MUTATION/g) ?? []).toHaveLength(1);
  });
});
