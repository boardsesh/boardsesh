import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import postgres from 'postgres';

type Snapshot = Parameters<typeof generateMigration>[0];
type Journal = { entries: { tag: string }[] };
const migrationDirectory = new URL('../../drizzle/', import.meta.url);
const journal = JSON.parse(readFileSync(new URL('meta/_journal.json', migrationDirectory), 'utf8')) as Journal;
const migrationIndex = journal.entries.findIndex(({ tag }) => tag.endsWith('_board_has_leds'));
assert.ok(migrationIndex > 0, 'the LED capability migration must follow an existing snapshot');
const migrationTag = journal.entries[migrationIndex].tag;
const previousTag = journal.entries[migrationIndex - 1].tag;
const readSnapshot = (tag: string): Snapshot =>
  JSON.parse(readFileSync(new URL(`meta/${tag.split('_')[0]}_snapshot.json`, migrationDirectory), 'utf8')) as Snapshot;
const previousSnapshot = readSnapshot(previousTag);
const nextSnapshot = readSnapshot(migrationTag);
const migrationSql = readFileSync(new URL(`${migrationTag}.sql`, migrationDirectory), 'utf8');

void test('LED capability migration preserves every existing schema object', async () => {
  const normalizedNext = structuredClone(nextSnapshot);
  const column = normalizedNext.tables['public.user_boards'].columns.has_leds;
  assert.equal(column.type, 'boolean');
  assert.equal(column.notNull, true);
  assert.equal(column.default, true);
  delete normalizedNext.tables['public.user_boards'].columns.has_leds;
  normalizedNext.id = previousSnapshot.id;
  normalizedNext.prevId = previousSnapshot.prevId;
  assert.deepEqual(normalizedNext, previousSnapshot);
  assert.equal(nextSnapshot.prevId, previousSnapshot.id);

  const generatedStatements = await generateMigration(previousSnapshot, nextSnapshot);
  assert.deepEqual(
    migrationSql
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter(Boolean),
    generatedStatements.map((statement) => statement.trim()),
  );
});

void test('LED capability migration preserves existing rows on PostgreSQL', async (context) => {
  const adminUrl = process.env.BOARD_HAS_LEDS_TEST_DATABASE_URL;
  if (!adminUrl) {
    context.skip('set BOARD_HAS_LEDS_TEST_DATABASE_URL to local PostgreSQL for replay');
    return;
  }
  assert.ok(['localhost', '127.0.0.1'].includes(new URL(adminUrl).hostname), 'replay is local-only');
  const databaseName = `bs_leds_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  let scratch: ReturnType<typeof postgres> | undefined;
  let created = false;
  try {
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    created = true;
    const scratchUrl = new URL(adminUrl);
    scratchUrl.pathname = `/${databaseName}`;
    scratch = postgres(scratchUrl.toString(), { max: 1, onnotice: () => {} });
    const baselineStatements = await generateMigration(generateDrizzleJson({}), previousSnapshot);
    for (const statement of baselineStatements) await scratch.unsafe(statement);

    // Replay uses the historical schema, which cannot be represented by the
    // current ORM tables (user_boards does not yet have has_leds).
    await scratch.unsafe(`
      INSERT INTO users (id, email) VALUES ('leds-owner', 'leds-owner@example.test');
      INSERT INTO gyms (id, uuid, name, owner_id) VALUES (1, 'leds-gym', 'Gym', 'leds-owner');
      INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name)
        VALUES ('leds-board', 'leds-board', 'leds-owner', 'kilter', 1, 10, '1,20', 'Wall');
      INSERT INTO gym_activity_stats (gym_id, pushes_all_time) VALUES (1, 17);
      INSERT INTO user_board_activity (user_id, board_uuid) VALUES ('leds-owner', 'leds-board');
      INSERT INTO qa_verdicts (pr_number, branch, verdict, platform)
        VALUES (4762, 'pr-4762', 'approved', 'ios');
      INSERT INTO hold_outline_overrides (board_name, layout_id, size_id, placement_id, outline)
        VALUES ('kilter', 1, 10, 1, '[0,0,1,0,0,1]');
      INSERT INTO board_sessions (id, board_path, origin) VALUES ('inferred', NULL, 'inferred');
      INSERT INTO notifications (uuid, recipient_id, type)
        VALUES ('proposal-note', 'leds-owner', 'proposal_on_your_climb');
      INSERT INTO climb_proposals (uuid, climb_uuid, board_type, proposer_id, type, proposed_value, current_value)
        VALUES ('hidden-climb', 'climb', 'kilter', 'leds-owner', 'hide', 'true', 'false');
    `);
    const preservedTables = [
      'gym_activity_stats',
      'user_board_activity',
      'qa_verdicts',
      'hold_outline_overrides',
      'board_sessions',
      'notifications',
      'climb_proposals',
    ];
    const before = new Map<string, unknown>();
    for (const tableName of preservedTables) {
      before.set(tableName, Array.from(await scratch.unsafe(`SELECT * FROM "${tableName}"`)));
    }
    await scratch.unsafe(migrationSql);
    for (const tableName of preservedTables) {
      assert.deepEqual(Array.from(await scratch.unsafe(`SELECT * FROM "${tableName}"`)), before.get(tableName));
    }
    const [existingBoard] = await scratch`SELECT has_leds FROM user_boards WHERE uuid = 'leds-board'`;
    assert.equal(existingBoard.has_leds, true);
    await scratch`UPDATE user_boards SET has_leds = false WHERE uuid = 'leds-board'`;
    const [updatedBoard] = await scratch`SELECT has_leds FROM user_boards WHERE uuid = 'leds-board'`;
    assert.equal(updatedBoard.has_leds, false);
    await assert.rejects(scratch`UPDATE user_boards SET has_leds = NULL WHERE uuid = 'leds-board'`, /not-null/);
  } finally {
    await scratch?.end();
    if (created) await admin.unsafe(`DROP DATABASE "${databaseName}"`);
    await admin.end();
  }
});
