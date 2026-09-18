import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import postgres from 'postgres';

const REPLAY_URL = process.env.MIGRATION_REPLAY_DB_URL;
const DB_NAME = 'bs_moonboard_snapped_angle_repair';
const MIGRATION_PATH = path.resolve(
  import.meta.dirname,
  '../../../../drizzle/0232_repair_moonboard_snapped_tick_angles.sql',
);

type RepairRow = {
  tickUuid: string;
  climbUuid: string;
  expectedUpdatedAt: string;
  fromAngle: number;
  toAngle: number;
};

function readRepairRows(migrationSql: string): RepairRow[] {
  const rowPattern = /\('([^']+)', '([^']+)', '([^']+)'::timestamp, (\d+), (\d+)\)/g;
  return [...migrationSql.matchAll(rowPattern)].map((match) => ({
    tickUuid: match[1],
    climbUuid: match[2],
    expectedUpdatedAt: match[3],
    fromAngle: Number(match[4]),
    toAngle: Number(match[5]),
  }));
}

function quoteSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

const suite = REPLAY_URL ? describe : describe.skip;

void suite('MoonBoard snapped-angle migration replay', () => {
  let admin: postgres.Sql;
  let db: postgres.Sql;
  let migrationSql: string;
  let repairs: RepairRow[];

  before(async () => {
    migrationSql = readFileSync(MIGRATION_PATH, 'utf8');
    repairs = readRepairRows(migrationSql);
    assert.equal(repairs.length, 55);
    assert.equal(new Set(repairs.map((repair) => repair.tickUuid)).size, 55);

    admin = postgres(REPLAY_URL as string, { max: 1, onnotice: () => {} });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${DB_NAME}`);
    const databaseUrl = new URL(REPLAY_URL as string);
    databaseUrl.pathname = `/${DB_NAME}`;
    db = postgres(databaseUrl.toString(), { max: 1, onnotice: () => {} });

    await db.unsafe(`
      CREATE TABLE board_climbs (
        board_type text NOT NULL,
        uuid text NOT NULL,
        user_id text,
        PRIMARY KEY (board_type, uuid)
      );
      CREATE TABLE boardsesh_ticks (
        id bigserial PRIMARY KEY,
        uuid text NOT NULL UNIQUE,
        user_id text NOT NULL,
        board_type text NOT NULL,
        climb_uuid text NOT NULL,
        angle integer NOT NULL,
        origin text NOT NULL,
        status text NOT NULL,
        quality integer,
        climbed_at timestamp without time zone NOT NULL,
        created_at timestamp without time zone NOT NULL,
        updated_at timestamp without time zone NOT NULL,
        kilter_detached_at timestamp without time zone,
        kilter_id integer,
        kilter_synced_at timestamp without time zone
      );
      CREATE TABLE board_beta_links (
        tick_uuid text,
        board_type text NOT NULL,
        angle integer NOT NULL
      );
      CREATE TABLE board_climb_stats (
        board_type text NOT NULL,
        climb_uuid text NOT NULL,
        angle integer NOT NULL,
        ascensionist_count bigint,
        upstream_ascensionist_count bigint,
        boardsesh_ascensionist_count bigint,
        quality_normalized boolean NOT NULL DEFAULT false,
        upstream_synced_at timestamp without time zone,
        upstream_quality_average double precision,
        boardsesh_quality_sum double precision,
        boardsesh_quality_count bigint,
        quality_average double precision,
        display_difficulty double precision,
        benchmark_difficulty double precision,
        fa_username text,
        PRIMARY KEY (board_type, climb_uuid, angle)
      );
    `);
  });

  after(async () => {
    if (db) await db.end();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
      await admin.end();
    }
  });

  void it('is a clean no-op when production UUIDs are absent', async () => {
    await db.begin(async (transaction) => {
      await transaction.unsafe(migrationSql);
    });
    assert.equal((await db`SELECT count(*)::integer AS count FROM boardsesh_ticks`)[0].count, 0);
  });

  void it('rejects a partial or subsequently changed repair set atomically', async () => {
    const climbUuids = [...new Set(repairs.map((repair) => repair.climbUuid))];
    await db`INSERT INTO board_climbs ${db(
      climbUuids.map((climbUuid) => ({ board_type: 'moonboard', uuid: climbUuid, user_id: null })),
      'board_type',
      'uuid',
      'user_id',
    )}`;
    // postgres.js converts parameterized timestamp strings through Date and
    // loses digits 4-6. SQL literals preserve the production microseconds that
    // the migration deliberately uses as its optimistic-concurrency fence.
    const tickValues = repairs
      .map(
        (repair) => `(
          ${quoteSqlLiteral(repair.tickUuid)},
          ${quoteSqlLiteral(repair.tickUuid)},
          'moonboard',
          ${quoteSqlLiteral(repair.climbUuid)},
          ${repair.fromAngle},
          'native',
          'send',
          5,
          ${quoteSqlLiteral(repair.expectedUpdatedAt)}::timestamp,
          ${quoteSqlLiteral(repair.expectedUpdatedAt)}::timestamp,
          ${quoteSqlLiteral(repair.expectedUpdatedAt)}::timestamp
        )`,
      )
      .join(',');
    await db.unsafe(`
      INSERT INTO boardsesh_ticks (
        uuid, user_id, board_type, climb_uuid, angle, origin, status, quality,
        climbed_at, created_at, updated_at
      ) VALUES ${tickValues}
    `);
    await db`INSERT INTO board_climb_stats ${db(
      climbUuids.map((climbUuid) => ({
        board_type: 'moonboard',
        climb_uuid: climbUuid,
        angle: 40,
        ascensionist_count: 7,
        upstream_ascensionist_count: 7,
        boardsesh_ascensionist_count: 0,
        quality_normalized: true,
        upstream_quality_average: 4,
        quality_average: 4,
        display_difficulty: 20,
        benchmark_difficulty: 21,
        fa_username: 'Catalog FA',
      })),
      'board_type',
      'climb_uuid',
      'angle',
      'ascensionist_count',
      'upstream_ascensionist_count',
      'boardsesh_ascensionist_count',
      'quality_normalized',
      'upstream_quality_average',
      'quality_average',
      'display_difficulty',
      'benchmark_difficulty',
      'fa_username',
    )}`;

    const changedRepair = repairs[0];
    await db`UPDATE boardsesh_ticks SET updated_at = updated_at + interval '1 second' WHERE uuid = ${changedRepair.tickUuid}`;

    await assert.rejects(
      db.begin(async (transaction) => {
        await transaction.unsafe(migrationSql);
      }),
      /expected 55 unchanged ticks, found 54/,
    );

    const angles = await db`SELECT DISTINCT angle FROM boardsesh_ticks`;
    assert.deepEqual(
      angles.map((row) => row.angle),
      [40],
    );

    await db`UPDATE boardsesh_ticks SET updated_at = ${changedRepair.expectedUpdatedAt} WHERE uuid = ${changedRepair.tickUuid}`;
  });

  void it('moves 55 exact ticks and recounts both angles without overwriting catalog data', async () => {
    const firstRepair = repairs[0];
    const firstClimbCount = repairs.filter((repair) => repair.climbUuid === firstRepair.climbUuid).length;
    await db`INSERT INTO board_beta_links (tick_uuid, board_type, angle) VALUES (${firstRepair.tickUuid}, 'moonboard', 40)`;
    await db`INSERT INTO board_climb_stats (
      board_type, climb_uuid, angle, ascensionist_count,
      upstream_ascensionist_count, boardsesh_ascensionist_count,
      quality_normalized, upstream_quality_average, quality_average,
      display_difficulty, benchmark_difficulty, fa_username
    ) VALUES (
      'moonboard', ${firstRepair.climbUuid}, 25, 3, 3, 0,
      true, 3, 3, 18, 19, '25-degree Catalog FA'
    )`;

    await db.begin(async (transaction) => {
      await transaction.unsafe(migrationSql);
    });

    const tickSummary = await db`
      SELECT count(*)::integer AS count, min(angle)::integer AS min_angle, max(angle)::integer AS max_angle
      FROM boardsesh_ticks
    `;
    assert.deepEqual(tickSummary[0], { count: 55, min_angle: 25, max_angle: 25 });
    assert.equal((await db`SELECT angle FROM board_beta_links WHERE tick_uuid = ${firstRepair.tickUuid}`)[0].angle, 25);

    const oldStats = await db`
      SELECT ascensionist_count::integer, upstream_ascensionist_count::integer,
             boardsesh_ascensionist_count::integer,
             quality_average, display_difficulty, benchmark_difficulty, fa_username
      FROM board_climb_stats
      WHERE board_type = 'moonboard' AND climb_uuid = ${firstRepair.climbUuid} AND angle = 40
    `;
    assert.deepEqual(oldStats[0], {
      ascensionist_count: 7,
      upstream_ascensionist_count: 7,
      boardsesh_ascensionist_count: 0,
      quality_average: 4,
      display_difficulty: 20,
      benchmark_difficulty: 21,
      fa_username: 'Catalog FA',
    });

    const newStats = await db`
      SELECT ascensionist_count::integer, upstream_ascensionist_count::integer,
             boardsesh_ascensionist_count::integer,
             quality_average, display_difficulty, benchmark_difficulty, fa_username
      FROM board_climb_stats
      WHERE board_type = 'moonboard' AND climb_uuid = ${firstRepair.climbUuid} AND angle = 25
    `;
    assert.deepEqual(newStats[0], {
      ascensionist_count: 3 + firstClimbCount,
      upstream_ascensionist_count: 3,
      boardsesh_ascensionist_count: firstClimbCount,
      quality_average: (3 * 3 + 5 * firstClimbCount) / (3 + firstClimbCount),
      display_difficulty: 18,
      benchmark_difficulty: 19,
      fa_username: '25-degree Catalog FA',
    });
  });
});
