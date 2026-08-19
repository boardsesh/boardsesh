/**
 * Per-worker database helper.
 *
 * When vitest runs test files in parallel, each file lands in a worker process
 * identified by VITEST_POOL_ID. Each worker gets its own throwaway database
 * (`boardsesh_backend_test_w<POOL_ID>`) that it creates blank and populates by
 * running schemaSQL itself — we don't use Postgres's `CREATE DATABASE ...
 * TEMPLATE` because the template can't have open connections while being copied.
 * That way a TRUNCATE in one file can't stomp on data another file is mid-way
 * through inserting.
 */

import postgres from 'postgres';
import { schemaSQL } from './schema-sql';

const PG_PORT = 5433;
const WORKER_DB_PREFIX = 'boardsesh_backend_test';

/**
 * Point the suite at a different Postgres server without editing the compose
 * file. The :5433 container is shared by every checkout on a dev machine, so
 * restarting it on a new image under a parallel run is not something running the
 * tests should demand.
 *
 * It needs a variable of its own rather than reusing DATABASE_URL: `test.env` in
 * vite.config.ts writes DATABASE_URL during worker init, before setupFiles import
 * this module, so an exported DATABASE_URL is overwritten before we read it.
 */
function getConfiguredDatabaseUrl(): string {
  return (
    process.env.BOARDSESH_TEST_DATABASE_URL ||
    process.env.DATABASE_URL ||
    `postgresql://postgres:postgres@localhost:${PG_PORT}/${WORKER_DB_PREFIX}`
  );
}

function getBaseConnection(): string {
  return getConfiguredDatabaseUrl().replace(/\/[^/]+$/, '/postgres');
}

export function getWorkerDatabaseName(): string {
  const id = process.env.VITEST_POOL_ID || '0';
  // fileParallelism=false still spawns one worker with id=0; we still get our own DB copy.
  return `${WORKER_DB_PREFIX}_w${id}`;
}

function buildWorkerDatabaseUrl(): string {
  const name = getWorkerDatabaseName();
  return getConfiguredDatabaseUrl().replace(/\/[^/]+$/, `/${name}`);
}

/** Redis ships with 16 logical databases (`databases 16`) unless configured otherwise. */
const REDIS_LOGICAL_DB_COUNT = 16;

/**
 * The worker's own Redis logical database, mirroring its own Postgres database.
 *
 * Giving each worker a private Postgres DB while leaving Redis shared is only
 * half an isolation story, and the missing half bites: every worker's
 * `user_boards_id_seq` restarts at 1, so several workers hold a *different*
 * board that is numerically id 3 at the same moment — and the Redis keys are
 * keyed on that number alone (`boardsesh:board-stats:v1:3`,
 * `boardsesh:debounce:board-stats:3`, `presence:board:3:user:…`).
 *
 * The debounce key is the sharpest edge. `queueBoardStatsPublish` writes a nonce,
 * then 2s later re-reads it and publishes ONLY if the nonce is still its own —
 * multi-instance leader election. A neighbouring worker's board 3 overwrites the
 * nonce, so our publish is silently suppressed and the stats cache is never
 * written. That is a test-harness artefact, not a product bug: in production
 * those ids are globally unique.
 *
 * `SELECT`ing a per-worker database costs nothing and keeps the whole keyspace
 * apart. Workers past the 16th wrap, which is still far better than everyone
 * sharing db 0.
 */
function buildWorkerRedisUrl(rawUrl: string): string {
  const poolId = Number.parseInt(process.env.VITEST_POOL_ID || '0', 10);
  const logicalDb = (Number.isFinite(poolId) ? poolId : 0) % REDIS_LOGICAL_DB_COUNT;
  try {
    const url = new URL(rawUrl);
    url.pathname = `/${logicalDb}`;
    return url.toString();
  } catch {
    // Not a URL we can parse (unix socket, sentinel list) — leave it alone
    // rather than hand ioredis something malformed.
    return rawUrl;
  }
}

// Module-load side effect: redirect DATABASE_URL to the worker's dedicated DB
// BEFORE any ESM import can materialise `db/client`'s cached connection against
// the template DB. Import worker-db.ts first in setupFiles.
//
// REDIS_URL rides along for the same reason: `redis/client.ts` reads it into a
// module-level const, so the rewrite has to beat that import too.
if (!process.env.__BOARDSESH_WORKER_DB_INITIALIZED__) {
  process.env.DATABASE_URL = buildWorkerDatabaseUrl();
  if (process.env.REDIS_URL) {
    process.env.REDIS_URL = buildWorkerRedisUrl(process.env.REDIS_URL);
  }
  process.env.__BOARDSESH_WORKER_DB_INITIALIZED__ = '1';
}

export function getWorkerDatabaseUrl(): string {
  return buildWorkerDatabaseUrl();
}

let setupPromise: Promise<void> | null = null;

export function setupWorkerDatabase(): Promise<void> {
  if (!setupPromise) {
    setupPromise = doSetup();
  }
  return setupPromise;
}

async function doSetup(): Promise<void> {
  const dbName = getWorkerDatabaseName();
  const admin = postgres(getBaseConnection(), { max: 1, onnotice: () => {} });
  try {
    const [row] = await admin`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;
    if (!row) {
      await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    }
  } finally {
    await admin.end().catch(() => {});
  }

  // Apply schema into this worker's DB. Cheap (~100–300ms) and only runs once per worker.
  const workerClient = postgres(getWorkerDatabaseUrl(), { max: 1, onnotice: () => {} });
  try {
    await workerClient.unsafe(schemaSQL);
  } finally {
    await workerClient.end().catch(() => {});
  }
}
