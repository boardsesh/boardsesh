import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { createScriptDb } from './db-connection.js';
import {
  applyForwardMoveBatches,
  applyRevertMoveBatches,
  loadSharedFeedTicks,
} from './backfill-shared-feed-tick-boards.js';
import { planSharedFeedTickMoves } from './backfill-shared-feed-tick-boards-helpers.js';

// Local runs opt in; CI runs these in test-backend against its disposable service.
// Temporary tables shadow existing names on this one connection and disappear
// when it closes, so no existing rows are touched.
const databaseUrl = process.env.SHARED_FEED_TICK_TEST_DB_URL;
if (process.env.CI) {
  assert.ok(databaseUrl, 'CI requires SHARED_FEED_TICK_TEST_DB_URL; integration coverage must not be skipped.');
}
const sharedFeedOwnerId = '00000000-0000-0000-0000-000000000000';

async function withFixture(
  run: (db: Pick<ReturnType<typeof createScriptDb>['db'], 'transaction' | 'execute' | 'select'>) => Promise<void>,
) {
  assert.ok(databaseUrl);
  assert.ok(
    ['localhost', '127.0.0.1', '[::1]'].includes(new URL(databaseUrl).hostname),
    'integration URL must be local',
  );
  const { db, close } = createScriptDb(databaseUrl);
  try {
    await db.execute(sql`
        CREATE TEMP TABLE boardsesh_ticks (
          uuid text PRIMARY KEY,
          user_id text NOT NULL,
          board_id bigint NOT NULL CHECK (board_id <> 999),
          session_id text,
          updated_at timestamptz NOT NULL DEFAULT '2020-01-01'
        ) ON COMMIT PRESERVE ROWS
      `);
    await db.execute(
      sql`CREATE TEMP TABLE update_batches (id integer GENERATED ALWAYS AS IDENTITY, touched integer) ON COMMIT PRESERVE ROWS`,
    );
    await db.execute(sql`CREATE TEMP TABLE user_boards (
      id bigint PRIMARY KEY, owner_id text NOT NULL, board_type text NOT NULL,
      layout_id integer NOT NULL, size_id integer NOT NULL, set_ids text NOT NULL,
      slug text NOT NULL DEFAULT '', deleted_at timestamptz
    ) ON COMMIT PRESERVE ROWS`);
    await db.execute(
      sql`CREATE TEMP TABLE board_sessions (id text PRIMARY KEY, board_id bigint, created_by_user_id text) ON COMMIT PRESERVE ROWS`,
    );
    await db.execute(sql`
          CREATE FUNCTION pg_temp.record_tick_batch() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            INSERT INTO update_batches (touched) SELECT count(*) FROM batch_ticks;
            RETURN NULL;
          END $$
        `);
    await db.execute(sql`
          CREATE TRIGGER record_tick_batch AFTER UPDATE ON boardsesh_ticks
          REFERENCING NEW TABLE AS batch_ticks FOR EACH STATEMENT EXECUTE FUNCTION pg_temp.record_tick_batch()
        `);
    await run(db);
  } finally {
    await close();
  }
}

type FixtureDb = Pick<ReturnType<typeof createScriptDb>['db'], 'transaction' | 'execute' | 'select'>;
const matchingConfig = { boardType: 'moonboard', layoutId: 6, sizeId: 1, setIds: '24,25' };

function forwardPlan(entries: { uuid: string; oldBoardId: number; newBoardId: number }[]) {
  return { feeds: [{ id: 10, ...matchingConfig }], entries };
}

function errorChainIncludes(error: unknown, message: string): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if (current.message.includes(message)) return true;
    current = current.cause;
  }
  return false;
}

async function createForwardPlan(db: FixtureDb, sessionId: string | null = null) {
  await db.execute(sql`INSERT INTO user_boards (id, owner_id, board_type, layout_id, size_id, set_ids, slug) VALUES
    (10, ${sharedFeedOwnerId}, 'moonboard', 6, 1, '24,25', 'presence-moonboard-6-1-24-25'),
    (20, 'climber', 'moonboard', 6, 1, '25,24', 'climber-wall'),
    (30, 'party-host', 'moonboard', 6, 1, '24,25', 'party-wall')`);
  if (sessionId) {
    await db.execute(
      sql`INSERT INTO board_sessions (id, board_id, created_by_user_id) VALUES (${sessionId}, 20, 'climber')`,
    );
  }
  await db.execute(
    sql`INSERT INTO boardsesh_ticks (uuid, user_id, board_id, session_id) VALUES ('planned-tick', 'climber', 10, ${sessionId})`,
  );
  const ticks = await loadSharedFeedTicks(db, [10]);
  const plan = planSharedFeedTickMoves({
    feeds: [{ id: 10, ...matchingConfig }],
    ticks,
    ownedBoards: [{ id: 20, ownerId: 'climber', ...matchingConfig }],
  });
  assert.deepEqual(plan.moves, [{ uuid: 'planned-tick', oldBoardId: 10, newBoardId: 20 }]);
  return { feeds: [{ id: 10, ...matchingConfig }], entries: plan.moves };
}

