/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
type SnapshotExportJob = {
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean; queue?: string };
  env?: Record<string, string>;
  steps: { name?: string; uses?: string; env?: Record<string, string>; run?: string; 'timeout-minutes'?: number }[];
  if?: string;
};
const workflow = parse(readFileSync(resolve(REPO_ROOT, '.github/workflows/export-board-snapshots.yml'), 'utf8')) as {
  jobs: Record<string, SnapshotExportJob>;
};

const exportJob = workflow.jobs['legacy-or-manual-export'];

describe('snapshot export workflow', () => {
  it('pins setup-vp to the reviewed bootstrap version', () => {
    const setup = exportJob.steps.find((step) => step.uses?.startsWith('voidzero-dev/setup-vp@'));
    expect(setup?.uses).toBe('voidzero-dev/setup-vp@250f29ce396baf5e8f24498e17c0dfdebabc26eb');
  });

  it('passes the public base name the exporter reads for both storage targets', () => {
    expect(exportJob.env?.SNAPSHOT_PUBLIC_BASE_URL).toBe(
      "${{ inputs.storage_target == 'r2' && 'https://snapshots.boardsesh.com' || 'https://boardsesh-board-snapshots.t3.tigrisfiles.io' }}",
    );
    expect(exportJob.env).not.toHaveProperty('SNAPSHOTS_PUBLIC_BASE_URL');
    for (const step of exportJob.steps) expect(step.env ?? {}).not.toHaveProperty('SNAPSHOTS_PUBLIC_BASE_URL');
  });

  it('bounds verification and cleans its temporary files', () => {
    const verification = exportJob.steps.find(
      (step) => step.name === 'Verify every R2 artifact through the public domain',
    );
    expect(verification?.['timeout-minutes']).toBe(20);
    expect(verification?.run).toMatch(/trap\s+'rm -rf "\$work_dir"'\s+EXIT/);

    const maximumAttempts = Number(verification?.run?.match(/cache_attempt <= (\d+)/)?.[1]);
    const terminalAttempt = Number(verification?.run?.match(/"\$cache_attempt" = (\d+)/)?.[1]);
    const retryDelaySeconds = Number(verification?.run?.match(/sleep (\d+)/)?.[1]);
    expect(maximumAttempts).toBe(13);
    expect(terminalAttempt).toBe(maximumAttempts);
    expect((maximumAttempts - 1) * retryDelaySeconds).toBe(60);
  });

  it('keeps the hardware catalogue publishing after homelab per-layout cutover', () => {
    const catalogJob = workflow.jobs['homelab-catalog'];
    expect(catalogJob.if).toContain("vars.SNAPSHOT_HOMELAB_EXPORT_ENABLED == 'true'");
    expect(catalogJob.if).toContain("github.event.schedule == '15 7 * * *'");
    const catalogStep = catalogJob.steps.find(
      (step) => step.name === 'Export board catalogue (gzip → board-snapshots/v1-catalog)',
    );
    expect(catalogStep?.run).toBe('node --import tsx src/scripts/export-board-catalog.ts');
    expect(catalogStep?.env).toHaveProperty('DATABASE_URL');
    expect(catalogStep?.env).toHaveProperty('AWS_S3_BUCKET_NAME');
    expect(catalogStep?.env).not.toHaveProperty('SNAPSHOTS_R2_AWS_ACCESS_KEY_ID');
  });

  it('queues every publishing job without canceling its active run', () => {
    for (const jobName of ['legacy-or-manual-export', 'homelab-catalog', 'homelab-watchdog']) {
      expect(workflow.jobs[jobName].concurrency).toEqual({
        group: 'export-board-snapshots',
        'cancel-in-progress': false,
        queue: 'max',
      });
    }
  });

  it('keeps the complete R2 rehearsal checking all three published prefixes', () => {
    const verification = exportJob.steps.find(
      (step) => step.name === 'Verify every R2 artifact through the public domain',
    );
    expect(verification?.run).toContain('for prefix in v1 v1-gzip v1-catalog; do');
  });
});
