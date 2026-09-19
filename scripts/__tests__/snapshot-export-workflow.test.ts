/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflow = parse(readFileSync(resolve(REPO_ROOT, '.github/workflows/export-board-snapshots.yml'), 'utf8')) as {
  jobs: {
    export: {
      env: Record<string, string>;
      steps: { name?: string; env?: Record<string, string>; run?: string; 'timeout-minutes'?: number }[];
    };
  };
};

const exportJob = workflow.jobs.export;

describe('snapshot export workflow', () => {
  it('passes the public base name the exporter reads for both storage targets', () => {
    expect(exportJob.env.SNAPSHOT_PUBLIC_BASE_URL).toBe(
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
  });
});
