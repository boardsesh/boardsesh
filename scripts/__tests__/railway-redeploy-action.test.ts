/// <reference types="node" />

import { readFileSync } from 'node:fs';
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

describe('railway-redeploy recovery contract', () => {
  const waitStep = stepNamed(actionSource, 'Lock and verify the exact new Railway deployment');
  const rollbackStep = stepNamed(actionSource, 'Restore the captured Railway deployment after redeploy failure');

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
    expect(rollbackStep).toContain("steps.railway-wait.outputs.automatic_recovery_safe == 'true'");
    expect(rollbackStep).not.toContain("steps.railway-wait.outputs.suppress_automatic_recovery != 'true'");
  });

  it('quarantines cancellation without marking automatic recovery safe', () => {
    expect(waitStep).toContain('OBSERVED_CANCELLED_DEPLOYMENT_ID=""');
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
