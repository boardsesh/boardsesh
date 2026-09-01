/// <reference types="node" />

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { migrationExecutionContractFromEnvironment } from '../packages/db/scripts/migration-owner-role';
import { PRODUCTION_TASK_ROLE_BY_NAME, PRODUCTION_TASK_ROLES } from './lib/production-db-task-role-contract.mjs';
import {
  PRODUCTION_MIGRATION_CORE_ENVIRONMENT,
  PRODUCTION_MIGRATION_SUBSCRIBER_ENVIRONMENT,
  validateProductionMigrationActivationEnvironment,
} from './lib/production-migration-activation-contract.mjs';

type WorkflowStep = {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
};

type WorkflowJob = {
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
};

type WorkflowDocument = {
  jobs?: Record<string, WorkflowJob>;
  on?: {
    workflow_dispatch?: {
      inputs?: Record<
        string,
        {
          options?: string[];
          type?: string;
        }
      >;
    };
  };
  runs?: {
    steps?: WorkflowStep[];
  };
};

const CONNECT_ACTION = './.github/actions/connect-production-db';
const TAILSCALE_ACTION = 'tailscale/github-action@780049a30b6ff5c378a9e7b389d15ece7a204888';
const MIGRATION_ROLE = 'boardsesh_migrator';

const databaseJobs = [
  {
    path: '.github/workflows/production-deploy.yml',
    job: 'migrate',
    secret: '${{ secrets.MIGRATION_DATABASE_DIRECT_URL }}',
    role: MIGRATION_ROLE,
    applicationName: 'boardsesh-ci-migrate',
  },
  {
    path: '.github/workflows/export-board-snapshots.yml',
    job: 'export',
    secret: '${{ secrets.SNAPSHOT_DATABASE_DIRECT_URL }}',
    role: 'boardsesh_snapshot_exporter',
    applicationName: 'boardsesh-ci-snapshot-export',
  },
  {
    path: '.github/workflows/refresh-climb-grades.yml',
    job: 'refresh',
    secret: '${{ secrets.CLIMB_GRADES_DATABASE_DIRECT_URL }}',
    role: 'boardsesh_climb_grades_refresh',
    applicationName: 'boardsesh-ci-climb-grades',
  },
  {
    path: '.github/workflows/refresh-content-model.yml',
    job: 'refresh',
    secret: '${{ secrets.CONTENT_MODEL_DATABASE_DIRECT_URL }}',
    role: 'boardsesh_content_model_refresh',
    applicationName: 'boardsesh-ci-content-model',
  },
  {
    path: '.github/workflows/refresh-hold-features.yml',
    job: 'refresh',
    secret: '${{ secrets.HOLD_FEATURES_DATABASE_DIRECT_URL }}',
    role: 'boardsesh_hold_features_refresh',
    applicationName: 'boardsesh-ci-hold-features',
  },
  {
    path: '.github/workflows/refresh-recommendations.yml',
    job: 'refresh',
    secret: '${{ secrets.RECOMMENDATIONS_DATABASE_DIRECT_URL }}',
    role: 'boardsesh_recommendations_refresh',
    applicationName: 'boardsesh-ci-recommendations',
  },
] as const;

function readYaml(path: string): WorkflowDocument {
  return parse(readFileSync(path, 'utf8')) as unknown as WorkflowDocument;
}

function getJob(path: string, name: string): WorkflowJob {
  const job = readYaml(path).jobs?.[name];
  if (!job) throw new Error(`${path} is missing job ${name}`);
  return job;
}

function validateRoute(databaseUrl: string, host: string, expectedRole = MIGRATION_ROLE): void {
  const result = spawnSync(process.execPath, ['scripts/validate-production-db-network-url.mjs'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL_INPUT: databaseUrl,
      EXPECTED_DATABASE_ROLE_INPUT: expectedRole,
      FORWARDER_HOST_INPUT: host,
    },
  });
  if (result.status !== 0) throw new Error(result.stderr.trim());
}

