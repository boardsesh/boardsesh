/// <reference types="node" />
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { selectTestDefaultProjects } from '../ci-test-default-projects';

interface WorkflowStep {
  if?: string;
  run?: string;
  env?: Record<string, string>;
  'continue-on-error'?: boolean;
}
interface WorkflowJob {
  needs?: string[];
  if?: string;
  env?: Record<string, string>;
  'runs-on': string;
  'timeout-minutes'?: number;
  'continue-on-error'?: boolean;
  strategy?: unknown;
  services?: Record<string, { image: string; env: Record<string, string>; ports: string[] }>;
  steps: WorkflowStep[];
}
const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as { jobs: Record<string, WorkflowJob> };
const fence = workflow.jobs['test-auth-fence'];
const rootSource = readFileSync('vite.config.ts', 'utf8');
const bootstrap = 'bash packages/backend/scripts/bootstrap-credential-writer-proof-database.sh';

// YAML reads have no affected-test graph edge, so the guards job runs this
// contract unconditionally: a workflow-only edit cannot quietly skip the proof.
describe('BA-04 writer fence CI proof', () => {
  it('runs for every backend input on its own hosted runner', () => {
    expect(fence.needs).toEqual(['changes']);
    expect(fence.if).toBe(workflow.jobs['test-backend'].if);
    expect(fence['runs-on']).toBe('ubuntu-latest');
    expect(fence['timeout-minutes']).toBe(10);
    expect(fence.strategy).toBeUndefined();
    expect(fence['continue-on-error']).toBeUndefined();
  });

  it('owns a separate PG18/PostGIS cluster on the credential proof image', () => {
    expect(Object.keys(fence.services ?? {})).toEqual(['postgres']);
    expect(fence.services?.postgres.image).toBe(workflow.jobs['test-credential-writer'].services?.postgres.image);
    expect(fence.services?.postgres.env).toEqual({
      POSTGRES_USER: 'postgres',
      POSTGRES_PASSWORD: 'postgres',
      POSTGRES_DB: 'epic6975_credential_ci',
    });
    expect(fence.services?.postgres.ports).toEqual(['5432:5432']);
    // The proof never reads the product connection string.
    const variableNames = [fence.env, ...fence.steps.map((step) => step.env)].flatMap((env) => Object.keys(env ?? {}));
    expect(variableNames).not.toContain('DATABASE_URL');
    expect(variableNames).not.toContain('WEB_DATABASE_URL');
  });

  it('migrates, dumps the schema, then runs every fence case with none skipped', () => {
    const bootstrapIndex = fence.steps.findIndex((step) => step.run === bootstrap);
    const dumpIndex = fence.steps.findIndex((step) => step.run?.includes('pg_dump'));
    const proofIndex = fence.steps.findIndex((step) => step.run?.includes('vp run test:auth-fence'));
    expect(bootstrapIndex).toBeGreaterThan(-1);
    expect(dumpIndex).toBeGreaterThan(bootstrapIndex);
    expect(proofIndex).toBeGreaterThan(dumpIndex);
    for (const index of [bootstrapIndex, dumpIndex, proofIndex]) {
      expect(fence.steps[index].if).toBeUndefined();
      expect(fence.steps[index]['continue-on-error']).toBeUndefined();
    }
    expect(fence.steps[bootstrapIndex].env).toMatchObject({
      PGPORT: '5432',
      PGDATABASE: 'epic6975_credential_ci',
      CREDENTIAL_WRITER_PROOF_DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/epic6975_credential_ci',
    });
    expect(fence.steps[dumpIndex].run).toContain('--schema-only');
    expect(fence.steps[dumpIndex].run).not.toMatch(/--data-only|--inserts|COPY/);
    const proof = fence.steps[proofIndex];
    // The full-schema suite skips itself without both; a loopback admin URL only.
    expect(proof.env).toEqual({
      AUTH_FENCE_TEST_SCHEMA_FILE: '${{ runner.temp }}/auth-fence-schema.sql',
      AUTH_FENCE_TEST_DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/postgres',
    });
    expect(proof.run).toContain('--reporter=junit');
    expect(proof.run).toContain('test -s packages/backend/test-results/junit-auth-fence.xml');
    expect(proof.run).toContain('/<skipped');
    expect(proof.run).toContain('fullSchema < 18');
    expect(proof.run).not.toMatch(/--changed|--shard|-t /);
    const task = rootSource.slice(
      rootSource.indexOf("'test:auth-fence': {"),
      rootSource.indexOf("'test:auth-web-credential-proof': {"),
    );
    expect(task).toContain('vp test run --config packages/backend/vite.auth-fence.config.ts --maxWorkers=1');
    expect(task).toContain('cache: false');
    expect(task).not.toMatch(/--changed|--shard|dependsOn/);
  });

  it('exposes the operator CLI as an uncached task', () => {
    const task = rootSource.slice(
      rootSource.indexOf("'auth:fence': {"),
      rootSource.indexOf("'test:auth-identities': {"),
    );
    expect(task).toContain("command: 'tsx packages/backend/src/scripts/auth-fence.ts'");
    expect(task).toContain('cache: false');
  });

  it('keeps the database proof out of the service-free default projects', () => {
    expect(rootSource.slice(rootSource.indexOf('projects:'), rootSource.indexOf('projects:') + 10_000)).not.toContain(
      "'./packages/backend/vite.auth-fence.config.ts'",
    );
    expect(selectTestDefaultProjects(rootSource, (path) => readFileSync(path, 'utf8'))).not.toContain('auth-fence');
  });

  it('is required, and this guard runs unconditionally', () => {
    const status = workflow.jobs['ci-status'];
    expect(status.needs).toContain('test-auth-fence');
    for (const result of ['failure', 'cancelled']) {
      const results = Object.fromEntries(
        (status.needs ?? []).map((name) => [name, { result: name === 'test-auth-fence' ? result : 'success' }]),
      );
      const execution = spawnSync('bash', ['-c', status.steps[0].run ?? 'exit 0'], {
        encoding: 'utf8',
        env: { ...process.env, RESULTS: JSON.stringify(results) },
      });
      expect(execution.status).toBe(1);
      expect(execution.stdout).toContain(`test-auth-fence: ${result}`);
    }
    const guard = workflow.jobs.guards.steps.find((step) =>
      step.run?.includes('scripts/__tests__/ci-auth-fence-workflow.test.ts'),
    );
    expect(guard?.if).not.toContain('needs.changes');
    expect(guard?.run).not.toContain('--changed');
  });
});
