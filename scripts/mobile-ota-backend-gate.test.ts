/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  type BackendGateInput,
  decideBackendGate,
  DEPLOY_REGISTRATION_GRACE_SECONDS,
  MAX_WAIT_SECONDS,
} from './mobile-ota-backend-gate';

const NEED = '3a6f0c0e2b1d4f5a6b7c8d9e0f1a2b3c4d5e6f70';
const RELEASE = '9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c';
const AFTER_GRACE = DEPLOY_REGISTRATION_GRACE_SECONDS + 60;

function gate(overrides: Partial<BackendGateInput>) {
  return decideBackendGate({
    needSha: NEED,
    release: RELEASE,
    isAncestor: false,
    schemaDiffEmpty: false,
    deployRunning: false,
    elapsedSeconds: AFTER_GRACE,
    ...overrides,
  });
}

describe('decideBackendGate', () => {
  it('passes once the deployed release contains the schema commit', () => {
    expect(gate({ isAncestor: true }).decision).toBe('pass');
    // Both directions, so an inverted ancestor check cannot survive.
    expect(gate({ isAncestor: false, deployRunning: true }).decision).toBe('wait');
  });

  it('passes when the deployed release has the same schema (hold or rollback)', () => {
    expect(gate({ schemaDiffEmpty: true }).decision).toBe('pass');
    expect(gate({ schemaDiffEmpty: false, deployRunning: true }).decision).toBe('wait');
  });

  it('never passes an unstamped `development` release, even if git agrees', () => {
    // No deploy running and past the grace, so only the SHA guard stands between
    // these inputs and a `pass`: without it, both git flags would pass them.
    for (const release of ['development', '']) {
      const verdict = gate({ release, isAncestor: true, schemaDiffEmpty: true, deployRunning: false });
      expect(verdict.decision, `release ${JSON.stringify(release)}`).toBe('timeout-publish');
    }
  });

  it('waits while a production deploy is running', () => {
    const verdict = gate({ deployRunning: true, elapsedSeconds: 30 * 60 });
    expect(verdict.decision).toBe('wait');
    expect(verdict.reason).toContain('deploy is running');
  });

  it('publishes anyway when no production deploy is running', () => {
    const verdict = gate({ deployRunning: false });
    expect(verdict.decision).toBe('timeout-publish');
    expect(verdict.reason).toContain('no production deploy is running');
  });

  it('gives a just-pushed deploy run time to be listed before failing open', () => {
    expect(gate({ deployRunning: false, elapsedSeconds: 0 }).decision).toBe('wait');
    expect(gate({ deployRunning: false, elapsedSeconds: DEPLOY_REGISTRATION_GRACE_SECONDS }).decision).toBe(
      'timeout-publish',
    );
  });

  it('stops waiting at the 60-minute cap even while a deploy is running', () => {
    expect(MAX_WAIT_SECONDS).toBe(60 * 60);
    expect(gate({ deployRunning: true, elapsedSeconds: MAX_WAIT_SECONDS - 1 }).decision).toBe('wait');
    const verdict = gate({ deployRunning: true, elapsedSeconds: MAX_WAIT_SECONDS });
    expect(verdict.decision).toBe('timeout-publish');
    expect(verdict.reason).toContain('waited 60 min');
  });

  it('passes a pass condition even after the cap', () => {
    expect(gate({ isAncestor: true, elapsedSeconds: MAX_WAIT_SECONDS * 2 }).decision).toBe('pass');
  });

  it('passes when no commit touches the schema source', () => {
    expect(gate({ needSha: '', release: 'development' }).decision).toBe('pass');
  });
});

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const production = readFileSync(resolve(REPO_ROOT, '.github', 'workflows', 'mobile-ota-production.yml'), 'utf8');

interface WorkflowJob {
  needs?: string | string[];
  if?: string;
  environment?: unknown;
  'timeout-minutes'?: number;
  permissions?: Record<string, string>;
  steps: { name?: string; if?: string; run?: string }[];
}

const workflow = parse(production) as { env: Record<string, unknown>; jobs: Record<string, WorkflowJob> };

describe('production OTA workflow backend-schema gate', () => {
  const gateJob = workflow.jobs['await-backend-schema'];
  const publishJob = workflow.jobs.publish;

  it('holds the publish job behind the gate', () => {
    const needs = [publishJob.needs ?? []].flat();
    expect(needs).toContain('await-backend-schema');
    // Fail open: a crashed or timed-out gate must still let the publish run.
    expect(publishJob.if).toContain('!cancelled()');
  });

  it('runs the gate without the Production environment and within a bounded time', () => {
    expect(gateJob).toBeDefined();
    expect(gateJob.environment).toBeUndefined();
    expect(gateJob['timeout-minutes']).toBe(75);
    expect(gateJob.permissions?.actions).toBe('read');
  });

  it('calls the unit-tested decision script and never fails the run', () => {
    const script = gateJob.steps.map((step) => step.run ?? '').join('\n');
    expect(script).toContain('scripts/mobile-ota-backend-gate.ts');
    expect(script).toContain('packages/shared-schema/src/schema');
    expect(script).toContain('gh run list');
    expect(script).not.toMatch(/^\s*exit 1\b/m);
  });

  it('skips the wait for a republish dispatched by a native build', () => {
    const wait = gateJob.steps.find((step) => step.name === 'Wait for the backend to serve this schema');
    expect(wait?.if).toContain("github.event.inputs.expect_fingerprint == ''");
  });
});