describe('production database network workflow contract', () => {
  it.each(databaseJobs)(
    '$path:$job joins through its exact role and secret',
    ({ path, job: jobName, secret, role, applicationName }) => {
      const job = getJob(path, jobName);
      expect(job.permissions).toMatchObject({ contents: 'read', 'id-token': 'write' });

      const steps = job.steps ?? [];
      const connectIndex = steps.findIndex((step) => step.uses === CONNECT_ACTION);
      expect(connectIndex).toBeGreaterThanOrEqual(0);
      expect(steps[connectIndex]?.with).toEqual({
        'oauth-client-id': '${{ secrets.TS_OAUTH_CLIENT_ID }}',
        audience: '${{ secrets.TS_AUDIENCE }}',
        'forwarder-host': '${{ vars.POSTGRES_FORWARDER_HOST }}',
        'database-url': secret,
        'expected-role': role,
      });

      for (const step of steps) {
        if (!step.uses || step.uses.startsWith('./')) continue;
        expect(step.uses, `${path} has a mutable external action`).toMatch(/@[0-9a-f]{40}$/);
      }

      const databaseStepIndexes = steps
        .map((step, index) => (step.env?.DATABASE_URL ? index : -1))
        .filter((index) => index >= 0);
      expect(databaseStepIndexes.length).toBeGreaterThan(0);
      for (const databaseStepIndex of databaseStepIndexes) {
        expect(databaseStepIndex).toBeGreaterThan(connectIndex);
        const databaseStep = steps[databaseStepIndex];
        expect(databaseStep?.env?.DATABASE_URL).toBe(secret);
        expect(databaseStep?.run).toEqual(expect.any(String));
        expect(databaseStep?.run, `${path} interpolates an expression inside a database-bearing shell`).not.toContain(
          '${{',
        );
      }

      const host = 'boardsesh-db-forwarder.example-tailnet.ts.net';
      expect(() =>
        validateRoute(
          `postgresql://${role}:secret@${host}:5432/railway?application_name=${applicationName}&sslmode=require`,
          host,
          role,
        ),
      ).not.toThrow();
    },
  );

  it('uses six distinct database credentials', () => {
    expect(new Set(databaseJobs.map(({ secret }) => secret))).toHaveProperty('size', databaseJobs.length);
    expect(databaseJobs).toHaveLength(PRODUCTION_TASK_ROLES.length);
    for (const databaseJob of databaseJobs) {
      const roleContract = PRODUCTION_TASK_ROLE_BY_NAME.get(databaseJob.role);
      if (!roleContract) throw new Error(`missing task-role manifest for ${databaseJob.role}`);
      expect(roleContract.applicationName).toBe(databaseJob.applicationName);
      expect(`\${{ secrets.${roleContract.githubSecret} }}`).toBe(databaseJob.secret);
    }
  });

  it('allowlists and safely quotes the hold-feature board dispatch input', () => {
    const workflow = readYaml('.github/workflows/refresh-hold-features.yml');
    const boardInput = workflow.on?.workflow_dispatch?.inputs?.board;
    expect(boardInput).toEqual({
      description: 'Board to refresh (default kilter)',
      type: 'choice',
      required: false,
      default: 'kilter',
      options: ['kilter', 'tension', 'moonboard', 'decoy', 'touchstone', 'grasshopper', 'soill', 'woods'],
    });

    const refreshStep = getJob('.github/workflows/refresh-hold-features.yml', 'refresh').steps?.find(
      (step) => step.name === 'Refresh hold features',
    );
    expect(refreshStep?.env).toMatchObject({
      BOARD: "${{ inputs.board || 'kilter' }}",
      DRY_RUN: "${{ inputs.dry_run && 'true' || 'false' }}",
    });
    expect(refreshStep?.run).toContain('kilter|tension|moonboard|decoy|touchstone|grasshopper|soill|woods)');
    expect(refreshStep?.run).toContain('--board="$BOARD"');
  });

  it('activates the core migration contract and validates the subscriber phase before DDL', () => {
    const migrateJob = getJob('.github/workflows/production-deploy.yml', 'migrate');
    const migrationStep = migrateJob.steps?.find((step) => step.name === 'Run database migrations');
    expect(migrationStep?.env).toEqual({
      DATABASE_URL: '${{ secrets.MIGRATION_DATABASE_DIRECT_URL }}',
      VERIFY_MIGRATION_JOURNAL: '1',
      ...PRODUCTION_MIGRATION_CORE_ENVIRONMENT,
      MIGRATION_SUBSCRIBER_ROLE: '${{ vars.MIGRATION_SUBSCRIBER_ROLE }}',
      MIGRATION_SUBSCRIPTION_NAME: '${{ vars.MIGRATION_SUBSCRIPTION_NAME }}',
    });
    expect(migrationStep?.run).toBe(
      'node scripts/validate-production-migration-activation.mjs\n' +
        'vp exec pnpm --filter @boardsesh/db run db:migrate\n',
    );
  });

  it('accepts the pre-bridge empty subscriber pair', () => {
    expect(validateProductionMigrationActivationEnvironment(PRODUCTION_MIGRATION_CORE_ENVIRONMENT)).toBe(
      'subscriber-absent',
    );
    expect(migrationExecutionContractFromEnvironment(PRODUCTION_MIGRATION_CORE_ENVIRONMENT)).toEqual({
      owner: {
        databaseName: 'railway',
        loginRole: 'boardsesh_migrator',
        ownerRole: 'boardsesh_owner',
      },
      runtimeRole: 'boardsesh_runtime',
      runtimeSchemas: ['public', 'drizzle'],
    });
  });

  it('accepts only the exact active-bridge subscriber pair', () => {
    const activeBridgeEnvironment = {
      ...PRODUCTION_MIGRATION_CORE_ENVIRONMENT,
      ...PRODUCTION_MIGRATION_SUBSCRIBER_ENVIRONMENT,
    };
    expect(validateProductionMigrationActivationEnvironment(activeBridgeEnvironment)).toBe('subscriber-active');
    expect(migrationExecutionContractFromEnvironment(activeBridgeEnvironment)).toEqual({
      owner: {
        databaseName: 'railway',
        loginRole: 'boardsesh_migrator',
        ownerRole: 'boardsesh_owner',
        subscriberRole: 'boardsesh_pg18_subscriber',
        subscriptionName: 'boardsesh_pg18_sub',
      },
      runtimeRole: 'boardsesh_runtime',
      runtimeSchemas: ['public', 'drizzle'],
    });
  });

  it.each([
    { MIGRATION_SUBSCRIBER_ROLE: 'boardsesh_pg18_subscriber' },
    { MIGRATION_SUBSCRIPTION_NAME: 'boardsesh_pg18_sub' },
  ])('rejects a half-set subscriber phase before DDL', (partialSubscriberEnvironment) => {
    expect(() =>
      validateProductionMigrationActivationEnvironment({
        ...PRODUCTION_MIGRATION_CORE_ENVIRONMENT,
        ...partialSubscriberEnvironment,
      }),
    ).toThrow('must be empty or set together');
  });

  it.each([
    {
      MIGRATION_SUBSCRIBER_ROLE: 'wrong_subscriber',
      MIGRATION_SUBSCRIPTION_NAME: 'boardsesh_pg18_sub',
    },
    {
      MIGRATION_SUBSCRIBER_ROLE: 'boardsesh_pg18_subscriber',
      MIGRATION_SUBSCRIPTION_NAME: 'wrong_subscription',
    },
  ])('rejects a renamed active-bridge subscriber pair before DDL', (wrongSubscriberEnvironment) => {
    expect(() =>
      validateProductionMigrationActivationEnvironment({
        ...PRODUCTION_MIGRATION_CORE_ENVIRONMENT,
        ...wrongSubscriberEnvironment,
      }),
    ).toThrow('must match the exact production migration contract');
  });

  it('returns to the post-teardown empty subscriber pair atomically', () => {
    const postTeardownEnvironment = {
      ...PRODUCTION_MIGRATION_CORE_ENVIRONMENT,
      MIGRATION_SUBSCRIBER_ROLE: '',
      MIGRATION_SUBSCRIPTION_NAME: '',
    };
    expect(validateProductionMigrationActivationEnvironment(postTeardownEnvironment)).toBe('subscriber-absent');
    expect(migrationExecutionContractFromEnvironment(postTeardownEnvironment)?.owner).toEqual({
      databaseName: 'railway',
      loginRole: 'boardsesh_migrator',
      ownerRole: 'boardsesh_owner',
      subscriberRole: '',
      subscriptionName: '',
    });
  });

  it('hash-locks every Python artifact installed by the OIDC-enabled job', () => {
    const job = getJob('.github/workflows/refresh-content-model.yml', 'refresh');
    const installStep = job.steps?.find((step) => step.name === 'Install Python deps (offline training only)');
    expect(installStep?.run).toContain('--require-hashes');
    expect(installStep?.run).toContain('--only-binary=:all:');
    expect(installStep?.run).toContain('ml/climb2vec/requirements-ci.lock');

    const lockSource = readFileSync('ml/climb2vec/requirements-ci.lock', 'utf8');
    expect(lockSource).toContain('torch==');
    expect(lockSource).toContain('+cpu');
    expect(lockSource).toContain('--hash=sha256:');
    const lockLines = lockSource.split('\n');
    const requirementLineIndexes: number[] = [];
    for (const [lineIndex, line] of lockLines.entries()) {
      if (/^[a-z0-9]/i.test(line)) expect(line).toMatch(/^[a-z0-9][a-z0-9._-]*==[^ ]+ \\$/i);
      if (/^[a-z0-9][a-z0-9._-]*==[^ ]+(?: \\)?$/i.test(line)) requirementLineIndexes.push(lineIndex);
    }
    expect(requirementLineIndexes.length).toBeGreaterThan(0);
    for (const [requirementIndex, lineIndex] of requirementLineIndexes.entries()) {
      const nextLineIndex = requirementLineIndexes[requirementIndex + 1] ?? lockLines.length;
      const requirementBlock = lockLines.slice(lineIndex, nextLineIndex).join('\n');
      expect(requirementBlock, `missing hash for ${lockLines[lineIndex]}`).toMatch(
        /^\s+--hash=sha256:[a-f0-9]{64}(?: \\)?$/m,
      );
    }
  });

  it('pins workload identity to the reviewed action, client, and CI tag', () => {
    const action = readYaml('.github/actions/connect-production-db/action.yml');
    const steps = action.runs?.steps ?? [];
    const tailscaleStep = steps.find((step) => step.uses === TAILSCALE_ACTION);
    expect(tailscaleStep).toBeDefined();
    expect(tailscaleStep?.with).toEqual({
      'oauth-client-id': '${{ inputs.oauth-client-id }}',
      audience: '${{ inputs.audience }}',
      tags: 'tag:boardsesh-db-ci',
      version: '1.102.3',
      ping: '${{ inputs.forwarder-host }}',
    });

    const actionSource = readFileSync('.github/actions/connect-production-db/action.yml', 'utf8');
    expect(actionSource).not.toMatch(/oauth-secret|authkey/i);
    expect(actionSource).toContain('node "$GITHUB_WORKSPACE/scripts/validate-production-db-network-url.mjs"');
    expect(actionSource).not.toContain('tsx');
    expect(actionSource).toContain('EXPECTED_DATABASE_ROLE_INPUT: ${{ inputs.expected-role }}');
    const validatorSource = readFileSync('scripts/validate-production-db-network-url.mjs', 'utf8');
    expect(validatorSource).toContain('POSTGRES_FORWARDER_HOST must be the full boardsesh-db-forwarder MagicDNS name');
    expect(validatorSource).toContain('direct database URL must target POSTGRES_FORWARDER_HOST on port 5432');
    expect(validatorSource).toContain('direct database URL must use the expected task-specific role');
  });

  it('rejects public, privileged, credential-free, and malformed direct URLs', () => {
    const host = 'boardsesh-db-forwarder.example-tailnet.ts.net';
    const validUrl = `postgresql://${MIGRATION_ROLE}:secret@${host}:5432/railway?application_name=boardsesh-ci-migrate&sslmode=require`;
    expect(() => validateRoute(validUrl, host)).not.toThrow();
    expect(() => validateRoute(`postgresql://${MIGRATION_ROLE}:secret@public.example.com:5432/railway`, host)).toThrow(
      'must target POSTGRES_FORWARDER_HOST',
    );
    expect(() => validateRoute(`postgresql://postgres:secret@${host}:5432/railway`, host)).toThrow(
      'must use the expected task-specific role',
    );
    expect(() => validateRoute(`postgresql://${MIGRATION_ROLE}@${host}:5432/railway`, host)).toThrow(
      'must include SCRAM credentials',
    );
    expect(() => validateRoute(`postgresql://${MIGRATION_ROLE}:secret@${host}:5432/postgres`, host)).toThrow(
      'must target the railway database',
    );
    expect(() =>
      validateRoute(
        `postgresql://${MIGRATION_ROLE}:secret@${host}:5432/railway?application_name=boardsesh-ci-migrate&sslmode=require&user=postgres`,
        host,
      ),
    ).toThrow('must not override user');
    expect(() =>
      validateRoute(
        `postgresql://${MIGRATION_ROLE}:secret@${host}:5432/railway?application_name=boardsesh-ci-migrate&sslmode=require&options=-c%20role%3Dpostgres`,
        host,
      ),
    ).toThrow('must not set a startup role');
    expect(() =>
      validateRoute(
        `postgresql://${MIGRATION_ROLE}:secret@${host}:5432/railway?application_name=boardsesh-ci-migrate&sslmode=require&options=-c%20statement_timeout%3D5s`,
        host,
      ),
    ).toThrow('must not set PostgreSQL startup options');
    expect(() => validateRoute('not a URL', host)).toThrow('not a valid URL');
    expect(() => validateRoute('postgresql://boardsesh_migrator:secret@localhost:5432/railway', 'localhost')).toThrow(
      'must be the full boardsesh-db-forwarder MagicDNS name',
    );
    expect(() =>
      validateRoute(
        `postgresql://unexpected_role:secret@${host}:5432/railway?application_name=unexpected&sslmode=require`,
        host,
        'unexpected_role',
      ),
    ).toThrow('EXPECTED_DATABASE_ROLE must be an approved task-specific Boardsesh role');
    expect(() =>
      validateRoute(
        `postgresql://${MIGRATION_ROLE}:secret@${host}:5432/railway?application_name=wrong&sslmode=require`,
        host,
      ),
    ).toThrow('must use the expected task-specific application_name');
    expect(() =>
      validateRoute(`postgresql://${MIGRATION_ROLE}:secret@${host}:5432/railway?sslmode=require`, host),
    ).toThrow('must set exactly one task-specific application_name');
    expect(() =>
      validateRoute(
        `postgresql://${MIGRATION_ROLE}:secret@${host}:5432/railway?application_name=boardsesh-ci-migrate`,
        host,
      ),
    ).toThrow('must set sslmode=require exactly once');
    expect(() =>
      validateRoute(
        `postgresql://${MIGRATION_ROLE}:secret@${host}:5432/railway?application_name=boardsesh-ci-migrate&sslmode=disable`,
        host,
      ),
    ).toThrow('must require PostgreSQL TLS');
    expect(() =>
      validateRoute(
        `postgresql://${MIGRATION_ROLE}:secret@${host}:5432/railway?application_name=boardsesh-ci-migrate&sslmode=require&connect_timeout=5`,
        host,
      ),
    ).toThrow('must not set query parameter connect_timeout');
  });

  it('keeps the publisher immutable and deployment-free', () => {
    const workflowSource = readFileSync('.github/workflows/postgres-secure-network.yml', 'utf8');
    const unpinnedAction = workflowSource
      .split('\n')
      .filter((line) => /^\s*-?\s*uses:/.test(line))
      .find((line) => !/@[0-9a-f]{40}\s+#\s+/.test(line));
    expect(unpinnedAction).toBeUndefined();
    expect(workflowSource).toContain('platforms: linux/amd64');
    expect(workflowSource).toContain('push-to-registry: true');
    expect(workflowSource).not.toMatch(/railway\s+(up|redeploy)|railwayapp\/cli|RAILWAY_TOKEN/);

    const dockerfile = readFileSync('deploy/postgres-tailscale-forwarder/Dockerfile', 'utf8');
    expect(dockerfile).toContain(
      'docker/dockerfile:1.20@sha256:26147acbda4f14c5add9946e2fd2ed543fc402884fd75146bd342a7f6271dc1d',
    );
    expect(dockerfile).toContain(
      'golang:1.27.0-alpine3.23@sha256:3747dcba41c8b0db3211fda4db61638b980e17ac5bb3c94460a975a9cfe19395',
    );
    expect(dockerfile).toContain(
      'gcr.io/distroless/static-debian13:nonroot@sha256:1c2c046bc09ed40fad370b599a0b1ae7987f55b01e247cf27a7c27cd97e5bbc7',
    );
    expect(dockerfile).toContain('USER nonroot:nonroot');
    expect(dockerfile).toContain('COPY --chown=65532:65532 state/ /var/lib/boardsesh-tsnet/');
  });
});
