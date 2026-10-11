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
  isScopeProtectedComplete,
  capturePurgeToken,
  hasPurgeLanded,
  hasProtectedWithdrawalLanded,
  holdIndexKey,
  BOARD_DATA_TABLES,
  CATALOGUE_PREPARED_FOR_KEY,
} from '@boardsesh/offline-sync';
import { createTestDatabase, markScopeDownloaded, type TestSqliteDb } from '@boardsesh/offline-sync/testing';
import {
  needsPrivacyRevalidation,
  revalidatePrivateCatalog,
  needsCatalogOutboxRepair,
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
    // The device stores no first-ascent name: what an earlier bundle stored
    // goes, once.
    expect(
      await database.getAllAsync('SELECT climb_uuid, fa_username FROM board_climb_stats ORDER BY climb_uuid'),
    ).toEqual([
      { climb_uuid: 'manufacturer', fa_username: null },
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

  it('opens the catalogue after the last queued reference to a foreign draft is delivered', async () => {
    database = createTestDatabase();
    await runMigrations(database);
    await database.runAsync(
      "INSERT INTO board_climbs (uuid, board_type, user_id, is_draft, sync_seq) VALUES ('queued-draft', 'kilter', 'other', 1, 42)",
    );
    await database.runAsync(
      "INSERT INTO pending_mutations (table_name, operation, payload, idempotency_key) VALUES ('boardsesh_ticks', 'insert', ?, 'queued-draft-reference')",
      [JSON.stringify({ climbUuid: 'queued-draft' })],
    );
    await revalidatePrivateCatalog(database, 'viewer');
    expect(needsCatalogOutboxRepair('viewer')).toBe(true);
    expect(needsCatalogOutboxRepair('another-viewer')).toBe(false);
    expect(await canReadPrivateCatalog(database)).toBe(false);
    await database.runAsync("DELETE FROM pending_mutations WHERE idempotency_key = 'queued-draft-reference'");
    await revalidatePrivateCatalog(database, 'viewer');
    expect(await database.getAllAsync('SELECT uuid FROM board_climbs')).toEqual([]);
    expect(await canReadPrivateCatalog(database)).toBe(true);
    expect(needsCatalogOutboxRepair('viewer')).toBe(false);
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

  it("opens access over another account's published climbs, even one a queued tick references", async () => {
    database = createTestDatabase();
    await runMigrations(database);
    await database.runAsync(`INSERT INTO board_climbs (uuid, board_type, layout_id, user_id, is_draft, is_listed, sync_seq) VALUES
      ('published', 'kilter', 1, 'other', 0, 1, 5),
      ('queued-published', 'kilter', 1, 'other', 0, 1, 6)`);
    await database.runAsync(
      "INSERT INTO pending_mutations (table_name, operation, payload, idempotency_key) VALUES ('boardsesh_ticks', 'insert', ?, 'queued-tick')",
      [JSON.stringify({ climbUuid: 'queued-published' })],
    );
    await revalidatePrivateCatalog(database, 'viewer');
    expect(await database.getAllAsync('SELECT uuid FROM board_climbs ORDER BY uuid')).toEqual([
      { uuid: 'published' },
      { uuid: 'queued-published' },
    ]);
    expect(await canReadPrivateCatalog(database)).toBe(true);
  });

  it("keeps access closed for another account's draft with no server sequence beside published climbs", async () => {
    database = createTestDatabase();
    await runMigrations(database);
    await database.runAsync(`INSERT INTO board_climbs (uuid, board_type, layout_id, user_id, is_draft, is_listed, sync_seq) VALUES
      ('published', 'kilter', 1, 'other', 0, 1, 5),
      ('unsynced-draft', 'kilter', 1, 'other', 1, 0, NULL)`);
    await revalidatePrivateCatalog(database, 'viewer');
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
/** The two rows a revalidation writes for itself: who may read, and who the catalogue was prepared for. */
const REVALIDATION_KEYS = [CATALOG_VIEWER_KEY, CATALOGUE_PREPARED_FOR_KEY];

/**
 * A scope whose download finished: the completion marker, every protected
 * stream at its tail, and a reference cursor per board table on a board that
 * has a reference stream.
 */
async function seedDownloadedScope(scopeKey: string): Promise<void> {
  await markScopeDownloaded(database, scopeKey);
  if (scopeKey.startsWith('spray:')) return;
  for (const table of BOARD_DATA_TABLES) {
    if (table === 'spray_walls') continue;
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

const indexedClimbUuids = () =>
  database.getAllAsync(
    `SELECT local_id.uuid FROM board_climb_hold_sets hold_set
     JOIN holds_index_climbs local_id ON local_id.id = hold_set.climb_id ORDER BY local_id.uuid`,
  );

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
    syncMeta: (
      await database.getAllAsync<{ key: string; value: string }>('SELECT key, value FROM sync_meta ORDER BY key')
    ).filter((row) => !REVALIDATION_KEYS.includes(row.key)),
    holdIndexIds: await database.getAllAsync('SELECT id, uuid FROM holds_index_climbs ORDER BY id'),
    holdSets: await database.getAllAsync(
      'SELECT climb_id, hex(holds) AS holds FROM board_climb_hold_sets ORDER BY climb_id',
    ),
    postings: await database.getAllAsync(
      'SELECT board_type, layout_id, hold_id, hex(climb_ids) AS climb_ids FROM board_climb_hold_postings ORDER BY board_type, layout_id, hold_id',
    ),
  };
}

// The device state around an event, on a phone with boards downloaded. Each
// case names what it starts from: a device already prepared for this account
// (every event but the first after a sign-in) or one that is not.
describe('a privacy event on a device with downloaded boards', () => {
  beforeEach(async () => {
    database = createTestDatabase();
    await runMigrations(database);
  });
  /** The first revalidation for an account also prepares the catalogue for it; later ones do not. */
  const prepareForViewer = () => revalidatePrivateCatalog(database, 'viewer');

  it('leaves a catalogue board, its cursors, completion marker and holds index exactly as they were', async () => {
    await prepareForViewer();
    await database.runAsync(`INSERT INTO board_climbs (uuid, board_type, layout_id, user_id, is_draft, is_listed, sync_seq) VALUES
      ('community-climb', 'kilter', 1, 'other', 0, 1, 5),
      ('manufacturer-climb', 'kilter', 1, NULL, 0, 1, 6),
      ('own-climb', 'kilter', 1, 'viewer', 0, 1, 7),
      ('own-draft', 'kilter', 1, 'viewer', 1, 0, 8)`);
    await database.runAsync(`INSERT INTO board_climb_stats (board_type, climb_uuid, angle, ascensionist_count, fa_username)
      VALUES ('kilter', 'community-climb', 40, 12, NULL), ('kilter', 'manufacturer-climb', 40, 3, 'Setter')`);
    await database.runAsync(`INSERT INTO board_climb_grades (board_type, climb_uuid, angle, local_grade)
      VALUES ('kilter', 'community-climb', 40, 21.4)`);
    await seedDownloadedScope(KILTER_SCOPE);
    await seedHoldIndex('kilter', 1, KILTER_SCOPE, ['community-climb', 'manufacturer-climb']);
    const downloaded = await readDownloadedCopy('kilter');

    await revalidatePrivateCatalog(database, 'viewer');

    expect(await readDownloadedCopy('kilter')).toEqual(downloaded);
    expect(await isScopeProtectedComplete(database, KILTER_SCOPE)).toBe(true);
    expect(await canReadPrivateCatalog(database)).toBe(true);
  });

  it('does not abort a catalogue sync in flight, and holds wall pulls off for the whole repair', async () => {
    await prepareForViewer();
    const beforeEvent = capturePurgeToken();
    let duringRepair: { kilterPurged: boolean; sprayPurged: boolean; wallPullsHeldOff: boolean } | undefined;
    request.mockImplementationOnce(async () => {
      // A cycle that starts mid-repair: no purge stops it on any board, and the
      // revalidation gate (the adapter's `isProtectedSyncAllowed`) is what keeps
      // it from asking for a wall.
      const startedMidRepair = capturePurgeToken();
      duringRepair = {
        kilterPurged: hasPurgeLanded(startedMidRepair, 'kilter:1'),
        sprayPurged: hasPurgeLanded(startedMidRepair, 'spray:7'),
        wallPullsHeldOff: needsPrivacyRevalidation(),
      };
      return { profile: { id: 'viewer' } };
    });

    await revalidatePrivateCatalog(database, 'viewer');

    expect(duringRepair).toEqual({ kilterPurged: false, sprayPurged: false, wallPullsHeldOff: true });
    // No global purge and no scope purge: the drain, the user tables and every
    // catalogue board carry on.
    expect(hasPurgeLanded(beforeEvent)).toBe(false);
    expect(hasPurgeLanded(beforeEvent, 'kilter:1')).toBe(false);
    // A wall page fetched before the event is refused by the protected fence.
    expect(hasProtectedWithdrawalLanded(beforeEvent)).toBe(true);
    // The gate opens with the repair, so the wall can download again.
    expect(needsPrivacyRevalidation()).toBe(false);
    expect(hasProtectedWithdrawalLanded(capturePurgeToken())).toBe(false);
  });

  it('still withdraws spray walls with their climbs, cursors and holds index', async () => {
    await prepareForViewer();
    await database.runAsync("INSERT INTO spray_walls (layout_id, board_uuid, name) VALUES (7, 'wall-uuid', 'Garage')");
    await database.runAsync(`INSERT INTO board_climbs (uuid, board_type, layout_id, user_id, is_draft, is_listed, sync_seq) VALUES
      ('spray-other', 'spray', 7, 'other', 0, 1, 5),
      ('spray-unowned', 'spray', 7, NULL, 0, 1, 6),
      ('spray-own', 'spray', 7, 'viewer', 0, 1, 7)`);
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

    await revalidatePrivateCatalog(database, 'viewer');

    expect(await database.getAllAsync('SELECT layout_id FROM spray_walls')).toEqual([]);
    expect(await database.getAllAsync('SELECT uuid FROM board_climbs')).toEqual([{ uuid: 'spray-own' }]);
    expect(await database.getAllAsync('SELECT climb_uuid FROM board_climb_stats')).toEqual([
      { climb_uuid: 'spray-own' },
    ]);
    expect(await database.getAllAsync('SELECT climb_uuid FROM board_climb_grades')).toEqual([
      { climb_uuid: 'spray-own' },
    ]);
    // The wall's cursors are forgotten, so the next pull asks for every row
    // again. Its `scope-complete:` marker stays; until that pull reaches the
    // tail the wall is not read from the device (`isScopeProtectedComplete`).
    for (const table of BOARD_DATA_TABLES) {
      expect(
        await database.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', [
          getCheckpointKey(table, SPRAY_SCOPE),
        ]),
      ).toBeNull();
    }
    expect(await isScopeProtectedComplete(database, SPRAY_SCOPE)).toBe(false);
    // The layout lost an indexed climb, so its postings and watermark go and it
    // rebuilds; the climber's own climb keeps its hold set.
    expect(
      await database.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', [holdIndexKey(SPRAY_SCOPE)]),
    ).toBeNull();
    expect(await database.getAllAsync('SELECT hold_id FROM board_climb_hold_postings')).toEqual([]);
    expect(await indexedClimbUuids()).toEqual([{ uuid: 'spray-own' }]);
    expect(await database.getAllAsync('SELECT uuid FROM holds_index_climbs')).toEqual([{ uuid: 'spray-own' }]);
    expect(await database.getAllAsync('SELECT user_id FROM followed_author_snapshots')).toEqual([]);
    expect(await canReadPrivateCatalog(database)).toBe(true);
  });

  it('withdraws a spray wall without touching the catalogue board beside it', async () => {
    await prepareForViewer();
    await database.runAsync(`INSERT INTO board_climbs (uuid, board_type, layout_id, user_id, is_draft, is_listed, sync_seq) VALUES
      ('community-climb', 'kilter', 1, 'other', 0, 1, 5),
      ('spray-other', 'spray', 7, 'other', 0, 1, 6)`);
    await seedDownloadedScope(KILTER_SCOPE);
    await seedDownloadedScope(SPRAY_SCOPE);
    await seedHoldIndex('kilter', 1, KILTER_SCOPE, ['community-climb']);
    // The wall's own sync_meta rows are meant to change; compare the board's.
    const readKilterCopy = async () => {
      const copy = await readDownloadedCopy('kilter');
      return { ...copy, syncMeta: copy.syncMeta.filter((row) => row.key.includes('kilter:')) };
    };
    const downloadedKilter = await readKilterCopy();

    await revalidatePrivateCatalog(database, 'viewer');

    expect(await readKilterCopy()).toEqual(downloadedKilter);
    expect(await database.getAllAsync("SELECT uuid FROM board_climbs WHERE board_type = 'spray'")).toEqual([]);
    expect(await isScopeProtectedComplete(database, SPRAY_SCOPE)).toBe(false);
    expect(await isScopeProtectedComplete(database, KILTER_SCOPE)).toBe(true);
    expect(await isScopeDownloadComplete(database, KILTER_SCOPE)).toBe(true);
  });

  it("rebuilds the holds index of a catalogue layout only when it loses another account's draft", async () => {
    // Not prepared yet: removing other accounts' drafts is the preparation's job.
    await database.runAsync(`INSERT INTO board_climbs (uuid, board_type, layout_id, user_id, is_draft, is_listed, sync_seq) VALUES
      ('downloaded-foreign-draft', 'kilter', 1, 'other', 1, 0, 10),
      ('kilter-climb', 'kilter', 1, NULL, 0, 1, 11),
      ('tension-climb', 'tension', 9, 'other', 0, 1, 12)`);
    await seedHoldIndex('kilter', 1, KILTER_SCOPE, ['downloaded-foreign-draft', 'kilter-climb']);
    await seedHoldIndex('tension', 9, 'tension:9:1', ['tension-climb']);

    await revalidatePrivateCatalog(database, 'viewer');

    expect(await database.getAllAsync('SELECT uuid FROM board_climbs ORDER BY uuid')).toEqual([
      { uuid: 'kilter-climb' },
      { uuid: 'tension-climb' },
    ]);
    // Kilter layout 1 lost an indexed row, so its postings and watermark start
    // over; the rebuild rewrites only hold sets that changed, so the climb that
    // stayed keeps its own. Tension lost nothing.
    expect(await database.getAllAsync('SELECT board_type FROM board_climb_hold_postings')).toEqual([
      { board_type: 'tension' },
    ]);
    expect(await indexedClimbUuids()).toEqual([{ uuid: 'kilter-climb' }, { uuid: 'tension-climb' }]);
    expect(
      await database.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', [holdIndexKey(KILTER_SCOPE)]),
    ).toBeNull();
    expect(
      await database.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', [holdIndexKey('tension:9:1')]),
    ).toEqual({ value: '10' });
  });

  it('leaves sync_meta byte for byte across three events in a row', async () => {
    await database.runAsync(`INSERT INTO board_climbs (uuid, board_type, layout_id, user_id, is_draft, is_listed, sync_seq)
      VALUES ('community-climb', 'kilter', 1, 'other', 0, 1, 5)`);
    await markScopeDownloadComplete(database, KILTER_SCOPE);
    for (const table of BOARD_DATA_TABLES) {
      if (table !== 'spray_walls')
        await setCheckpoint(database, getCheckpointKey(table, KILTER_SCOPE), DOWNLOADED_CURSOR);
    }
    await seedHoldIndex('kilter', 1, KILTER_SCOPE, ['community-climb']);
    const readSyncMeta = () =>
      database.getAllAsync<{ key: string; value: string }>('SELECT key, value FROM sync_meta ORDER BY key');
    const downloaded = await readSyncMeta();

    await revalidatePrivateCatalog(database, 'viewer');
    const afterFirstEvent = await readSyncMeta();
    // The first event for an account adds its own two rows and nothing else: a
    // board with no protected cursor yet has none to forget.
    expect(afterFirstEvent.filter((row) => !REVALIDATION_KEYS.includes(row.key))).toEqual(downloaded);

    for (let event = 2; event <= 3; event += 1) {
      await revalidatePrivateCatalog(database, 'viewer');
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

    await revalidatePrivateCatalog(database, 'viewer');
    expect(await rewrittenRows()).toEqual([{ climb_uuid: 'dated' }, { climb_uuid: 'named' }]);
    expect(await database.getAllAsync('SELECT fa_username, fa_at FROM board_climb_stats')).toEqual([
      { fa_username: null, fa_at: null },
      { fa_username: null, fa_at: null },
      { fa_username: null, fa_at: null },
    ]);

    await revalidatePrivateCatalog(database, 'viewer');
    expect(await rewrittenRows()).toHaveLength(2);
  });
});
