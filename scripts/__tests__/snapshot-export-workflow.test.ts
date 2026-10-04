/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
type Step = { name?: string; uses?: string; env?: Record<string, string>; run?: string; 'timeout-minutes'?: number };
const workflow = parse(readFileSync(resolve(REPO_ROOT, '.github/workflows/export-board-snapshots.yml'), 'utf8')) as {
  on: { schedule?: unknown; workflow_dispatch: { inputs: { storage_target: { default: string; options: string[] } } } };
  jobs: { export: { if: string; env: Record<string, string>; steps: Step[] } };
};
const exportJob = workflow.jobs.export;

describe('snapshot export rehearsal workflow', () => {
  it('keeps Actions manual-only and prohibits an ordinary Tigris publisher', () => {
    expect(workflow.on).not.toHaveProperty('schedule');
    expect(exportJob.if).toBe("github.ref == 'refs/heads/main'");
    expect(workflow.on.workflow_dispatch.inputs.storage_target).toMatchObject({ default: 'r2', options: ['r2'] });
    expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toEqual(['storage_target']);
  });

  it('fails closed unless the homelab producer is explicitly still on Tigris', () => {
    const validation = exportJob.steps.find((step) => step.name === 'Validate isolated R2 rehearsal')!;
    expect(validation.env?.SNAPSHOT_PUBLISHER_STORAGE_TARGET).toBe('${{ vars.SNAPSHOT_PUBLISHER_STORAGE_TARGET }}');
    expect(validation.run).toContain(`[ "$SNAPSHOT_PUBLISHER_STORAGE_TARGET" != 'tigris' ]`);
    expect(validation.run).toContain(`[ "$STORAGE_TARGET" != 'r2' ]`);
    expect(exportJob.steps.indexOf(validation)).toBe(0);
  });

  it('pins setup-vp and confines credentials to the operations that need them', () => {
    const setup = exportJob.steps.find((step) => step.uses?.startsWith('voidzero-dev/setup-vp@'));
    expect(setup?.uses).toBe('voidzero-dev/setup-vp@250f29ce396baf5e8f24498e17c0dfdebabc26eb');
    expect(Object.keys(exportJob.env)).toEqual(['SNAPSHOT_PUBLIC_BASE_URL', 'SYNC_STABILITY_WINDOW_SECONDS']);
    expect(exportJob.env.SNAPSHOT_PUBLIC_BASE_URL).toBe('https://snapshots.boardsesh.com');
    for (const step of exportJob.steps.filter((candidate) => candidate.name?.startsWith('Export board'))) {
      expect(step.env?.SNAPSHOTS_S3_BUCKET_NAME).toBe('boardsesh-board-snapshots');
      expect(step.env?.SNAPSHOTS_PUBLIC_BASE_URL).toBe(exportJob.env.SNAPSHOT_PUBLIC_BASE_URL);
      expect(step.env?.SNAPSHOTS_AWS_ENDPOINT_URL).toBe('${{ secrets.SNAPSHOTS_R2_AWS_ENDPOINT_URL }}');
      expect(step.env).not.toHaveProperty('AWS_S3_BUCKET_NAME');
      expect(step.run).toContain('--no-prune');
    }
  });

  it('captures coverage before all three complete exports and runs the full artifact verifier', () => {
    const capture = exportJob.steps.findIndex((step) => step.name === 'Capture trusted coverage before export');
    const exports = exportJob.steps.filter((step) => step.name?.startsWith('Export board'));
    expect(exports).toHaveLength(3);
    expect(exports.every((step) => exportJob.steps.indexOf(step) > capture)).toBe(true);
    expect(exports.every((step) => !/--board|--layout|--refresh-threshold/.test(step.run ?? ''))).toBe(true);
    const verification = exportJob.steps.find(
      (step) => step.name === 'Verify every R2 artifact through the public domain',
    )!;
    expect(verification['timeout-minutes']).toBe(30);
    expect(verification.run).toContain('vp run storage:verify-snapshots');
    expect(verification.run).toContain('--expected-manifest');
    expect(verification.run).toContain('--built-after');
    expect(verification.env).not.toHaveProperty('DATABASE_URL');
  });
});
