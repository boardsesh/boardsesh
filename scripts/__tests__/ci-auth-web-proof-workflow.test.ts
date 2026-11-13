/// <reference types="node" />

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
const providerProofFiles = ['provider-security-auth.proof.ts', 'provider-security-publication.proof.ts'];
const cookieProofFiles = ['browser-proof-cookies.proof.ts', 'provider-security-cookie-recovery.proof.ts'];
const task = 'vp run test:auth-web-credential-proof';

describe('database-backed backend/web credential proof placement', () => {
  it('keeps backend source imports outside the web-only build and default web tests', () => {
    expect(existsSync(`packages/web/auth-prototype/${proofFile}`)).toBe(true);
    expect(existsSync('packages/web/app/lib/auth/__tests__/web-credential-proof.integration.test.ts')).toBe(false);
    for (const filename of providerProofFiles) {
      expect(existsSync(`packages/web/auth-prototype/${filename}`)).toBe(true);
      expect(existsSync(`packages/web/app/lib/auth/__tests__/${filename.replace('.proof.ts', '.test.ts')}`)).toBe(
        false,
      );
    }
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
    expect(configuration.include).toEqual(expect.arrayContaining(providerProofFiles));
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

  it('runs every proof case in the required compatibility job with PostgreSQL', () => {
    const backend = workflow.jobs['test-auth-compatibility'];
    const steps = backend.steps.filter((step) => step.run === task);
    expect(steps).toHaveLength(1);
    expect(steps[0].if).toBe('${{ !cancelled() }}');
    expect(steps[0].env?.AUTH_PROTOTYPE_DATABASE_URL).toBe('postgresql://postgres:postgres@localhost:5433/postgres');
    expect(backend.services?.postgres.ports).toContain('5433:5432');
    expect(steps[0]['continue-on-error']).toBeUndefined();
    const allProofs = Object.values(workflow.jobs).flatMap((job) => job.steps.filter((step) => step.run === task));
    expect(allProofs).toHaveLength(1);
  });

  it('selects only the explicit node proof and never the database-free default project', () => {
    const configuration = readFileSync('packages/web/auth-prototype/credential-proof.vite.config.ts', 'utf8');
    expect(configuration).toContain("environment: 'node'");
    for (const filename of [proofFile, ...providerProofFiles])
      expect(configuration).toContain(`'auth-prototype/${filename}'`);
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
  it('runs both actual-cookie proofs explicitly in the required post-install task', () => {
    const configuration = readFileSync('packages/web/auth-prototype/browser-proof-cookies.vite.config.ts', 'utf8');
    const types = JSON.parse(readFileSync('packages/web/auth-prototype/tsconfig.json', 'utf8')) as {
      include: string[];
    };
    for (const file of cookieProofFiles) {
      expect(existsSync(`packages/web/auth-prototype/${file}`)).toBe(true);
      expect(configuration).toContain(`'auth-prototype/${file}'`);
      expect(types.include).toContain(file);
    }
    const tasks = readFileSync('vite.config.ts', 'utf8');
    const start = tasks.indexOf("'test:auth-browser-proof-cookies':");
    expect(start).toBeGreaterThanOrEqual(0);
    const task = tasks.slice(start, tasks.indexOf("'test:offline-sync':", start));
    expect(task).toContain('browser-proof-cookies.vite.config.ts');
    expect(task).toContain("dependsOn: ['typecheck:auth-prototype-browser']");
    expect(task).toContain('--maxWorkers=1');
    expect(task).toContain('cache: false');
    expect(task).not.toContain('--changed');
  });
});
