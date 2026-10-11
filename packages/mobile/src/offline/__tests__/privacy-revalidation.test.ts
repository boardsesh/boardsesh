import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const auth = vi.hoisted(() => ({ token: 'accepted-token', generation: 1, viewer: 'viewer' }));
const request = vi.hoisted(() => vi.fn());
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
  getHttpClient: () => ({ request }),
}));
import {
  canReadPrivateCatalog,
  getAuthorizedCatalogViewerId,
  captureCatalogReadEpoch,
  isCatalogReadCurrent,
  CATALOG_VIEWER_KEY,
  subscribeCatalogCredentialMismatch,
  beginCatalogInvalidation,
} from '../catalog-access';
import {
  runMigrations,
  setCheckpoint,
  getCheckpointKey,
  getCheckpoint,
  isScopeDownloadComplete,
  isScopeProtectedComplete,
} from '@boardsesh/offline-sync';
import { createTestDatabase, markScopeDownloaded, type TestSqliteDb } from '@boardsesh/offline-sync/testing';
import {
  revalidatePrivateCatalog,
  waitForPrivacyRevalidation,
  subscribePrivacyRevalidation,
  PrivacyRevalidationDeferredError,
} from '../privacy-revalidation';

let database: TestSqliteDb;
afterEach(() => database?.close());
beforeEach(() => {
  auth.token = 'accepted-token';
  auth.viewer = 'viewer';
  request.mockReset().mockImplementation(async () => ({ profile: { id: auth.viewer } }));
});

