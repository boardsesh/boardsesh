import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type BootstrapWorkflow = {
  on: {
    workflow_dispatch: {
      inputs: { mode: { default: string; options: string[] } };
    };
  };
  jobs: {
    bootstrap: {
      if: string;
      'timeout-minutes': number;
      env?: Record<string, string>;
      steps: Array<{ name?: string; if?: string; env?: Record<string, string>; run?: string }>;
    };
  };
};

const workflow = parse(readFileSync('.github/workflows/bootstrap-r2-static-assets.yml', 'utf8')) as BootstrapWorkflow;
const bootstrap = workflow.jobs.bootstrap;
const endpointValidation = bootstrap.steps[0].run?.match(/node -e '([\s\S]*?)'\s*$/)?.[1];

describe('static asset bootstrap trust boundary', () => {
  it.each([
    ['https://t3.storage.dev', true],
    ['https://fly.storage.tigris.dev', true],
    ['http://t3.storage.dev', false],
    ['https://unrelated.example', false],
    ['https://user:secret@t3.storage.dev', false],
    ['https://t3.storage.dev/other', false],
    ['https://t3.storage.dev?secret=hidden', false],
    ['not a URL', false],
  ])('preflights the legacy endpoint %s (valid=%s)', (endpoint, valid) => {
    expect(endpointValidation).toBeDefined();
    const result = spawnSync(process.execPath, ['-e', endpointValidation!], {
      env: {
        STATIC_ASSETS_AWS_ENDPOINT_URL: endpoint,
        STATIC_ASSETS_R2_AWS_ENDPOINT_URL: `https://${'a'.repeat(32)}.r2.cloudflarestorage.com`,
      },
      encoding: 'utf8',
    });
    expect(result.status).toBe(valid ? 0 : 1);
    expect(result.stderr).not.toContain('secret');
    if (!valid) expect(result.stderr).toContain('STATIC_ASSETS_AWS_ENDPOINT_URL must be');
  });
  it('validates both credential sets before checkout or dependency installation', () => {
    const validation = bootstrap.steps[0];
    expect(validation.name).toBe('Validate migration credentials');
    for (const secret of [
      'STATIC_ASSETS_S3_BUCKET_NAME',
      'STATIC_ASSETS_AWS_ENDPOINT_URL',
      'STATIC_ASSETS_AWS_REGION',
      'STATIC_ASSETS_AWS_ACCESS_KEY_ID',
      'STATIC_ASSETS_AWS_SECRET_ACCESS_KEY',
      'STATIC_ASSETS_R2_AWS_ENDPOINT_URL',
      'STATIC_ASSETS_R2_AWS_ACCESS_KEY_ID',
      'STATIC_ASSETS_R2_AWS_SECRET_ACCESS_KEY',
    ]) {
      expect(validation.env?.[secret]).toBe(`\${{ secrets.${secret} }}`);
      expect(validation.run).toContain(secret);
    }
    expect(validation.run).toContain('Missing Production secret: $required_name');
    expect(validation.run).not.toContain('echo "${!required_name}"');
  });
  it('keeps production credentials on main and defaults to read-only inventory', () => {
    expect(bootstrap.if).toBe("github.ref == 'refs/heads/main'");
    expect(workflow.on.workflow_dispatch.inputs.mode.default).toBe('inventory');
    expect(workflow.on.workflow_dispatch.inputs.mode.options).toEqual(['inventory', 'bootstrap', 'verify']);
    expect(bootstrap.env).toBeUndefined();
  });

  it('copies historical keys before publishing the current catalog', () => {
    const historicalIndex = bootstrap.steps.findIndex(
      (step) => step.name === 'Preserve and verify historical immutable assets',
    );
    const publishIndex = bootstrap.steps.findIndex((step) => step.name === 'Upload and verify the complete catalogue');
    expect(historicalIndex).toBeGreaterThanOrEqual(0);
    expect(publishIndex).toBeGreaterThan(historicalIndex);
    const historical = bootstrap.steps[historicalIndex];
    expect(historical.run).toContain('inventory) vp run storage:migrate-static-assets -- --dry-run');
    expect(historical.run).toContain('bootstrap) vp run storage:migrate-static-assets -- --apply');
    expect(historical.run).toContain('verify) vp run storage:migrate-static-assets -- --verify-only');
    expect(bootstrap.steps[publishIndex].if).toBe("inputs.mode == 'bootstrap'");
    expect(bootstrap['timeout-minutes']).toBe(30);
  });

  it('separates legacy source credentials from the pinned R2 destination', () => {
    const historical = bootstrap.steps.find((step) => step.name === 'Preserve and verify historical immutable assets');
    expect(historical?.env).toMatchObject({
      STATIC_ASSETS_LEGACY_S3_BUCKET_NAME: '${{ secrets.STATIC_ASSETS_S3_BUCKET_NAME }}',
      STATIC_ASSETS_LEGACY_AWS_ENDPOINT_URL: '${{ secrets.STATIC_ASSETS_AWS_ENDPOINT_URL }}',
      STATIC_ASSETS_LEGACY_AWS_REGION: '${{ secrets.STATIC_ASSETS_AWS_REGION }}',
      STATIC_ASSETS_LEGACY_AWS_ACCESS_KEY_ID: '${{ secrets.STATIC_ASSETS_AWS_ACCESS_KEY_ID }}',
      STATIC_ASSETS_LEGACY_AWS_SECRET_ACCESS_KEY: '${{ secrets.STATIC_ASSETS_AWS_SECRET_ACCESS_KEY }}',
      STATIC_ASSETS_R2_AWS_ENDPOINT_URL: '${{ secrets.STATIC_ASSETS_R2_AWS_ENDPOINT_URL }}',
      STATIC_ASSETS_R2_AWS_ACCESS_KEY_ID: '${{ secrets.STATIC_ASSETS_R2_AWS_ACCESS_KEY_ID }}',
      STATIC_ASSETS_R2_AWS_SECRET_ACCESS_KEY: '${{ secrets.STATIC_ASSETS_R2_AWS_SECRET_ACCESS_KEY }}',
    });
    const publication = bootstrap.steps.find((step) => step.name === 'Upload and verify the complete catalogue');
    expect(publication?.env).toMatchObject({
      STATIC_ASSETS_S3_BUCKET_NAME: 'boardsesh-static-assets',
      STATIC_ASSETS_AWS_REGION: 'auto',
      STATIC_ASSETS_PUBLIC_BASE_URL: 'https://assets-r2.boardsesh.com',
      STATIC_ASSETS_AWS_ENDPOINT_URL: '${{ secrets.STATIC_ASSETS_R2_AWS_ENDPOINT_URL }}',
    });
  });
});
