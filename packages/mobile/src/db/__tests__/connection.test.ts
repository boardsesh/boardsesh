// Exercises clearUserData against the REAL v1 DDL (via node:sqlite): every
// user-data table plus the mutation queue and sync checkpoints must be wiped on
// sign-out, while the expensive board reference cache is left untouched.
//
// Also exercises the optional bundled-seed path in initializeDatabase: it must be
// a true no-op when no asset is bundled (the default), and copy board reference
// rows + stamp checkpoints when one is.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The seed module and expo-asset are mocked per-test so the default path resolves
// to "no asset" and the with-asset path points at a temp file we build below.
const resolveSeedAssetModuleId = vi.fn<() => number | null>(() => null);
vi.mock('../seed-asset', () => ({
  resolveSeedAssetModuleId: () => resolveSeedAssetModuleId(),
}));

const assetLocalUri = { current: null as string | null };
vi.mock('expo-asset', () => ({
  Asset: {
    fromModule: () => ({
      downloadAsync: async () => undefined,
      get localUri() {
        return assetLocalUri.current;
      },
    }),
  },
}));

import { clearUserData, initializeDatabase } from '../connection';
import { runMigrations } from '../migrations';
import { SCHEMA_STATEMENTS } from '../schema';
import { setCheckpoint, getCheckpoint, getCheckpointKey } from '../../sync/checkpoints';
import { enqueue, getPendingCount } from '../../mutation-queue/queue';
import { createTestDatabase, type TestSqliteDb } from './sqlite-test-db';

let db: TestSqliteDb;

