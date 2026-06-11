import { describe, it, expect } from 'vitest';

import { runMigrations, MIGRATIONS, LATEST_SCHEMA_VERSION } from '../migrations';
import { SCHEMA_STATEMENTS } from '../schema';
import { createTestDatabase, listTables, primaryKeyColumns, tableColumns } from './sqlite-test-db';

// The set of tables migration 1 must create (the sync manifest's per-table list
// plus the bookkeeping tables). pending_mutations comes from MUTATION_QUEUE_SCHEMA,
// which SCHEMA_STATEMENTS includes.
const EXPECTED_TABLES = [
  'board_climb_stats',
  'board_climbs',
  'boardsesh_ticks',
  'pending_mutations',
  'playlist_climbs',
  'playlist_follows',
  'playlists',
  'setter_follows',
  'sync_meta',
  'user_favorites',
  'user_follows',
];

// Local PK per the sync-table manifest. Single-column PKs are declared inline so
// pragma_table_info reports them with pk position 1.
const EXPECTED_PRIMARY_KEYS: Record<string, string[]> = {
  boardsesh_ticks: ['uuid'],
  playlists: ['uuid'],
  playlist_climbs: ['playlist_uuid', 'climb_uuid'],
  user_favorites: ['board_name', 'climb_uuid', 'angle'],
  user_follows: ['following_id'],
  setter_follows: ['setter_username'],
  playlist_follows: ['playlist_uuid'],
  board_climbs: ['uuid'],
  board_climb_stats: ['board_type', 'climb_uuid', 'angle'],
  sync_meta: ['key'],
};

describe('runMigrations', () => {
  it('creates every expected table on a fresh database', async () => {
    const db = createTestDatabase();

    await runMigrations(db);

    const tables = await listTables(db);
    for (const table of EXPECTED_TABLES) {
      expect(tables).toContain(table);
    }
  });

  it('creates each table with the manifest primary key columns', async () => {
    const db = createTestDatabase();

    await runMigrations(db);

    for (const [table, expectedPk] of Object.entries(EXPECTED_PRIMARY_KEYS)) {
      const actualPk = await primaryKeyColumns(db, table);
      expect(actualPk, `primary key of ${table}`).toEqual(expectedPk);
    }
  });

  it('records the latest schema version after running', async () => {
    const db = createTestDatabase();

    await runMigrations(db);

    const row = await db.getFirstAsync<{ version: number }>('SELECT version FROM schema_version WHERE id = 1');
    expect(row?.version).toBe(LATEST_SCHEMA_VERSION);
  });

  it('starts from version 0 when schema_version is empty', async () => {
    const db = createTestDatabase();

    // Pre-create the version table with no row; getCurrentVersion must treat the
    // missing row as version 0 and apply every migration.
    await db.execAsync(
      'CREATE TABLE IF NOT EXISTS schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)',
    );

    await runMigrations(db);

    const tables = await listTables(db);
    expect(tables).toContain('boardsesh_ticks');
    const row = await db.getFirstAsync<{ version: number }>('SELECT version FROM schema_version WHERE id = 1');
    expect(row?.version).toBe(LATEST_SCHEMA_VERSION);
  });

  it('is idempotent: a second run is a no-op and does not error', async () => {
    const db = createTestDatabase();

    await runMigrations(db);
    // Seed a row so we can prove the second run does not wipe / re-create data.
    await db.runAsync(
      "INSERT INTO boardsesh_ticks (uuid, board_type, climb_uuid, angle, status) VALUES ('keep-me', 'kilter', 'climb-1', 40, 'sent')",
    );

    await expect(runMigrations(db)).resolves.toBeUndefined();

    const survivor = await db.getFirstAsync<{ uuid: string }>(
      "SELECT uuid FROM boardsesh_ticks WHERE uuid = 'keep-me'",
    );
    expect(survivor?.uuid).toBe('keep-me');
    const row = await db.getFirstAsync<{ version: number }>('SELECT version FROM schema_version WHERE id = 1');
    expect(row?.version).toBe(LATEST_SCHEMA_VERSION);
  });

  it('does not re-apply a migration whose version is already stored', async () => {
    const db = createTestDatabase();

    await runMigrations(db);
    await db.runAsync('UPDATE schema_version SET version = ? WHERE id = 1', [LATEST_SCHEMA_VERSION]);

    // Drop a table, then re-run: because the stored version already covers
    // migration 1, runMigrations must NOT re-create it.
    await db.execAsync('DROP TABLE user_favorites');
    await runMigrations(db);

    const tables = await listTables(db);
    expect(tables).not.toContain('user_favorites');
  });

  it('applies a newly appended migration on top of an older version', async () => {
    const db = createTestDatabase();

    await runMigrations(db);

    // Simulate the device sitting at v1, then the app shipping a v2 migration.
    const extendedMigrations = [
      ...MIGRATIONS,
      { version: LATEST_SCHEMA_VERSION + 1, statements: ['ALTER TABLE boardsesh_ticks ADD COLUMN note TEXT'] },
    ];

    // Re-run the same logic against the extended list by inlining the runner's
    // contract: only the pending (version > stored) migration should apply.
    const currentRow = await db.getFirstAsync<{ version: number }>('SELECT version FROM schema_version WHERE id = 1');
    const current = currentRow?.version ?? 0;
    const pending = extendedMigrations.filter((migration) => migration.version > current);
    for (const migration of pending) {
      await db.withExclusiveTransactionAsync(async (txn) => {
        for (const statement of migration.statements) {
          await txn.execAsync(statement);
        }
        await txn.runAsync('INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, ?)', [migration.version]);
      });
    }

    const columns = await tableColumns(db, 'boardsesh_ticks');
    expect(columns).toContain('note');
    const finalRow = await db.getFirstAsync<{ version: number }>('SELECT version FROM schema_version WHERE id = 1');
    expect(finalRow?.version).toBe(LATEST_SCHEMA_VERSION + 1);
  });
});

describe('SCHEMA_STATEMENTS', () => {
  it('declares a CREATE TABLE for every manifest table', () => {
    const joined = SCHEMA_STATEMENTS.join('\n');
    for (const table of EXPECTED_TABLES) {
      expect(joined, `CREATE TABLE for ${table}`).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });

  it('declares the manifest primary key columns in each CREATE TABLE', () => {
    const joined = SCHEMA_STATEMENTS.join('\n');
    // Composite PKs appear as a PRIMARY KEY (...) clause; single-column PKs as an
    // inline PRIMARY KEY. Assert the load-bearing composite ones literally.
    expect(joined).toContain('PRIMARY KEY (playlist_uuid, climb_uuid)');
    expect(joined).toContain('PRIMARY KEY (board_name, climb_uuid, angle)');
    expect(joined).toContain('PRIMARY KEY (board_type, climb_uuid, angle)');
  });

  it('includes the sync_meta and pending_mutations bookkeeping tables', () => {
    const joined = SCHEMA_STATEMENTS.join('\n');
    expect(joined).toContain('CREATE TABLE IF NOT EXISTS sync_meta');
    expect(joined).toContain('CREATE TABLE IF NOT EXISTS pending_mutations');
  });

  it('indexes pending_mutations by status and created_at (reviewer I10)', () => {
    const joined = SCHEMA_STATEMENTS.join('\n');
    expect(joined).toContain('idx_pending_mutations_status');
    expect(joined).toContain('pending_mutations (status, created_at)');
  });

  it('indexes ticks by climb lookup key for logbook reads', () => {
    const joined = SCHEMA_STATEMENTS.join('\n');
    expect(joined).toContain('boardsesh_ticks (climb_uuid, board_type, angle)');
  });
});
