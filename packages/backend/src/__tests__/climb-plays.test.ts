import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '@boardsesh/db/client';
import { initializeJobQueueSchema } from '@boardsesh/db/job-queue-schema';
import { planClimbPlays, applyClimbPlaysBatch } from '../services/climb-plays';
import { refreshClimbPlaysFamily } from '../workers/families/refresh-climb-plays';
import type { BackgroundJobContext } from '../workers/families';

const database = createDb();
const systemOwner = '00000000-0000-0000-0000-000000000000';
let sequence = 0;

beforeEach(async () => {
  sequence = 0;
  await database.execute(
    sql`TRUNCATE board_climb_events,board_climb_stats,user_boards,board_climb_aliases,board_climbs CASCADE`,
  );
  await database.execute(
    sql`INSERT INTO users(id,email,name) VALUES ('plays-a','plays-a@test.local','A'),('plays-b','plays-b@test.local','B'),(${systemOwner},'plays-system@test.local','System') ON CONFLICT(id) DO NOTHING`,
  );
  await database.execute(
    sql`INSERT INTO board_climbs(uuid,board_type,layout_id,name) VALUES ('a','kilter',1,'A'),('b','kilter',1,'B')`,
  );
  await database.execute(
    sql`INSERT INTO board_climb_aliases(board_type,alias_uuid,canonical_uuid,source) VALUES ('kilter','alias-a','a','test')`,
  );
});

async function board(slug = 'plays-board', owner = 'plays-a', deleted = false): Promise<number> {
  const [inserted] = await database.execute<{
    id: number;
  }>(sql`INSERT INTO user_boards(uuid,slug,owner_id,board_type,layout_id,size_id,set_ids,name,deleted_at)
    VALUES (${randomUUID()},${slug},${owner},'kilter',1,1,'1','Test',${deleted ? '2026-01-01' : null}::timestamp) RETURNING id`);
  return Number(inserted.id);
}
async function event(
  boardId: number,
  climb: string,
  seconds: number,
  angle = 40,
  user: string | null = 'plays-a',
  source = 'boardsesh',
) {
  await database.execute(sql`INSERT INTO board_climb_events(board_id,board_type,climb_uuid,angle,user_id,seq,confirmed_at,source)
    VALUES (${boardId},'kilter',${climb},${angle},${user},${++sequence},timestamp '2026-01-01'+${seconds}::double precision * interval '1 second',${source})`);
}
async function stats(climb = 'a', angle = 40, plays = 0) {
  await database.execute(sql`INSERT INTO board_climb_stats(board_type,climb_uuid,angle,ascensionist_count,display_difficulty,play_count,updated_at)
    VALUES ('kilter',${climb},${angle},99,20,${plays},timestamp '2000-01-01')`);
}
function readStats(connection: Pick<typeof database, 'execute'> = database) {
  return connection.execute<{
    climb_uuid: string;
    ascensionist_count: number;
    display_difficulty: number;
    play_count: number;
    updated_at: string;
    sync_seq: string;
  }>(sql`SELECT climb_uuid, ascensionist_count::int, display_difficulty, play_count::int,
    updated_at::text, sync_seq::text FROM board_climb_stats ORDER BY climb_uuid`);
}
function context(overrides: Partial<BackgroundJobContext> = {}): BackgroundJobContext {
  return {
    runId: randomUUID(),
    family: 'refresh-climb-plays',
    database,
    signal: new AbortController().signal,
    expiresAt: Date.now() + 120000,
    transaction: (callback) => database.transaction(callback),
    enqueue: async () => {
      throw new Error('unexpected enqueue');
    },
    ...overrides,
  };
}

