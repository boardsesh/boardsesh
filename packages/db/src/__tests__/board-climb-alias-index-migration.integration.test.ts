/**
 * Exercises migration 0250 against isolated PostgreSQL sessions.
 *
 * Each fixture uses only a temporary table and index; closing the session
 * removes them. CI supplies a dedicated stock PostgreSQL service through
 * MIGRATION_INDEX_TEST_DB_URL. There is deliberately no DATABASE_URL fallback.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import postgres from 'postgres';

type PgSession = Awaited<ReturnType<ReturnType<typeof postgres>['reserve']>>;

type AliasIndexState = {
  indexName: string;
  tableName: string;
  method: string;
  definition: string;
  valid: boolean;
  ready: boolean;
  unique: boolean;
  primary: boolean;
  partial: boolean;
  expression: boolean;
  columns: string[];
};

const migrationDatabaseUrl = process.env.MIGRATION_INDEX_TEST_DB_URL;
const expectedDatabaseName = process.env.MIGRATION_INDEX_TEST_EXPECTED_DATABASE;
const migrationSqlPath = fileURLToPath(new URL('../../drizzle/0250_mushy_retro_girl.sql', import.meta.url));
const migrationSql = await readFile(migrationSqlPath, 'utf8');
const migrationStatement = migrationSql.match(/CREATE INDEX IF NOT EXISTS[\s\S]*?;/i)?.[0];

if (!migrationStatement) {
  throw new Error('migration 0250 must contain the executable IF NOT EXISTS index statement');
}
if (process.env.CI && (!migrationDatabaseUrl || !expectedDatabaseName)) {
  throw new Error('CI requires MIGRATION_INDEX_TEST_DB_URL and MIGRATION_INDEX_TEST_EXPECTED_DATABASE');
}
if (migrationDatabaseUrl && !expectedDatabaseName) {
  throw new Error('MIGRATION_INDEX_TEST_EXPECTED_DATABASE is required before connecting to the fixture');
}

function localTestDatabaseUrl(): string | null {
  if (!migrationDatabaseUrl) return null;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(migrationDatabaseUrl);
  } catch {
    throw new Error('MIGRATION_INDEX_TEST_DB_URL must be a valid PostgreSQL URL');
  }

  if (!['postgres:', 'postgresql:'].includes(parsedUrl.protocol)) {
    throw new Error('MIGRATION_INDEX_TEST_DB_URL must use PostgreSQL');
  }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(parsedUrl.hostname.toLowerCase())) {
    throw new Error('MIGRATION_INDEX_TEST_DB_URL must target loopback PostgreSQL');
  }
  if (decodeURIComponent(parsedUrl.pathname.slice(1)) !== expectedDatabaseName) {
    throw new Error('MIGRATION_INDEX_TEST_DB_URL database path must match MIGRATION_INDEX_TEST_EXPECTED_DATABASE');
  }
  if (parsedUrl.search || parsedUrl.hash) {
    throw new Error('MIGRATION_INDEX_TEST_DB_URL must not contain query options or a fragment');
  }
  return migrationDatabaseUrl;
}

const testDatabaseUrl = localTestDatabaseUrl();

async function withTemporaryAliasTable<T>(run: (session: PgSession) => Promise<T>): Promise<T> {
  assert.ok(testDatabaseUrl);
  const connectionPool = postgres(testDatabaseUrl, { max: 1 });
  const session = await connectionPool.reserve();
  try {
    const [{ databaseName }] = await session<{ databaseName: string }[]>`
      SELECT pg_catalog.current_database() AS "databaseName"
    `;
    assert.equal(databaseName, expectedDatabaseName, 'the fixture must use its explicitly expected database');
    await session.unsafe('CREATE TEMPORARY TABLE board_climb_aliases (alias_uuid text NOT NULL)');
    return await run(session);
  } finally {
    session.release();
    await connectionPool.end();
  }
}

async function readAliasIndexState(session: PgSession): Promise<AliasIndexState[]> {
  return session<AliasIndexState[]>`
    SELECT index_class.relname AS "indexName",
           table_class.relname AS "tableName",
           access_method.amname AS method,
           pg_catalog.pg_get_indexdef(indexes.indexrelid) AS definition,
           indexes.indisvalid AS valid,
           indexes.indisready AS ready,
           indexes.indisunique AS unique,
           indexes.indisprimary AS primary,
           indexes.indpred IS NOT NULL AS partial,
           indexes.indexprs IS NOT NULL AS expression,
           ARRAY(
             SELECT attribute.attname
             FROM unnest(indexes.indkey) WITH ORDINALITY AS key(attnum, ordinal)
             JOIN pg_catalog.pg_attribute AS attribute
               ON attribute.attrelid = indexes.indrelid
              AND attribute.attnum = key.attnum
             ORDER BY key.ordinal
           ) AS columns
    FROM pg_catalog.pg_index AS indexes
    JOIN pg_catalog.pg_class AS index_class ON index_class.oid = indexes.indexrelid
    JOIN pg_catalog.pg_class AS table_class ON table_class.oid = indexes.indrelid
    JOIN pg_catalog.pg_am AS access_method ON access_method.oid = index_class.relam
    WHERE indexes.indrelid = pg_catalog.to_regclass('pg_temp.board_climb_aliases')
      AND index_class.relname = 'board_climb_aliases_alias_uuid_idx'
  `;
}

function assertExpectedIndex(state: AliasIndexState[]): AliasIndexState {
  assert.equal(state.length, 1, 'migration must leave exactly one named alias UUID index');
  const indexState = state[0];
  assert.ok(indexState);
  assert.equal(indexState.tableName, 'board_climb_aliases');
  assert.equal(indexState.method, 'btree');
  assert.deepEqual(indexState.columns, ['alias_uuid']);
  assert.equal(indexState.valid, true);
  assert.equal(indexState.ready, true);
  assert.equal(indexState.unique, false);
  assert.equal(indexState.primary, false);
  assert.equal(indexState.partial, false);
  assert.equal(indexState.expression, false);
  return indexState;
}

void describe(
  'migration 0250 alias UUID index',
  { skip: testDatabaseUrl ? false : 'set MIGRATION_INDEX_TEST_DB_URL to an owned loopback PostgreSQL fixture' },
  () => {
    void it('creates the expected index when it is absent', async () => {
      await withTemporaryAliasTable(async (session) => {
        await session.unsafe(migrationStatement);

        const indexState = assertExpectedIndex(await readAliasIndexState(session));
        assert.match(indexState.definition, /USING btree \(alias_uuid\)/);
      });
    });

    void it('leaves an already matching index intact on replay', async () => {
      await withTemporaryAliasTable(async (session) => {
        await session.unsafe(`
          CREATE INDEX board_climb_aliases_alias_uuid_idx
            ON pg_temp.board_climb_aliases USING btree (alias_uuid)
        `);
        const [{ existingIndexOid }] = await session<{ existingIndexOid: string }[]>`
          SELECT index_class.oid::text AS "existingIndexOid"
          FROM pg_catalog.pg_class AS index_class
          WHERE index_class.relnamespace = pg_catalog.pg_my_temp_schema()
            AND index_class.relname = 'board_climb_aliases_alias_uuid_idx'
        `;
        assert.ok(existingIndexOid);

        await session.unsafe(migrationStatement);

        const indexState = assertExpectedIndex(await readAliasIndexState(session));
        assert.equal(indexState.indexName, 'board_climb_aliases_alias_uuid_idx');
        const [{ replayedIndexOid }] = await session<{ replayedIndexOid: string }[]>`
          SELECT index_class.oid::text AS "replayedIndexOid"
          FROM pg_catalog.pg_class AS index_class
          WHERE index_class.relnamespace = pg_catalog.pg_my_temp_schema()
            AND index_class.relname = 'board_climb_aliases_alias_uuid_idx'
        `;
        assert.equal(replayedIndexOid, existingIndexOid, 'replay must not replace a matching prebuilt index');
      });
    });
  },
);
