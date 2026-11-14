import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const providerConfigPath = 'packages/backend/vite.provider-credential-writer-proof.config.ts';
const firstPasswordConfigPath = 'packages/backend/vite.first-password-proof.config.ts';
const firstPasswordConfiguration = readFileSync(firstPasswordConfigPath, 'utf8');
const nativeHandoffConfigPath = 'packages/backend/vite.native-handoff-proof.config.ts';
const nativeHandoffConfiguration = readFileSync(nativeHandoffConfigPath, 'utf8');
const browserRenewalConfigPath = 'packages/backend/vite.browser-renewal-proof.config.ts';
const browserRenewalConfiguration = readFileSync(browserRenewalConfigPath, 'utf8');
const providerConfiguration = readFileSync(providerConfigPath, 'utf8');
const bootstrapPath = 'packages/backend/scripts/bootstrap-credential-writer-proof-database.sh';
const bootstrap = readFileSync(bootstrapPath, 'utf8');
const historicalFixturePath =
  'packages/backend/src/auth/authority/__tests__/fixtures/credential-writer-historical-fixture.ts';

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

  it('runs pinned historical0312 and current provider/first-password fixtures as full serial uncached tasks', () => {
    const historicalBootstrapIndex = proof.steps.findIndex(
      (step) => step.run === `bash ${bootstrapPath} --historical-private-browser-v1`,
    );
    const historicalTaskIndex = proof.steps.findIndex((step) => step.run?.includes('vp run test:credential-writer'));
    const bootstrapIndex = proof.steps.findIndex((step) => step.run === `bash ${bootstrapPath}`);
    const taskIndex = proof.steps.findIndex((step) => step.run?.includes('vp run test:provider-credential-writer'));
    const firstPasswordTaskIndex = proof.steps.findIndex((step) =>
      step.run?.includes('vp run test:first-password-credential-writer'),
    );
    const nativeHandoffTaskIndex = proof.steps.findIndex((step) =>
      step.run?.includes('vp run test:native-handoff-credential-writer'),
    );
    const browserRenewalTaskIndex = proof.steps.findIndex((step) =>
      step.run?.includes('vp run test:browser-renewal-credential-writer'),
    );
    expect(historicalBootstrapIndex).toBeGreaterThan(-1);
    expect(historicalTaskIndex).toBeGreaterThan(historicalBootstrapIndex);
    expect(bootstrapIndex).toBeGreaterThan(historicalTaskIndex);
    expect(taskIndex).toBeGreaterThan(bootstrapIndex);
    expect(firstPasswordTaskIndex).toBeGreaterThan(taskIndex);
    expect(nativeHandoffTaskIndex).toBeGreaterThan(firstPasswordTaskIndex);
    expect(browserRenewalTaskIndex).toBeGreaterThan(nativeHandoffTaskIndex);
    const historicalEnvironment = {
      PGDATABASE: 'epic6975_credential_historical_ci',
      CREDENTIAL_WRITER_PROOF_DATABASE_URL:
        'postgresql://postgres:postgres@127.0.0.1:5432/epic6975_credential_historical_ci',
    };
    expect(proof.steps[historicalBootstrapIndex].env).toEqual(historicalEnvironment);
    expect(proof.steps[historicalTaskIndex].env).toEqual(historicalEnvironment);
    expect(proof.steps[bootstrapIndex].env).toBeUndefined();
    expect(proof.steps[taskIndex].env).toBeUndefined();
    expect(proof.steps[firstPasswordTaskIndex].env).toBeUndefined();
    expect(proof.steps[nativeHandoffTaskIndex].env).toBeUndefined();
    expect(proof.steps[browserRenewalTaskIndex].env).toBeUndefined();
    for (const index of [
      historicalBootstrapIndex,
      historicalTaskIndex,
      bootstrapIndex,
      taskIndex,
      firstPasswordTaskIndex,
      nativeHandoffTaskIndex,
      browserRenewalTaskIndex,
    ]) {
      expect(proof.steps[index].if).toBeUndefined();
      expect(proof.steps[index]['continue-on-error']).toBeUndefined();
    }
    for (const [index, taskName, config, artifact] of [
      [historicalTaskIndex, 'test:credential-writer', proofConfigPath, 'junit-credential-writer.xml'],
      [taskIndex, 'test:provider-credential-writer', providerConfigPath, 'junit-provider-credential-writer.xml'],
      [
        firstPasswordTaskIndex,
        'test:first-password-credential-writer',
        firstPasswordConfigPath,
        'junit-first-password-credential-writer.xml',
      ],
      [
        nativeHandoffTaskIndex,
        'test:native-handoff-credential-writer',
        nativeHandoffConfigPath,
        'junit-native-handoff-credential-writer.xml',
      ],
      [
        browserRenewalTaskIndex,
        'test:browser-renewal-credential-writer',
        browserRenewalConfigPath,
        'junit-browser-renewal-credential-writer.xml',
      ],
    ] as const) {
      expect(proof.steps[index].run).toContain('--reporter=junit');
      expect(proof.steps[index].run).toContain(`--outputFile.junit=./test-results/${artifact}`);
      expect(proof.steps[index].run).toContain(`test -s packages/backend/test-results/${artifact}`);
      expect(proof.steps[index].run).not.toMatch(/--changed|--shard|\.proof\.ts/);
      const task = rootSource.slice(
        rootSource.indexOf(`'${taskName}': {`),
        rootSource.indexOf("'test:auth-authority': {"),
      );
      expect(task).toContain(`vp test run --config ${config} --maxWorkers=1 --reporter=agent`);
      expect(task).toContain('cache: false');
      expect(task).not.toMatch(/--changed|--shard|dependsOn/);
    }
    for (const configuration of [
      proofConfiguration,
      providerConfiguration,
      firstPasswordConfiguration,
      nativeHandoffConfiguration,
      browserRenewalConfiguration,
    ]) {
      expect(configuration).toContain('maxWorkers: 1');
      expect(configuration).toContain('fileParallelism: false');
    }
    expect(proofConfiguration).toContain("AUTH_CREDENTIAL_HTTP_CONTRACT: ''");
    expect(providerConfiguration).toContain("AUTH_CREDENTIAL_HTTP_CONTRACT: 'private-provider-v1'");
    expect(firstPasswordConfiguration).toContain("AUTH_CREDENTIAL_HTTP_CONTRACT: 'private-first-password-v1'");
    expect(nativeHandoffConfiguration).toContain("AUTH_CREDENTIAL_HTTP_CONTRACT: 'private-native-handoff-v1'");
    expect(browserRenewalConfiguration).toContain("AUTH_CREDENTIAL_HTTP_CONTRACT: 'private-browser-renewal-v1'");
    for (const file of ['credential-writer-http.proof.ts', 'browser-credential-writer-http.proof.ts']) {
      expect(proofConfiguration).toContain(file);
      expect(providerConfiguration).toContain(file);
      expect(firstPasswordConfiguration).toContain(file);
      expect(nativeHandoffConfiguration).toContain(file);
      expect(browserRenewalConfiguration).toContain(file);
    }
    expect(proofConfiguration).toContain('credential-writer-acl.proof.ts');
    expect(proofConfiguration).toContain('browser-credential-writer.proof.ts');
    expect(proofConfiguration).not.toContain('provider-credential-writer.proof.ts');
    expect(providerConfiguration).toContain('provider-credential-writer.proof.ts');
    expect(providerConfiguration).toContain('provider-security-http.proof.ts');
    for (const file of [
      'browser-renewal-credential-writer.proof.ts',
      'provider-security-http.proof.ts',
      'first-password-http.proof.ts',
      'anonymous-provider-http.proof.ts',
    ]) {
      expect(browserRenewalConfiguration).toContain(file);
      expect(existsSync(`packages/backend/src/auth/authority/__tests__/${file}`)).toBe(true);
    }
    for (const file of [
      'native-handoff-credential-writer.proof.ts',
      'provider-security-http.proof.ts',
      'first-password-http.proof.ts',
    ])
      expect(nativeHandoffConfiguration).toContain(file);
    for (const file of [
      'provider-security-http.proof.ts',
      'first-password-credential-writer.proof.ts',
      'first-password-http.proof.ts',
    ]) {
      expect(firstPasswordConfiguration).toContain(file);
      expect(existsSync(`packages/backend/src/auth/authority/__tests__/${file}`)).toBe(true);
    }
    for (const file of ['provider-credential-writer.proof.ts', 'provider-security-http.proof.ts'])
      expect(existsSync(`packages/backend/src/auth/authority/__tests__/${file}`)).toBe(true);
    expect(bootstrap).toContain('packages/db/docker/apply-drizzle-migrations.sh');
    expect(bootstrap).not.toMatch(/db:migrate|DROP DATABASE|DROP SCHEMA/);
  });

  it('pins historical provenance before any fixture database creation or mutation', () => {
    const historical = readFileSync(historicalFixturePath, 'utf8');
    expect(historical).toContain('count: 313');
    expect(historical).toContain("lastTag: '0312_browser_selection_possession'");
    expect(historical).toContain('ed600748d4863fa4dd7c7a4286041db19c1738085d57410554893d7916a4b5c8');
    expect(historical).toContain('0e32ca2c7e0071b5404fbca9ae5e852d5a0af3a1c9a03019268595032007ae06');
    const materialize = bootstrap.indexOf(
      'vp exec tsx packages/backend/src/auth/authority/__tests__/fixtures/prepare-credential-writer-historical-fixture.ts',
    );
    expect(materialize).toBeGreaterThan(-1);
    expect(bootstrap.indexOf('createdb --maintenance-db=postgres')).toBeGreaterThan(materialize);
    expect(bootstrap.indexOf('psql -X')).toBeGreaterThan(materialize);
    expect(bootstrap).not.toMatch(/MIGRATION_CUTOFF|MIGRATION_LIMIT|JOURNAL_PREFIX|SKIP.*PROVENANCE/);
    const checkIndex = proof.steps.findIndex((step) =>
      step.run?.includes('credential-writer-historical-fixture.test.ts'),
    );
    expect(checkIndex).toBeGreaterThan(-1);
    expect(checkIndex).toBeLessThan(
      proof.steps.findIndex((step) => step.run?.includes('--historical-private-browser-v1')),
    );
  });

  it('keeps the explicit proof outside service-free default projects and runs this guard unconditionally', () => {
    for (const configuration of [proofConfigPath, providerConfigPath, firstPasswordConfigPath])
      expect(rootSource.slice(rootSource.indexOf('projects:'), rootSource.indexOf('projects:') + 10_000)).not.toContain(
        `'./${configuration}'`,
      );
    for (const project of ['credential-writer-proof', 'provider-credential-writer-proof', 'first-password-proof'])
      expect(selectTestDefaultProjects(rootSource, (path) => readFileSync(path, 'utf8'))).not.toContain(project);
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
    expect(String(upload?.with?.path).trim().split('\n')).toEqual([
      'packages/backend/test-results/junit-credential-writer.xml',
      'packages/backend/test-results/junit-provider-credential-writer.xml',
      'packages/backend/test-results/junit-first-password-credential-writer.xml',
      'packages/backend/test-results/junit-native-handoff-credential-writer.xml',
      'packages/backend/test-results/junit-browser-renewal-credential-writer.xml',
    ]);
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
      writeFileSync(
        join(directory, 'createdb'),
        '#!/bin/sh\nprintf createdb >> "$CREDENTIAL_BOUNDARY_MARKER"\nexit 77\n',
        { mode: 0o755 },
      );
      // Exercise the actual checked-in Node URL validator. The fake vp permits
      // only that local invocation, so later tsx/bootstrap execution is trapped.
      writeFileSync(
        join(directory, 'vp'),
        '#!/bin/sh\nif [ "$#" = 3 ] && [ "$1" = exec ] && [ "$2" = node ] && [ "$3" = --input-type=module ]; then\n  exec "$CREDENTIAL_BOUNDARY_NODE" --input-type=module\nfi\nif [ "$#" = 5 ] && [ "$1" = exec ] && [ "$2" = tsx ] && [ "$3" = packages/backend/src/auth/authority/__tests__/fixtures/prepare-credential-writer-historical-fixture.ts ] && [ "$4" = --out ]; then\n  printf historical-helper >> "$CREDENTIAL_BOUNDARY_MARKER"\n  exit 77\nfi\nprintf unexpected-vp >> "$CREDENTIAL_BOUNDARY_MARKER"\nexit 77\n',
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
      for (const argument of ['--cutoff=313', '--skip-provenance', '--historical-private-provider-v1']) {
        const execution = spawnSync('bash', [resolve(bootstrapPath), argument], {
          env: baseline,
          encoding: 'utf8',
          timeout: 10_000,
        });
        expect(execution.status).not.toBe(0);
        expect(execution.error).toBeUndefined();
        expect(() => readFileSync(marker)).toThrow();
      }
      for (const [arguments_, database] of [
        [[], 'epic6975_credential_historical_ci'],
        [['--historical-private-browser-v1'], 'epic6975_credential_ci'],
      ] as const) {
        const execution = spawnSync('bash', [resolve(bootstrapPath), ...arguments_], {
          env: {
            ...baseline,
            CI: 'true',
            GITHUB_ACTIONS: 'true',
            PGPORT: '5432',
            PGDATABASE: database,
            CREDENTIAL_WRITER_PROOF_DATABASE_URL: `postgresql://postgres:owned-fixture-only@127.0.0.1:5432/${database}`,
          },
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
      rmSync(marker);
      // A valid historical target reaches only its fixed provenance helper.
      // Failing that helper must stop before createdb/psql; its real contents
      // are covered by the seven pure-file tests and owned bootstrap replay.
      const historical = spawnSync('bash', [resolve(bootstrapPath), '--historical-private-browser-v1'], {
        env: {
          ...baseline,
          CI: 'true',
          GITHUB_ACTIONS: 'true',
          PGPORT: '5432',
          PGDATABASE: 'epic6975_credential_historical_ci',
          CREDENTIAL_WRITER_PROOF_DATABASE_URL:
            'postgresql://postgres:owned-fixture-only@127.0.0.1:5432/epic6975_credential_historical_ci',
        },
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(historical.status).not.toBe(0);
      expect(historical.error).toBeUndefined();
      expect(readFileSync(marker, 'utf8')).toBe('historical-helper');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
