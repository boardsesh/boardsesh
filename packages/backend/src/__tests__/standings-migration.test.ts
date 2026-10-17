import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import { rowsFromResult } from '@boardsesh/db/client';
import { db } from '../db/client';

const describeWithDatabase = process.env.SKIP_TEST_INFRA === '1' ? describe.skip : describe;

describeWithDatabase('standings migration compatibility', () => {
  it('keeps legacy zero grades and real walls while enforcing new-write bounds', async () => {
    const journal = JSON.parse(
      readFileSync(new URL('../../../db/drizzle/meta/_journal.json', import.meta.url), 'utf8'),
    ) as { entries: { tag: string }[] };
    const entry = journal.entries.find((migration) => migration.tag.endsWith('_standings_visibility_and_tick_bounds'));
    expect(entry).toBeDefined();
    const migrationSql = readFileSync(new URL(`../../../db/drizzle/${entry!.tag}.sql`, import.meta.url), 'utf8');
    const schemaName = `standings_${randomUUID().replaceAll('-', '')}`;

    await db.transaction(async (transaction) => {
      await transaction.execute(sql.raw(`CREATE SCHEMA "${schemaName}"`));
      await transaction.execute(sql.raw(`SET LOCAL search_path TO "${schemaName}", public`));
      await transaction.execute(
        sql.raw(`
        CREATE TABLE users (id text PRIMARY KEY);
        CREATE TABLE user_profiles (user_id text PRIMARY KEY);
        CREATE TABLE user_boards (id integer PRIMARY KEY, owner_id text, name text, gym_id integer);
        CREATE TABLE boardsesh_ticks (id integer PRIMARY KEY, difficulty integer, climbed_at timestamp, status text);
        INSERT INTO users VALUES ('climber');
        INSERT INTO user_profiles VALUES ('climber');
        INSERT INTO boardsesh_ticks (id, difficulty) VALUES (1, 0), (2, NULL);
        INSERT INTO user_boards VALUES
          (1, '00000000-0000-0000-0000-000000000000', 'Kilter Board Shared Feed', NULL),
          (2, 'climber', 'My Shared Feed', NULL),
          (3, '00000000-0000-0000-0000-000000000000', 'Gym Shared Feed', 1);
      `),
      );
      for (const statement of migrationSql
        .replaceAll('"public".', `"${schemaName}".`)
        .split('--> statement-breakpoint')) {
        await transaction.execute(sql.raw(statement));
      }

      expect(
        rowsFromResult(await transaction.execute(sql`SELECT id FROM user_boards WHERE is_virtual = true`)),
      ).toEqual([{ id: 1 }]);
      expect(
        rowsFromResult(await transaction.execute(sql`SELECT difficulty FROM boardsesh_ticks WHERE id = 1`)),
      ).toEqual([{ difficulty: 0 }]);
      expect(
        rowsFromResult(
          await transaction.execute(sql`SELECT leaderboard_visibility, gym_screen_visibility FROM user_profiles`),
        ),
      ).toEqual([{ leaderboard_visibility: 'public', gym_screen_visibility: 'public' }]);
      const constraints = rowsFromResult(
        await transaction.execute(sql`
        SELECT convalidated FROM pg_constraint
        WHERE conname = 'boardsesh_ticks_difficulty_range' AND connamespace = ${schemaName}::regnamespace
      `),
      );
      expect(constraints).toEqual([{ convalidated: false }]);

      for (const difficulty of [0, 2147483647]) {
        await expect(
          transaction.transaction(async (savepoint) => {
            await savepoint.execute(sql`INSERT INTO boardsesh_ticks (id, difficulty) VALUES (3, ${difficulty})`);
          }),
        ).rejects.toThrow();
      }
      await transaction.execute(sql`INSERT INTO boardsesh_ticks (id, difficulty) VALUES (3, 1), (4, 39), (5, NULL)`);
      await transaction.execute(sql.raw(`DROP SCHEMA "${schemaName}" CASCADE`));
    });
  });
});
