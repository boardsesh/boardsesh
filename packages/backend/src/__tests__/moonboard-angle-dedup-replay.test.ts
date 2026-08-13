import { afterAll, beforeAll, describe, it } from 'vite-plus/test';
import postgres from 'postgres';

import {
  MOONBOARD_DEDUP_REPLAY_MIGRATION_TAG,
  prepareMoonboardDedupReplayDatabase,
  moonboardDedupReplayChecks,
} from '@boardsesh/db/testing/moonboard-angle-dedup-replay';

/**
 * CI replay of migration 0193_moonboard_angle_dedup_backfill.
 *
 * Runs as a regular backend-project test so it executes on every CI backend
 * job against the auto-started docker postgres (docker-compose.test.yml; CI=1
 * caller-provided services) — no extra env plumbing. Uses a throwaway
 * database per vitest worker (not the shared worker database) since the
 * migration needs its own minimal synthetic schema. Schema, seed, migration
 * application, and every assertion live in
 * @boardsesh/db/testing/moonboard-angle-dedup-replay, shared with the opt-in
 * local harness (packages/db moonboard-angle-dedup-replay.integration.test.ts)
 * so the two can't drift.
 */

// Same admin-connection derivation as worker-db.ts getBaseConnection(): take
// DATABASE_URL (already rewritten to the worker DB by setup) and re-point the
// path at the maintenance database.
const ADMIN_URL = (
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/boardsesh_backend_test'
).replace(/\/[^/]+$/, '/postgres');

// Unique per vitest worker so parallel workers can't collide.
const DB_NAME = `bs_moonboard_dedup_replay_w${process.env.VITEST_POOL_ID || '0'}`;

describe(`moonboard angle dedup migration replay (${MOONBOARD_DEDUP_REPLAY_MIGRATION_TAG})`, () => {
  let admin: postgres.Sql;
  let db: postgres.Sql;

  beforeAll(async () => {
    admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${DB_NAME}`);
    db = postgres(ADMIN_URL.replace(/\/[^/]+$/, `/${DB_NAME}`), { max: 1, onnotice: () => {} });

    await prepareMoonboardDedupReplayDatabase(db);
  });

  afterAll(async () => {
    if (db) await db.end().catch(() => {});
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => {});
      await admin.end().catch(() => {});
    }
  });

  for (const check of moonboardDedupReplayChecks) {
    it(check.name, async () => {
      await check.run(db);
    });
  }
});
