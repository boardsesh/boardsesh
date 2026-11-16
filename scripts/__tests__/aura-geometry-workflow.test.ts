import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('Aura publication workflow', () => {
  it('requires an explicit dispatch and exports a verified manifest without repository writes', () => {
    const source = readFileSync(new URL('../../.github/workflows/aura-geometry.yml', import.meta.url), 'utf8');
    const workflow = parse(source) as {
      on: Record<string, unknown>;
      permissions: Record<string, string>;
      jobs: Record<string, { steps: { name?: string; if?: string; run?: string; env?: Record<string, string> }[] }>;
    };
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(workflow.permissions).toEqual({ contents: 'read' });
    const steps = workflow.jobs.prebuild.steps;
    const publish = steps.find((step) => step.name?.startsWith('Generate, publish'));
    expect(publish?.if).toBe('inputs.publish == true');
    expect(publish?.run).toContain('vp run publish:aura-geometry');
    expect(publish?.run).toContain('--release-manifest "$RUNNER_TEMP/aura-geometry/manifest.verified.json"');
    expect(Object.keys(publish?.env ?? {})).toEqual([
      'STATIC_ASSETS_S3_BUCKET_NAME',
      'STATIC_ASSETS_AWS_ACCESS_KEY_ID',
      'STATIC_ASSETS_AWS_SECRET_ACCESS_KEY',
      'STATIC_ASSETS_AWS_ENDPOINT_URL',
      'STATIC_ASSETS_AWS_REGION',
    ]);
    expect(source).not.toContain('git push');
    expect(source).not.toContain('DeleteObject');
  });
});
