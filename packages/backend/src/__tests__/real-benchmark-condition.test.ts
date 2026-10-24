/**
 * `realBenchmarkCondition` is the one rule for "this stats row marks a
 * benchmark": a real number above zero. Postgres ranks NaN above every number,
 * so the old `> 0` let NaN through, and Kilter holds tens of thousands of NaN
 * rows (#6232). These run the rule against a real Postgres, alone and in the
 * Tension benchmark holdout that the grade refresh scores and that the rater
 * and behavior fits leave out with `NOT (...)`.
 */
import { like, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vite-plus/test';
import * as dbSchema from '@boardsesh/db/schema';
import {
  TENSION_BENCHMARK_HOLDOUT_MODULUS,
  TENSION_BENCHMARK_HOLDOUT_REMAINDER,
  buildTensionBenchmarkHoldoutPredicate,
  buildTensionBenchmarkHoldoutSql,
  realBenchmarkCondition,
  rowsOf,
} from '@boardsesh/db/queries';
import { db } from '../db/client';

const PREFIX = 'real-benchmark-condition-';
const ANGLE = 40;

/** The four shapes a stats row's benchmark_difficulty takes, as SQL literals. */
const BENCHMARK_VALUES = {
  nan: sql`'NaN'::double precision`,
  null: sql`NULL::double precision`,
  zero: sql`0::double precision`,
  real: sql`15::double precision`,
} as const;
type BenchmarkKey = keyof typeof BENCHMARK_VALUES;
const BENCHMARK_KEYS = Object.keys(BENCHMARK_VALUES) as BenchmarkKey[];

describe('realBenchmarkCondition', () => {
  it('is true only for a real number above zero, and never NULL', async () => {
    const results: Record<string, boolean | null> = {};
    for (const key of BENCHMARK_KEYS) {
      const [row] = rowsOf<{ isBenchmark: boolean | null; negated: boolean | null }>(
        await db.execute(sql`
          SELECT ${realBenchmarkCondition(sql`value`)} AS "isBenchmark",
                 NOT ${realBenchmarkCondition(sql`value`)} AS negated
          FROM (SELECT ${BENCHMARK_VALUES[key]} AS value) AS input
        `),
      );
      results[key] = row.isBenchmark;
      // Two-valued, so a NOT around it keeps every non-benchmark row.
      expect(row.negated).toBe(!row.isBenchmark);
    }
    expect(results).toEqual({ nan: false, null: false, zero: false, real: true });
  });
});

describe('Tension benchmark holdout', () => {
  afterAll(async () => {
    await db.delete(dbSchema.boardClimbStats).where(like(dbSchema.boardClimbStats.climbUuid, `${PREFIX}%`));
    await db.delete(dbSchema.boardClimbs).where(like(dbSchema.boardClimbs.uuid, `${PREFIX}%`));
  });

  /** Climb uuids whose stable climb+angle hash lands in the held-out bucket. */
  async function holdoutBucketUuids(count: number): Promise<string[]> {
    const rows = rowsOf<{ uuid: string }>(
      await db.execute(sql`
        SELECT candidate.uuid
        FROM generate_series(1, 500) AS series(n)
        CROSS JOIN LATERAL (SELECT ${PREFIX} || series.n::text AS uuid) AS candidate
        WHERE ABS(('x' || SUBSTR(md5(candidate.uuid || ':' || ${ANGLE}::text), 1, 8))::bit(32)::int)
          % ${TENSION_BENCHMARK_HOLDOUT_MODULUS} = ${TENSION_BENCHMARK_HOLDOUT_REMAINDER}
        ORDER BY series.n
        LIMIT ${count}
      `),
    );
    return rows.map((row) => row.uuid);
  }

  it('holds out only real benchmarks and trains on every other row', async () => {
    const uuids = await holdoutBucketUuids(BENCHMARK_KEYS.length);
    expect(uuids).toHaveLength(BENCHMARK_KEYS.length);
    const uuidByKey = Object.fromEntries(BENCHMARK_KEYS.map((key, index) => [key, uuids[index]])) as Record<
      BenchmarkKey,
      string
    >;

    for (const key of BENCHMARK_KEYS) {
      await db.execute(sql`
        INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, frames, frames_count, is_draft, is_listed, edge_left, edge_right, edge_bottom, edge_top, created_at)
        VALUES (${uuidByKey[key]}, 'tension', 10, 'test-setter', ${`Holdout ${key}`}, 'p1r1', 1, false, true, 0, 100, 0, 150, '2024-01-01')
      `);
      await db.execute(sql`
        INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty, benchmark_difficulty, ascensionist_count, difficulty_average, quality_average)
        VALUES ('tension', ${uuidByKey[key]}, ${ANGLE}, 15, ${BENCHMARK_VALUES[key]}, 10, 15, 3)
      `);
    }

    const holdout = rowsOf<{ climb_uuid: string }>(await db.execute(buildTensionBenchmarkHoldoutSql())).filter((row) =>
      row.climb_uuid.startsWith(PREFIX),
    );
    expect(holdout.map((row) => row.climb_uuid)).toEqual([uuidByKey.real]);

    // The rater and behavior fits read `NOT (predicate)`: everything but the
    // held-out benchmark stays in, NULL included.
    const trained = rowsOf<{ climb_uuid: string }>(
      await db.execute(sql`
        SELECT s.climb_uuid FROM board_climb_stats s
        WHERE s.climb_uuid LIKE ${`${PREFIX}%`}
          AND NOT (${buildTensionBenchmarkHoldoutPredicate()})
      `),
    ).map((row) => row.climb_uuid);
    expect(trained).toHaveLength(3);
    expect(trained).toEqual(expect.arrayContaining([uuidByKey.nan, uuidByKey.null, uuidByKey.zero]));
  });
});
