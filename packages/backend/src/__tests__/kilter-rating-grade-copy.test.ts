import { describe, it, expect } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import { rowsFromResult } from '@boardsesh/db/client';
import type { ClimbStatsKey } from '@boardsesh/db/queries';
import { applyClimbRatings, applyLogs, type PowerSyncOp } from '@boardsesh/kilter-sync';

import { db } from '../db/client';

// ---------------------------------------------------------------------------
// Kilter tick grade from the climber's rating (real DB) — #6182
//
// A tick pulled from Kilter must show the grade the climber picked on Kilter,
// not the climb's consensus grade. A Kilter log has no grade; the grade rides
// the climber's climb_ratings row, and applyRatingGradesToTicks copies it onto
// the tick from whichever phase (logs or ratings) lands second.
//
// The guards live in SQL (edit guard, origin rule, detached rating, unknown
// grade) and the set_updated_at trigger decides whether the copy itself reads
// as a local edit, so this drives the REAL applyLogs / applyClimbRatings.
// Every case runs inside one transaction that is rolled back, so it leaves
// nothing behind.
// ---------------------------------------------------------------------------

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ApplyTx = Parameters<typeof applyLogs>[0];

/** Run `body` in a transaction that is always rolled back. */
async function inRolledBackTransaction(body: (tx: Tx) => Promise<void>): Promise<void> {
  const rollback = new Error('rollback');
  try {
    await db.transaction(async (tx) => {
      await body(tx);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

async function queryRows<T>(tx: Tx, query: ReturnType<typeof sql>): Promise<T[]> {
  return rowsFromResult<T>(await tx.execute(query));
}

const ANGLE = 40;
const noLog = () => {};

function logOp(logUuid: string, climbUuid: string): PowerSyncOp {
  return {
    op_id: '1',
    op: 'PUT',
    object_type: 'logs',
    object_id: logUuid,
    data: {
      id: logUuid,
      log_uuid: logUuid,
      climb_uuid: climbUuid,
      user_uuid: 'user-sub',
      gym_uuid: null,
      wall_uuid: null,
      product_layout_uuid: null,
      angle: ANGLE,
      flashed: 0,
      topped: 1,
      attempts: 3,
      created_at: '2026-10-01T18:00:00.000Z',
    },
  };
}

function ratingOp(ratingUuid: string, climbUuid: string, difficultyGradeId: number | null): PowerSyncOp {
  return {
    op_id: '1',
    op: 'PUT',
    object_type: 'climb_ratings',
    object_id: ratingUuid,
    data: {
      id: ratingUuid,
      climb_rating_uuid: ratingUuid,
      user_uuid: 'user-sub',
      gym_uuid: null,
      wall_uuid: null,
      product_layout_uuid: null,
      climb_uuid: climbUuid,
      angle: ANGLE,
      rating: 3,
      difficulty_grade_id: difficultyGradeId,
      comment: null,
      created_at: '2026-10-01T18:00:00.000Z',
    },
  };
}

type TickState = {
  difficulty: number | null;
  ctid: string;
  edited: boolean;
};

async function tickState(tx: Tx, userId: string, climbUuid: string): Promise<TickState> {
  const [row] = await queryRows<TickState>(
    tx,
    sql`SELECT difficulty, ctid::text AS ctid, (updated_at > kilter_synced_at) AS edited
          FROM boardsesh_ticks
         WHERE user_id = ${userId} AND board_type = 'kilter' AND climb_uuid = ${climbUuid} AND angle = ${ANGLE}`,
  );
  if (!row) throw new Error(`no tick for ${climbUuid}`);
  return row;
}

/** Seed the user and the kilter grades the test uses (20–24), inside the rolled-back transaction. */
async function seed(tx: Tx, tag: string): Promise<string> {
  const userId = `${tag}-user`;
  await tx.execute(sql`INSERT INTO users (id, email) VALUES (${userId}, ${`${tag}@example.test`})`);
  await tx.execute(sql`
    INSERT INTO board_difficulty_grades (board_type, difficulty, boulder_name)
    SELECT 'kilter', g, g::text FROM generate_series(20, 24) AS g
    ON CONFLICT DO NOTHING`);
  return userId;
}

/** Runs one phase with a recompute that records the keys it was handed. */
function recorder() {
  const keys: Array<{ climbUuid: string; angle: number }> = [];
  const recompute = async (_tx: unknown, batch: ClimbStatsKey[]) => {
    for (const key of batch) keys.push({ climbUuid: key.climbUuid, angle: key.angle });
  };
  return { keys, recompute };
}

async function pullLog(tx: Tx, userId: string, logUuid: string, climbUuid: string) {
  const { keys, recompute } = recorder();
  await applyLogs(tx as unknown as ApplyTx, userId, [logOp(logUuid, climbUuid)], new Map(), noLog, recompute);
  return keys;
}

async function pullRating(tx: Tx, userId: string, ratingUuid: string, climbUuid: string, grade: number | null) {
  const { keys, recompute } = recorder();
  await applyClimbRatings(
    tx as unknown as ApplyTx,
    userId,
    [ratingOp(ratingUuid, climbUuid, grade)],
    new Map(),
    noLog,
    new Map(),
    recompute,
  );
  return keys;
}

describe('kilter-sync copies the climber’s Kilter grade onto pulled ticks (#6182, real Postgres)', () => {
  it('log first, then rating: the tick takes the climber’s grade without reading as a local edit', async () => {
    await inRolledBackTransaction(async (tx) => {
      const tag = `grade-${Date.now()}-a`;
      const userId = await seed(tx, tag);
      const climb = `${tag}-climb`;

      await pullLog(tx, userId, `${tag}-log`, climb);
      expect((await tickState(tx, userId, climb)).difficulty).toBeNull();

      const recomputed = await pullRating(tx, userId, `${tag}-rating`, climb, 22);
      const after = await tickState(tx, userId, climb);
      expect(after.difficulty).toBe(22);
      expect(after.edited).toBe(false);
      expect(recomputed).toEqual([{ climbUuid: climb, angle: ANGLE }]);
    });
  });

  it('rating first, then log: the freshly inserted tick picks up the stored grade', async () => {
    await inRolledBackTransaction(async (tx) => {
      const tag = `grade-${Date.now()}-b`;
      const userId = await seed(tx, tag);
      const climb = `${tag}-climb`;

      // No tick yet: the rating phase has nothing to copy onto.
      expect(await pullRating(tx, userId, `${tag}-rating`, climb, 21)).toEqual([]);
      await pullLog(tx, userId, `${tag}-log`, climb);

      const after = await tickState(tx, userId, climb);
      expect(after.difficulty).toBe(21);
      expect(after.edited).toBe(false);
    });
  });

  it('a redelivered identical snapshot rewrites nothing; a grade changed on Kilter follows', async () => {
    await inRolledBackTransaction(async (tx) => {
      const tag = `grade-${Date.now()}-c`;
      const userId = await seed(tx, tag);
      const climb = `${tag}-climb`;
      await pullLog(tx, userId, `${tag}-log`, climb);
      await pullRating(tx, userId, `${tag}-rating`, climb, 22);
      const first = await tickState(tx, userId, climb);

      expect(await pullRating(tx, userId, `${tag}-rating`, climb, 22)).toEqual([]);
      expect((await tickState(tx, userId, climb)).ctid).toBe(first.ctid);

      await pullRating(tx, userId, `${tag}-rating`, climb, 23);
      expect((await tickState(tx, userId, climb)).difficulty).toBe(23);
    });
  });

  it('never overwrites a grade the climber edited in Boardsesh since the last sync', async () => {
    await inRolledBackTransaction(async (tx) => {
      const tag = `grade-${Date.now()}-d`;
      const userId = await seed(tx, tag);
      const climb = `${tag}-climb`;
      await pullLog(tx, userId, `${tag}-log`, climb);
      await pullRating(tx, userId, `${tag}-rating`, climb, 22);

      // A local edit: newer than the last sync, pending push-back.
      await tx.execute(sql`
        UPDATE boardsesh_ticks
           SET difficulty = 20, kilter_synced_at = kilter_synced_at - interval '1 hour'
         WHERE user_id = ${userId} AND climb_uuid = ${climb}`);
      expect((await tickState(tx, userId, climb)).edited).toBe(true);

      expect(await pullRating(tx, userId, `${tag}-rating`, climb, 24)).toEqual([]);
      expect((await tickState(tx, userId, climb)).difficulty).toBe(20);
    });
  });

  it('a native tick linked to Kilter keeps its own grade, and gains one only when it had none', async () => {
    await inRolledBackTransaction(async (tx) => {
      const tag = `grade-${Date.now()}-e`;
      const userId = await seed(tx, tag);
      const graded = `${tag}-graded`;
      const ungraded = `${tag}-ungraded`;
      for (const [climb, difficulty] of [
        [graded, 20],
        [ungraded, null],
      ] as const) {
        await tx.execute(sql`
          INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, is_mirror, status,
            attempt_count, difficulty, is_benchmark, comment, climbed_at, origin,
            kilter_id, kilter_type, kilter_synced_at, updated_at)
          VALUES (gen_random_uuid()::text, ${userId}, 'kilter', ${climb}, ${ANGLE}, false, 'send',
            1, ${difficulty}, false, '', '2026-10-01 18:00:00', 'native',
            ${`${climb}-log`}, 'logs', (now() AT TIME ZONE 'UTC') + interval '1 minute', now() AT TIME ZONE 'UTC')`);
      }

      await pullRating(tx, userId, `${tag}-r1`, graded, 23);
      await pullRating(tx, userId, `${tag}-r2`, ungraded, 23);

      expect((await tickState(tx, userId, graded)).difficulty).toBe(20);
      expect((await tickState(tx, userId, ungraded)).difficulty).toBe(23);
    });
  });

  it('no grade, a placeholder grade, an unknown grade or a detached rating leaves the tick alone', async () => {
    await inRolledBackTransaction(async (tx) => {
      const tag = `grade-${Date.now()}-f`;
      const userId = await seed(tx, tag);
      const cases: Array<[string, number | null]> = [
        [`${tag}-null`, null],
        [`${tag}-one`, 1],
        [`${tag}-unknown`, 999],
      ];
      for (const [climb, grade] of cases) {
        await pullLog(tx, userId, `${climb}-log`, climb);
        await pullRating(tx, userId, `${climb}-rating`, climb, grade);
        expect((await tickState(tx, userId, climb)).difficulty).toBeNull();
      }

      // Detached: upstream deleted the rating. Its stale grade must not reach the tick.
      const detached = `${tag}-detached`;
      await tx.execute(sql`
        INSERT INTO board_climb_ratings (board_type, climb_uuid, angle, user_id, rating, difficulty_grade_id,
          comment, kilter_detached_at)
        VALUES ('kilter', ${detached}, ${ANGLE}, ${userId}, 3, 22, '', now())`);
      await pullLog(tx, userId, `${detached}-log`, detached);
      expect((await tickState(tx, userId, detached)).difficulty).toBeNull();
    });
  });
});
