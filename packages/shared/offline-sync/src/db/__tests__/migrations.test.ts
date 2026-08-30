import { describe, it, expect } from 'vitest';

import { runMigrations, MIGRATIONS, LATEST_SCHEMA_VERSION } from '../migrations';
import { SCHEMA_STATEMENTS } from '../schema';
import { createTestDatabase, listTables, primaryKeyColumns, tableColumns } from '../../testing/sqlite-test-db';

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

async function createDatabaseAtVersion(version: number): Promise<ReturnType<typeof createTestDatabase>> {
  const db = createTestDatabase();
  await db.execAsync(
    'CREATE TABLE IF NOT EXISTS schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)',
  );

  for (const migration of MIGRATIONS.filter((candidate) => candidate.version <= version)) {
    await db.withExclusiveTransactionAsync(async (transaction) => {
      for (const statement of migration.statements) {
        await transaction.execAsync(statement);
      }
      await transaction.runAsync('INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, ?)', [
        migration.version,
      ]);
    });
  }

  return db;
}

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

  it('v3 adds the per-board recency index on ticks, on fresh and on v2-stamped databases', async () => {
    const indexQuery = "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_ticks_board_climbed_at'";

    // Fresh install: the full migration chain lands the index.
    const freshDb = createTestDatabase();
    await runMigrations(freshDb);
    const freshIndex = await freshDb.getFirstAsync<{ name: string }>(indexQuery);
    expect(freshIndex?.name).toBe('idx_ticks_board_climbed_at');

    // Existing install stamped at v2 (index dropped to simulate the pre-v3
    // state): only the pending v3 migration applies and creates it.
    const upgradedDb = await createDatabaseAtVersion(2);
    await runMigrations(upgradedDb);
    const upgradedIndex = await upgradedDb.getFirstAsync<{ name: string }>(indexQuery);
    expect(upgradedIndex?.name).toBe('idx_ticks_board_climbed_at');
  });

  it('v4 creates board_climb_grades with its manifest PK + columns, on fresh and on v3-stamped databases', async () => {
    const pkQuery = async (database: ReturnType<typeof createTestDatabase>) =>
      primaryKeyColumns(database, 'board_climb_grades');

    // Fresh install: the full migration chain lands the grade table.
    const freshDb = createTestDatabase();
    await runMigrations(freshDb);
    expect(await listTables(freshDb)).toContain('board_climb_grades');
    expect(await pkQuery(freshDb)).toEqual(['board_type', 'climb_uuid', 'angle']);
    const columns = await tableColumns(freshDb, 'board_climb_grades');
    for (const column of [
      'board_type',
      'climb_uuid',
      'angle',
      'local_grade',
      'universal_grade',
      'grade_low',
      'grade_high',
      'confidence',
      'ascensionist_count',
      'computed_at',
      'sync_seq',
    ]) {
      expect(columns, `board_climb_grades.${column}`).toContain(column);
    }

    // Existing install stamped at v3 (grade table dropped to simulate the pre-v4
    // state): only the pending v4 migration applies and re-creates it.
    const upgradedDb = await createDatabaseAtVersion(3);
    await runMigrations(upgradedDb);
    expect(await listTables(upgradedDb)).toContain('board_climb_grades');
    expect(await pkQuery(upgradedDb)).toEqual(['board_type', 'climb_uuid', 'angle']);
  });

  it('v5 adds controller route identity on fresh and v4-stamped databases', async () => {
    const freshDb = createTestDatabase();
    await runMigrations(freshDb);
    expect(await tableColumns(freshDb, 'board_climbs')).toContain('controller_route_uuid');

    const upgradedDb = await createDatabaseAtVersion(4);
    expect(await tableColumns(upgradedDb, 'board_climbs')).not.toContain('controller_route_uuid');
    await runMigrations(upgradedDb);
    expect(await tableColumns(upgradedDb, 'board_climbs')).toContain('controller_route_uuid');
  });

  it('v6 creates exact Quantum geometry on fresh and v5-stamped databases', async () => {
    const assertQuantumGeometry = async (database: ReturnType<typeof createTestDatabase>) => {
      expect(await listTables(database)).toContain('quantum_geometry');
      expect(await primaryKeyColumns(database, 'quantum_geometry')).toEqual(['layout_id', 'size_id']);
      expect(await tableColumns(database, 'quantum_geometry')).toEqual(
        expect.arrayContaining([
          'layout_id',
          'size_id',
          'revision',
          'edge_left',
          'edge_right',
          'edge_bottom',
          'edge_top',
          'placements_json',
          'updated_at',
        ]),
      );
    };

    const freshDb = createTestDatabase();
    await runMigrations(freshDb);
    await assertQuantumGeometry(freshDb);

    const upgradedDb = await createDatabaseAtVersion(5);
    expect(await listTables(upgradedDb)).not.toContain('quantum_geometry');
    await runMigrations(upgradedDb);
    await assertQuantumGeometry(upgradedDb);
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