describe('downloaded catalogue privacy', () => {
  it('persists withdrawal while offline without attempting network authorization', async () => {
    database = createTestDatabase();
    await runMigrations(database);
    await revalidatePrivateCatalog(database, 'viewer');
    request.mockClear();
    await expect(
      revalidatePrivateCatalog(
        database,
        'viewer',
        () => true,
        () => false,
      ),
    ).rejects.toBeInstanceOf(PrivacyRevalidationDeferredError);
    expect(request).not.toHaveBeenCalled();
    expect(await database.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', [CATALOG_VIEWER_KEY])).toBeNull();
    expect(await canReadPrivateCatalog(database)).toBe(false);
    await revalidatePrivateCatalog(database, 'viewer');
    expect(await canReadPrivateCatalog(database)).toBe(true);
  });

  it('requests recovery when an ordinary token refresh invalidates a downloaded marker', async () => {
    database = createTestDatabase();
    await runMigrations(database);
    await revalidatePrivateCatalog(database, 'viewer');
    auth.token = 'ordinary-refresh';
    expect(await canReadPrivateCatalog(database)).toBe(false);
    const listener = vi.fn(() => beginCatalogInvalidation());
    const unsubscribe = subscribeCatalogCredentialMismatch(listener);
    try {
      expect(await canReadPrivateCatalog(database)).toBe(false);
      expect(listener).toHaveBeenCalledOnce();
      expect(await canReadPrivateCatalog(database)).toBe(false);
      expect(listener).toHaveBeenCalledOnce();
      await revalidatePrivateCatalog(database, 'viewer');
      expect(await canReadPrivateCatalog(database)).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  it('does not let an obsolete marker read request another repair', async () => {
    database = createTestDatabase();
    await runMigrations(database);
    await revalidatePrivateCatalog(database, 'viewer');
    auth.token = 'ordinary-refresh';
    const listener = vi.fn();
    const unsubscribe = subscribeCatalogCredentialMismatch(listener);
    const read = database.getFirstAsync.bind(database);
    vi.spyOn(database, 'getFirstAsync').mockImplementationOnce(async (query, params) => {
      const marker = await read(query, params);
      beginCatalogInvalidation();
      return marker;
    });
    try {
      expect(await canReadPrivateCatalog(database)).toBe(false);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it('authorizes the refreshed token with a second profile request before stamping it', async () => {
    database = createTestDatabase();
    await runMigrations(database);
    request.mockImplementationOnce(async () => {
      auth.token = 'refreshed-token';
      return { profile: { id: 'viewer' } };
    });
    await revalidatePrivateCatalog(database, 'viewer');
    expect(request).toHaveBeenCalledTimes(2);
    expect(await canReadPrivateCatalog(database)).toBe(true);
    const marker = await database.getFirstAsync<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [
      CATALOG_VIEWER_KEY,
    ]);
    expect(JSON.parse(marker!.value).credentialDigest).toBe('digest-refreshed-token');
  });

  it('serializes a newer invalidation and refuses to reopen for the older response', async () => {
    database = createTestDatabase();
    await runMigrations(database);
    let finish!: (response: { profile: { id: string } }) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const notified = vi.fn();
    const unsubscribe = subscribePrivacyRevalidation(notified);
    try {
      const oldRepair = revalidatePrivateCatalog(database, 'viewer');
      const oldFailure = expect(oldRepair).rejects.toThrow('superseded');
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      const currentRepair = revalidatePrivateCatalog(database, 'viewer');
      finish({ profile: { id: 'viewer' } });
      await oldFailure;
      await currentRepair;
      expect(request).toHaveBeenCalledTimes(2);
      expect(notified).toHaveBeenCalledOnce();
      expect(await canReadPrivateCatalog(database)).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  it('rejects a replaced database or unmounted owner before committing authorization', async () => {
    database = createTestDatabase();
    await runMigrations(database);
    let current = true;
    request.mockImplementationOnce(async () => {
      current = false;
      return { profile: { id: 'viewer' } };
    });
    await expect(revalidatePrivateCatalog(database, 'viewer', () => current)).rejects.toThrow('superseded');
    expect(await canReadPrivateCatalog(database)).toBe(false);
    expect(await database.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', [CATALOG_VIEWER_KEY])).toBeNull();
  });

  it('rolls back if a same-account token rotates after authorization while taking the write lock', async () => {
    database = createTestDatabase();
    await runMigrations(database);
    const exclusive = database.withExclusiveTransactionAsync.bind(database);
    vi.spyOn(database, 'withExclusiveTransactionAsync').mockImplementationOnce((task) =>
      exclusive(async (transaction) => {
        auth.token = 'rotated-after-response';
        await task(transaction);
      }),
    );
    await expect(revalidatePrivateCatalog(database, 'viewer')).rejects.toThrow('Account changed');
    expect(await canReadPrivateCatalog(database)).toBe(false);
    expect(await database.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', [CATALOG_VIEWER_KEY])).toBeNull();
  });

  it('requires a verified marker and rejects a credential change during its read', async () => {
    database = createTestDatabase();
    await runMigrations(database);
    expect(await getAuthorizedCatalogViewerId(database)).toBeNull();
    await revalidatePrivateCatalog(database, 'viewer');
    const readMarker = database.getFirstAsync.bind(database);
    const readSpy = vi.spyOn(database, 'getFirstAsync').mockImplementationOnce(async (query, params) => {
      const marker = await readMarker(query, params);
      auth.token = 'another-account';
      auth.generation += 1;
      return marker;
    });
    expect(await getAuthorizedCatalogViewerId(database)).toBeNull();
    readSpy.mockRestore();
  });

  it('keeps every published climb, whoever set it, with personal ticks, every cursor and the download', async () => {
    database = createTestDatabase();
    await runMigrations(database);
    for (const [uuid, userId] of [
      ['own-climb', 'viewer'],
      ['published-by-another', 'other'],
      ['manufacturer', null],
    ]) {
      await database.runAsync(
        'INSERT INTO board_climbs (uuid, board_type, layout_id, user_id, is_draft, is_listed, sync_seq) VALUES (?, ?, ?, ?, 0, 1, 5)',
        [uuid, 'kilter', 1, userId],
      );
      await database.runAsync(
        'INSERT INTO board_climb_stats (board_type, climb_uuid, angle, fa_username) VALUES (?, ?, ?, ?)',
        ['kilter', uuid, 40, 'Copied identity'],
      );
    }
    await database.runAsync(
      "INSERT INTO boardsesh_ticks (uuid, user_id, climb_uuid) VALUES ('own-tick', 'viewer', 'published-by-another')",
    );
    const scopeKey = 'kilter:1:1';
    const referenceCursor = { updatedAt: '2026-01-01T00:00:00Z', syncSeq: '10' };
    await markScopeDownloaded(database, scopeKey);
    await setCheckpoint(database, getCheckpointKey('board_climbs', scopeKey), referenceCursor);
    const previousEpoch = captureCatalogReadEpoch();
    await revalidatePrivateCatalog(database, 'viewer');
    expect(isCatalogReadCurrent(previousEpoch)).toBe(false);
    await waitForPrivacyRevalidation();
    // A published climb is public: no privacy setting takes it off the device.
    expect(await database.getAllAsync('SELECT uuid FROM board_climbs ORDER BY uuid')).toEqual([
      { uuid: 'manufacturer' },
      { uuid: 'own-climb' },
      { uuid: 'published-by-another' },
    ]);
    expect(await database.getAllAsync('SELECT uuid FROM boardsesh_ticks')).toEqual([{ uuid: 'own-tick' }]);
    // A first-ascent name an earlier bundle copied from Boardsesh ticks goes,
    // once; the manufacturer's credit on a climb with no owner stays.
    expect(
      await database.getAllAsync('SELECT climb_uuid, fa_username FROM board_climb_stats ORDER BY climb_uuid'),
    ).toEqual([
      { climb_uuid: 'manufacturer', fa_username: 'Copied identity' },
      { climb_uuid: 'own-climb', fa_username: null },
      { climb_uuid: 'published-by-another', fa_username: null },
    ]);
    // The board still reads as downloaded and its public catalogue is not
    // pulled again (issue #6306).
    expect(await getCheckpoint(database, getCheckpointKey('board_climbs', scopeKey))).toEqual(referenceCursor);
    expect(await isScopeDownloadComplete(database, scopeKey)).toBe(true);
    // The first revalidation for an account forgets the protected cursors, which
    // are the previous account's. A later event leaves them alone.
    expect(await isScopeProtectedComplete(database, scopeKey)).toBe(false);
    await markScopeDownloaded(database, scopeKey);
    await revalidatePrivateCatalog(database, 'viewer');
    expect(await isScopeProtectedComplete(database, scopeKey)).toBe(true);
    expect(await canReadPrivateCatalog(database)).toBe(true);
    expect(await getAuthorizedCatalogViewerId(database)).toBe('viewer');
    auth.token = 'another-account-token';
    auth.generation += 1;
    expect(await canReadPrivateCatalog(database)).toBe(false);
    expect(await getAuthorizedCatalogViewerId(database)).toBeNull();
    expect(await database.getAllAsync('SELECT uuid FROM boardsesh_ticks')).toEqual([{ uuid: 'own-tick' }]);
  });
  it('rejects a stale cached profile before binding the new credential to old rows', async () => {
    database = createTestDatabase();
    await runMigrations(database);
    await database.runAsync(
      "INSERT INTO board_climbs (uuid, board_type, user_id, is_draft) VALUES ('old-draft', 'kilter', 'viewer', 1)",
    );
    await revalidatePrivateCatalog(database, 'viewer');
    expect(await canReadPrivateCatalog(database)).toBe(true);
    auth.viewer = 'new-account';
    auth.token = 'new-account-credential';
    auth.generation += 1;
    await expect(revalidatePrivateCatalog(database, 'viewer')).rejects.toThrow('Account changed');
    expect(await canReadPrivateCatalog(database)).toBe(false);
    expect(await database.getAllAsync('SELECT uuid FROM board_climbs')).toEqual([{ uuid: 'old-draft' }]);
    expect(await database.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', [CATALOG_VIEWER_KEY])).toBeNull();
  });
  // Drafts and unlisted climbs are kept only for their owner. That is settled
  // once per account, not per event: see "preparing the catalogue for an
  // account, once" in privacy-revalidation-sync-meta.test.ts.

  it('retains unsynced foreign drafts and outbox references even with a server version', async () => {
    database = createTestDatabase();
    await runMigrations(database);
    await database.runAsync(`INSERT INTO board_climbs (uuid, board_type, user_id, is_draft, sync_seq) VALUES
      ('unknown-version', 'kilter', 'other', 1, NULL),
      ('zero-version', 'kilter', 'other', 1, 0),
      ('queued-downloaded-draft', 'kilter', 'other', 1, 42),
      ('unknown-spray-draft', 'spray', NULL, 1, NULL)`);
    await database.runAsync(
      "INSERT INTO pending_mutations (table_name, operation, payload, idempotency_key) VALUES ('boardsesh_ticks', 'insert', ?, 'draft-reference')",
      [JSON.stringify({ climbUuid: 'queued-downloaded-draft' })],
    );
    await revalidatePrivateCatalog(database, 'viewer');
    expect(await database.getAllAsync('SELECT uuid FROM board_climbs ORDER BY uuid')).toEqual([
      { uuid: 'queued-downloaded-draft' },
      { uuid: 'unknown-spray-draft' },
      { uuid: 'unknown-version' },
      { uuid: 'zero-version' },
    ]);
    expect(await database.getAllAsync('SELECT idempotency_key FROM pending_mutations')).toEqual([
      { idempotency_key: 'draft-reference' },
    ]);
    expect(await canReadPrivateCatalog(database)).toBe(false);
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
    await revalidatePrivateCatalog(database, 'viewer');
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
