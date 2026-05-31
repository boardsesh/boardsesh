// Exercises clearUserData against the REAL v1 DDL (via node:sqlite): every
// user-data table plus the mutation queue and sync checkpoints must be wiped on
// sign-out, while the expensive board reference cache is left untouched.

import { describe, it, expect, beforeEach } from 'vitest';

import { clearUserData } from '../connection';
import { runMigrations } from '../migrations';
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
