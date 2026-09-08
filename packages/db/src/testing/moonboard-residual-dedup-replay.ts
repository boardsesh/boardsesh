import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type postgres from 'postgres';
import {
  MOONBOARD_DEDUP_REPLAY_SCHEMA_SQL,
  MOONBOARD_DEDUP_REPLAY_SEED_SQL,
  MOONBOARD_DEDUP_REPLAY_PRE_CURSORS_SQL,
  moonboardDedupReplayChecks,
  type MoonboardDedupReplayCheck,
} from './moonboard-angle-dedup-replay.js';

export const RESIDUAL_MIGRATION_TAG = '0223_moonboard_residual_dedup';
export function residualMigrationSql() {
  return readFileSync(path.resolve(import.meta.dirname, '../../drizzle', `${RESIDUAL_MIGRATION_TAG}.sql`), 'utf8');
}

export async function prepareResidualReplay(db: postgres.Sql, beforeMigration?: () => Promise<void>) {
  await db.unsafe(MOONBOARD_DEDUP_REPLAY_SCHEMA_SQL);
  await db`ALTER TABLE board_climbs ADD COLUMN name text, ADD COLUMN frames_count integer DEFAULT 1`;
  await db.unsafe(MOONBOARD_DEDUP_REPLAY_SEED_SQL);
  await db`UPDATE board_climbs SET name = left(uuid, 1)`;
  await db.unsafe(`
    -- Three roots at one signature: NULL angle, repeated 40 degrees, plus
    -- a missing-native-angle stats row. The NULL-angle member wins by its
    -- peak count. Separate names sum; identical names with unequal counts sum.
    INSERT INTO board_climbs (uuid, name, board_type, layout_id, angle, is_listed, created_at) VALUES
      ('n-null','Same','moonboard',2,NULL,true,'2024-01-01'),
      ('n-40','same','moonboard',2,40,true,'2024-01-02'),
      ('n-missing','Different','moonboard',2,40,true,'2024-01-03'),
      ('n-retired','same','moonboard',2,40,false,'2024-01-01'),
      ('n-draft','same','moonboard',2,40,true,'2024-01-01'),
      ('n-owned','same','moonboard',2,40,true,'2024-01-01'),
      ('n-multiframe','same','moonboard',2,40,true,'2024-01-01'),
      ('n-other-layout','same','moonboard',3,40,true,'2024-01-01'),
      ('n-different-holds','same','moonboard',2,40,true,'2024-01-01'),
      ('n-holdless','same','moonboard',2,40,true,'2024-01-01'),
      ('n-redirected','same','moonboard',2,40,true,'2024-01-01');
    UPDATE board_climbs SET is_draft=true WHERE uuid='n-draft';
    UPDATE board_climbs SET user_id='owner' WHERE uuid='n-owned';
    UPDATE board_climbs SET frames_count=2 WHERE uuid='n-multiframe';
    INSERT INTO board_climb_holds (board_type,climb_uuid,hold_id,hold_state)
      SELECT 'moonboard',uuid,100,'STARTING' FROM board_climbs WHERE uuid LIKE 'n-%' AND uuid <> 'n-holdless';
    INSERT INTO board_climb_holds (board_type,climb_uuid,hold_id,hold_state)
      SELECT 'moonboard',uuid,CASE WHEN uuid='n-different-holds' THEN 102 ELSE 101 END,'FINISH'
        FROM board_climbs WHERE uuid LIKE 'n-%' AND uuid <> 'n-holdless';
    INSERT INTO board_climb_aliases(board_type,alias_uuid,canonical_uuid,source) VALUES
      ('moonboard','n-retired','n-null','old-dedup'),
      ('moonboard','n-redirected','n-40','old-dedup'),
      ('moonboard','n-40','n-40','catalog'),
      ('moonboard','n-external-alias','n-40','catalog');
    INSERT INTO board_climb_stats(board_type,climb_uuid,angle,upstream_ascensionist_count,ascensionist_count,boardsesh_ascensionist_count,display_difficulty,upstream_quality_average) VALUES
      ('moonboard','n-null',40,50,50,0,20,4),
      ('moonboard','n-null',25,10,10,0,NULL,NULL),
      ('moonboard','n-40',40,20,20,0,22,3),
      ('moonboard','n-40',25,10,10,0,18,2),
      ('moonboard','n-missing',25,10,10,0,19,3),
      ('moonboard','n-retired',40,900,900,0,20,4),
      ('moonboard','n-redirected',40,800,800,0,20,4);

    -- A listed redirect escapes this group: both roots must stay untouched.
    INSERT INTO board_climbs(uuid,name,board_type,layout_id,angle,is_listed) VALUES
      ('conflict-a','A','moonboard',2,40,true),
      ('conflict-b','B','moonboard',2,40,true),
      ('conflict-redirect','C','moonboard',2,40,true);
    INSERT INTO board_climb_holds(board_type,climb_uuid,hold_id,hold_state)
      SELECT 'moonboard',uuid,110,'STARTING' FROM board_climbs WHERE uuid LIKE 'conflict-%';
    INSERT INTO board_climb_aliases(board_type,alias_uuid,canonical_uuid,source) VALUES
      ('moonboard','conflict-redirect','n-different-holds','catalog');
    -- NULL counts coalesce to zero; missing stats rows do not invent grades.
    INSERT INTO board_climbs(uuid,name,board_type,layout_id,angle,is_listed,created_at) VALUES
      ('zero-a','Zero','moonboard',2,NULL,true,'2024-01-01'),
      ('zero-b','ZERO','moonboard',2,NULL,true,'2024-01-01');
    INSERT INTO board_climb_holds(board_type,climb_uuid,hold_id,hold_state) VALUES
      ('moonboard','zero-a',120,'STARTING'),('moonboard','zero-b',120,'STARTING');
    INSERT INTO board_climb_stats(board_type,climb_uuid,angle) VALUES ('moonboard','zero-b',40);
    CREATE TABLE _residual_original_ticks AS SELECT uuid,climb_uuid,angle,climbed_at FROM boardsesh_ticks;
    CREATE TABLE _residual_original_holds AS TABLE board_climb_holds;
    CREATE TABLE _residual_original_climbs AS SELECT uuid FROM board_climbs;
  `);
  await db.unsafe(MOONBOARD_DEDUP_REPLAY_PRE_CURSORS_SQL);
  await beforeMigration?.();
  await db.unsafe(residualMigrationSql());
}

