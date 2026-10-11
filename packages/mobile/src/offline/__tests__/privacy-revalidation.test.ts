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
  markScopeDownloadComplete,
  setCheckpoint,
  getCheckpointKey,
  getCheckpoint,
  isScopeDownloadComplete,
  capturePurgeToken,
  hasPurgeLanded,
  holdIndexKey,
  BOARD_DATA_TABLES,
} from '@boardsesh/offline-sync';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';
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
    await revalidatePrivateCatalog(database, 'viewer', []);
    request.mockClear();
    await expect(
      revalidatePrivateCatalog(
        database,
        'viewer',
        [],
        () => true,
        () => false,
      ),
    ).rejects.toBeInstanceOf(PrivacyRevalidationDeferredError);
    expect(request).not.toHaveBeenCalled();
    expect(await database.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', [CATALOG_VIEWER_KEY])).toBeNull();
    expect(await canReadPrivateCatalog(database)).toBe(false);
    await revalidatePrivateCatalog(database, 'viewer', []);
    expect(await canReadPrivateCatalog(database)).toBe(true);
  });

  it('requests recovery when an ordinary token refresh invalidates a downloaded marker', async () => {
    database = createTestDatabase();
    await runMigrations(database);
    await revalidatePrivateCatalog(database, 'viewer', []);
    auth.token = 'ordinary-refresh';
    expect(await canReadPrivateCatalog(database)).toBe(false);
    const listener = vi.fn(() => beginCatalogInvalidation());
    const unsubscribe = subscribeCatalogCredentialMismatch(listener);
    try {
      expect(await canReadPrivateCatalog(database)).toBe(false);
      expect(listener).toHaveBeenCalledOnce();
      expect(await canReadPrivateCatalog(database)).toBe(false);
      expect(listener).toHaveBeenCalledOnce();
      await revalidatePrivateCatalog(database, 'viewer', []);
      expect(await canReadPrivateCatalog(database)).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  it('does not let an obsolete marker read request another repair', async () => {
    database = createTestDatabase();
    await runMigrations(database);
    await revalidatePrivateCatalog(database, 'viewer', []);
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
    await revalidatePrivateCatalog(database, 'viewer', []);
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
      const oldRepair = revalidatePrivateCatalog(database, 'viewer', []);
      const oldFailure = expect(oldRepair).rejects.toThrow('superseded');
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      const currentRepair = revalidatePrivateCatalog(database, 'viewer', []);
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
    await expect(revalidatePrivateCatalog(database, 'viewer', [], () => current)).rejects.toThrow('superseded');
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
    await expect(revalidatePrivateCatalog(database, 'viewer', [])).rejects.toThrow('Account changed');
    expect(await canReadPrivateCatalog(database)).toBe(false);
    expect(await database.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', [CATALOG_VIEWER_KEY])).toBeNull();
  });

  it('requires a verified marker and rejects a credential change during its read', async () => {
    database = createTestDatabase();
    await runMigrations(database);
    expect(await getAuthorizedCatalogViewerId(database)).toBeNull();
    await revalidatePrivateCatalog(database, 'viewer', []);
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

  it('keeps published climbs of other authors, clears copied FA names and preserves personal ticks', async () => {
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
    // A published climb is public whatever its author's privacy settings, so the
    // board keeps its rows, its cursor and its "downloaded" marker.
    expect(await database.getAllAsync('SELECT uuid FROM board_climbs ORDER BY uuid')).toEqual([
      { uuid: 'manufacturer' },
      { uuid: 'own-climb' },
      { uuid: 'protected-climb' },
    ]);
    expect(await database.getAllAsync('SELECT uuid FROM boardsesh_ticks')).toEqual([{ uuid: 'own-tick' }]);
    expect(await database.getAllAsync('SELECT fa_username FROM board_climb_stats')).toEqual([
      { fa_username: null },
      { fa_username: null },
      { fa_username: null },
    ]);
    expect(await getCheckpoint(database, getCheckpointKey('board_climbs', scopeKey))).toEqual({
      updatedAt: '2026-01-01T00:00:00Z',
      syncSeq: '10',
    });
    expect(await isScopeDownloadComplete(database, scopeKey)).toBe(true);
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
  it('withdraws downloaded foreign drafts while preserving owned and manufacturer drafts', async () => {
    database = createTestDatabase();
    await runMigrations(database);
    await database.runAsync(`INSERT INTO board_climbs (uuid, board_type, user_id, is_draft, sync_seq) VALUES
      ('downloaded-foreign-draft', 'kilter', 'other', 1, 10),
      ('owned-draft', 'kilter', 'viewer', 1, 11),
      ('manufacturer-draft', 'kilter', NULL, 1, 12),
      ('unowned-spray-draft', 'spray', NULL, 1, 13)`);
    await database.runAsync(`INSERT INTO board_climb_stats (board_type, climb_uuid, angle)
      VALUES ('kilter', 'downloaded-foreign-draft', 40)`);
    await database.runAsync(`INSERT INTO board_climb_grades (board_type, climb_uuid, angle)
      VALUES ('kilter', 'downloaded-foreign-draft', 40)`);
    await revalidatePrivateCatalog(database, 'viewer', []);
    expect(await database.getAllAsync('SELECT uuid FROM board_climbs ORDER BY uuid')).toEqual([
      { uuid: 'manufacturer-draft' },
      { uuid: 'owned-draft' },
    ]);
    expect(await database.getAllAsync('SELECT climb_uuid FROM board_climb_stats')).toEqual([]);
    expect(await database.getAllAsync('SELECT climb_uuid FROM board_climb_grades')).toEqual([]);
    expect(await canReadPrivateCatalog(database)).toBe(true);
  });

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
    await revalidatePrivateCatalog(database, 'viewer', []);
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

  it("opens access over another account's published climbs, even one a queued tick references", async () => {
    database = createTestDatabase();
    await runMigrations(database);
    await database.runAsync(`INSERT INTO board_climbs (uuid, board_type, layout_id, user_id, is_draft, sync_seq) VALUES
      ('published', 'kilter', 1, 'other', 0, 5),
      ('queued-published', 'kilter', 1, 'other', 0, 6)`);
    await database.runAsync(
      "INSERT INTO pending_mutations (table_name, operation, payload, idempotency_key) VALUES ('boardsesh_ticks', 'insert', ?, 'queued-tick')",
      [JSON.stringify({ climbUuid: 'queued-published' })],
    );
    await revalidatePrivateCatalog(database, 'viewer', []);
    expect(await database.getAllAsync('SELECT uuid FROM board_climbs ORDER BY uuid')).toEqual([
      { uuid: 'published' },
      { uuid: 'queued-published' },
    ]);
    expect(await canReadPrivateCatalog(database)).toBe(true);
  });

  it("keeps access closed for another account's draft with no server sequence beside published climbs", async () => {
    database = createTestDatabase();
    await runMigrations(database);
    await database.runAsync(`INSERT INTO board_climbs (uuid, board_type, layout_id, user_id, is_draft, sync_seq) VALUES
      ('published', 'kilter', 1, 'other', 0, 5),
      ('unsynced-draft', 'kilter', 1, 'other', 1, NULL)`);
    await revalidatePrivateCatalog(database, 'viewer', []);
    expect(await database.getAllAsync('SELECT uuid FROM board_climbs ORDER BY uuid')).toEqual([
      { uuid: 'published' },
      { uuid: 'unsynced-draft' },
    ]);
    expect(await database.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', [CATALOG_VIEWER_KEY])).toBeNull();
    expect(await canReadPrivateCatalog(database)).toBe(false);
  });
});

const KILTER_SCOPE = 'kilter:1:1';
const SPRAY_SCOPE = 'spray:7:7';
const DOWNLOADED_CURSOR = { updatedAt: '2026-01-01T00:00:00Z', syncSeq: '10' };

/** A scope whose download finished: a cursor per board table and the completion marker. */
async function seedDownloadedScope(scopeKey: string): Promise<void> {
  await markScopeDownloadComplete(database, scopeKey);
  for (const table of BOARD_DATA_TABLES) {
    await setCheckpoint(database, getCheckpointKey(table, scopeKey), DOWNLOADED_CURSOR);
  }
}

/** A built holds index: a local id and hold set per climb, one posting, and the scope's watermark. */
async function seedHoldIndex(boardType: string, layoutId: number, scopeKey: string, climbUuids: string[]) {
  for (const uuid of climbUuids) {
    await database.runAsync('INSERT INTO holds_index_climbs (uuid) VALUES (?)', [uuid]);
    await database.runAsync(
      "INSERT INTO board_climb_hold_sets (climb_id, holds) SELECT id, X'0D00000001' FROM holds_index_climbs WHERE uuid = ?",
      [uuid],
    );
  }
  await database.runAsync(
    "INSERT INTO board_climb_hold_postings (board_type, layout_id, hold_id, climb_ids) VALUES (?, ?, 13, X'01000000')",
    [boardType, layoutId],
  );
  await database.runAsync('INSERT INTO sync_meta (key, value) VALUES (?, ?)', [holdIndexKey(scopeKey), '10']);
}

/** Every row a downloaded board keeps on the device, read back in full. */
async function readDownloadedCopy(boardType: string) {
  return {
    climbs: await database.getAllAsync('SELECT * FROM board_climbs WHERE board_type = ? ORDER BY uuid', [boardType]),
    stats: await database.getAllAsync(
      'SELECT * FROM board_climb_stats WHERE board_type = ? ORDER BY climb_uuid, angle',
      [boardType],
    ),
    grades: await database.getAllAsync(
      'SELECT * FROM board_climb_grades WHERE board_type = ? ORDER BY climb_uuid, angle',
      [boardType],
    ),
    syncMeta: await database.getAllAsync<{ key: string; value: string }>(
      'SELECT key, value FROM sync_meta WHERE key <> ? ORDER BY key',
      [CATALOG_VIEWER_KEY],
    ),
    holdIndexIds: await database.getAllAsync('SELECT id, uuid FROM holds_index_climbs ORDER BY id'),
    holdSets: await database.getAllAsync(
      'SELECT climb_id, hex(holds) AS holds FROM board_climb_hold_sets ORDER BY climb_id',
    ),
    postings: await database.getAllAsync(
      'SELECT board_type, layout_id, hold_id, hex(climb_ids) AS climb_ids FROM board_climb_hold_postings ORDER BY board_type, layout_id, hold_id',
    ),
  };
}

describe('a privacy event on a device with downloaded boards', () => {
  beforeEach(async () => {
    database = createTestDatabase();
    await runMigrations(database);
  });

  it('leaves a catalogue board, its cursors, completion marker and holds index exactly as they were', async () => {
    await database.runAsync(`INSERT INTO board_climbs (uuid, board_type, layout_id, user_id, is_draft, sync_seq) VALUES
      ('community-climb', 'kilter', 1, 'other', 0, 5),
      ('manufacturer-climb', 'kilter', 1, NULL, 0, 6),
      ('own-climb', 'kilter', 1, 'viewer', 0, 7)`);
    await database.runAsync(`INSERT INTO board_climb_stats (board_type, climb_uuid, angle, ascensionist_count)
      VALUES ('kilter', 'community-climb', 40, 12)`);
    await database.runAsync(`INSERT INTO board_climb_grades (board_type, climb_uuid, angle, local_grade)
      VALUES ('kilter', 'community-climb', 40, 21.4)`);
    await seedDownloadedScope(KILTER_SCOPE);
    await seedHoldIndex('kilter', 1, KILTER_SCOPE, ['community-climb', 'manufacturer-climb']);
    const downloaded = await readDownloadedCopy('kilter');

    await revalidatePrivateCatalog(database, 'viewer', [KILTER_SCOPE]);

    expect(await readDownloadedCopy('kilter')).toEqual(downloaded);
    expect(await canReadPrivateCatalog(database)).toBe(true);
  });

  it('does not abort a catalogue sync in flight, while a spray wall stays purged for the whole repair', async () => {
    const beforeEvent = capturePurgeToken();
    let duringRepair: { kilter: boolean; spray: boolean } | undefined;
    request.mockImplementationOnce(async () => {
      // A cycle that starts mid-repair: only the latch can stop it.
      const startedMidRepair = capturePurgeToken();
      duringRepair = {
        kilter: hasPurgeLanded(startedMidRepair, 'kilter:1'),
        spray: hasPurgeLanded(startedMidRepair, 'spray:7'),
      };
      return { profile: { id: 'viewer' } };
    });

    await revalidatePrivateCatalog(database, 'viewer', [KILTER_SCOPE, SPRAY_SCOPE]);

    expect(duringRepair).toEqual({ kilter: false, spray: true });
    // No global purge: the drain, the user tables and every other board carry on.
    expect(hasPurgeLanded(beforeEvent)).toBe(false);
    expect(hasPurgeLanded(beforeEvent, 'kilter:1')).toBe(false);
    expect(hasPurgeLanded(beforeEvent, 'spray:7')).toBe(true);
    // The latch is released with the repair, so the wall can download again.
    expect(hasPurgeLanded(capturePurgeToken(), 'spray:7')).toBe(false);
  });

  it('still withdraws spray walls with their climbs, cursors, completion marker and holds index', async () => {
    await database.runAsync("INSERT INTO spray_walls (layout_id, board_uuid, name) VALUES (7, 'wall-uuid', 'Garage')");
    await database.runAsync(`INSERT INTO board_climbs (uuid, board_type, layout_id, user_id, is_draft, sync_seq) VALUES
      ('spray-other', 'spray', 7, 'other', 0, 5),
      ('spray-unowned', 'spray', 7, NULL, 0, 6),
      ('spray-own', 'spray', 7, 'viewer', 0, 7)`);
    for (const climbUuid of ['spray-other', 'spray-own']) {
      await database.runAsync("INSERT INTO board_climb_stats (board_type, climb_uuid, angle) VALUES ('spray', ?, 40)", [
        climbUuid,
      ]);
      await database.runAsync(
        "INSERT INTO board_climb_grades (board_type, climb_uuid, angle) VALUES ('spray', ?, 40)",
        [climbUuid],
      );
    }
    await seedDownloadedScope(SPRAY_SCOPE);
    await seedHoldIndex('spray', 7, SPRAY_SCOPE, ['spray-other', 'spray-own']);
    await database.runAsync("INSERT INTO followed_author_snapshots (user_id, snapshot) VALUES ('viewer', '{}')");

    await revalidatePrivateCatalog(database, 'viewer', [SPRAY_SCOPE]);

    expect(await database.getAllAsync('SELECT layout_id FROM spray_walls')).toEqual([]);
    expect(await database.getAllAsync('SELECT uuid FROM board_climbs')).toEqual([{ uuid: 'spray-own' }]);
    expect(await database.getAllAsync('SELECT climb_uuid FROM board_climb_stats')).toEqual([
      { climb_uuid: 'spray-own' },
    ]);
    expect(await database.getAllAsync('SELECT climb_uuid FROM board_climb_grades')).toEqual([
      { climb_uuid: 'spray-own' },
    ]);
    for (const table of BOARD_DATA_TABLES) {
      expect(await getCheckpoint(database, getCheckpointKey(table, SPRAY_SCOPE))).toBeNull();
    }
    expect(await isScopeDownloadComplete(database, SPRAY_SCOPE)).toBe(false);
    expect(
      await database.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', [holdIndexKey(SPRAY_SCOPE)]),
    ).toBeNull();
    expect(await database.getAllAsync('SELECT hold_id FROM board_climb_hold_postings')).toEqual([]);
    expect(await database.getAllAsync('SELECT climb_id FROM board_climb_hold_sets')).toEqual([]);
    expect(await database.getAllAsync('SELECT uuid FROM holds_index_climbs')).toEqual([{ uuid: 'spray-own' }]);
    expect(await database.getAllAsync('SELECT user_id FROM followed_author_snapshots')).toEqual([]);
    expect(await canReadPrivateCatalog(database)).toBe(true);
  });

  it('withdraws a spray wall without touching the catalogue board beside it', async () => {
    await database.runAsync(`INSERT INTO board_climbs (uuid, board_type, layout_id, user_id, is_draft, sync_seq) VALUES
      ('community-climb', 'kilter', 1, 'other', 0, 5),
      ('spray-other', 'spray', 7, 'other', 0, 6)`);
    await seedDownloadedScope(KILTER_SCOPE);
    await seedDownloadedScope(SPRAY_SCOPE);
    await seedHoldIndex('kilter', 1, KILTER_SCOPE, ['community-climb']);
    // The wall's own sync_meta rows are meant to change; compare the board's.
    const readKilterCopy = async () => {
      const copy = await readDownloadedCopy('kilter');
      return { ...copy, syncMeta: copy.syncMeta.filter((row) => row.key.includes('kilter:')) };
    };
    const downloadedKilter = await readKilterCopy();

    await revalidatePrivateCatalog(database, 'viewer', [KILTER_SCOPE, SPRAY_SCOPE]);

    expect(await readKilterCopy()).toEqual(downloadedKilter);
    expect(await database.getAllAsync("SELECT uuid FROM board_climbs WHERE board_type = 'spray'")).toEqual([]);
    expect(await isScopeDownloadComplete(database, SPRAY_SCOPE)).toBe(false);
    expect(await isScopeDownloadComplete(database, KILTER_SCOPE)).toBe(true);
  });

  it("rebuilds the holds index of a catalogue layout only when it loses another account's draft", async () => {
    await database.runAsync(`INSERT INTO board_climbs (uuid, board_type, layout_id, user_id, is_draft, sync_seq) VALUES
      ('downloaded-foreign-draft', 'kilter', 1, 'other', 1, 10),
      ('kilter-climb', 'kilter', 1, NULL, 0, 11),
      ('tension-climb', 'tension', 9, 'other', 0, 12)`);
    await seedHoldIndex('kilter', 1, KILTER_SCOPE, ['downloaded-foreign-draft', 'kilter-climb']);
    await seedHoldIndex('tension', 9, 'tension:9:1', ['tension-climb']);

    await revalidatePrivateCatalog(database, 'viewer', [KILTER_SCOPE, 'tension:9:1']);

    expect(await database.getAllAsync('SELECT uuid FROM board_climbs ORDER BY uuid')).toEqual([
      { uuid: 'kilter-climb' },
      { uuid: 'tension-climb' },
    ]);
    // Kilter layout 1 lost a row, so its index starts over. Tension lost nothing.
    expect(await database.getAllAsync('SELECT board_type FROM board_climb_hold_postings')).toEqual([
      { board_type: 'tension' },
    ]);
    expect(
      await database.getAllAsync(
        'SELECT local_id.uuid FROM board_climb_hold_sets hold_set JOIN holds_index_climbs local_id ON local_id.id = hold_set.climb_id',
      ),
    ).toEqual([{ uuid: 'tension-climb' }]);
    expect(
      await database.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', [holdIndexKey(KILTER_SCOPE)]),
    ).toBeNull();
    expect(
      await database.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', [holdIndexKey('tension:9:1')]),
    ).toEqual({ value: '10' });
  });

  it('leaves sync_meta byte for byte across three events in a row', async () => {
    await database.runAsync(`INSERT INTO board_climbs (uuid, board_type, layout_id, user_id, is_draft, sync_seq)
      VALUES ('community-climb', 'kilter', 1, 'other', 0, 5)`);
    await seedDownloadedScope(KILTER_SCOPE);
    await seedHoldIndex('kilter', 1, KILTER_SCOPE, ['community-climb']);
    const readSyncMeta = () =>
      database.getAllAsync<{ key: string; value: string }>('SELECT key, value FROM sync_meta ORDER BY key');
    const downloaded = await readSyncMeta();

    await revalidatePrivateCatalog(database, 'viewer', [KILTER_SCOPE]);
    const afterFirstEvent = await readSyncMeta();
    // The viewer marker is the only row an event may add.
    expect(afterFirstEvent.filter((row) => row.key !== CATALOG_VIEWER_KEY)).toEqual(downloaded);

    for (let event = 2; event <= 3; event += 1) {
      await revalidatePrivateCatalog(database, 'viewer', [KILTER_SCOPE]);
      expect(await readSyncMeta()).toEqual(afterFirstEvent);
    }
  });

  it('clears first-ascent credits once and rewrites no stats row on a later event', async () => {
    await database.runAsync(`INSERT INTO board_climb_stats (board_type, climb_uuid, angle, fa_username, fa_at) VALUES
      ('kilter', 'named', 40, 'Copied identity', '2025-03-01T00:00:00Z'),
      ('kilter', 'dated', 40, NULL, '2025-03-01T00:00:00Z'),
      ('kilter', 'bare', 40, NULL, NULL)`);
    // Count the rows SQLite rewrites, whichever statement rewrites them.
    await database.execAsync(`CREATE TABLE stats_row_writes (climb_uuid TEXT);
      CREATE TRIGGER count_stats_row_writes AFTER UPDATE ON board_climb_stats
      BEGIN INSERT INTO stats_row_writes VALUES (NEW.climb_uuid); END;`);
    const rewrittenRows = () =>
      database.getAllAsync<{ climb_uuid: string }>('SELECT climb_uuid FROM stats_row_writes ORDER BY climb_uuid');

    await revalidatePrivateCatalog(database, 'viewer', []);
    expect(await rewrittenRows()).toEqual([{ climb_uuid: 'dated' }, { climb_uuid: 'named' }]);
    expect(await database.getAllAsync('SELECT fa_username, fa_at FROM board_climb_stats')).toEqual([
      { fa_username: null, fa_at: null },
      { fa_username: null, fa_at: null },
      { fa_username: null, fa_at: null },
    ]);

    await revalidatePrivateCatalog(database, 'viewer', []);
    expect(await rewrittenRows()).toHaveLength(2);
  });
});