async function countRows(table: string): Promise<number> {
  const row = await db.getFirstAsync<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`);
  return row?.count ?? 0;
}

beforeEach(async () => {
  db = createTestDatabase();
  await runMigrations(db);
  resolveSeedAssetModuleId.mockReturnValue(null);
  assetLocalUri.current = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('clearUserData', () => {
  it('clears every user-data table, the mutation queue, and sync checkpoints', async () => {
    const now = '2024-06-01T00:00:00Z';

    await db.runAsync(`INSERT INTO boardsesh_ticks (uuid, board_type, climb_uuid, angle) VALUES (?, ?, ?, ?)`, [
      'tick-1',
      'kilter',
      'climb-1',
      40,
    ]);
    await db.runAsync(`INSERT INTO playlists (uuid, name) VALUES (?, ?)`, ['pl-1', 'Projects']);
    await db.runAsync(`INSERT INTO playlist_climbs (playlist_uuid, climb_uuid) VALUES (?, ?)`, ['pl-1', 'climb-1']);
    await db.runAsync(`INSERT INTO user_favorites (board_name, climb_uuid, angle) VALUES (?, ?, ?)`, [
      'kilter',
      'climb-1',
      40,
    ]);
    await db.runAsync(`INSERT INTO user_follows (following_id) VALUES (?)`, ['user-2']);
    await db.runAsync(`INSERT INTO setter_follows (setter_username) VALUES (?)`, ['setter-x']);
    await db.runAsync(`INSERT INTO playlist_follows (playlist_uuid) VALUES (?)`, ['pl-9']);
    await enqueue(db, 'boardsesh_ticks', 'create', { climbUuid: 'climb-1' }, 'tick-1');
    await setCheckpoint(db, getCheckpointKey('boardsesh_ticks'), { updatedAt: now, syncSeq: '5' });

    // Board reference data that must survive the wipe.
    await db.runAsync(`INSERT INTO board_climbs (uuid, board_type) VALUES (?, ?)`, ['climb-1', 'kilter']);
    await db.runAsync(
      `INSERT INTO board_climb_stats (board_type, climb_uuid, angle, ascensionist_count) VALUES (?, ?, ?, ?)`,
      ['kilter', 'climb-1', 40, 12],
    );

    await clearUserData(db);

    expect(await countRows('boardsesh_ticks')).toBe(0);
    expect(await countRows('playlists')).toBe(0);
    expect(await countRows('playlist_climbs')).toBe(0);
    expect(await countRows('user_favorites')).toBe(0);
    expect(await countRows('user_follows')).toBe(0);
    expect(await countRows('setter_follows')).toBe(0);
    expect(await countRows('playlist_follows')).toBe(0);
    expect(await getPendingCount(db)).toBe(0);
    expect(await getCheckpoint(db, getCheckpointKey('boardsesh_ticks'))).toBeNull();

    // The expensive shared cache is deliberately retained.
    expect(await countRows('board_climbs')).toBe(1);
    expect(await countRows('board_climb_stats')).toBe(1);
  });

  it('is a no-op on an already-empty database', async () => {
    await clearUserData(db);

    expect(await countRows('boardsesh_ticks')).toBe(0);
    expect(await getPendingCount(db)).toBe(0);
  });
});

describe('initializeDatabase optional seed', () => {
  let seedDir: string;

  beforeEach(() => {
    seedDir = mkdtempSync(join(tmpdir(), 'bs-seed-'));
  });

  afterEach(() => {
    rmSync(seedDir, { recursive: true, force: true });
  });

  // Builds a real on-disk seed DB carrying the v1 schema, a couple of board
  // reference rows, and (optionally) the seed_checkpoints cursor table.
  function buildSeedFile(withCheckpoints: boolean): string {
    const seedPath = join(seedDir, 'seed.db');
    const seed = new DatabaseSync(seedPath);
    for (const statement of SCHEMA_STATEMENTS) seed.exec(statement);
    seed.prepare(`INSERT INTO board_climbs (uuid, board_type) VALUES (?, ?)`).run('seed-climb-1', 'kilter');
    seed.prepare(`INSERT INTO board_climbs (uuid, board_type) VALUES (?, ?)`).run('seed-climb-2', 'tension');
    seed
      .prepare(`INSERT INTO board_climb_stats (board_type, climb_uuid, angle, ascensionist_count) VALUES (?, ?, ?, ?)`)
      .run('kilter', 'seed-climb-1', 40, 99);
    if (withCheckpoints) {
      seed.exec(`CREATE TABLE seed_checkpoints (board_type TEXT, table_name TEXT, updated_at TEXT, sync_seq TEXT)`);
      seed
        .prepare(`INSERT INTO seed_checkpoints (board_type, table_name, updated_at, sync_seq) VALUES (?, ?, ?, ?)`)
        .run('kilter', 'board_climbs', '2024-01-01T00:00:00Z', '42');
    }
    seed.close();
    return seedPath;
  }

  it('leaves board tables empty when no asset is bundled (default build)', async () => {
    resolveSeedAssetModuleId.mockReturnValue(null);

    await initializeDatabase(db);

    expect(await countRows('board_climbs')).toBe(0);
    expect(await countRows('board_climb_stats')).toBe(0);
  });

  it('copies board reference rows and stamps checkpoints from a bundled seed', async () => {
    resolveSeedAssetModuleId.mockReturnValue(1);
    assetLocalUri.current = buildSeedFile(true);

    await initializeDatabase(db);

    expect(await countRows('board_climbs')).toBe(2);
    expect(await countRows('board_climb_stats')).toBe(1);
    expect(await getCheckpoint(db, getCheckpointKey('board_climbs', 'kilter'))).toEqual({
      updatedAt: '2024-01-01T00:00:00Z',
      syncSeq: '42',
    });
  });

  it('imports without a checkpoint table (cursor stamping is optional)', async () => {
    resolveSeedAssetModuleId.mockReturnValue(1);
    assetLocalUri.current = buildSeedFile(false);

    await initializeDatabase(db);

    expect(await countRows('board_climbs')).toBe(2);
    expect(await getCheckpoint(db, getCheckpointKey('board_climbs', 'kilter'))).toBeNull();
  });

  it('does not overwrite board rows that a prior sync already populated', async () => {
    await db.runAsync(`INSERT INTO board_climbs (uuid, board_type) VALUES (?, ?)`, ['existing', 'kilter']);
    resolveSeedAssetModuleId.mockReturnValue(1);
    assetLocalUri.current = buildSeedFile(true);

    await initializeDatabase(db);

    // The non-empty board_climbs table is left untouched (the per-table guard
    // only fills empty tables); the pre-existing row survives.
    expect(await countRows('board_climbs')).toBe(1);
    const remaining = await db.getFirstAsync<{ uuid: string }>(`SELECT uuid FROM board_climbs`);
    expect(remaining?.uuid).toBe('existing');
  });
});
