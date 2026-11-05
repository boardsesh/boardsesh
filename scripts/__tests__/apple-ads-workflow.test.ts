import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vite-plus/test';
import { parse } from 'yaml';

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  if?: string;
  with?: Record<string, unknown>;
}
interface AdsWorkflow {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  concurrency: { group: string; 'cancel-in-progress': boolean };
  jobs: Record<string, { if: string; environment?: string; steps: WorkflowStep[] }>;
}
const workflow = parse(readFileSync('.github/workflows/apple-ads.yml', 'utf8')) as AdsWorkflow;

describe('Apple Ads workflow boundaries', () => {
  it('keeps PR previews offline and credential free', () => {
    const preview = workflow.jobs.preview;
    expect(preview.if).toBe("github.event_name == 'pull_request'");
    expect(preview.environment).toBeUndefined();
    const serialized = JSON.stringify(preview);
    expect(serialized).not.toContain('secrets.');
    expect(serialized).not.toContain('action:apply');
    expect(serialized).toContain('--offline');
    expect(workflow.on).not.toHaveProperty('pull_request_target');
  });

  it('only runs credential-bearing reconciliation on main and serializes writers', () => {
    const reconcile = workflow.jobs.reconcile;
    expect(reconcile.if).toContain("github.event_name != 'pull_request'");
    expect(reconcile.if).toContain("github.ref == 'refs/heads/main'");
    expect(reconcile.environment).toBe('Production');
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.concurrency['cancel-in-progress']).toBe(false);
    expect(workflow.concurrency.group).toContain('apple-ads-21374740');
    expect(workflow.on).not.toHaveProperty('schedule');
    for (const step of reconcile.steps) {
      expect(step.uses ?? '').not.toContain('actions/cache');
      expect(step.with?.cache).not.toBe(true);
      expect(step.with?.['bundler-cache']).not.toBe(true);
      if (step.uses?.startsWith('actions/checkout')) {
        expect(step.with?.['persist-credentials']).toBe(false);
        expect(step.with?.ref).toBe('${{ github.sha }}');
      }
    }
  });

  it('previews live changes before applying and cleans up private keys', () => {
    const step = workflow.jobs.reconcile.steps.find((entry) => entry.name === 'Reconcile Apple Ads');
    expect(step?.env?.REQUESTED_ACTION).toBe("${{ inputs.action || 'apply' }}");
    expect(step?.if).toBe("steps.source.outputs.fresh == 'true'");
    const guard = workflow.jobs.reconcile.steps.find(
      (entry) => entry.name === 'Verify current main before paid writes',
    );
    expect(guard?.env?.EXPECTED_SHA).toBe('${{ github.sha }}');
    expect(guard?.run).toContain('git/ref/heads/main');
    expect(guard?.run).toContain('fresh=false');

    expect(step?.run).toContain('chmod 600 "$APPLE_ADS_PRIVATE_KEY_PATH"');
    expect(step?.run).toContain("trap 'rm -f");
    expect(step?.run).not.toContain('${{');
    expect(step?.run?.indexOf('action:plan')).toBeLessThan(step?.run?.indexOf('action:"$REQUESTED_ACTION"') ?? 0);
    expect(step?.env).toHaveProperty('APPLE_ADS_PRIVATE_KEY_BASE64');
    const artifact = workflow.jobs.reconcile.steps.find((entry) => entry.uses?.startsWith('actions/upload-artifact'));
    expect(artifact?.with?.path).not.toContain('.pem');
  });
});
