import { execSync, spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const PG_PORT = 5433;
const REDIS_PORT = 6380;
const COMPOSE_FILE = fileURLToPath(new URL('../../docker-compose.test.yml', import.meta.url));

const WORKER_DB_PREFIX = 'boardsesh_backend_test';
const baseConnectionString = (
  process.env.DATABASE_URL || `postgresql://postgres:postgres@localhost:${PG_PORT}/${WORKER_DB_PREFIX}`
).replace(/\/[^/]+$/, '/postgres');

export function snapshotFenceMembershipSql(serverVersionNum: number): string {
  if (serverVersionNum >= 160000) {
    return `
      ALTER ROLE boardsesh_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
      GRANT pg_read_all_stats TO boardsesh_snapshot_fence_owner
        WITH ADMIN FALSE, INHERIT TRUE, SET FALSE;
      GRANT boardsesh_snapshot_fence_owner TO boardsesh_owner
        WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
    `;
  }
  return `
    ALTER ROLE boardsesh_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
    GRANT pg_read_all_stats TO boardsesh_snapshot_fence_owner;
    GRANT boardsesh_snapshot_fence_owner TO boardsesh_owner;
  `;
}

async function isPortOpen(host: string, port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function ensureInfra(): Promise<void> {
  if (process.env.CI) return;
  if (process.env.SKIP_TEST_INFRA === '1') {
    console.info('[test-infra] SKIP_TEST_INFRA=1 — skipping docker orchestration');
    return;
  }

  const [pgUp, redisUp] = await Promise.all([isPortOpen('127.0.0.1', PG_PORT), isPortOpen('127.0.0.1', REDIS_PORT)]);
  if (pgUp && redisUp) {
    console.info(`[test-infra] postgres:${PG_PORT} + redis:${REDIS_PORT} already reachable — skipping docker`);
    return;
  }

  const dockerCheck = spawnSync('docker', ['info'], { stdio: 'pipe' });
  if (dockerCheck.status !== 0) {
    throw new Error(
      '[test-infra] Docker is not running. Start Docker Desktop (or the docker daemon), ' +
        'or set SKIP_TEST_INFRA=1 to skip orchestration (DB-dependent tests will then fail).',
    );
  }

  console.info('[test-infra] starting postgres+redis via docker compose (first run pulls ~150MB)…');
  try {
    execSync(`docker compose -f "${COMPOSE_FILE}" up -d --wait --wait-timeout 45`, {
      stdio: 'inherit',
    });
  } catch (error) {
    throw new Error(
      `[test-infra] Failed to start test containers from ${COMPOSE_FILE}. ` +
        'Check Docker Compose v2 is installed (`docker compose version`).\n' +
        `Original error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// Drop per-worker DB clones left over from a previous run so workers rebuild
// them against the current schema. Running tests always materialise their own
// DB via worker-db, so there is nothing else to prepare here.
async function dropStaleWorkerDatabases(): Promise<void> {
  const adminClient = postgres(baseConnectionString, { max: 1, onnotice: () => {} });
  try {
    const stale = await adminClient`
      SELECT datname FROM pg_database WHERE datname LIKE ${WORKER_DB_PREFIX + '_w%'}
    `;
    for (const { datname } of stale) {
      try {
        await adminClient.unsafe(`DROP DATABASE "${datname}"`);
      } catch {
        // ignore — if a leftover connection is holding it, worker-db will CREATE IF NOT EXISTS against it
      }
    }
  } finally {
    await adminClient.end().catch(() => {});
  }
}

// TODO(#4475 review, finding 9): fourth copy of the fence role/grant contract
// (migration 0205, the development bootstrap SQL, assertPrimaryFenceContract,
// and this fixture) with no parity test tying them together.
async function ensureSnapshotFenceOwnerRole(): Promise<void> {
  const adminClient = postgres(baseConnectionString, { max: 1, onnotice: () => {} });
  try {
    const [versionRow] = await adminClient<{ serverVersionNum: number }[]>`
      SELECT current_setting('server_version_num')::integer AS "serverVersionNum"
    `;
    const serverVersionNum = versionRow?.serverVersionNum ?? 0;
    await adminClient.unsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'boardsesh_owner') THEN
          CREATE ROLE boardsesh_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'boardsesh_snapshot_fence_owner') THEN
          CREATE ROLE boardsesh_snapshot_fence_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        END IF;
      END;
      $$;
      ALTER ROLE boardsesh_snapshot_fence_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
      REVOKE pg_read_all_stats FROM boardsesh_snapshot_fence_owner;
      REVOKE boardsesh_snapshot_fence_owner FROM boardsesh_owner;
      REVOKE EXECUTE ON FUNCTION pg_catalog.pg_control_system() FROM boardsesh_snapshot_fence_owner;
      REVOKE EXECUTE ON FUNCTION pg_catalog.pg_control_checkpoint() FROM boardsesh_snapshot_fence_owner;
      GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO boardsesh_snapshot_fence_owner;
      GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_checkpoint() TO boardsesh_snapshot_fence_owner;
    `);
    // PostgreSQL 15 has no per-membership INHERIT/SET options. The fallback
    // keeps the owner NOINHERIT; PG18 CI exercises the production option rows.
    await adminClient.unsafe(snapshotFenceMembershipSql(serverVersionNum));
  } finally {
    await adminClient.end().catch(() => {});
  }
}

export default async function globalSetup() {
  await ensureInfra();
  // vp test loads every workspace project's globalSetup even when the
  // project itself is filtered out via `--project '!backend'`. The
  // `test-default` CI job runs without postgres, so probe the port first
  // and skip the cleanup when nothing is listening — backend tests still
  // run their `dropStaleWorkerDatabases` step in the dedicated
  // `test-backend` job where postgres IS started.
  const configuredAdminUrl = new URL(baseConnectionString);
  const configuredHost = configuredAdminUrl.hostname.replace(/^\[(.*)\]$/, '$1');
  const configuredPort = Number(configuredAdminUrl.port || '5432');
  if (!(await isPortOpen(configuredHost, configuredPort))) {
    return;
  }
  // SKIP_TEST_INFRA=1 means the cluster belongs to the caller, not to our
  // disposable docker container — it can be a shared or staging server behind
  // DATABASE_URL. Everything below mutates the cluster (ALTER ROLE, fence
  // grant REVOKEs, DROP DATABASE of every boardsesh_backend_test_w%), so the
  // flag has to stop here, not just at the docker orchestration above. Suites
  // that need the fence roles must run without the flag.
  if (process.env.SKIP_TEST_INFRA === '1') {
    console.info('[test-infra] SKIP_TEST_INFRA=1 — leaving cluster roles and worker databases untouched');
    return;
  }
  await ensureSnapshotFenceOwnerRole();
  await dropStaleWorkerDatabases();
}
