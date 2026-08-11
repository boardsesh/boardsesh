import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { getPostgresConstraintName, getPostgresErrorCode } from '../utils/postgres-errors';
import { getWorkerDatabaseUrl, setupWorkerDatabase } from './worker-db';

// ---------------------------------------------------------------------------
// #3551: DB-level range guard on board_climb_stats.quality_average and
// board_climb_stats.upstream_quality_average.
//
// Both columns are only ever kept on the canonical 1-5 scale by in-code
// guards (blendedQualityAverageSql, recompute filters, upstream writers) —
// this CHECK is defense-in-depth so a future writer regression fails loud
// instead of silently poisoning stats. Mirrors board_climb_ratings_rating_range
// (migration 0112). Bound is `> 0` (not `>= 1`) because both columns are float
// blends, not integer votes.
// ---------------------------------------------------------------------------

describe('board_climb_stats quality range CHECK constraints (real DB)', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    await setupWorkerDatabase();
    client = postgres(getWorkerDatabaseUrl(), { max: 1, onnotice: () => {} });
    db = drizzle(client);
  });

  afterAll(async () => {
    if (client) await client.end();
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE board_climb_stats RESTART IDENTITY CASCADE`);
  });

  async function insertStats(qualityAverage: number | null, upstreamQualityAverage: number | null) {
    await db.execute(sql`
      INSERT INTO board_climb_stats
        (board_type, climb_uuid, angle, quality_average, upstream_quality_average)
      VALUES ('kilter', 'CHK1', 40, ${qualityAverage}, ${upstreamQualityAverage})
    `);
  }

  // drizzle-orm >= 0.44 wraps the driver's PostgresError in a DrizzleQueryError
  // whose top-level `.message` is just "Failed query: ..." — the constraint
  // name lives on the underlying cause, so match it via the same cause-chain
  // helper the resolvers use for unique-violation handling (postgres-errors.ts),
  // not a fragile message regex.
  async function expectCheckViolation(insertPromise: Promise<unknown>, constraintName: string) {
    let caughtError: unknown;
    try {
      await insertPromise;
    } catch (error) {
      caughtError = error;
    }
    expect(caughtError).toBeDefined();
    expect(getPostgresErrorCode(caughtError)).toBe('23514'); // check_violation
    expect(getPostgresConstraintName(caughtError)).toBe(constraintName);
  }

  describe('quality_average', () => {
    it.each([0, -1, 5.01])('rejects %s as out of range', async (badValue) => {
      await expectCheckViolation(insertStats(badValue, null), 'board_climb_stats_quality_average_range');
    });

    it.each([0.5, 1, 5])('accepts %s as in range', async (goodValue) => {
      await insertStats(goodValue, null);
    });

    it('accepts NULL', async () => {
      await insertStats(null, null);
    });
  });

  describe('upstream_quality_average', () => {
    it.each([0, -1, 5.01])('rejects %s as out of range', async (badValue) => {
      await expectCheckViolation(insertStats(null, badValue), 'board_climb_stats_upstream_quality_average_range');
    });

    it.each([0.5, 1, 5])('accepts %s as in range', async (goodValue) => {
      await insertStats(null, goodValue);
    });

    it('accepts NULL', async () => {
      await insertStats(null, null);
    });
  });
});
