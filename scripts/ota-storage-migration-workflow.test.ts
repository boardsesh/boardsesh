/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vite-plus/test';

const source = readFileSync(resolve(__dirname, '../.github/workflows/migrate-ota-storage.yml'), 'utf8');
const workflow = parse(source) as {
  on: { workflow_dispatch: { inputs: Record<string, { type: string; options?: string[]; default: unknown }> } };
  concurrency: { group: string; 'cancel-in-progress': boolean };
  permissions: { contents: string; actions: string };
  jobs: {
    migrate: {
      if: string;
      environment: string;
      'timeout-minutes': number;
      steps: { name?: string; uses?: string; if?: string; env?: Record<string, string>; run?: string }[];
    };
  };
};

describe('Migrate OTA Storage to R2 workflow', () => {
  it('is manual, main-only, serialized, and Production-protected', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(workflow.jobs.migrate.if).toContain("github.ref == 'refs/heads/main'");
    expect(workflow.jobs.migrate.environment).toBe('Production');
    expect(workflow.jobs.migrate['timeout-minutes']).toBe(180);
    expect(workflow.concurrency).toEqual({ group: 'migrate-ota-storage', 'cancel-in-progress': false });
    expect(workflow.permissions).toEqual({ contents: 'read', actions: 'read' });
  });

  it('defaults to inventory and requires an explicit write freeze for copy or verify', () => {
    const inputs = workflow.on.workflow_dispatch.inputs;
    expect(inputs.mode).toMatchObject({
      type: 'choice',
      options: ['inventory', 'copy', 'verify'],
      default: 'inventory',
    });
    expect(inputs.ota_publishes_frozen).toMatchObject({ type: 'boolean', default: false });
    const guard = workflow.jobs.migrate.steps.find(({ name }) => name?.includes('write freeze'));
    expect(guard?.if).toContain("inputs.mode != 'inventory'");
    expect(guard?.if).toContain('!inputs.ota_publishes_frozen');

    const apiGuard = workflow.jobs.migrate.steps.find(({ name }) => name?.includes('writer is disabled'));
    expect(apiGuard?.if).toContain("inputs.mode != 'inventory'");
    expect(apiGuard?.env).toEqual({ GH_TOKEN: '${{ github.token }}' });
    for (const workflowFile of [
      'mobile-ota-production.yml',
      'mobile-ota-backport.yml',
      'mobile-ota-preview.yml',
      'mobile-ota-preview-prompt.yml',
      'mobile-ota-preview-sweep.yml',
    ]) {
      expect(apiGuard?.run).toContain(workflowFile);
    }
    expect(apiGuard?.run).toContain('disabled_manually');
    expect(apiGuard?.run).toContain('for status in requested waiting pending queued in_progress');
  });

  it('exposes credentials only to the migration step under dedicated OTA_R2 names', () => {
    const credentialSteps = workflow.jobs.migrate.steps.filter(({ env }) => env?.OTA_R2_AWS_SECRET_ACCESS_KEY);
    expect(credentialSteps).toHaveLength(1);
    expect(credentialSteps[0].env).toMatchObject({
      RAILWAY_TOKEN: '${{ secrets.RAILWAY_TOKEN }}',
      RAILWAY_PROJECT_ID: '${{ vars.RAILWAY_PROJECT_ID }}',
      OTA_R2_AWS_ENDPOINT_URL: '${{ secrets.OTA_R2_AWS_ENDPOINT_URL }}',
      OTA_R2_AWS_ACCESS_KEY_ID: '${{ secrets.OTA_R2_AWS_ACCESS_KEY_ID }}',
      OTA_R2_AWS_SECRET_ACCESS_KEY: '${{ secrets.OTA_R2_AWS_SECRET_ACCESS_KEY }}',
    });
  });

  it('maps every mode to the safe script flag', () => {
    const run = workflow.jobs.migrate.steps.find(({ name }) => name?.includes('Inventory, copy'))?.run ?? '';
    expect(run).toContain('inventory) vp run storage:migrate-ota ;;');
    expect(run).toContain('copy) vp run storage:migrate-ota -- --apply ;;');
    expect(run).toContain('verify) vp run storage:migrate-ota -- --verify-only ;;');
  });
});