void test('forward apply revalidates the original destination before updating', { skip: !databaseUrl }, async () => {
  await withFixture(async (db) => {
    const forwardPlan = await createForwardPlan(db);
    assert.equal(await applyForwardMoveBatches(db, forwardPlan), 1);
    assert.deepEqual(Array.from(await db.execute(sql`SELECT board_id::integer FROM boardsesh_ticks`)), [
      { board_id: 20 },
    ]);
  });
});

void test(
  'forward apply skips a tick re-filed after planning without choosing another destination',
  { skip: !databaseUrl },
  async () => {
    await withFixture(async (db) => {
      const forwardPlan = await createForwardPlan(db);
      await db.execute(sql`UPDATE boardsesh_ticks SET board_id = 99 WHERE uuid = 'planned-tick'`);
      assert.equal(await applyForwardMoveBatches(db, forwardPlan), 0);
      assert.deepEqual(Array.from(await db.execute(sql`SELECT board_id::integer FROM boardsesh_ticks`)), [
        { board_id: 99 },
      ]);
    });
  },
);

for (const staleCase of [
  {
    name: 'source feed reconfiguration',
    change: (db: FixtureDb) => db.execute(sql`UPDATE user_boards SET size_id = 2 WHERE id = 10`),
  },
  {
    name: 'destination deletion',
    change: (db: FixtureDb) => db.execute(sql`UPDATE user_boards SET deleted_at = '2026-09-21' WHERE id = 20`),
  },
  {
    name: 'destination reconfiguration',
    change: (db: FixtureDb) => db.execute(sql`UPDATE user_boards SET size_id = 2 WHERE id = 20`),
  },
  {
    name: 'destination owner change',
    change: (db: FixtureDb) => db.execute(sql`UPDATE user_boards SET owner_id = 'other-climber' WHERE id = 20`),
  },
  {
    name: 'second matching owned board',
    change: (db: FixtureDb) =>
      db.execute(sql`INSERT INTO user_boards (id, owner_id, board_type, layout_id, size_id, set_ids, slug)
        VALUES (21, 'climber', 'moonboard', 6, 1, '24,25', 'another-climber-wall')`),
  },
  {
    name: 'session destination change',
    change: async (db: FixtureDb) => {
      await db.execute(sql`UPDATE board_sessions SET board_id = 30 WHERE id = 'active-session'`);
    },
    sessionId: 'active-session',
  },
]) {
  void test(`forward apply aborts all writes after ${staleCase.name}`, { skip: !databaseUrl }, async () => {
    await withFixture(async (db) => {
      const forwardPlan = await createForwardPlan(db, staleCase.sessionId);
      await db.execute(
        sql`INSERT INTO boardsesh_ticks (uuid, user_id, board_id) VALUES ('other-planned-tick', 'climber', 10)`,
      );
      forwardPlan.entries.push({ uuid: 'other-planned-tick', oldBoardId: 10, newBoardId: 20 });
      await staleCase.change(db);
      await assert.rejects(applyForwardMoveBatches(db, forwardPlan), /Forward plan is stale/);
      assert.deepEqual(Array.from(await db.execute(sql`SELECT board_id::integer FROM boardsesh_ticks ORDER BY uuid`)), [
        { board_id: 10 },
        { board_id: 10 },
      ]);
    });
  });
}

