/// <reference types="node" />

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ENTRYPOINT_PATH = 'deploy/pgbouncer/docker-entrypoint.sh';
const DOCKERFILE_PATH = 'deploy/pgbouncer/Dockerfile';
const HEALTHCHECK_PATH = 'deploy/pgbouncer/healthcheck.sh';
const SMOKE_TEST_PATH = 'deploy/pgbouncer/smoke-test.sh';
const WORKFLOW_PATH = '.github/workflows/pgbouncer-image.yml';
const PRODUCTION_WORKFLOW_PATH = '.github/workflows/production-deploy.yml';
const temporaryDirectories: string[] = [];

const baseEnvironment = {
  PGBOUNCER_UPSTREAM_HOST: 'postgres.internal',
  PGBOUNCER_UPSTREAM_PORT: '5432',
  PGBOUNCER_DATABASE_NAME: 'boardsesh',
  PGBOUNCER_UPSTREAM_USER: 'boardsesh_server',
  PGBOUNCER_UPSTREAM_PASSWORD: 'upstream "secret" \\ value',
  PGBOUNCER_CLIENT_USER: 'boardsesh_client',
  PGBOUNCER_CLIENT_PASSWORD: 'client "secret" \\ value',
  PGBOUNCER_ADMIN_USER: 'pgbouncer_admin',
  PGBOUNCER_ADMIN_PASSWORD: 'admin "secret" \\ value',
  PGBOUNCER_CLIENT_TLS_CERT: '-----BEGIN CERTIFICATE-----\nclient certificate\n-----END CERTIFICATE-----',
  PGBOUNCER_CLIENT_TLS_KEY: '-----BEGIN PRIVATE KEY-----\nclient key\n-----END PRIVATE KEY-----',
  PGBOUNCER_SERVER_TLS_CA: '-----BEGIN CERTIFICATE-----\nserver ca\n-----END CERTIFICATE-----',
};

