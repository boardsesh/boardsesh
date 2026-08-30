import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';
import { SCHEMA_STATEMENTS, stampLocalUserId } from '@boardsesh/offline-sync';
import {
  exportLocalProfileBackup,
  restoreLocalProfileBackup,
  validateLocalProfileBackup,
} from '../local-profile-backup-core';

let source: TestSqliteDb;
let destination: TestSqliteDb;

beforeEach(async () => {
  source = createTestDatabase();
  destination = createTestDatabase();
  for (const statement of SCHEMA_STATEMENTS) await source.execAsync(statement);
  await stampLocalUserId(source, 'local:profile-1');
});

afterEach(() => {
  source.close();
  destination.close();
});

describe('local profile backup', () => {
  it('exports only the active local owner and personal tables', async () => {
    await source.runAsync(
      `INSERT INTO boardsesh_ticks
       (uuid, user_id, board_type, climb_uuid, angle, status, climbed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'mine',
        'local:profile-1',
        'kilter',
        'climb-1',
        40,
        'sent',
        '2026-08-30T00:00:00.000Z',
        '2026-08-30T00:00:00.000Z',
        '2026-08-30T00:00:00.000Z',
        'other',
        'local:profile-2',
        'kilter',
        'climb-2',
        40,
        'sent',
        '2026-08-30T00:00:00.000Z',
        '2026-08-30T00:00:00.000Z',
        '2026-08-30T00:00:00.000Z',
      ],
    );
    await source.runAsync(
      `INSERT INTO user_favorites (board_name, climb_uuid, angle, user_id)
       VALUES (?, ?, ?, ?), (?, ?, ?, ?)`,
      ['kilter', 'climb-1', 40, 'local:profile-1', 'kilter', 'climb-2', 40, 'local:profile-2'],
    );
    await source.runAsync(
      `INSERT INTO playlists (uuid, board_type, layout_id, name, is_public)
       VALUES (?, ?, ?, ?, ?)`,
      ['playlist-1', 'kilter', 1, 'Projects', 0],
    );
    await source.runAsync(
      `INSERT INTO playlist_climbs (playlist_uuid, climb_uuid, angle, position)
       VALUES (?, ?, ?, ?)`,
      ['playlist-1', 'climb-1', 40, 0],
    );
    await source.runAsync(
      `INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, description, frames,
       is_draft, is_listed, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['catalog-climb', 'kilter', 1, 'setter', 'Catalog climb', '', 'p1r1', 0, 1, '', ''],
    );

    await expect(exportLocalProfileBackup(source, destination, '2026-08-30T01:02:03.000Z')).resolves.toEqual({
      ticks: 1,
      favorites: 1,
      playlists: 1,
      playlistClimbs: 1,
    });
    expect(await destination.getAllAsync<{ uuid: string }>('SELECT uuid FROM boardsesh_ticks')).toEqual([
      { uuid: 'mine' },
    ]);
    expect(await destination.getAllAsync<{ climb_uuid: string }>('SELECT climb_uuid FROM user_favorites')).toEqual([
      { climb_uuid: 'climb-1' },
    ]);
    expect(
      await destination.getFirstAsync<{ value: string }>(
        "SELECT value FROM backup_metadata WHERE key = 'format_version'",
      ),
    ).toEqual({ value: '1' });
    expect(
      await destination.getFirstAsync<{ name: string }>("SELECT name FROM sqlite_master WHERE name = 'board_climbs'"),
    ).toBeNull();
    expect(
      await destination.getFirstAsync<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE name = 'pending_mutations'",
      ),
    ).toBeNull();
  });

  it('refuses to export an account-owned database', async () => {
    await source.runAsync("UPDATE sync_meta SET value = 'account-user' WHERE key = 'local_user_id'", []);

    await expect(exportLocalProfileBackup(source, destination, new Date().toISOString())).rejects.toThrow(
      'login-free profile',
    );
  });

  it('validates and atomically restores missing rows under the current local owner', async () => {
    await source.runAsync(
      `INSERT INTO boardsesh_ticks
       (uuid, user_id, board_type, climb_uuid, angle, status, attempt_count, comment, climbed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'restored-tick',
        'local:profile-1',
        'kilter',
        'climb-1',
        40,
        'send',
        1,
        'Left heel beta',
        '2026-08-30T00:00:00.000Z',
        '2026-08-30T00:00:00.000Z',
        '2026-08-30T00:00:00.000Z',
      ],
    );
    await exportLocalProfileBackup(source, destination, '2026-08-30T01:02:03.000Z');
    await expect(validateLocalProfileBackup(destination)).resolves.toMatchObject({
      ticks: 1,
      sourceOwnerUserId: 'local:profile-1',
    });

    const restored = createTestDatabase();
    try {
      for (const statement of SCHEMA_STATEMENTS) await restored.execAsync(statement);
      await stampLocalUserId(restored, 'local:profile-restored');

      await expect(restoreLocalProfileBackup(destination, restored)).resolves.toEqual({
        ticks: 1,
        favorites: 0,
        playlists: 0,
        playlistClimbs: 0,
      });
      expect(
        await restored.getFirstAsync<{ user_id: string; comment: string; quality: number | null }>(
          'SELECT user_id, comment, quality FROM boardsesh_ticks WHERE uuid = ?',
          ['restored-tick'],
        ),
      ).toEqual({ user_id: 'local:profile-restored', comment: 'Left heel beta', quality: null });

      // A second merge is idempotent and never overwrites the current copy.
      await restored.runAsync("UPDATE boardsesh_ticks SET comment = 'Keep current' WHERE uuid = 'restored-tick'", []);
      await expect(restoreLocalProfileBackup(destination, restored)).resolves.toEqual({
        ticks: 0,
        favorites: 0,
        playlists: 0,
        playlistClimbs: 0,
      });
      expect(
        await restored.getFirstAsync<{ comment: string }>(
          "SELECT comment FROM boardsesh_ticks WHERE uuid = 'restored-tick'",
        ),
      ).toEqual({ comment: 'Keep current' });
    } finally {
      restored.close();
    }
  });

  it('rejects a backup with unexpected tables before restoring anything', async () => {
    await exportLocalProfileBackup(source, destination, '2026-08-30T01:02:03.000Z');
    await destination.execAsync('CREATE TABLE stolen_tokens (token TEXT)');

    await expect(validateLocalProfileBackup(destination)).rejects.toThrow('personal-only');
  });
});
