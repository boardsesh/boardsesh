/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { readPrivacyReconcileCounts, readPrivacyReconcilePreflight } from './privacy-reconcile-cutover.js';
import { readExpectedMigrations } from './migration-journal.js';

const testDatabaseUrl = process.env.PRIVACY_RECONCILE_TEST_DATABASE_URL;

void test(
  'read-only preflight matches both unchanged migration blocks and recognizes the applied hash',
  {
    skip: !testDatabaseUrl,
  },
  async () => {
    const target = new URL(testDatabaseUrl!);
    assert.ok(['localhost', '127.0.0.1', 'postgres'].includes(target.hostname), 'requires disposable local PostgreSQL');
    target.pathname = '/postgres';
    const admin = postgres(target.toString(), { max: 1, onnotice: () => {} });
    const databaseName = `privacy_reconcile_${process.pid}`;
    let client: ReturnType<typeof postgres> | undefined;
    try {
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
      target.pathname = `/${databaseName}`;
      client = postgres(target.toString(), { max: 1, onnotice: () => {} });
      const migration = readExpectedMigrations().find((entry) =>
        entry.tag.endsWith('_privacy_reconcile_tick_tombstones'),
      )!;
      assert.deepEqual(await readPrivacyReconcileCounts(client), { tickStamps: '0', legacySessions: '0' });
      await client.unsafe(`
      CREATE TABLE user_profiles (user_id text, privacy_revision int, default_session_audience text);
      CREATE TABLE board_sessions (id text, is_public boolean, origin text);
      CREATE TABLE boardsesh_ticks (uuid text, session_id text);
      CREATE TABLE content_privacy (entity_type text, entity_id text, audience text, updated_at timestamptz, owner_id text, public_consent_revision int);
      CREATE TABLE resource_privacy (kind text, resource_id text, audience text, updated_at timestamptz, owner_id text, revision int);
      INSERT INTO user_profiles VALUES ('edited', 1, NULL), ('session-default', 0, 'only_me');
      INSERT INTO board_sessions VALUES ('explicit', false, 'explicit'), ('edited', false, 'explicit'), ('inferred', false, 'inferred'), ('session-default', false, 'explicit');
      INSERT INTO boardsesh_ticks VALUES ('stamp', 'explicit'), ('choice', 'edited'), ('inferred-tick', 'inferred'), ('old-stamp', 'explicit'), ('consented-stamp', 'explicit');
      INSERT INTO content_privacy VALUES
        ('tick', 'stamp', 'only_me', '2026-10-10', 'owner', NULL),
        ('tick', 'choice', 'only_me', '2026-10-10', 'edited', NULL),
        ('tick', 'inferred-tick', 'only_me', '2026-10-10', 'owner', NULL),
        ('tick', 'old-stamp', 'only_me', '2026-10-08', 'owner', NULL),
        ('tick', 'consented-stamp', 'only_me', '2026-10-10', 'consented-owner', NULL),
        ('beta', 'public-choice', 'public', '2026-10-10', 'consented-owner', 0);
      INSERT INTO resource_privacy VALUES
        ('session', 'explicit', 'invite_only', '2026-10-10', 'owner', 0),
        ('session', 'edited', 'invite_only', '2026-10-10', 'edited', 0),
        ('session', 'session-default', 'invite_only', '2026-10-10', 'session-default', 0);
    `);
      const counts = await client.begin('read only', async (transaction) => readPrivacyReconcileCounts(transaction));
      assert.deepEqual(counts, { tickStamps: '1', legacySessions: '1' });
      assert.deepEqual(await readPrivacyReconcilePreflight(client, [migration]), {
        hash: migration.hash,
        tag: migration.tag,
        ...counts,
      });
      const migrationSql = readFileSync(
        new URL('../drizzle/0265_privacy_reconcile_tick_tombstones.sql', import.meta.url),
        'utf8',
      );
      for (const statement of migrationSql.split('--> statement-breakpoint')) await client.unsafe(statement);
      assert.deepEqual(await readPrivacyReconcileCounts(client), { tickStamps: '0', legacySessions: '0' });
      const retained = await client<{ entity_id: string }[]>`SELECT entity_id FROM content_privacy ORDER BY entity_id`;
      assert.deepEqual(
        retained.map((row) => row.entity_id),
        ['choice', 'consented-stamp', 'inferred-tick', 'old-stamp', 'public-choice'],
      );
      const remapped = await client<
        { resource_id: string; audience: string }[]
      >`SELECT resource_id, audience FROM resource_privacy ORDER BY resource_id`;
      assert.deepEqual(
        remapped.map((row) => [row.resource_id, row.audience]),
        [
          ['edited', 'invite_only'],
          ['explicit', 'unlisted'],
          ['session-default', 'invite_only'],
        ],
      );
      await client.unsafe('CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations (hash text)');
      await client`INSERT INTO drizzle.__drizzle_migrations VALUES (${migration.hash})`;
      assert.equal(await readPrivacyReconcilePreflight(client, [migration]), null);
      assert.equal(
        await readPrivacyReconcilePreflight(client, [{ ...migration, tag: `0999_privacy_reconcile_tick_tombstones` }]),
        null,
      );
    } finally {
      await client?.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await admin.end();
    }
  },
);
