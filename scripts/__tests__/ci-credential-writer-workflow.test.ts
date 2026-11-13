import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { selectTestDefaultProjects } from '../ci-test-default-projects';

interface WorkflowStep {
  id?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
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
  services?: Record<
    string,
    {
      image: string;
      env: Record<string, string>;
      ports: string[];
      options?: string;
    }
  >;
  steps: WorkflowStep[];
}
const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as { jobs: Record<string, WorkflowJob> };
const proof = workflow.jobs['test-credential-writer'];
const rootSource = readFileSync('vite.config.ts', 'utf8');
const proofConfigPath = 'packages/backend/vite.credential-writer-proof.config.ts';
const proofConfiguration = readFileSync(proofConfigPath, 'utf8');
const bootstrapPath = 'packages/backend/scripts/bootstrap-credential-writer-proof-database.sh';
const bootstrap = readFileSync(bootstrapPath, 'utf8');

// File-based workflow/bootstrap inputs need an unconditional guard: affected
// test selection does not derive their dependency graph from readFileSync.
describe('owned credential writer CI boundary', () => {
  it('runs unsharded on an independent required backend dependency gate', () => {
    expect(proof.needs).toEqual(['changes']);
    expect(proof.if).toBe(workflow.jobs['test-backend'].if);
    expect(proof['runs-on']).toBe('ubuntu-latest');
    expect(proof['timeout-minutes']).toBe(15);
    expect(proof.strategy).toBeUndefined();
    expect(proof['continue-on-error']).toBeUndefined();
    expect(workflow.jobs['ci-status'].needs).toContain('test-credential-writer');
  });

  it('owns a fresh database on the existing pinned PG18/PostGIS image', () => {
    expect(Object.keys(proof.services ?? {})).toEqual(['postgres']);
    expect(proof.services?.postgres.image).toBe(workflow.jobs['test-backend'].services?.postgres.image);
    expect(proof.services?.postgres.image).toMatch(
      /^ghcr\.io\/boardsesh\/boardsesh-postgres-postgis@sha256:[a-f0-9]{64}$/,
    );
    expect(proof.services?.postgres.env).toEqual({
      POSTGRES_USER: 'postgres',
      POSTGRES_PASSWORD: 'postgres',
      POSTGRES_DB: 'epic6975_credential_ci',
    });
    expect(proof.services?.postgres.ports).toEqual(['5432:5432']);
    expect(proof.env).toEqual({
      PGHOST: '127.0.0.1',
      PGPORT: '5432',
      PGUSER: 'postgres',
      PGPASSWORD: 'postgres',
      PGDATABASE: 'epic6975_credential_ci',
      CREDENTIAL_WRITER_PROOF_DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/epic6975_credential_ci',
    });
    expect(proof.env).not.toHaveProperty('DATABASE_URL');
  });

  it('bootstraps canonically before the full uncached catalog and HTTP task', () => {
    const bootstrapIndex = proof.steps.findIndex((step) => step.run === `bash ${bootstrapPath}`);
    const taskIndex = proof.steps.findIndex((step) => step.run?.includes('vp run test:credential-writer'));
    expect(bootstrapIndex).toBeGreaterThan(-1);
    expect(taskIndex).toBeGreaterThan(bootstrapIndex);
    expect(proof.steps[bootstrapIndex].if).toBeUndefined();
    expect(proof.steps[taskIndex].if).toBeUndefined();
    expect(proof.steps[taskIndex]['continue-on-error']).toBeUndefined();
    expect(proof.steps[taskIndex].run).toContain('--reporter=junit');
    expect(proof.steps[taskIndex].run).toContain('--outputFile.junit=./test-results/junit-credential-writer.xml');
    expect(proof.steps[taskIndex].run).not.toMatch(/--changed|--shard|\.proof\.ts/);
    expect(rootSource).toContain("'test:credential-writer': {");
    const task = rootSource.slice(
      rootSource.indexOf("'test:credential-writer': {"),
      rootSource.indexOf("'test:auth-authority': {"),
    );
    expect(task).toContain(`vp test run --config ${proofConfigPath} --maxWorkers=1 --reporter=agent`);
    expect(task).toContain('cache: false');
    expect(task).not.toMatch(/--changed|--shard|dependsOn/);
    expect(proofConfiguration).toContain("include: ['src/auth/authority/__tests__/*credential*writer*.proof.ts']");
    expect(proofConfiguration).toContain('maxWorkers: 1');
    expect(proofConfiguration).toContain('fileParallelism: false');
    expect(bootstrap).toContain('packages/db/docker/apply-drizzle-migrations.sh');
    expect(bootstrap).not.toMatch(/db:migrate|DROP DATABASE|DROP SCHEMA/);
  });

  it('keeps the explicit proof outside service-free default projects and runs this guard unconditionally', () => {
    expect(rootSource.slice(rootSource.indexOf('projects:'), rootSource.indexOf('projects:') + 10_000)).not.toContain(
      `'./${proofConfigPath}'`,
    );
    expect(selectTestDefaultProjects(rootSource, (path) => readFileSync(path, 'utf8'))).not.toContain(
      'credential-writer-proof',
    );
    const guard = workflow.jobs.guards.steps.find((step) =>
      step.run?.includes('scripts/__tests__/ci-credential-writer-workflow.test.ts'),
    );
    expect(guard).toBeDefined();
    expect(guard?.if).not.toContain('needs.changes');
    expect(guard?.run).toContain('vp test run --project scripts');
    expect(guard?.run).not.toContain('--changed');
    expect(guard?.['continue-on-error']).toBeUndefined();
    const upload = proof.steps.find((step) => step.with?.name === 'test-results-credential-writer');
    expect(upload?.if).toBe('always()');
    expect(upload?.with?.path).toBe('packages/backend/test-results/junit-credential-writer.xml');
  });

  it.each(['failure', 'cancelled'])('propagates %s to the required aggregate', (result) => {
    const status = workflow.jobs['ci-status'];
    const results = Object.fromEntries(
      (status.needs ?? []).map((name) => [name, { result: name === 'test-credential-writer' ? result : 'success' }]),
    );
    const execution = spawnSync('bash', ['-c', status.steps[0].run ?? 'exit 0'], {
      encoding: 'utf8',
      env: { ...process.env, RESULTS: JSON.stringify(results) },
    });
    expect(execution.status).toBe(1);
    expect(execution.stdout).toContain(`test-credential-writer: ${result}`);
  });

  it('rejects invalid targets before any database, bootstrap helper or network call', () => {
    const directory = mkdtempSync(join(tmpdir(), 'credential-bootstrap-boundary-'));
    const marker = join(directory, 'unexpected-side-effect');
    const networkGuard = join(directory, 'network-guard.cjs');
    try {
      writeFileSync(join(directory, 'psql'), '#!/bin/sh\nprintf psql >> "$CREDENTIAL_BOUNDARY_MARKER"\nexit 77\n', {
        mode: 0o755,
      });
      // Exercise the actual checked-in Node URL validator. The fake vp permits
      // only that local invocation, so later tsx/bootstrap execution is trapped.
      writeFileSync(
        join(directory, 'vp'),
        '#!/bin/sh\nif [ "$#" = 3 ] && [ "$1" = exec ] && [ "$2" = node ] && [ "$3" = --input-type=module ]; then\n  exec "$CREDENTIAL_BOUNDARY_NODE" --input-type=module\nfi\nprintf unexpected-vp >> "$CREDENTIAL_BOUNDARY_MARKER"\nexit 77\n',
        { mode: 0o755 },
      );
      writeFileSync(
        networkGuard,
        `const fs=require('node:fs');const refuse=()=>{fs.appendFileSync(process.env.CREDENTIAL_BOUNDARY_MARKER,'network');throw Error('UNEXPECTED_NETWORK')};require('node:net').Socket.prototype.connect=refuse;require('node:dns').lookup=refuse;globalThis.fetch=refuse;`,
      );
      for (const command of ['curl', 'wget', 'docker', 'nc'])
        writeFileSync(
          join(directory, command),
          '#!/bin/sh\nprintf network-command >> "$CREDENTIAL_BOUNDARY_MARKER"\nexit 77\n',
          { mode: 0o755 },
        );
      const baseline = {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ''}`,
        NODE_OPTIONS: `--require=${networkGuard}`,
        CREDENTIAL_BOUNDARY_NODE: process.execPath,
        CREDENTIAL_BOUNDARY_MARKER: marker,
        PGHOSTADDR: '',
        PGSERVICE: '',
        PGSERVICEFILE: '',
        PGSYSCONFDIR: '',
        PGOPTIONS: '',
        PGHOST: '127.0.0.1',
        PGPORT: '55480',
        PGUSER: 'postgres',
        PGPASSWORD: 'owned-fixture-only',
        PGDATABASE: 'epic6975_credential_20261115',
        CREDENTIAL_WRITER_PROOF_DATABASE_URL:
          'postgresql://postgres:owned-fixture-only@127.0.0.1:55480/epic6975_credential_20261115',
      };
      const invalid = [
        { PGHOSTADDR: '203.0.113.1' },
        { PGSERVICE: 'unreviewed-service' },
        { PGSERVICEFILE: '/unreviewed/pg_service.conf' },
        { PGSYSCONFDIR: '/unreviewed' },
        { PGOPTIONS: '-c role=postgres -c search_path=unreviewed' },
        { PGHOST: 'remote.example.test' },
        { PGPORT: '5432' },
        { PGDATABASE: 'boardsesh_dev' },
        ...[
          'postgresql://postgres:owned-fixture-only@127.0.0.1:55480/epic6975_credential_20261116',
          'postgresql://other:owned-fixture-only@127.0.0.1:55480/epic6975_credential_20261115',
          'postgresql://postgres:wrong@127.0.0.1:55480/epic6975_credential_20261115',
          'postgresql://postgres:owned-fixture-only@localhost:55480/epic6975_credential_20261115',
          `${baseline.CREDENTIAL_WRITER_PROOF_DATABASE_URL}?options=-crole=postgres`,
          `${baseline.CREDENTIAL_WRITER_PROOF_DATABASE_URL}#fragment`,
        ].map((target) => ({ CREDENTIAL_WRITER_PROOF_DATABASE_URL: target })),
      ];
      for (const patch of invalid) {
        const execution = spawnSync('bash', [resolve(bootstrapPath)], {
          env: { ...baseline, ...patch },
          encoding: 'utf8',
          timeout: 10_000,
        });
        expect(execution.status).not.toBe(0);
        expect(execution.error).toBeUndefined();
        expect(() => readFileSync(marker)).toThrow();
      }
      // A valid local target must reach the trapped first catalog probe. This
      // positive control rejects a guard that merely fails every invocation.
      const positive = spawnSync('bash', [resolve(bootstrapPath)], {
        env: baseline,
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(positive.status).not.toBe(0);
      expect(positive.error).toBeUndefined();
      expect(readFileSync(marker, 'utf8')).toBe('psql');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
