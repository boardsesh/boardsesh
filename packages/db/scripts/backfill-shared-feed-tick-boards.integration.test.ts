import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { createScriptDb } from './db-connection.js';
import { applyMoveBatches } from './backfill-shared-feed-tick-boards.js';

// Explicit opt-in only. Temporary tables shadow production names on this one
// connection; all fixture writes roll back and no existing rows are touched.
const databaseUrl = process.env.SHARED_FEED_TICK_TEST_DB_URL;
const rollbackMarker = new Error('rollback temporary shared-feed fixture');

async function withFixture(
  run: (db: Pick<ReturnType<typeof createScriptDb>['db'], 'transaction' | 'execute'>) => Promise<void>,
) {
  assert.ok(databaseUrl);
  assert.ok(
    ['localhost', '127.0.0.1', '[::1]'].includes(new URL(databaseUrl).hostname),
    'integration URL must be local',
  );
  const { db, close } = createScriptDb(databaseUrl);
  try {
    await assert.rejects(
      db.transaction(async (transaction) => {
        await transaction.execute(sql`
        CREATE TEMP TABLE boardsesh_ticks (
          uuid text PRIMARY KEY,
          user_id text NOT NULL,
          board_id bigint NOT NULL CHECK (board_id <> 999),
          updated_at timestamptz NOT NULL DEFAULT '2020-01-01'
        ) ON COMMIT DROP
      `);
        await transaction.execute(
          sql`CREATE TEMP TABLE update_batches (id integer GENERATED ALWAYS AS IDENTITY, touched integer) ON COMMIT DROP`,
        );
        await transaction.execute(sql`
          CREATE FUNCTION pg_temp.record_tick_batch() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            INSERT INTO update_batches (touched) SELECT count(*) FROM batch_ticks;
            RETURN NULL;
          END $$
        `);
        await transaction.execute(sql`
          CREATE TRIGGER record_tick_batch AFTER UPDATE ON boardsesh_ticks
          REFERENCING NEW TABLE AS batch_ticks FOR EACH STATEMENT EXECUTE FUNCTION pg_temp.record_tick_batch()
        `);
        await run(transaction);
        throw rollbackMarker;
      }),
      (error: unknown) => error === rollbackMarker,
    );
  } finally {
    await close();
  }
}

void test(
  'batched apply/revert retain current-board guards and only change matching tick timestamps',
  { skip: !databaseUrl },
  async () => {
    await withFixture(async (db) => {
      await db.execute(sql`
      INSERT INTO boardsesh_ticks (uuid, user_id, board_id)
      SELECT 'tick-' || sequence, 'owner-' || (sequence % 2), 10 FROM generate_series(0, 1000) sequence
    `);
      const moves = Array.from({ length: 1001 }, (_, index) => ({
        uuid: `tick-${index}`,
        oldBoardId: 10,
        newBoardId: 20,
      }));
      // A concurrent re-file after planning must survive the forward update.
      await db.execute(sql`UPDATE boardsesh_ticks SET board_id = 30 WHERE uuid = 'tick-1000'`);
      await db.execute(sql`TRUNCATE update_batches`);
      assert.equal(await applyMoveBatches(db, moves, 'forward'), 1000);
      const forwardBatches = await db.execute(sql`SELECT touched FROM update_batches ORDER BY id`);
      assert.deepEqual(Array.from(forwardBatches), [{ touched: 500 }, { touched: 500 }, { touched: 0 }]);
      const state = await db.execute(sql`
      SELECT count(*) FILTER (WHERE board_id = 20)::int AS moved,
        count(*) FILTER (WHERE board_id = 20 AND updated_at > '2020-01-01')::int AS stamped,
        count(*) FILTER (WHERE uuid = 'tick-1000' AND board_id = 30 AND updated_at = '2020-01-01')::int AS untouched,
        count(*) FILTER (WHERE user_id <> 'owner-' || (replace(uuid, 'tick-', '')::int % 2))::int AS owner_changes
      FROM boardsesh_ticks
    `);
      assert.deepEqual(Array.from(state), [{ moved: 1000, stamped: 1000, untouched: 1, owner_changes: 0 }]);
      // A later edit must also survive reversal. Reverting twice is harmless.
      await db.execute(sql`UPDATE boardsesh_ticks SET board_id = 40 WHERE uuid = 'tick-0'`);
      await db.execute(sql`TRUNCATE update_batches`);
      assert.equal(await applyMoveBatches(db, moves, 'revert'), 999);
      const reverseBatches = await db.execute(sql`SELECT touched FROM update_batches ORDER BY id`);
      assert.deepEqual(Array.from(reverseBatches), [{ touched: 499 }, { touched: 500 }, { touched: 0 }]);
      assert.equal(await applyMoveBatches(db, moves, 'revert'), 0);
      const restored = await db.execute(sql`
      SELECT count(*) FILTER (WHERE board_id = 10)::int AS restored,
        count(*) FILTER (WHERE board_id IN (30, 40))::int AS preserved
      FROM boardsesh_ticks
    `);
      assert.deepEqual(Array.from(restored), [{ restored: 999, preserved: 2 }]);
    });
  },
);

void test('a later batch failure rolls back all earlier batches', { skip: !databaseUrl }, async () => {
  await withFixture(async (db) => {
    await db.execute(sql`
      INSERT INTO boardsesh_ticks (uuid, user_id, board_id)
      SELECT 'tick-' || sequence, 'owner', 10 FROM generate_series(0, 500) sequence
    `);
    const moves = Array.from({ length: 501 }, (_, index) => ({
      uuid: `tick-${index}`,
      oldBoardId: 10,
      newBoardId: index === 500 ? 999 : 20,
    }));
    await assert.rejects(applyMoveBatches(db, moves, 'forward'));
    const unchanged = await db.execute(sql`
      SELECT count(*)::int AS unchanged FROM boardsesh_ticks WHERE board_id = 10 AND updated_at = '2020-01-01'
    `);
    assert.deepEqual(Array.from(unchanged), [{ unchanged: 501 }]);
  });
});