// Reuse the full reference-collision, recount and offline-sync regression suite.
// Only these three assertions describe the OLD angle-only merge policy.
const replacedChecks = new Set([
  'CASE B: same-angle collision group left completely untouched',
  'CASE E: two aliases holding a stats row at the SAME target angle fold by the documented rank',
  'records the guard row; re-application is a no-op',
]);

export const residualReplayChecks: MoonboardDedupReplayCheck[] = [
  ...moonboardDedupReplayChecks.filter((check) => !replacedChecks.has(check.name)),
  {
    name: 'same-name same-angle double imports use MAX and preserve oldest UUID',
    run: async (db) => {
      assert.deepEqual(
        (await db`SELECT uuid,is_listed FROM board_climbs WHERE uuid IN ('q25a','q25b') ORDER BY uuid`).map((row) => [
          row.uuid,
          row.is_listed,
        ]),
        [
          ['q25a', true],
          ['q25b', false],
        ],
      );
      assert.equal(
        Number(
          (await db`SELECT upstream_ascensionist_count FROM board_climb_stats WHERE climb_uuid='q25a'`)[0]
            .upstream_ascensionist_count,
        ),
        1,
      );
    },
  },
  {
    name: 'same-name differing counts SUM while native-angle grade wins fallback',
    run: async (db) => {
      const [stat] = await db`SELECT * FROM board_climb_stats WHERE climb_uuid='w40' AND angle=55`;
      assert.equal(Number(stat.upstream_ascensionist_count), 16);
      assert.equal(Number(stat.ascensionist_count), 16);
      assert.equal(stat.display_difficulty, 21);
      assert.equal(stat.upstream_quality_average, 4.4);
    },
  },
  {
    name: 'angle-null canonical preserves each angle, SUMs independent cohorts and excludes old aliases',
    run: async (db) => {
      const stats =
        await db`SELECT angle,upstream_ascensionist_count,display_difficulty,upstream_quality_average FROM board_climb_stats WHERE climb_uuid='n-null' ORDER BY angle`;
      assert.deepEqual(
        stats.map((stat) => [
          stat.angle,
          Number(stat.upstream_ascensionist_count),
          stat.display_difficulty,
          stat.upstream_quality_average,
        ]),
        [
          [25, 30, 18, 2],
          [40, 70, 20, 4],
        ],
      );
      assert.equal((await db`SELECT angle FROM board_climbs WHERE uuid='n-null'`)[0].angle, null);
      const aliases =
        await db`SELECT alias_uuid,canonical_uuid FROM board_climb_aliases WHERE alias_uuid IN ('n-40','n-missing','n-external-alias','n-redirected')`;
      assert.equal(aliases.length, 4);
      assert.ok(aliases.every((alias) => alias.canonical_uuid === 'n-null'));
      assert.equal(
        Number(
          (await db`SELECT upstream_ascensionist_count FROM board_climb_stats WHERE climb_uuid='n-retired'`)[0]
            .upstream_ascensionist_count,
        ),
        900,
      );
    },
  },
  {
    name: 'draft, owned, multiframe, holdless, different-layout and redirect-conflict rows stay untouched',
    run: async (db) => {
      const rows =
        await db`SELECT uuid,is_listed FROM board_climbs WHERE uuid IN ('n-draft','n-owned','n-multiframe','n-other-layout','n-different-holds','n-holdless','conflict-a','conflict-b','conflict-redirect')`;
      assert.equal(rows.length, 9);
      assert.ok(rows.every((row) => row.is_listed === true));
      assert.equal(
        (await db`SELECT 1 FROM board_climb_aliases WHERE alias_uuid IN ('conflict-a','conflict-b')`).length,
        0,
      );
      assert.equal(
        (await db`SELECT canonical_uuid FROM board_climb_aliases WHERE alias_uuid='conflict-redirect'`)[0]
          .canonical_uuid,
        'n-different-holds',
      );
    },
  },
  {
    name: 'missing stats and null upstream counts do not prevent a deterministic merge',
    run: async (db) => {
      assert.equal(
        (await db`SELECT canonical_uuid FROM board_climb_aliases WHERE alias_uuid='zero-b'`)[0].canonical_uuid,
        'zero-a',
      );
      const [stat] = await db`SELECT * FROM board_climb_stats WHERE climb_uuid='zero-a'`;
      assert.equal(Number(stat.upstream_ascensionist_count), 0);
      assert.equal(Number(stat.ascensionist_count), 0);
      assert.equal(stat.display_difficulty, null);
    },
  },
  {
    name: 'all climb identities, hold rows and tick history survive',
    run: async (db) => {
      assert.equal((await db`SELECT * FROM _residual_original_climbs EXCEPT SELECT uuid FROM board_climbs`).length, 0);
      assert.equal((await db`SELECT * FROM _residual_original_holds EXCEPT SELECT * FROM board_climb_holds`).length, 0);
      assert.equal(
        (
          await db`SELECT uuid,angle,climbed_at FROM _residual_original_ticks EXCEPT SELECT uuid,angle,climbed_at FROM boardsesh_ticks`
        ).length,
        0,
      );
    },
  },
  {
    name: 'the semantic guard makes reapplication byte-for-byte inert',
    run: async (db) => {
      const snapshot = () => db`SELECT jsonb_build_object(
        'climbs',(SELECT jsonb_agg(to_jsonb(c) ORDER BY uuid) FROM board_climbs c),
        'stats',(SELECT jsonb_agg(to_jsonb(s) ORDER BY climb_uuid,angle) FROM board_climb_stats s),
        'aliases',(SELECT jsonb_agg(to_jsonb(a) ORDER BY alias_uuid) FROM board_climb_aliases a),
        'tombstones',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM sync_deletions d)
      ) AS snapshot`;
      const before = await snapshot();
      await db.unsafe(residualMigrationSql());
      assert.deepEqual(await snapshot(), before);
      assert.equal((await db`SELECT 1 FROM _bs_migration_guards WHERE tag='moonboard_residual_dedup_5253'`).length, 1);
    },
  },
];
