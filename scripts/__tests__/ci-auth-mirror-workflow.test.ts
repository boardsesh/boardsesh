/// <reference types="node" />
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface WorkflowStep {
  id?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  'continue-on-error'?: boolean;
}
interface WorkflowJob {
  needs?: string[];
  if?: string;
  'runs-on': string;
  'timeout-minutes'?: number;
  'continue-on-error'?: boolean;
  strategy?: unknown;
  services?: Record<string, unknown>;
  steps: WorkflowStep[];
}
const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
  jobs: Record<string, WorkflowJob>;
};
const mirror = workflow.jobs['test-auth-mirror'];
const backend = workflow.jobs['test-backend'];

// YAML reads have no affected-test graph edge. The auth boundary guard invokes
// this contract unconditionally so a workflow-only regression cannot opt out.
describe('independent current-store mirror qualification', () => {
  it('runs for every backend input on its own hosted runner and budget', () => {
    expect(mirror.needs).toEqual(['changes']);
    expect(mirror.if).toBe(backend.if);
    for (const input of ['backend', 'sharedDeps', 'rootCi']) {
      expect(mirror.if).toContain(`needs.changes.outputs.${input} == 'true'`);
    }
    expect(mirror['runs-on']).toBe('ubuntu-latest');
    expect(mirror.strategy).toBeUndefined();
    expect(mirror['timeout-minutes']).toBe(30);
    expect(backend['timeout-minutes']).toBe(40);
  });

  it('owns the baseline PostgreSQL and Redis service configuration', () => {
    expect(Object.keys(mirror.services ?? {}).sort()).toEqual(['postgres', 'redis']);
    expect(mirror.services).toEqual(backend.services);
  });

  it('runs the full mirror-on task exactly once with explicit fixture endpoints', () => {
    const qualification = mirror.steps.filter((step) => step.run === 'vp run test:auth-mirror');
    expect(qualification).toHaveLength(1);
    expect(qualification[0].env).toEqual({
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5433/boardsesh_backend_test',
      REDIS_URL: 'redis://localhost:6380',
    });
    expect(qualification[0].if).toBeUndefined();
    expect(mirror['continue-on-error']).toBeUndefined();
    expect(qualification[0]['continue-on-error']).toBeUndefined();
    const allQualifications = Object.values(workflow.jobs).flatMap((job) =>
      job.steps.filter((step) => step.run?.includes('vp run test:auth-mirror')),
    );
    expect(allQualifications).toHaveLength(1);
    const taskConfiguration = readFileSync('vite.config.ts', 'utf8');
    expect(taskConfiguration).toContain(
      'BOARDSESH_MIRROR_PROOF_MODE=on vp test run --config packages/backend/vite.auth-mirror.config.ts --maxWorkers=2',
    );
  });

  it('makes a cancelled mirror qualification fail the required aggregate', () => {
    const status = workflow.jobs['ci-status'];
    expect(status.needs).toContain('test-auth-mirror');
    const results = Object.fromEntries(
      (status.needs ?? []).map((name) => [name, { result: name === 'test-auth-mirror' ? 'cancelled' : 'success' }]),
    );
    const execution = spawnSync('bash', ['-c', status.steps[0].run ?? 'exit 0'], {
      encoding: 'utf8',
      env: { ...process.env, RESULTS: JSON.stringify(results) },
    });
    expect(execution.status).toBe(1);
    expect(execution.stdout).toContain('test-auth-mirror: cancelled');
  });

  it('runs this YAML contract without a changed-file path gate', () => {
    const contract = workflow.jobs.guards.steps.find((step) =>
      step.run?.includes('scripts/__tests__/ci-auth-mirror-workflow.test.ts'),
    );
    expect(contract).toBeDefined();
    expect(contract?.if).not.toContain('needs.changes');
    expect(contract?.run).toContain('vp test run --project scripts');
    expect(contract?.run).toContain('--maxWorkers=2');
    expect(contract?.['continue-on-error']).toBeUndefined();
  });
});
