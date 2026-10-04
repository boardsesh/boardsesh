/// <reference types="node" />

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
      'production-deploy.yml',
    ]) {
      expect(apiGuard?.run).toContain(workflowFile);
    }
    expect(apiGuard?.run).toContain('disabled_manually');
    expect(apiGuard?.run).toContain('for status in requested waiting pending queued in_progress');
    expect(apiGuard?.run).toContain('for workflow in "${ota_writer_workflows[@]}"; do');
    expect(apiGuard?.run?.match(/for workflow in "\$\{ota_writer_workflows\[@\]\}"; do/g)).toHaveLength(2);
  });

  it('blocks copy or verification while production-deploy is active and direct OTA writers are idle', () => {
    const apiGuard = workflow.jobs.migrate.steps.find(({ name }) => name?.includes('writer is disabled'));
    const guardScript = apiGuard?.run;
    expect(guardScript).toBeDefined();

    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'ota-writer-freeze-'));
    const ghMockPath = join(temporaryDirectory, 'gh');
    const requestLogPath = join(temporaryDirectory, 'requests.log');
    writeFileSync(
      ghMockPath,
      `#!/usr/bin/env bash
set -euo pipefail
endpointPath=''
requestedStatus=state
for argument in "$@"; do
  case "$argument" in
    */actions/workflows/*) endpointPath="\${argument#*/actions/workflows/}" ;;
    status=*) requestedStatus="\${argument#status=}" ;;
  esac
done
if [ -z "$endpointPath" ]; then exit 2; fi
workflowFile="\${endpointPath%/runs}"
printf '%s\\t%s\\n' "$workflowFile" "$requestedStatus" >> "$OTA_WRITER_TEST_LOG"
if [[ "$endpointPath" != */runs ]]; then
  echo disabled_manually
elif [ "$workflowFile" = production-deploy.yml ] && [ "$requestedStatus" = in_progress ]; then
  echo 1
else
  echo 0
fi
`,
    );
    chmodSync(ghMockPath, 0o755);

    try {
      const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', guardScript ?? ''], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${temporaryDirectory}:${process.env.PATH ?? ''}`,
          GITHUB_REPOSITORY: 'boardsesh/boardsesh',
          GH_TOKEN: 'fixture-token',
          OTA_WRITER_TEST_LOG: requestLogPath,
        },
      });
      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain('production-deploy.yml still has 1 in_progress run(s).');

      const requests = readFileSync(requestLogPath, 'utf8');
      for (const workflowFile of [
        'mobile-ota-production.yml',
        'mobile-ota-backport.yml',
        'mobile-ota-preview.yml',
        'mobile-ota-preview-prompt.yml',
        'mobile-ota-preview-sweep.yml',
      ]) {
        expect(requests).toContain(`${workflowFile}\tin_progress`);
      }
      expect(requests).toContain('production-deploy.yml\tin_progress');
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
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
    expect(run).toContain('inventory) vp run storage:migrate-ota -- --concurrency "$OTA_MIGRATION_CONCURRENCY" ;;');
    expect(run).toContain('copy) vp run storage:migrate-ota -- --apply --concurrency "$OTA_MIGRATION_CONCURRENCY" ;;');
    expect(run).toContain(
      'verify) vp run storage:migrate-ota -- --verify-only --concurrency "$OTA_MIGRATION_CONCURRENCY" ;;',
    );
  });
});

describe('OTA migration workflow concurrency validation', () => {
  it('defaults operators to 32 bounded parallel workers', () => {
    expect(workflow.on.workflow_dispatch.inputs.concurrency).toMatchObject({ type: 'string', default: '32' });
    const guard = workflow.jobs.migrate.steps.find(({ name }) => name === 'Validate migration concurrency');
    expect(guard?.env).toEqual({ OTA_MIGRATION_CONCURRENCY: '${{ inputs.concurrency }}' });
    const migration = workflow.jobs.migrate.steps.find(({ name }) => name?.includes('Inventory, copy'));
    expect(migration?.env?.OTA_MIGRATION_CONCURRENCY).toBe('${{ inputs.concurrency }}');
    expect(migration?.run).not.toContain('${{ inputs.');
  });
  it.each(['1', '32', '64', '0', '65', '-1', '1.5', '1e1', '', '04', '$(exit 99)', '9999999999999999999'])(
    'validates dispatch value %j before providers are accessed',
    (requested) => {
      const guard = workflow.jobs.migrate.steps.find(({ name }) => name === 'Validate migration concurrency');
      const result = spawnSync('bash', ['-c', guard!.run!], {
        env: { ...process.env, OTA_MIGRATION_CONCURRENCY: requested },
        encoding: 'utf8',
      });
      expect(result.status).toBe(['1', '32', '64'].includes(requested) ? 0 : 1);
    },
  );
});