void test(
  'batched apply/revert retain current-board guards and only change matching tick timestamps',
  { skip: !databaseUrl },
  async () => {
    await withFixture(async (db) => {
      await db.execute(sql`INSERT INTO user_boards (id, owner_id, board_type, layout_id, size_id, set_ids, slug) VALUES
        (10, ${sharedFeedOwnerId}, 'moonboard', 6, 1, '24,25', 'presence-moonboard-6-1-24-25'),
        (20, 'owner', 'moonboard', 6, 1, '24,25', 'owner-wall')`);
      await db.execute(sql`
      INSERT INTO boardsesh_ticks (uuid, user_id, board_id)
      SELECT 'tick-' || sequence, 'owner', 10 FROM generate_series(0, 1000) sequence
    `);
      const moves = Array.from({ length: 1001 }, (_, index) => ({
        uuid: `tick-${index}`,
        oldBoardId: 10,
        newBoardId: 20,
      }));
      // A concurrent re-file after planning must survive the forward update.
      await db.execute(sql`UPDATE boardsesh_ticks SET board_id = 30 WHERE uuid = 'tick-1000'`);
      await db.execute(sql`TRUNCATE update_batches`);
      assert.equal(await applyForwardMoveBatches(db, forwardPlan(moves)), 1000);
      const forwardBatches = await db.execute(sql`SELECT touched FROM update_batches ORDER BY id`);
      assert.deepEqual(Array.from(forwardBatches), [{ touched: 500 }, { touched: 500 }]);
      const state = await db.execute(sql`
      SELECT count(*) FILTER (WHERE board_id = 20)::int AS moved,
        count(*) FILTER (WHERE board_id = 20 AND updated_at > '2020-01-01')::int AS stamped,
        count(DISTINCT updated_at) FILTER (WHERE board_id = 20)::int AS timestamps,
        count(*) FILTER (WHERE uuid = 'tick-1000' AND board_id = 30 AND updated_at = '2020-01-01')::int AS untouched,
        count(*) FILTER (WHERE user_id <> 'owner')::int AS owner_changes
      FROM boardsesh_ticks
    `);
      assert.deepEqual(Array.from(state), [
        { moved: 1000, stamped: 1000, timestamps: 1, untouched: 1, owner_changes: 0 },
      ]);
      // A later edit must also survive reversal. Reverting twice is harmless.
      await db.execute(sql`UPDATE boardsesh_ticks SET board_id = 40 WHERE uuid = 'tick-0'`);
      await db.execute(sql`TRUNCATE update_batches`);
      assert.equal(await applyRevertMoveBatches(db, moves), 999);
      const reverseBatches = await db.execute(sql`SELECT touched FROM update_batches ORDER BY id`);
      assert.deepEqual(Array.from(reverseBatches), [{ touched: 499 }, { touched: 500 }, { touched: 0 }]);
      assert.equal(await applyRevertMoveBatches(db, moves), 0);
      const restored = await db.execute(sql`
      SELECT count(*) FILTER (WHERE board_id = 10)::int AS restored,
        count(DISTINCT updated_at) FILTER (WHERE board_id = 10)::int AS timestamps,
        count(*) FILTER (WHERE board_id IN (30, 40))::int AS preserved
      FROM boardsesh_ticks
    `);
      assert.deepEqual(Array.from(restored), [{ restored: 999, timestamps: 1, preserved: 2 }]);
    });
  },
);

void test(
  'guarded forward apply rolls back an earlier batch after a later batch fails',
  { skip: !databaseUrl },
  async () => {
    await withFixture(async (db) => {
      await db.execute(sql`INSERT INTO user_boards (id, owner_id, board_type, layout_id, size_id, set_ids, slug) VALUES
      (10, ${sharedFeedOwnerId}, 'moonboard', 6, 1, '24,25', 'presence-moonboard-6-1-24-25'),
      (20, 'owner', 'moonboard', 6, 1, '24,25', 'owner-wall')`);
      await db.execute(sql`
      INSERT INTO boardsesh_ticks (uuid, user_id, board_id)
      SELECT 'tick-' || sequence, 'owner', 10 FROM generate_series(0, 500) sequence
    `);
      const moves = Array.from({ length: 501 }, (_, index) => ({
        uuid: `tick-${index}`,
        oldBoardId: 10,
        newBoardId: 20,
      }));
      await db.execute(sql`
      CREATE FUNCTION pg_temp.fail_late_tick_batch() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM batch_ticks WHERE uuid = 'tick-500') THEN
          RAISE EXCEPTION 'late batch failure';
        END IF;
        RETURN NULL;
      END $$
    `);
      await db.execute(sql`
      CREATE TRIGGER fail_late_tick_batch AFTER UPDATE ON boardsesh_ticks
      REFERENCING NEW TABLE AS batch_ticks FOR EACH STATEMENT EXECUTE FUNCTION pg_temp.fail_late_tick_batch()
    `);
      await assert.rejects(applyForwardMoveBatches(db, forwardPlan(moves)), (error: unknown) =>
        errorChainIncludes(error, 'late batch failure'),
      );
      const unchanged = await db.execute(sql`
      SELECT count(*)::int AS unchanged FROM boardsesh_ticks WHERE board_id = 10 AND updated_at = '2020-01-01'
    `);
      assert.deepEqual(Array.from(unchanged), [{ unchanged: 501 }]);
    });
  },
);

