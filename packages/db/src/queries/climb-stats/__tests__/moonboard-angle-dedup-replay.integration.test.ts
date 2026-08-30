import { describe, it, before, after } from 'node:test';
import postgres from 'postgres';

import {
  MOONBOARD_DEDUP_REPLAY_MIGRATION_TAG,
  prepareMoonboardDedupReplayDatabase,
  moonboardDedupReplayChecks,
} from '../../../testing/moonboard-angle-dedup-replay';

/**
 * Scratch-Postgres replay of migration 0193_moonboard_angle_dedup_backfill —
 * LOCAL opt-in mode. Set MIGRATION_REPLAY_DB_URL to a throwaway superuser
 * Postgres (a plain `docker run postgres`), e.g.
 *
 *   cd packages/db && MIGRATION_REPLAY_DB_URL=postgres://postgres:postgres@localhost:5433/postgres \
 *     vp exec tsx --test src/queries/climb-stats/__tests__/moonboard-angle-dedup-replay.integration.test.ts
 *
 * CI coverage does NOT depend on this gate: the same fixture also runs as a
 * backend-project vitest test (packages/backend/src/__tests__/
 * moonboard-angle-dedup-replay.test.ts) against the auto-started test
 * postgres on every CI backend job. Schema, seed, migration application, and
 * every assertion live in @boardsesh/db/testing/moonboard-angle-dedup-replay
 * so the two harnesses can't drift.
 */

const REPLAY_URL = process.env.MIGRATION_REPLAY_DB_URL;
const DB_NAME = 'bs_moonboard_angle_dedup_replay';

const suite = REPLAY_URL ? describe : describe.skip;

suite(`moonboard angle dedup migration replay (${MOONBOARD_DEDUP_REPLAY_MIGRATION_TAG})`, () => {
  let admin: postgres.Sql;
  let db: postgres.Sql;

  before(async () => {
    admin = postgres(REPLAY_URL as string, { max: 1, onnotice: () => {} });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${DB_NAME}`);
    const dbUrl = new URL(REPLAY_URL as string);
    dbUrl.pathname = `/${DB_NAME}`;
    db = postgres(dbUrl.toString(), { max: 1, onnotice: () => {} });

    await prepareMoonboardDedupReplayDatabase(db);
  });

  after(async () => {
    if (db) await db.end();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
      await admin.end();
    }
  });

  for (const check of moonboardDedupReplayChecks) {
    it(check.name, async () => {
      await check.run(db);
    });
  }
});
