import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Step {
  if?: string;
  run?: string;
  env?: Record<string, string>;
  'continue-on-error'?: boolean;
}
interface Job {
  services?: Record<string, { ports?: string[] }>;
  steps: Step[];
}
const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as { jobs: Record<string, Job> };
const proofFile = 'web-credential-proof.integration.proof.ts';
const task = 'vp run test:auth-web-credential-proof';

describe('database-backed backend/web credential proof placement', () => {
  it('keeps backend source imports outside the web-only build and default web tests', () => {
    expect(existsSync(`packages/web/auth-prototype/${proofFile}`)).toBe(true);
    expect(existsSync('packages/web/app/lib/auth/__tests__/web-credential-proof.integration.test.ts')).toBe(false);
    const typeConfiguration = JSON.parse(readFileSync('packages/web/tsconfig.json', 'utf8')) as {
      exclude: string[];
    };
    expect(typeConfiguration.exclude).toContain('auth-prototype');
    expect(readFileSync('packages/web/vite.config.ts', 'utf8')).toContain("'auth-prototype/**'");
  });

  it('strictly typechecks the proof in the existing separate auth project', () => {
    const configuration = JSON.parse(readFileSync('packages/web/auth-prototype/tsconfig.json', 'utf8')) as {
      include: string[];
    };
    expect(configuration.include).toContain(proofFile);
    expect(configuration.include).toContain('credential-proof.vite.config.ts');
    expect(configuration.include).toContain('../app/lib/auth/types.ts');
    const tasks = readFileSync('vite.config.ts', 'utf8');
    const typecheckStart = tasks.indexOf("'typecheck:auth-prototype-browser':");
    const typecheck = tasks.slice(typecheckStart, tasks.indexOf("'typecheck:ble-protocol':", typecheckStart));
    expect(typecheck).toContain('cache: false');
    const start = tasks.indexOf("'test:auth-web-credential-proof':");
    expect(start).toBeGreaterThanOrEqual(0);
    const definition = tasks.slice(start, tasks.indexOf("'test:auth-prototype:browser':", start));
    expect(definition).toContain("dependsOn: ['typecheck:auth-prototype-browser']");
    expect(definition).toContain('--maxWorkers=1');
    expect(definition).not.toContain('--changed');
  });

  it('runs every proof case in the required backend job with PostgreSQL', () => {
    const backend = workflow.jobs['test-backend'];
    const steps = backend.steps.filter((step) => step.run === task);
    expect(steps).toHaveLength(1);
    expect(steps[0].if).toBe('${{ !cancelled() && matrix.shard == 1 }}');
    expect(steps[0].env?.AUTH_PROTOTYPE_DATABASE_URL).toBe('postgresql://postgres:postgres@localhost:5433/postgres');
    expect(backend.services?.postgres.ports).toContain('5433:5432');
    expect(steps[0]['continue-on-error']).toBeUndefined();
    const allProofs = Object.values(workflow.jobs).flatMap((job) => job.steps.filter((step) => step.run === task));
    expect(allProofs).toHaveLength(1);
  });

  it('selects only the explicit node proof and never the database-free default project', () => {
    const configuration = readFileSync('packages/web/auth-prototype/credential-proof.vite.config.ts', 'utf8');
    expect(configuration).toContain("environment: 'node'");
    expect(configuration).toContain(`include: ['auth-prototype/${proofFile}']`);
    expect(configuration).toContain('maxWorkers: 1');
  });

  it('runs the placement guard unconditionally for YAML-only changes', () => {
    const step = workflow.jobs.guards.steps.find((candidate) =>
      candidate.run?.includes('scripts/__tests__/ci-auth-web-proof-workflow.test.ts'),
    );
    expect(step).toBeDefined();
    expect(step?.if).not.toContain('needs.changes');
    expect(step?.['continue-on-error']).toBeUndefined();
  });
});