void test(
  'actual session loader and repair preserve another climber session wall before owned-board fallback',
  { skip: !databaseUrl },
  async () => {
    await withFixture(async (db) => {
      await db.execute(sql`INSERT INTO user_boards (id, owner_id, board_type, layout_id, size_id, set_ids, slug, deleted_at) VALUES
      (10, ${sharedFeedOwnerId}, 'moonboard', 6, 1, '24,25', 'presence-moonboard-6-1-24-25', NULL),
      (20, 'climber', 'moonboard', 6, 1, '24,25', 'climber-wall', NULL),
      (30, 'party-host', 'moonboard', 6, 1, '25,24', 'party-wall', NULL),
      (31, 'party-host', 'moonboard', 6, 2, '24,25', 'wrong-config-wall', NULL),
      (32, 'party-host', 'moonboard', 6, 1, '24,25', 'deleted-wall', '2026-01-01')`);
      await db.execute(sql`INSERT INTO board_sessions VALUES
      ('party', 30, 'party-host'), ('wrong-config', 31, 'party-host'), ('deleted-wall', 32, 'party-host'),
      ('feed-session', 10, 'party-host'), ('no-wall', NULL, 'party-host')`);
      await db.execute(sql`INSERT INTO boardsesh_ticks (uuid, user_id, board_id, session_id) VALUES
      ('party-home', 'climber', 10, 'party'), ('party-no-home', 'visitor', 10, 'party'),
      ('party-ambiguous', 'two-walls', 10, 'party'), ('no-session', 'climber', 10, NULL),
      ('mismatch', 'climber', 10, 'wrong-config'), ('deleted', 'climber', 10, 'deleted-wall'),
      ('already-session-feed', 'climber', 10, 'feed-session'), ('missing-session', 'climber', 10, 'missing'),
      ('no-session-wall', 'climber', 10, 'no-wall'), ('not-on-feed', 'climber', 20, 'party')`);
      const ticks = await loadSharedFeedTicks(db, [10]);
      assert.equal(ticks.length, 9);
      assert.equal(ticks.find((tick) => tick.uuid === 'party-home')?.sessionBoard?.id, 30);
      assert.equal(ticks.find((tick) => tick.uuid === 'deleted')?.sessionBoard, null);
      assert.equal(ticks.find((tick) => tick.uuid === 'missing-session')?.sessionBoard, null);
      assert.equal(ticks.find((tick) => tick.uuid === 'no-session-wall')?.sessionBoard, null);
      const config = { boardType: 'moonboard', layoutId: 6, sizeId: 1, setIds: '24,25' };
      const plan = planSharedFeedTickMoves({
        feeds: [{ id: 10, ...config }],
        ticks,
        ownedBoards: [
          { id: 20, ownerId: 'climber', ...config },
          { id: 40, ownerId: 'two-walls', ...config },
          { id: 41, ownerId: 'two-walls', ...config },
        ],
      });
      assert.equal(plan.sessionMoves, 3);
      assert.equal(plan.sessionRetained, 1);
      assert.equal(await applyForwardMoveBatches(db, forwardPlan(plan.moves)), 8);
      const rows = Array.from(
        await db.execute(sql`SELECT uuid, user_id, board_id::integer, session_id FROM boardsesh_ticks ORDER BY uuid`),
      );
      assert.deepEqual(rows, [
        { uuid: 'already-session-feed', user_id: 'climber', board_id: 10, session_id: 'feed-session' },
        { uuid: 'deleted', user_id: 'climber', board_id: 20, session_id: 'deleted-wall' },
        { uuid: 'mismatch', user_id: 'climber', board_id: 20, session_id: 'wrong-config' },
        { uuid: 'missing-session', user_id: 'climber', board_id: 20, session_id: 'missing' },
        { uuid: 'no-session', user_id: 'climber', board_id: 20, session_id: null },
        { uuid: 'no-session-wall', user_id: 'climber', board_id: 20, session_id: 'no-wall' },
        { uuid: 'not-on-feed', user_id: 'climber', board_id: 20, session_id: 'party' },
        { uuid: 'party-ambiguous', user_id: 'two-walls', board_id: 30, session_id: 'party' },
        { uuid: 'party-home', user_id: 'climber', board_id: 30, session_id: 'party' },
        { uuid: 'party-no-home', user_id: 'visitor', board_id: 30, session_id: 'party' },
      ]);
      assert.equal(await applyRevertMoveBatches(db, plan.moves), 8);
      const restored = Array.from(
        await db.execute(sql`SELECT count(*)::integer AS restored FROM boardsesh_ticks WHERE board_id = 10`),
      );
      assert.deepEqual(restored, [{ restored: 9 }]);
    });
  },
);
