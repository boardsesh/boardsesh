import { afterAll, beforeAll, describe, it } from 'vite-plus/test';
import postgres from 'postgres';
import { getWorkerDatabaseName } from './worker-db';

import { prepareDedupReplayDatabase, dedupReplayChecks } from '@boardsesh/db/testing/dedup-replay';

/**
 * CI replay of the PR4 dedup migration lineage (0164 kilter_detached_at,
 * 0165 kilter dedup, 0166 aurora/json dedup).
 *
 * Runs as a regular backend-project test so it executes on every CI backend
 * job against the auto-started docker postgres (docker-compose.test.yml; CI=1
 * caller-provided services) — no extra env plumbing. It does NOT use the
 * worker database: migrations must run against the synthetic minimal schema
 * (boardsesh_ticks without kilter_detached_at so 0164 exercises the ADD
 * COLUMN), so a throwaway database is created per vitest worker and dropped
 * afterwards. Schema, seed, migration application, and every assertion live in
 * @boardsesh/db/testing/dedup-replay, shared with the opt-in local harness
 * (packages/db dedup-migration-replay.integration.test.ts) so the two can't
 * drift.
 */

// Same admin-connection derivation as worker-db.ts getBaseConnection(): take
// DATABASE_URL (already rewritten to the worker DB by setup) and re-point the
// path at the maintenance database.
const ADMIN_URL = (
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/boardsesh_backend_test'
).replace(/\/[^/]+$/, '/postgres');

// Same validated checkout/salt namespace as worker-db, including for forced teardown.
const DB_NAME = getWorkerDatabaseName('bs_dedup_replay');

describe('PR4 dedup migration replay (0164→0166)', () => {
  let admin: postgres.Sql;
  let db: postgres.Sql;

  beforeAll(async () => {
    admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${DB_NAME}`);
    db = postgres(ADMIN_URL.replace(/\/[^/]+$/, `/${DB_NAME}`), { max: 1, onnotice: () => {} });

    await prepareDedupReplayDatabase(db);
  });

  afterAll(async () => {
    if (db) await db.end().catch(() => {});
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => {});
      await admin.end().catch(() => {});
    }
  });

  for (const check of dedupReplayChecks) {
    it(check.name, async () => {
      await check.run(db);
    });
  }
});
