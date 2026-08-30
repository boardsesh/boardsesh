import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_STATEMENTS, stampLocalUserId } from '@boardsesh/offline-sync';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';
import { getLocalProfileImportCounts, importLocalProfileIntoAccount } from '../local-profile-account-import';

let localProfile: TestSqliteDb;
let accountProfile: TestSqliteDb;

async function initialize(database: TestSqliteDb, ownerUserId: string): Promise<void> {
  for (const statement of SCHEMA_STATEMENTS) await database.execAsync(statement);
  await stampLocalUserId(database, ownerUserId);
}

beforeEach(async () => {
  localProfile = createTestDatabase();
  accountProfile = createTestDatabase();
  await initialize(localProfile, 'local:profile-1');
  await initialize(accountProfile, 'account-user-1');
});

afterEach(() => {
  localProfile.close();
  accountProfile.close();
});

describe('login-free profile account import', () => {
  it('copies personal rows and queues normal account mutations without changing the local copy', async () => {
    await localProfile.runAsync(
      `INSERT INTO boardsesh_ticks
       (uuid, user_id, board_type, climb_uuid, angle, is_mirror, status, attempt_count, is_benchmark,
        comment, climbed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'tick-1',
        'local:profile-1',
        'kilter',
        'climb-1',
        40,
        0,
        'send',
        2,
        0,
        'Heel first',
        '2026-08-30T00:00:00.000Z',
        '2026-08-30T00:00:00.000Z',
        '2026-08-30T00:00:00.000Z',
      ],
    );
    await localProfile.runAsync(
      `INSERT INTO user_favorites (board_name, climb_uuid, angle, user_id) VALUES (?, ?, ?, ?)`,
      ['kilter', 'climb-1', 40, 'local:profile-1'],
    );
    await localProfile.runAsync(
      `INSERT INTO playlists (uuid, board_type, layout_id, name, is_public) VALUES (?, ?, ?, ?, 0)`,
      ['playlist-1', 'kilter', 1, 'Projects'],
    );
    await localProfile.runAsync(
      `INSERT INTO playlist_climbs (playlist_uuid, climb_uuid, angle, position) VALUES (?, ?, ?, ?)`,
      ['playlist-1', 'climb-1', 40, 0],
    );

    await expect(getLocalProfileImportCounts(localProfile)).resolves.toEqual({
      ticks: 1,
      favorites: 1,
      playlists: 1,
      playlistClimbs: 1,
    });
    await expect(importLocalProfileIntoAccount(localProfile, accountProfile, 'account-user-1')).resolves.toEqual({
      ticks: 1,
      favorites: 1,
      playlists: 1,
      playlistClimbs: 1,
    });

    expect(
      await accountProfile.getFirstAsync<{ user_id: string; comment: string }>(
        'SELECT user_id, comment FROM boardsesh_ticks WHERE uuid = ?',
        ['tick-1'],
      ),
    ).toEqual({ user_id: 'account-user-1', comment: 'Heel first' });
    expect(
      await accountProfile.getAllAsync<{ table_name: string; operation: string }>(
        'SELECT table_name, operation FROM pending_mutations ORDER BY id',
      ),
    ).toEqual([
      { table_name: 'boardsesh_ticks', operation: 'create' },
      { table_name: 'user_favorites', operation: 'create' },
      { table_name: 'playlists', operation: 'create' },
      { table_name: 'playlist_climbs', operation: 'create' },
    ]);
    expect(
      await localProfile.getFirstAsync<{ user_id: string }>('SELECT user_id FROM boardsesh_ticks WHERE uuid = ?', [
        'tick-1',
      ]),
    ).toEqual({ user_id: 'local:profile-1' });

    await expect(importLocalProfileIntoAccount(localProfile, accountProfile, 'account-user-1')).resolves.toEqual({
      ticks: 0,
      favorites: 0,
      playlists: 0,
      playlistClimbs: 0,
    });
    expect(
      await accountProfile.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM pending_mutations'),
    ).toEqual({ count: 4 });
  });

  it('refuses to import before the destination account owner is ready', async () => {
    await stampLocalUserId(accountProfile, 'different-account');

    await expect(importLocalProfileIntoAccount(localProfile, accountProfile, 'account-user-1')).rejects.toThrow(
      'owner is not ready',
    );
  });
});
