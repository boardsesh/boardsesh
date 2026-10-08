import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const auth = vi.hoisted(() => ({ token: 'accepted-token', generation: 1, viewer: 'viewer' }));
vi.mock('../../lib/auth-store', () => ({
  getAuthToken: async () => auth.token,
  captureAuthCredentialGeneration: () => auth.generation,
  isAuthCredentialGenerationCurrent: (generation: number) => generation === auth.generation,
}));
vi.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digestStringAsync: async (_algorithm: string, token: string) => `digest-${token}`,
}));
vi.mock('../../lib/graphql/client', () => ({
  getHttpClient: () => ({ request: async () => ({ profile: { id: auth.viewer } }) }),
}));
import {
  canReadPrivateCatalog,
  captureCatalogReadEpoch,
  isCatalogReadCurrent,
  CATALOG_VIEWER_KEY,
} from '../catalog-access';
import {
  runMigrations,
  markScopeDownloadComplete,
  setCheckpoint,
  getCheckpointKey,
  getCheckpoint,
  isScopeDownloadComplete,
} from '@boardsesh/offline-sync';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';
import { revalidatePrivateCatalog, waitForPrivacyRevalidation } from '../privacy-revalidation';

let database: TestSqliteDb;
afterEach(() => database?.close());
beforeEach(() => {
  auth.token = 'accepted-token';
  auth.viewer = 'viewer';
});

describe('downloaded catalogue privacy', () => {
  it('removes other authors and copied FA names, preserving personal ticks and authored drafts', async () => {
    database = createTestDatabase();
    await runMigrations(database);
    for (const [uuid, userId] of [
      ['own-climb', 'viewer'],
      ['protected-climb', 'other'],
      ['manufacturer', null],
    ]) {
      await database.runAsync('INSERT INTO board_climbs (uuid, board_type, layout_id, user_id) VALUES (?, ?, ?, ?)', [
        uuid,
        'kilter',
        1,
        userId,
      ]);
      await database.runAsync(
        'INSERT INTO board_climb_stats (board_type, climb_uuid, angle, fa_username) VALUES (?, ?, ?, ?)',
        ['kilter', uuid, 40, 'Copied identity'],
      );
    }
    await database.runAsync(
      "INSERT INTO boardsesh_ticks (uuid, user_id, climb_uuid) VALUES ('own-tick', 'viewer', 'protected-climb')",
    );
    const scopeKey = 'kilter:1:1';
    await markScopeDownloadComplete(database, scopeKey);
    await setCheckpoint(database, getCheckpointKey('board_climbs', scopeKey), {
      updatedAt: '2026-01-01T00:00:00Z',
      syncSeq: '10',
    });
    const previousEpoch = captureCatalogReadEpoch();
    await revalidatePrivateCatalog(database, 'viewer', [scopeKey]);
    expect(isCatalogReadCurrent(previousEpoch)).toBe(false);
    await waitForPrivacyRevalidation();
    expect(await database.getAllAsync('SELECT uuid FROM board_climbs ORDER BY uuid')).toEqual([
      { uuid: 'manufacturer' },
      { uuid: 'own-climb' },
    ]);
    expect(await database.getAllAsync('SELECT uuid FROM boardsesh_ticks')).toEqual([{ uuid: 'own-tick' }]);
    expect(await database.getAllAsync('SELECT fa_username FROM board_climb_stats')).toEqual([
      { fa_username: null },
      { fa_username: null },
    ]);
    expect(await getCheckpoint(database, getCheckpointKey('board_climbs', scopeKey))).toBeNull();
    expect(await isScopeDownloadComplete(database, scopeKey)).toBe(false);
    expect(await canReadPrivateCatalog(database)).toBe(true);
    auth.token = 'another-account-token';
    auth.generation += 1;
    expect(await canReadPrivateCatalog(database)).toBe(false);
    expect(await database.getAllAsync('SELECT uuid FROM boardsesh_ticks')).toEqual([{ uuid: 'own-tick' }]);
  });
  it('rejects a stale cached profile before binding the new credential to old rows', async () => {
    database = createTestDatabase();
    await runMigrations(database);
    await database.runAsync(
      "INSERT INTO board_climbs (uuid, board_type, user_id, is_draft) VALUES ('old-draft', 'kilter', 'viewer', 1)",
    );
    await revalidatePrivateCatalog(database, 'viewer', []);
    expect(await canReadPrivateCatalog(database)).toBe(true);
    auth.viewer = 'new-account';
    auth.token = 'new-account-credential';
    auth.generation += 1;
    await expect(revalidatePrivateCatalog(database, 'viewer', [])).rejects.toThrow('Account changed');
    expect(await canReadPrivateCatalog(database)).toBe(false);
    expect(await database.getAllAsync('SELECT uuid FROM board_climbs')).toEqual([{ uuid: 'old-draft' }]);
    expect(await database.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', [CATALOG_VIEWER_KEY])).toBeNull();
  });
  it('preserves another account drafts and queued climb references without granting catalogue access', async () => {
    database = createTestDatabase();
    await runMigrations(database);
    await database.runAsync(
      "INSERT INTO board_climbs (uuid, board_type, user_id, is_draft) VALUES ('other-draft', 'kilter', 'other', 1), ('queued-reference', 'kilter', 'other', 0)",
    );
    await database.runAsync(
      "INSERT INTO pending_mutations (table_name, operation, payload, idempotency_key) VALUES ('boardsesh_ticks', 'insert', ?, 'unsynced')",
      [JSON.stringify({ climbUuid: 'queued-reference' })],
    );
    await revalidatePrivateCatalog(database, 'viewer', []);
    expect(await database.getAllAsync('SELECT uuid FROM board_climbs ORDER BY uuid')).toEqual([
      { uuid: 'other-draft' },
      { uuid: 'queued-reference' },
    ]);
    expect(await database.getAllAsync('SELECT idempotency_key FROM pending_mutations')).toEqual([
      { idempotency_key: 'unsynced' },
    ]);
    expect(await canReadPrivateCatalog(database)).toBe(false);
  });
});
