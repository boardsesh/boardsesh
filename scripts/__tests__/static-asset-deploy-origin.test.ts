/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STATIC_ASSET_ORIGIN } from '../../packages/shared/static-assets/src';

describe('static asset production origin', () => {
  it('keeps both browser builds aligned with the uploader validation origin', () => {
    const workflow = readFileSync('.github/workflows/production-deploy.yml', 'utf8');

    expect(workflow).toContain(`EXPO_PUBLIC_STATIC_ASSET_BASE_URL: ${STATIC_ASSET_ORIGIN}`);
    expect(workflow).toContain(`NEXT_PUBLIC_STATIC_ASSET_BASE_URL: ${STATIC_ASSET_ORIGIN}`);
    // The container build takes it as a Docker build-arg, not a step env, and
    // packages/web/app/lib/static-asset-url.ts throws without it — so a web
    // image built from a drifted origin fails at build time on the workflow's
    // value, not at request time on a 404 nobody sees.
    expect(workflow).toContain(`NEXT_PUBLIC_STATIC_ASSET_BASE_URL=${STATIC_ASSET_ORIGIN}`);
  });

  it('bounds the serialized static asset publication job', () => {
    const workflow = readFileSync('.github/workflows/production-deploy.yml', 'utf8');
    const jobStart = workflow.indexOf('\n  sync-static-assets:\n');
    expect(jobStart).toBeGreaterThanOrEqual(0);
    const remainingWorkflow = workflow.slice(jobStart + 1);
    const nextJobOffset = remainingWorkflow.slice(1).search(/^  [a-z][\w-]+:\n/m);
    const job = nextJobOffset < 0 ? remainingWorkflow : remainingWorkflow.slice(0, nextJobOffset + 1);

    expect(job).toContain('timeout-minutes: 10');
  });
});
