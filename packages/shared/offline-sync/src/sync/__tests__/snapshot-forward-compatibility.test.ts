import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Reproduce the shipped v4 client contract against a v5 producer, without adding
// a production option that could bypass schema verification.
vi.mock('../../db/migrations', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../db/migrations')>();
  return { ...original, LATEST_SCHEMA_VERSION: 4 };
});
vi.mock('../table-config', async (importOriginal) => {
  const original = await importOriginal<typeof import('../table-config')>();
  return {
    ...original,
    TABLE_CONFIGS: {
      ...original.TABLE_CONFIGS,
      board_climbs: {
        ...original.TABLE_CONFIGS.board_climbs,
        refreshRevision: undefined,
        localColumns: original.TABLE_CONFIGS.board_climbs.localColumns.filter((column) => column !== 'is_hidden'),
      },
    },
  };
});

import { MIGRATIONS, runMigrations } from '../../db/migrations';
import { createTestDatabase, type TestSqliteDb } from '../../testing/sqlite-test-db';
import { bootstrapScopeFromSnapshot } from '../snapshot-bootstrap';
import { getCheckpoint } from '../checkpoints';
import { __resetDrainerStateForTests } from '../../mutation-queue/drainer';

let directory: string;
let db: TestSqliteDb;
let filePath: string;
beforeEach(async () => {
  __resetDrainerStateForTests();
  directory = mkdtempSync(join(tmpdir(), 'snapshot-forward-compat-'));
  db = createTestDatabase(join(directory, 'main.db'));
  await runMigrations(db);
  await db.execAsync('ALTER TABLE board_climbs DROP COLUMN is_hidden; UPDATE schema_version SET version = 4');
  filePath = join(directory, 'artifact.db');
  const artifact = new DatabaseSync(filePath);
  try {
    for (const migration of MIGRATIONS) for (const statement of migration.statements) artifact.exec(statement);
    artifact.exec(`
      ALTER TABLE board_climbs ADD COLUMN future_column TEXT;
      INSERT INTO board_climbs (uuid, board_type, layout_id, compatible_size_ids, is_hidden, updated_at, sync_seq)
        VALUES ('hidden', 'tension', 10, '[8]', 1, '2026-09-07T22:00:00.000Z', 10);
      CREATE TABLE snapshot_meta (table_name TEXT PRIMARY KEY, watermark_updated_at TEXT,
        watermark_sync_seq TEXT, row_count INTEGER, built_at TEXT, schema_version INTEGER, format_version INTEGER);
      INSERT INTO snapshot_meta VALUES
        ('board_climbs', '2026-09-07T22:00:00.000Z', '10', 1, '2026-09-07T22:30:00.000Z', 5, 1),
        ('board_climb_stats', '1970-01-01T00:00:00.000Z', '0', 0, '2026-09-07T22:30:00.000Z', 5, 1);
    `);
  } finally {
    artifact.close();
  }
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

it('imports a newer Tension artifact, reports additions once, and survives a throwing reporter', async () => {
  const reporter = vi.fn(() => {
    throw new Error('telemetry unavailable');
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await bootstrapScopeFromSnapshot({
      db,
      filePath,
      scope: { boardType: 'tension', layoutId: 10, sizeId: 8 },
      scopeKey: 'tension:10:8',
      onSchemaDrift: reporter,
    });
  }
  expect(await db.getFirstAsync("SELECT uuid FROM board_climbs WHERE uuid = 'hidden'")).toMatchObject({
    uuid: 'hidden',
  });
  expect(await getCheckpoint(db, 'checkpoint:board_climbs:tension:10:8')).toMatchObject({ syncSeq: '10' });
  expect(reporter).toHaveBeenCalledTimes(2);
  expect(reporter).toHaveBeenCalledWith({
    tableName: 'board_climbs',
    column: 'is_hidden',
    origin: 'snapshot',
    direction: 'extra-source-column',
    clientSchemaVersion: 4,
    artifactSchemaVersion: 5,
  });
});
