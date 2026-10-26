import { execSync, spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import {
  createWorkerDatabaseNamespace,
  selectWorkerDatabasesForCleanup,
  workerDatabaseCleanupPattern,
  WORKER_DATABASE_PREFIX,
} from './worker-db-namespace';

const PG_PORT = 5433;
const REDIS_PORT = 6380;
const COMPOSE_FILE = fileURLToPath(new URL('../../docker-compose.test.yml', import.meta.url));

const WORKER_DB_PREFIX = WORKER_DATABASE_PREFIX;
const CHECKOUT_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const baseConnectionString = (
  process.env.DATABASE_URL || `postgresql://postgres:postgres@localhost:${PG_PORT}/${WORKER_DB_PREFIX}`
).replace(/\/[^/]+$/, '/postgres');

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

// Drop this checkout/salt's per-worker DB clones left over from a previous run so workers rebuild
// them against the current schema. Running tests always materialise their own
// DB via worker-db, so there is nothing else to prepare here.
async function dropStaleWorkerDatabases(): Promise<void> {
  const namespace = createWorkerDatabaseNamespace({
    checkoutRoot: CHECKOUT_ROOT,
    ci: Boolean(process.env.CI),
    salt: process.env.BOARDSESH_TEST_DB_SALT,
  });
  const adminClient = postgres(baseConnectionString, { max: 1, onnotice: () => {} });
  try {
    const stale = await adminClient<{ datname: string }[]>`
      SELECT datname FROM pg_database WHERE datname ~ ${workerDatabaseCleanupPattern(namespace)}
    `;
    const ownedDatabaseNames = selectWorkerDatabasesForCleanup(
      stale.map(({ datname }) => datname),
      namespace,
    );
    for (const datname of ownedDatabaseNames) {
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

export default async function globalSetup() {
  await ensureInfra();
  if (process.env.SKIP_TEST_INFRA === '1') return;
  // vp test loads every workspace project's globalSetup even when the
  // project itself is filtered out via `--project '!backend'`. The
  // `test-default` CI job runs without postgres, so probe the port first
  // and skip the cleanup when nothing is listening — backend tests still
  // run their `dropStaleWorkerDatabases` step in the dedicated
  // `test-backend` job where postgres IS started.
  if (!(await isPortOpen('127.0.0.1', PG_PORT))) {
    return;
  }
  await dropStaleWorkerDatabases();
}