describe('per-angle Plays (real Postgres)', () => {
  it('merges aliases and repeats, separates angles and returns, excludes swipes and final tails', async () => {
    const wall = await board();
    await stats();
    await stats('a', 50);
    await stats('b');
    await event(wall, 'a', 0);
    await event(wall, 'alias-a', 10);
    await event(wall, 'b', 30);
    await event(wall, 'a', 59.999);
    await event(wall, 'a', 90, 50);
    await event(wall, 'b', 120);
    const plan = await planClimbPlays(database);
    expect(plan.qualifyingPlays).toBe(3);
    expect(plan.changes).toEqual([
      { boardType: 'kilter', climbUuid: 'a', angle: 40, playCount: 2 },
      { boardType: 'kilter', climbUuid: 'a', angle: 50, playCount: 1 },
    ]);
  });

  it('bounds inactivity, retains repeated-report evidence and treats a long repeat gap as a new run', async () => {
    const wall = await board();
    await stats();
    await stats('b');
    await event(wall, 'a', 0);
    await event(wall, 'b', 1800); // inclusive 30 minutes
    await event(wall, 'a', 3600.001); // b is not countable
    await event(wall, 'a', 5400.002); // previous a is not countable
    await event(wall, 'a', 7000); // still same run
    await event(wall, 'b', 7030);
    expect((await planClimbPlays(database)).changes).toEqual([
      { boardType: 'kilter', climbUuid: 'a', angle: 40, playCount: 2 },
    ]);
  });

  it('isolates shared-feed reporters but combines reporters on an individually identified board', async () => {
    const shared = await board('presence-kilter-test', systemOwner);
    const named = await board();
    await stats();
    for (const wall of [shared, named]) {
      await event(wall, 'a', 0, 40, 'plays-a');
      await event(wall, 'b', 5, 40, 'plays-b');
      await event(wall, 'b', 30, 40, 'plays-a');
    }
    await event(shared, 'a', 40, 40, null);
    await event(shared, 'b', 80, 40, null);
    const plan = await planClimbPlays(database);
    expect(plan.changes).toEqual([{ boardType: 'kilter', climbUuid: 'a', angle: 40, playCount: 1 }]);
    expect(plan.excludedRecords).toBe(2);
  });

  it('excludes QA/deleted boards and imports; ties use sequence; missing stats are reported, never created', async () => {
    await stats();
    for (const wall of [await board('boardsesh-qa-test'), await board('deleted', 'plays-a', true)]) {
      await event(wall, 'a', 0);
      await event(wall, 'b', 30);
    }
    const wall = await board();
    await event(wall, 'a', 0);
    await event(wall, 'b', 10, 40, 'plays-a', 'kilter');
    await event(wall, 'b', 30);
    await event(wall, 'a', 30); // zero-duration b
    await event(wall, 'b', 60);
    await event(wall, 'missing', 90);
    await event(wall, 'tail', 120);
    const plan = await planClimbPlays(database);
    expect(plan.changes).toEqual([{ boardType: 'kilter', climbUuid: 'a', angle: 40, playCount: 2 }]);
    expect(plan.unmatchedKeys).toBe(2);
    expect(plan.unmatchedPlays).toBe(2);
    expect(plan.excludedRecords).toBe(4);
    await refreshClimbPlaysFamily.execute(context(), { dryRun: false });
    expect(await database.execute(sql`SELECT climb_uuid FROM board_climb_stats ORDER BY climb_uuid`)).toEqual([
      { climb_uuid: 'a' },
    ]);
  });

  it('publishes changed and cleared Plays through the stats cursor, and skips equal writes', async () => {
    const wall = await board();
    await stats();
    await stats('b', 40, 9);
    await event(wall, 'a', 0);
    await event(wall, 'b', 30);
    const before = await readStats();
    const firstPlan = await planClimbPlays(database);
    await refreshClimbPlaysFamily.execute(context(), { dryRun: false });
    const after = await readStats();
    expect(after).toEqual([
      expect.objectContaining({ climb_uuid: 'a', ascensionist_count: 99, display_difficulty: 20, play_count: 1 }),
      expect.objectContaining({ climb_uuid: 'b', ascensionist_count: 99, display_difficulty: 20, play_count: 0 }),
    ]);
    for (const [index, row] of after.entries()) {
      expect(BigInt(row.sync_seq)).toBeGreaterThan(BigInt(before[index].sync_seq));
      expect(row.updated_at).not.toBe(before[index].updated_at);
    }

    // A fresh plan skips equal counts. Even a stale plan must skip them at write time.
    expect(await applyClimbPlaysBatch(database, firstPlan.changes)).toBe(0);
    expect((await planClimbPlays(database)).changes).toEqual([]);
    await refreshClimbPlaysFamily.execute(context(), { dryRun: false });
    expect(await readStats()).toEqual(after);
    await expect(database.execute(sql`UPDATE board_climb_stats SET play_count=-1`)).rejects.toThrow();
  });

  it('dry runs, failed planning, and cancellation never enter a write transaction', async () => {
    const wall = await board();
    await stats();
    await event(wall, 'a', 0);
    await event(wall, 'b', 30);
    const noWrites: BackgroundJobContext['transaction'] = async () => {
      throw new Error('write attempted');
    };
    await refreshClimbPlaysFamily.execute(context({ transaction: noWrites }), { dryRun: true });
    const failed = {
      execute: async () => {
        throw new Error('read failed');
      },
    } as unknown as BackgroundJobContext['database'];
    await expect(
      refreshClimbPlaysFamily.execute(context({ database: failed, transaction: noWrites }), { dryRun: false }),
    ).rejects.toThrow('read failed');
    const controller = new AbortController();
    controller.abort();
    await expect(
      refreshClimbPlaysFamily.execute(context({ signal: controller.signal, transaction: noWrites }), { dryRun: false }),
    ).rejects.toThrow();
    expect((await planClimbPlays(database)).changes).toHaveLength(1);
  });

  it('defaults to zero and cannot resurrect a row deleted after planning', async () => {
    const wall = await board();
    await database.execute(sql`INSERT INTO board_climb_stats(board_type,climb_uuid,angle) VALUES ('kilter','a',40)`);
    expect(await database.execute(sql`SELECT play_count::int AS plays FROM board_climb_stats`)).toEqual([{ plays: 0 }]);
    await event(wall, 'a', 0);
    await event(wall, 'b', 30);
    const plan = await planClimbPlays(database);
    await database.execute(sql`DELETE FROM board_climb_stats WHERE climb_uuid='a'`);
    expect(await applyClimbPlaysBatch(database, plan.changes)).toBe(0);
    expect(await database.execute(sql`SELECT climb_uuid FROM board_climb_stats`)).toEqual([]);
  });

  it('writes at most 500 keys per fence and retry recomputes after a partial commit', async () => {
    const wall = await board();
    await database.execute(sql`INSERT INTO board_climb_stats(board_type,climb_uuid,angle)
      SELECT 'kilter','batch-'||series,40 FROM generate_series(1,501) AS series`);
    await database.execute(sql`INSERT INTO board_climb_events(board_id,board_type,climb_uuid,angle,user_id,seq,confirmed_at)
      SELECT ${wall},'kilter','batch-'||series,40,'plays-a',series,timestamp '2026-01-01'+series*interval '30 seconds'
      FROM generate_series(1,502) AS series`);
    let fences = 0;
    await expect(
      refreshClimbPlaysFamily.execute(
        context({
          transaction: async (callback) => {
            fences++;
            if (fences === 2) throw new Error('interrupted after first batch');
            return database.transaction(callback);
          },
        }),
        { dryRun: false },
      ),
    ).rejects.toThrow('interrupted after first batch');
    expect(
      await database.execute(sql`SELECT count(*)::int AS populated FROM board_climb_stats WHERE play_count=1`),
    ).toEqual([{ populated: 500 }]);
    expect((await planClimbPlays(database)).changes).toHaveLength(1);
    await refreshClimbPlaysFamily.execute(context(), { dryRun: false });
    expect((await planClimbPlays(database)).changes).toEqual([]);
  });

  it('publishes Plays as the restricted batch role and denies direct stats cursor, grade and insert writes', async () => {
    const role = `plays_${randomUUID().replaceAll('-', '')}`;
    const wall = await board();
    await stats();
    await event(wall, 'a', 0);
    await event(wall, 'b', 30);
    const [ledger] = await database.execute<{ present: string | null }>(
      sql`SELECT to_regclass('public.background_job_runs') AS present`,
    );
    if (!ledger.present) {
      for (const migration of ['0241_background_job_runs.sql', '0243_background_job_families.sql']) {
        await database.execute(
          sql.raw(readFileSync(new URL(`../../../db/drizzle/${migration}`, import.meta.url), 'utf8')),
        );
      }
    }
    await database.execute(sql`CREATE ROLE ${sql.identifier(role)} NOLOGIN`);
    try {
      const owner = postgres(process.env.DATABASE_URL!, { max: 1 });
      try {
        await initializeJobQueueSchema(drizzle(owner), undefined, undefined, [`batch=${role}`]);
      } finally {
        await owner.end();
      }
      await database.transaction(async (transaction) => {
        await transaction.execute(sql`SET LOCAL ROLE ${sql.identifier(role)}`);
        const [before] = await readStats(transaction);
        const plan = await planClimbPlays(transaction);
        expect(await applyClimbPlaysBatch(transaction, plan.changes)).toBe(1);
        const [after] = await readStats(transaction);
        expect(after.play_count).toBe(1);
        expect(BigInt(after.sync_seq)).toBeGreaterThan(BigInt(before.sync_seq));
      });
      for (const denied of [
        sql`UPDATE board_climb_stats SET display_difficulty=21`,
        sql`UPDATE board_climb_stats SET updated_at=NOW()`,
        sql`UPDATE board_climb_stats SET sync_seq=0`,
        sql`INSERT INTO board_climb_stats(board_type,climb_uuid,angle) VALUES ('kilter','forbidden',40)`,
      ]) {
        await expect(
          database.transaction(async (transaction) => {
            await transaction.execute(sql`SET LOCAL ROLE ${sql.identifier(role)}`);
            await transaction.execute(denied);
          }),
        ).rejects.toMatchObject({ cause: { code: '42501' } });
      }
    } finally {
      await database.execute(sql`DROP OWNED BY ${sql.identifier(role)}`);
      await database.execute(sql`DROP ROLE ${sql.identifier(role)}`);
    }
  });
});
