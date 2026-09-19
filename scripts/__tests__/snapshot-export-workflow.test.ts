/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflow = readFileSync(resolve(REPO_ROOT, '.github/workflows/export-board-snapshots.yml'), 'utf8');

describe('snapshot export workflow', () => {
  it('passes the public base name the exporter reads for both storage targets', () => {
    expect(workflow).toContain(
      "SNAPSHOT_PUBLIC_BASE_URL: ${{ inputs.storage_target == 'r2' && 'https://snapshots.boardsesh.com' || 'https://boardsesh-board-snapshots.t3.tigrisfiles.io' }}",
    );
    expect(workflow).not.toContain('SNAPSHOTS_PUBLIC_BASE_URL');
  });

  it('bounds verification and cleans its temporary files', () => {
    const verification = workflow.slice(workflow.indexOf('- name: Verify every R2 artifact'));
    expect(verification).toContain('timeout-minutes: 20');
    expect(verification).toContain(`trap 'rm -rf "$work_dir"' EXIT`);
  });
});
