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

function getBaseConnection(): string {
  const raw = process.env.DATABASE_URL || `postgresql://postgres:postgres@localhost:${PG_PORT}/${WORKER_DB_PREFIX}`;
  return raw.replace(/\/[^/]+$/, '/postgres');
}

export function getWorkerDatabaseName(): string {
  const id = process.env.VITEST_POOL_ID || '0';
  // fileParallelism=false still spawns one worker with id=0; we still get our own DB copy.
  return `${WORKER_DB_PREFIX}_w${id}`;
}

function buildWorkerDatabaseUrl(): string {
  const name = getWorkerDatabaseName();
  const raw = process.env.DATABASE_URL || `postgresql://postgres:postgres@localhost:${PG_PORT}/${WORKER_DB_PREFIX}`;
  return raw.replace(/\/[^/]+$/, `/${name}`);
}

// Resolve once at module init using the original DATABASE_URL, then redirect
// DATABASE_URL to it BEFORE any ESM import can materialise `db/client`'s
// cached connection against the template DB. Import worker-db.ts first in
// setupFiles.
const WORKER_DATABASE_URL = buildWorkerDatabaseUrl();

if (!process.env.__BOARDSESH_WORKER_DB_INITIALIZED__) {
  process.env.DATABASE_URL = WORKER_DATABASE_URL;
  process.env.__BOARDSESH_WORKER_DB_INITIALIZED__ = '1';
}

export function getWorkerDatabaseUrl(): string {
  return WORKER_DATABASE_URL;
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