afterEach(() => {
  for (const temporaryDirectory of temporaryDirectories.splice(0)) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

function render(overrides: Record<string, string | undefined> = {}, trace = false) {
  const runtimeDirectory = mkdtempSync(join(tmpdir(), 'boardsesh-pgbouncer-'));
  temporaryDirectories.push(runtimeDirectory);

  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    PATH: process.env.PATH,
    ...baseEnvironment,
    PGBOUNCER_RUNTIME_DIR: runtimeDirectory,
  };
  for (const [variableName, variableValue] of Object.entries(overrides)) {
    if (variableValue === undefined) delete environment[variableName];
    else environment[variableName] = variableValue;
  }

  const result = spawnSync('sh', [...(trace ? ['-x'] : []), ENTRYPOINT_PATH, 'true'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: environment,
  });

  return { result, runtimeDirectory };
}

describe('PgBouncer runtime configuration', () => {
  it('renders the bounded transaction pool and required TLS modes', () => {
    const { result, runtimeDirectory } = render();
    expect(result.status, result.stderr).toBe(0);

    const configuration = readFileSync(join(runtimeDirectory, 'pgbouncer.ini'), 'utf8');
    expect(configuration).toContain(
      'boardsesh = host=postgres.internal port=5432 dbname=boardsesh user=boardsesh_server',
    );
    expect(configuration).toMatch(/pool_mode = transaction/);
    expect(configuration).toMatch(/default_pool_size = 40/);
    expect(configuration).toMatch(/min_pool_size = 0/);
    expect(configuration).toMatch(/reserve_pool_size = 5/);
    expect(configuration).toMatch(/reserve_pool_timeout = 3/);
    expect(configuration).toMatch(/max_db_connections = 45/);
    expect(configuration).toMatch(/max_user_connections = 45/);
    expect(configuration).toMatch(/max_client_conn = 500/);
    expect(configuration).toMatch(/max_prepared_statements = 0/);
    expect(configuration).toMatch(/query_wait_timeout = 5/);
    expect(configuration).toMatch(/client_login_timeout = 5/);
    expect(configuration).toMatch(/server_connect_timeout = 5/);
    expect(configuration).toMatch(/server_login_retry = 3/);
    expect(configuration).toMatch(/server_idle_timeout = 300/);
    expect(configuration).toMatch(/idle_transaction_timeout = 60/);
    expect(configuration).toMatch(/client_tls_sslmode = require/);
    expect(configuration).toMatch(/server_tls_sslmode = verify-full/);

    for (const secret of [
      baseEnvironment.PGBOUNCER_UPSTREAM_PASSWORD,
      baseEnvironment.PGBOUNCER_CLIENT_PASSWORD,
      baseEnvironment.PGBOUNCER_ADMIN_PASSWORD,
    ]) {
      expect(configuration).not.toContain(secret);
      expect(result.stdout).not.toContain(secret);
      expect(result.stderr).not.toContain(secret);
    }
  });

  it('escapes auth-file quotes and protects every generated file', () => {
    const { result, runtimeDirectory } = render();
    expect(result.status, result.stderr).toBe(0);

    expect(readFileSync(join(runtimeDirectory, 'userlist.txt'), 'utf8')).toBe(
      '"boardsesh_client" "client ""secret"" \\ value"\n' +
        '"boardsesh_server" "upstream ""secret"" \\ value"\n' +
        '"pgbouncer_admin" "admin ""secret"" \\ value"\n',
    );

    for (const fileName of [
      'pgbouncer.ini',
      'userlist.txt',
      'auth_hba.conf',
      'client.crt',
      'client.key',
      'server-ca.crt',
    ]) {
      expect(statSync(join(runtimeDirectory, fileName)).mode & 0o777).toBe(0o600);
    }
  });

  it('rejects configuration injection without echoing the supplied value', () => {
    const injectedHost = 'postgres.internal\npassword=do-not-print';
    const { result } = render({ PGBOUNCER_UPSTREAM_HOST: injectedHost });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('PGBOUNCER_UPSTREAM_HOST contains unsupported characters');
    expect(result.stderr).not.toContain(injectedHost);
  });

  it('rejects unsafe runtime directories without echoing injected configuration', () => {
    const injectedRuntimeDirectory = '/tmp/pgbouncer\nauth_type = trust';
    const injectedResult = render({ PGBOUNCER_RUNTIME_DIR: injectedRuntimeDirectory }).result;
    expect(injectedResult.status).not.toBe(0);
    expect(injectedResult.stderr).toContain('PGBOUNCER_RUNTIME_DIR contains unsupported characters');
    expect(injectedResult.stderr).not.toContain(injectedRuntimeDirectory);
    expect(injectedResult.stderr).not.toContain('auth_type = trust');

    const relativeResult = render({ PGBOUNCER_RUNTIME_DIR: 'relative/runtime' }).result;
    expect(relativeResult.status).not.toBe(0);
    expect(relativeResult.stderr).toContain('PGBOUNCER_RUNTIME_DIR must be an absolute path');

    const parentSegmentResult = render({ PGBOUNCER_RUNTIME_DIR: '/tmp/../run/pgbouncer' }).result;
    expect(parentSegmentResult.status).not.toBe(0);
    expect(parentSegmentResult.stderr).toContain("PGBOUNCER_RUNTIME_DIR must not contain '..' path segments");
  });

  it('disables shell tracing before it handles credentials', () => {
    const { result } = render({}, true);
    expect(result.status, result.stderr).toBe(0);
    for (const secret of [
      baseEnvironment.PGBOUNCER_UPSTREAM_PASSWORD,
      baseEnvironment.PGBOUNCER_CLIENT_PASSWORD,
      baseEnvironment.PGBOUNCER_ADMIN_PASSWORD,
    ]) {
      expect(result.stderr).not.toContain(secret);
    }
  });

  it('requires both optional upstream client-certificate values', () => {
    const { result } = render({ PGBOUNCER_SERVER_TLS_CERT: 'certificate only' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('PGBOUNCER_SERVER_TLS_CERT and PGBOUNCER_SERVER_TLS_KEY must be set together');
  });

  it('requires the primary identities to be pairwise distinct', () => {
    const { result } = render({ PGBOUNCER_UPSTREAM_USER: baseEnvironment.PGBOUNCER_CLIENT_USER });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('client, upstream, and admin users must be pairwise distinct');
  });

  it('overlaps a distinct next client identity without widening HBA access', () => {
    const { result, runtimeDirectory } = render({
      PGBOUNCER_CLIENT_USER_NEXT: 'boardsesh_client_next',
      PGBOUNCER_CLIENT_PASSWORD_NEXT: 'next client secret',
    });
    expect(result.status, result.stderr).toBe(0);

    const hba = readFileSync(join(runtimeDirectory, 'auth_hba.conf'), 'utf8');
    expect(hba).toBe(
      'local all all reject\n' +
        'hostnossl all all 0.0.0.0/0 reject\n' +
        'hostssl boardsesh boardsesh_client 0.0.0.0/0 scram-sha-256\n' +
        'hostssl boardsesh boardsesh_client_next 0.0.0.0/0 scram-sha-256\n' +
        'hostssl pgbouncer pgbouncer_admin 0.0.0.0/0 scram-sha-256\n' +
        'hostssl all all 0.0.0.0/0 reject\n',
    );
    expect(readFileSync(join(runtimeDirectory, 'userlist.txt'), 'utf8')).toContain(
      '"boardsesh_client_next" "next client secret"',
    );
  });

  it('requires both next-client credential values and a unique next identity', () => {
    const missingPassword = render({ PGBOUNCER_CLIENT_USER_NEXT: 'boardsesh_client_next' }).result;
    expect(missingPassword.status).not.toBe(0);
    expect(missingPassword.stderr).toContain(
      'PGBOUNCER_CLIENT_USER_NEXT and PGBOUNCER_CLIENT_PASSWORD_NEXT must be set together',
    );

    const reusedIdentity = render({
      PGBOUNCER_CLIENT_USER_NEXT: baseEnvironment.PGBOUNCER_ADMIN_USER,
      PGBOUNCER_CLIENT_PASSWORD_NEXT: 'next secret',
    }).result;
    expect(reusedIdentity.status).not.toBe(0);
    expect(reusedIdentity.stderr).toContain('PGBOUNCER_CLIENT_USER_NEXT must be distinct from all active users');
  });

  it('generates a self-signed client-facing identity when none is injected', () => {
    const { result, runtimeDirectory } = render({
      PGBOUNCER_CLIENT_TLS_CERT: undefined,
      PGBOUNCER_CLIENT_TLS_KEY: undefined,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(runtimeDirectory, 'client.crt'), 'utf8')).toContain('-----BEGIN CERTIFICATE-----');
    expect(readFileSync(join(runtimeDirectory, 'client.key'), 'utf8')).toContain('-----BEGIN PRIVATE KEY-----');
  });

  it('health-checks the client application path over TLS', () => {
    const healthcheck = readFileSync(HEALTHCHECK_PATH, 'utf8');
    expect(healthcheck).toContain('PGPASSWORD=$PGBOUNCER_CLIENT_PASSWORD');
    expect(healthcheck).toContain('PGSSLMODE=require');
    expect(healthcheck).toContain('--username="$PGBOUNCER_CLIENT_USER"');
    expect(healthcheck).toContain('--dbname="$PGBOUNCER_DATABASE_NAME"');
    expect(healthcheck).toContain("--command='SELECT 1'");
  });
});

describe('PgBouncer image publication contract', () => {
  it('builds the verified official release in a non-root multi-stage image', () => {
    const dockerfile = readFileSync(DOCKERFILE_PATH, 'utf8');
    expect(dockerfile.match(/^FROM /gm)).toHaveLength(2);
    expect(
      dockerfile.match(
        /^FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171/gm,
      ),
    ).toHaveLength(2);
    expect(dockerfile).toContain('PGBOUNCER_VERSION=1.25.2');
    expect(dockerfile).toContain('924ad35113fd0a71c8e2dbe85b5d03445532e2b7b37a9f8a48983beea238b332');
    expect(dockerfile).toContain('https://www.pgbouncer.org/downloads/files/${PGBOUNCER_VERSION}/');
    expect(dockerfile).toContain('sha256sum --check --strict');
    expect(dockerfile).toContain('--with-cares');
    expect(dockerfile).toContain('grep --line-regexp --fixed-strings "PgBouncer ${PGBOUNCER_VERSION}"');
    expect(dockerfile).toContain("grep --fixed-strings 'adns: c-ares'");
    expect(dockerfile).toContain("grep --fixed-strings 'tls: OpenSSL'");
    expect(dockerfile).toContain('USER 10001:10001');
    expect(dockerfile).toContain('HEALTHCHECK');
  });

  it('publishes the production multi-architecture image from main with provenance', () => {
    const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
    expect(workflow).toContain('branches: [main]');
    expect(workflow).toContain('pull_request:');
    expect(workflow).toContain(
      "group: pgbouncer-image-${{ github.event_name == 'push' && 'production' || github.ref }}",
    );
    expect(workflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
    expect(workflow).toContain("- 'deploy/pgbouncer/**'");
    expect(workflow).toContain('IMAGE: ghcr.io/boardsesh/boardsesh-pgbouncer');
    expect(workflow).toContain('type=raw,value=production');
    expect(workflow).toContain('platforms: linux/amd64,linux/arm64');
    expect(workflow).toContain('provenance: mode=max');
    expect(workflow).toContain('push: false');
    expect(workflow).toContain('boardsesh-pgbouncer:pr-smoke');
    expect(workflow).toContain('run: sh deploy/pgbouncer/smoke-test.sh boardsesh-pgbouncer:pr-smoke');
    expect(workflow).toContain('needs: validate');
    expect(workflow).toContain('type=sha,prefix=sha-,format=long');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('actions/attest-build-provenance@8beda2b7ed98355c0e97c0a63bec38ae472e66c4');
    expect(workflow).toContain('attestations: write');
    expect(workflow).toContain('id-token: write');
  });

  it('boots pinned PostgreSQL and tests health plus both HBA denial paths', () => {
    const smokeTest = readFileSync(SMOKE_TEST_PATH, 'utf8');
    expect(smokeTest).toContain(
      'postgres:17-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0',
    );
    expect(smokeTest).toContain('.State.Health.Status');
    expect(smokeTest).toContain('--port=6432 --username=next_client_user --dbname=boardsesh');
    expect(smokeTest).toContain('admin identity unexpectedly reached the application database');
    expect(smokeTest).toContain('application identity unexpectedly reached the admin console');
  });

  it('keeps production migrations on a required direct database URL', () => {
    const productionWorkflow = readFileSync(PRODUCTION_WORKFLOW_PATH, 'utf8');
    const migrateJobStart = productionWorkflow.indexOf('\n  migrate:\n');
    const deployWebJobStart = productionWorkflow.indexOf('\n  deploy-web:\n', migrateJobStart);
    expect(migrateJobStart).toBeGreaterThan(-1);
    expect(deployWebJobStart).toBeGreaterThan(migrateJobStart);

    const migrateJob = productionWorkflow.slice(migrateJobStart, deployWebJobStart);
    const guardStepStart = migrateJob.indexOf('      - name: Require direct database connection\n');
    const migrationStepStart = migrateJob.indexOf('      - name: Run database migrations\n', guardStepStart);
    expect(guardStepStart).toBeGreaterThan(-1);
    expect(migrationStepStart).toBeGreaterThan(guardStepStart);

    const guardStep = migrateJob.slice(guardStepStart, migrationStepStart);
    expect(guardStep).toContain('DATABASE_DIRECT_URL: ${{ secrets.DATABASE_DIRECT_URL }}');
    expect(guardStep).toContain('DATABASE_URL: ${{ secrets.DATABASE_URL }}');
    expect(guardStep).toMatch(/if \[ -z "\$DATABASE_DIRECT_URL" \]; then[\s\S]*?exit 1\s+fi/);
    expect(guardStep).toMatch(/if \[ "\$DATABASE_DIRECT_URL" = "\$DATABASE_URL" \]; then[\s\S]*?exit 1\s+fi/);
    expect(guardStep).toContain('DATABASE_DIRECT_URL must differ from the pooled DATABASE_URL');
    expect(guardStep).not.toMatch(/DATABASE_DIRECT_URL\s*\|\|/);

    const migrationStep = migrateJob.slice(migrationStepStart);
    expect(migrationStep).toContain('DATABASE_URL: ${{ secrets.DATABASE_DIRECT_URL }}');
    expect(migrationStep).not.toContain('DATABASE_URL: ${{ secrets.DATABASE_URL }}');
  });
});
