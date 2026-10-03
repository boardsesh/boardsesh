import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { withPostgresDatabaseName } from './postgres-url';
import { createDefaultTestInfraDependencies, ensureTestInfrastructure } from './test-infra';

const PG_PORT = 5433;
const REDIS_PORT = 6380;
const COMPOSE_FILE = fileURLToPath(new URL('../../docker-compose.test.yml', import.meta.url));

const WORKER_DB_PREFIX = 'boardsesh_backend_test';
const databaseUrlOverride = process.env.BOARDSESH_TEST_DATABASE_URL;
const configuredDatabaseUrl =
  databaseUrlOverride ||
  process.env.DATABASE_URL ||
  `postgresql://postgres:postgres@localhost:${PG_PORT}/${WORKER_DB_PREFIX}`;
const baseConnectionString = withPostgresDatabaseName(configuredDatabaseUrl, 'postgres');
const infraDependencies = createDefaultTestInfraDependencies(COMPOSE_FILE);

async function ensureInfra(): Promise<void> {
  await ensureTestInfrastructure(
    {
      ci: Boolean(process.env.CI),
      skip: process.env.SKIP_TEST_INFRA === '1',
      databaseUrlOverride,
      redisUrl: process.env.REDIS_URL,
      postgresPort: PG_PORT,
      redisPort: REDIS_PORT,
    },
    infraDependencies,
  );
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
  // vp test loads every workspace project's globalSetup even when the
  // project itself is filtered out via `--project '!backend'`. The
  // `test-default` CI job runs without postgres, so probe the port first
  // and skip the cleanup when nothing is listening — backend tests still
  // run their `dropStaleWorkerDatabases` step in the dedicated
  // `test-backend` job where postgres IS started. An override URL points
  // somewhere other than :5433, so the probe would be answering about the wrong
  // server — skip it and let the connection itself report a problem.
  if (!databaseUrlOverride && !(await infraDependencies.isPortOpen('127.0.0.1', PG_PORT))) {
    return;
  }
  await dropStaleWorkerDatabases();
}
