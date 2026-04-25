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

export default async function globalSetup() {
  await ensureInfra();
  if (process.env.SKIP_TEST_INFRA === '1') return;
  try {
    await dropStaleWorkerDatabases();
  } catch (error) {
    const masked = baseConnectionString.replace(/\/\/[^@]+@/, '//***@');
    console.error(
      `[test-infra] Failed to clean up stale worker databases via ${masked}. ` +
        `Check that DATABASE_URL points to a reachable postgres admin DB with valid credentials.\n` +
        `Original error: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
}
