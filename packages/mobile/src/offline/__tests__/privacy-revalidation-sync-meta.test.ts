// What a privacy revalidation does to the device's sync state, and what it
// leaves exactly as it was (issue #6306).
//
// It runs on every launch, reconnect and token refresh, and whenever any climber
// changes something privacy-related. It used to delete every board cursor and
// every completion marker, and abort every transfer in flight, so each of those
// events made the phone crawl its boards again from nothing. Now it resets the
// protected half of the sync state and nothing else.
//
// The engine's own suites model a revalidation as `resetProtectedSyncState` plus
// the row deletes (`simulatePrivacyRevalidation` in the two-stream fixtures).
// The first describe pins that the REAL function changes `sync_meta` in exactly
// that way, so the model cannot drift from it unnoticed.

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
vi.mock('../../lib/graphql/client', () => ({ getHttpClient: () => ({ request }) }));

import {
  BOARD_DATA_TABLES,
  LEGACY_FIRST_ASCENT_SCRUB_KEY,
  USER_DATA_TABLES,
  capturePurgeToken,
  ensureHoldIndex,
  ensureMutationQueueTable,
  getCheckpointKey,
  hasProtectedWithdrawalLanded,
  hasPurgeLanded,
  isScopeDownloadComplete,
  isScopeProtectedComplete,
  resetProtectedSyncState,
  runMigrations,
  scopeSyncMetaKeys,
  setCheckpoint,
  setProtectedCheckpoint,
} from '@boardsesh/offline-sync';
import { createTestDatabase, markScopeDownloaded, type TestSqliteDb } from '@boardsesh/offline-sync/testing';
import { CATALOG_VIEWER_KEY, canReadPrivateCatalog } from '../catalog-access';
import {
  needsPrivacyRevalidation,
  requirePrivacyRevalidation,
  revalidatePrivateCatalog,
  waitForPrivacyRevalidation,
} from '../privacy-revalidation';

const VIEWER = 'viewer';
const REFERENCE_CURSOR = { updatedAt: '2026-06-01T00:00:00.000Z', syncSeq: '900' };
const PROTECTED_CURSOR = { updatedAt: '2026-05-01T00:00:00.000Z', syncSeq: '40', complete: true, revision: 1 };

let database: TestSqliteDb;

beforeEach(async () => {
  auth.token = 'accepted-token';
  auth.generation = 1;
  request.mockReset().mockImplementation(async () => ({ profile: { id: auth.viewer } }));
  database = createTestDatabase();
  await runMigrations(database);
  await ensureMutationQueueTable(database);
});

afterEach(() => database.close());

const syncMeta = async (db: TestSqliteDb = database): Promise<Map<string, string>> =>
  new Map(
    (await db.getAllAsync<{ key: string; value: string }>('SELECT key, value FROM sync_meta ORDER BY key')).map(
      (row) => [row.key, row.value],
    ),
  );

/**
 * Every kind of row the offline engine keeps in sync_meta, for two catalogue
 * boards and a spray wall, as a device that has been in use holds them.
 */
async function seedEverySyncMetaFamily(db: TestSqliteDb): Promise<void> {
  const scopes = ['kilter:1:10', 'tension:9:6', 'spray:7:7'];
  for (const scopeKey of scopes) {
    // Every per-scope key the engine knows of, so a new family is covered the
    // day `scopeSyncMetaKeys` learns about it.
    for (const key of scopeSyncMetaKeys(scopeKey)) {
      await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [key, '1']);
    }
    for (const tableName of BOARD_DATA_TABLES) {
      const key = getCheckpointKey(tableName, scopeKey);
      await db.runAsync('DELETE FROM sync_meta WHERE key = ?', [key]);
      const isWallTable = tableName === 'spray_walls';
      const isSpray = scopeKey.startsWith('spray');
      // A catalogue board has both cursors; a wall, and a wall's own row, only
      // the protected one.
      if (!isSpray && !isWallTable) await setCheckpoint(db, key, REFERENCE_CURSOR);
      if (isSpray || !isWallTable) await setProtectedCheckpoint(db, key, PROTECTED_CURSOR);
    }
    await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
      `bootstrap-done:${scopeKey}`,
      '2',
    ]);
  }
  for (const tableName of USER_DATA_TABLES) {
    await setCheckpoint(db, getCheckpointKey(tableName), REFERENCE_CURSOR);
  }
  const global: Record<string, string> = {
    'checkpoint:deletions': JSON.stringify(REFERENCE_CURSOR),
    'checkpoint:user_data_complete': '1',
    'deletions-coverage': '1791685452000',
    'local-user-id': VIEWER,
    'holds-index-generation:kilter:1': '3',
    'spray-photo-pending:7': JSON.stringify({ photoKey: 'wall.jpg', attempts: 1 }),
    'dead-letter-recovery-notice': '0',
    // Something this suite has never heard of must be left alone too.
    'some-future-key': 'untouched',
  };
  for (const [key, value] of Object.entries(global)) {
    await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [key, value]);
  }
}

describe('what a privacy revalidation changes in sync_meta', () => {
  it('changes exactly what the engine’s protected reset changes, plus its own two keys', async () => {
    await seedEverySyncMetaFamily(database);
    const before = await syncMeta();
    // The model: the same seed, with only the engine's reset applied.
    const model = createTestDatabase();
    await runMigrations(model);
    await ensureMutationQueueTable(model);
    await seedEverySyncMetaFamily(model);
    await resetProtectedSyncState(model);
    const modelled = await syncMeta(model);
    model.close();

    await revalidatePrivateCatalog(database, VIEWER);

    const after = await syncMeta();
    const ownKeys = [CATALOG_VIEWER_KEY, LEGACY_FIRST_ASCENT_SCRUB_KEY];
    for (const key of ownKeys) {
      expect(after.has(key)).toBe(true);
      after.delete(key);
      modelled.delete(key);
    }
    expect([...after]).toEqual([...modelled]);
    // And the reset is not a no-op here: it really did take something.
    expect([...after]).not.toEqual([...before]);
  });

  it('deletes only rows that carried nothing but a protected cursor', async () => {
    await seedEverySyncMetaFamily(database);
    const before = await syncMeta();

    await revalidatePrivateCatalog(database, VIEWER);

    const after = await syncMeta();
    const deleted = [...before.keys()].filter((key) => !after.has(key)).sort();
    // A wall has no reference stream, so its checkpoint rows held only that.
    expect(deleted).toEqual(BOARD_DATA_TABLES.map((tableName) => getCheckpointKey(tableName, 'spray:7:7')).sort());
  });

  it('keeps every reference cursor byte for byte, with no protected cursor left beside it', async () => {
    await seedEverySyncMetaFamily(database);

    await revalidatePrivateCatalog(database, VIEWER);

    const after = await syncMeta();
    for (const scopeKey of ['kilter:1:10', 'tension:9:6']) {
      for (const tableName of ['board_climbs', 'board_climb_stats', 'board_climb_grades']) {
        expect(after.get(getCheckpointKey(tableName, scopeKey))).toBe(JSON.stringify(REFERENCE_CURSOR));
      }
      expect(await isScopeProtectedComplete(database, scopeKey)).toBe(false);
    }
  });

  it('keeps every other key and value: completion, bootstrap, refresh, holds index, user tables, deletions', async () => {
    await seedEverySyncMetaFamily(database);
    const before = await syncMeta();
    const boardCheckpointKeys = new Set(
      ['kilter:1:10', 'tension:9:6', 'spray:7:7'].flatMap((scopeKey) =>
        BOARD_DATA_TABLES.map((tableName) => getCheckpointKey(tableName, scopeKey)),
      ),
    );

    await revalidatePrivateCatalog(database, VIEWER);

    const after = await syncMeta();
    const untouched = [...before].filter(([key]) => !boardCheckpointKeys.has(key));
    // More than a hundred keys across the three scopes: every marker family.
    expect(untouched.length).toBeGreaterThan(30);
    for (const [key, value] of untouched) expect([key, after.get(key)]).toEqual([key, value]);
    for (const scopeKey of ['kilter:1:10', 'tension:9:6', 'spray:7:7']) {
      expect(await isScopeDownloadComplete(database, scopeKey)).toBe(true);
    }
  });

  it('writes the same thing on every later event', async () => {
    await seedEverySyncMetaFamily(database);
    await revalidatePrivateCatalog(database, VIEWER);
    const afterFirst = await syncMeta();

    await revalidatePrivateCatalog(database, VIEWER);
    await revalidatePrivateCatalog(database, VIEWER);

    expect([...(await syncMeta())]).toEqual([...afterFirst]);
  });
});

describe('what a privacy event stops, and what it does not', () => {
  it('raises the protected fence and no purge', () => {
    const token = capturePurgeToken();

    requirePrivacyRevalidation();

    // The one thing fenced: a protected page or a saved-climb mirror in flight.
    expect(hasProtectedWithdrawalLanded(token)).toBe(true);
    // Not a global purge and not a scope purge. Those are what artifact
    // transfers, imports, reference pages, the user tables, the deletions stream
    // and the outbox watch, and a privacy event must stop none of them.
    expect(hasPurgeLanded(token)).toBe(false);
    for (const namespace of ['kilter:1', 'tension:9', 'spray:7']) expect(hasPurgeLanded(token, namespace)).toBe(false);
  });

  it('leaves no scope purge behind once it has finished', async () => {
    const token = capturePurgeToken();

    await revalidatePrivateCatalog(database, VIEWER);

    expect(hasPurgeLanded(token)).toBe(false);
    expect(hasPurgeLanded(token, 'kilter:1')).toBe(false);
  });
});

describe('first-ascent names an earlier bundle stored', () => {
  const stats = () =>
    database.getAllAsync<{ climb_uuid: string; fa_username: string | null; fa_at: string | null }>(
      'SELECT climb_uuid, fa_username, fa_at FROM board_climb_stats ORDER BY climb_uuid',
    );
  const seedStats = (climbUuid: string, faUsername: string) =>
    database.runAsync(
      "INSERT OR REPLACE INTO board_climb_stats (board_type, climb_uuid, angle, fa_username, fa_at) VALUES ('kilter', ?, 40, ?, '2020-01-01T00:00:00Z')",
      [climbUuid, faUsername],
    );

  it('are blanked once, across the whole table', async () => {
    await seedStats('catalogue', 'Somebody');
    await seedStats('authored', 'A Private Climber');

    await revalidatePrivateCatalog(database, VIEWER);

    expect(await stats()).toEqual([
      { climb_uuid: 'authored', fa_username: null, fa_at: null },
      { climb_uuid: 'catalogue', fa_username: null, fa_at: null },
    ]);
  });

  it('are not blanked again: a manufacturer credit that arrives later survives every event after it', async () => {
    await revalidatePrivateCatalog(database, VIEWER);
    // The reference stream delivers a public credit. Nothing resets that
    // stream's cursor any more, so blanking it would lose it for good.
    await seedStats('catalogue', 'Manufacturer Setter');

    for (let event = 0; event < 3; event += 1) await revalidatePrivateCatalog(database, VIEWER);

    expect(await stats()).toEqual([
      { climb_uuid: 'catalogue', fa_username: 'Manufacturer Setter', fa_at: '2020-01-01T00:00:00Z' },
    ]);
  });

  it('cost no whole-table write after the first event', async () => {
    await revalidatePrivateCatalog(database, VIEWER);
    const exclusive = database.withExclusiveTransactionAsync.bind(database);
    const statements: string[] = [];
    vi.spyOn(database, 'withExclusiveTransactionAsync').mockImplementation((task) =>
      exclusive(async (transaction) => {
        const run = transaction.runAsync.bind(transaction);
        transaction.runAsync = ((sql: string, ...params: unknown[]) => {
          statements.push(sql);
          return run(sql, ...(params as []));
        }) as typeof transaction.runAsync;
        await task(transaction);
      }),
    );

    await revalidatePrivateCatalog(database, VIEWER);

    expect(statements.length).toBeGreaterThan(0);
    expect(statements.filter((sql) => /UPDATE\s+board_climb_stats/i.test(sql))).toEqual([]);
    // Nor a sweep of the holds index or the stats and grades by anything but key.
    expect(statements.filter((sql) => /NOT IN \(SELECT uuid FROM board_climbs\)/i.test(sql))).toEqual([]);
  });

  it('are blanked again after an older bundle ran, which deletes the note that it was done', async () => {
    await revalidatePrivateCatalog(database, VIEWER);
    // The older bundle's revalidation: every stats checkpoint goes, and its one
    // stream then stores names filled in for whoever was asking.
    await database.runAsync('DELETE FROM sync_meta WHERE key LIKE ?', ['checkpoint:board_climb_stats:%']);
    await seedStats('authored', 'A Private Climber');

    await revalidatePrivateCatalog(database, VIEWER);

    expect(await stats()).toEqual([{ climb_uuid: 'authored', fa_username: null, fa_at: null }]);
  });
});

describe('the holds index', () => {
  const SCOPE = { boardType: 'kilter', layoutId: 1, sizeId: 12 };
  const OTHER_LAYOUT = { boardType: 'kilter', layoutId: 2, sizeId: 12 };
  const parseHoldRows = (_boardType: string, frames: string) =>
    [...frames.matchAll(/p(\d+)r\d+/g)].map((match) => ({ holdId: Number(match[1]), holdState: 'HAND' }));
  const indexOptions = { parseHoldRows, yieldToHost: async () => {} };

  async function seedClimb(uuid: string, userId: string | null, layoutId: number, isDraft = 0): Promise<void> {
    await database.runAsync(
      `INSERT INTO board_climbs
         (uuid, board_type, layout_id, user_id, compatible_size_ids, frames, is_listed, is_draft, updated_at, sync_seq)
       VALUES (?, 'kilter', ?, ?, '[12]', 'p1r13p2r13', 1, ?, '2026-01-01T00:00:00Z', 5)`,
      [uuid, layoutId, userId, isDraft],
    );
  }
  const indexedUuids = async () =>
    (
      await database.getAllAsync<{ uuid: string }>(
        'SELECT hic.uuid FROM holds_index_climbs hic JOIN board_climb_hold_sets hs ON hs.climb_id = hic.id ORDER BY hic.uuid',
      )
    ).map((row) => row.uuid);
  const mappedUuids = async () =>
    (await database.getAllAsync<{ uuid: string }>('SELECT uuid FROM holds_index_climbs ORDER BY uuid')).map(
      (row) => row.uuid,
    );
  const postingLayouts = async () =>
    (
      await database.getAllAsync<{ layout_id: number }>(
        'SELECT DISTINCT layout_id FROM board_climb_hold_postings ORDER BY layout_id',
      )
    ).map((row) => row.layout_id);
  const watermarkKeys = async () =>
    (
      await database.getAllAsync<{ key: string }>(
        "SELECT key FROM sync_meta WHERE key LIKE 'holds-index:%' ORDER BY key",
      )
    ).map((row) => row.key);

  /** Two downloaded layouts with a built index; layout 1 also holds `layoutOneExtra`. */
  async function seedIndexedBoards(layoutOneExtra: () => Promise<void>): Promise<void> {
    await seedClimb('catalogue-1', null, 1);
    await layoutOneExtra();
    await seedClimb('catalogue-2', null, 2);
    for (const scope of [SCOPE, OTHER_LAYOUT]) {
      await markScopeDownloaded(database, `kilter:${scope.layoutId}:12`);
      await ensureHoldIndex(database, scope, indexOptions);
    }
  }
  const withAnotherClimbersClimb = () => seedIndexedBoards(() => seedClimb('friend-1', 'friend', 1));

  it('loses every trace of a withdrawn climb: its hold set, its uuid, and the postings that named it', async () => {
    await withAnotherClimbersClimb();
    expect(await indexedUuids()).toEqual(['catalogue-1', 'catalogue-2', 'friend-1']);

    await revalidatePrivateCatalog(database, VIEWER);

    expect(await indexedUuids()).toEqual(['catalogue-1', 'catalogue-2']);
    expect(await mappedUuids()).toEqual(['catalogue-1', 'catalogue-2']);
    // Layout 1's postings went with it, and its watermark, so it is rebuilt.
    expect(await postingLayouts()).toEqual([2]);
    expect(await watermarkKeys()).toEqual(['holds-index:kilter:2:12']);
  });

  it('keeps the index of a layout that lost nothing', async () => {
    await withAnotherClimbersClimb();
    const before = await database.getAllAsync(
      'SELECT hold_id, hex(climb_ids) AS ids FROM board_climb_hold_postings WHERE layout_id = 2 ORDER BY hold_id',
    );

    await revalidatePrivateCatalog(database, VIEWER);

    expect(
      await database.getAllAsync(
        'SELECT hold_id, hex(climb_ids) AS ids FROM board_climb_hold_postings WHERE layout_id = 2 ORDER BY hold_id',
      ),
    ).toEqual(before);
  });

  it('keeps the index of a layout that lost only drafts, which were never in it', async () => {
    await seedIndexedBoards(() => seedClimb('ownerless-draft', null, 1, 1));
    expect(await indexedUuids()).toEqual(['catalogue-1', 'catalogue-2']);

    await revalidatePrivateCatalog(database, VIEWER);

    // The draft went, and nothing the index held went with it.
    expect(await database.getAllAsync('SELECT uuid FROM board_climbs WHERE layout_id = 1')).toEqual([
      { uuid: 'catalogue-1' },
    ]);
    expect(await postingLayouts()).toEqual([1, 2]);
    expect(await watermarkKeys()).toEqual(['holds-index:kilter:1:12', 'holds-index:kilter:2:12']);
  });

  it('is not rebuilt until the protected rows are back', async () => {
    await withAnotherClimbersClimb();

    await revalidatePrivateCatalog(database, VIEWER);

    // The board is still downloaded, its protected streams are mid-replay.
    expect((await ensureHoldIndex(database, SCOPE, indexOptions)).status).toBe('not-downloaded');
    expect(await watermarkKeys()).toEqual(['holds-index:kilter:2:12']);
  });
});

describe('everything else it removes', () => {
  it('deletes every wall row, and the snapshots of followed authors', async () => {
    await database.runAsync(
      "INSERT INTO spray_walls (layout_id, board_uuid, name, reference_width, reference_height) VALUES (7, 'wall', 'Garage', 1, 1)",
    );
    await database.runAsync("INSERT INTO followed_author_snapshots (user_id, snapshot) VALUES ('viewer', '[]')");

    await revalidatePrivateCatalog(database, VIEWER);

    expect(await database.getAllAsync('SELECT layout_id FROM spray_walls')).toEqual([]);
    expect(await database.getAllAsync('SELECT user_id FROM followed_author_snapshots')).toEqual([]);
  });

  it('deletes hundreds of withdrawn climbs across boards, each with its own stats and grades', async () => {
    // More than one statement's worth of uuids, on two board types.
    const withdrawnCount = 2000;
    await database.execAsync('BEGIN');
    for (let index = 0; index < withdrawnCount; index += 1) {
      const boardType = index % 2 === 0 ? 'kilter' : 'tension';
      await database.runAsync(
        "INSERT INTO board_climbs (uuid, board_type, layout_id, user_id, sync_seq) VALUES (?, ?, 1, 'other', ?)",
        [`withdrawn-${index}`, boardType, index + 1],
      );
      await database.runAsync('INSERT INTO board_climb_stats (board_type, climb_uuid, angle) VALUES (?, ?, 40)', [
        boardType,
        `withdrawn-${index}`,
      ]);
      await database.runAsync('INSERT INTO board_climb_grades (board_type, climb_uuid, angle) VALUES (?, ?, 40)', [
        boardType,
        `withdrawn-${index}`,
      ]);
    }
    await database.runAsync(
      "INSERT INTO board_climbs (uuid, board_type, layout_id, user_id, sync_seq) VALUES ('mine', 'kilter', 1, 'viewer', 1)",
    );
    await database.runAsync(
      "INSERT INTO board_climb_stats (board_type, climb_uuid, angle) VALUES ('kilter', 'mine', 40)",
    );
    await database.runAsync(
      "INSERT INTO board_climb_grades (board_type, climb_uuid, angle) VALUES ('kilter', 'mine', 40)",
    );
    await database.execAsync('COMMIT');

    await revalidatePrivateCatalog(database, VIEWER);

    expect(await database.getAllAsync('SELECT uuid FROM board_climbs')).toEqual([{ uuid: 'mine' }]);
    expect(await database.getAllAsync('SELECT climb_uuid FROM board_climb_stats')).toEqual([{ climb_uuid: 'mine' }]);
    expect(await database.getAllAsync('SELECT climb_uuid FROM board_climb_grades')).toEqual([{ climb_uuid: 'mine' }]);
  });
});

// The two halves of a withdrawal are one transaction: the copies go, and the
// cursor that covered them goes with them. A cursor that outlived its rows
// would skip them for good. Rows that outlived a reset would be on the device
// with nothing left to say the server had been asked about them.
describe('one transaction for the rows and the cursors that covered them', () => {
  const SCOPE_KEY = 'kilter:1:10';
  const foreignClimbs = () =>
    database.getAllAsync<{ uuid: string }>("SELECT uuid FROM board_climbs WHERE user_id = 'other'");

  beforeEach(async () => {
    await database.runAsync(
      "INSERT INTO board_climbs (uuid, board_type, layout_id, user_id, sync_seq) VALUES ('theirs', 'kilter', 1, 'other', 7)",
    );
    await database.runAsync(
      "INSERT INTO board_climb_stats (board_type, climb_uuid, angle) VALUES ('kilter', 'theirs', 40)",
    );
    await markScopeDownloaded(database, SCOPE_KEY);
  });

  it('issues the row deletes and the cursor reset inside the same exclusive transaction', async () => {
    const statementsByTransaction: string[][] = [];
    const exclusive = database.withExclusiveTransactionAsync.bind(database);
    vi.spyOn(database, 'withExclusiveTransactionAsync').mockImplementation((task) =>
      exclusive(async (transaction) => {
        const statements: string[] = [];
        statementsByTransaction.push(statements);
        const run = transaction.runAsync.bind(transaction);
        const recorder = vi.spyOn(transaction, 'runAsync').mockImplementation((source, ...params) => {
          statements.push(source);
          return run(source, ...params);
        });
        try {
          await task(transaction);
        } finally {
          recorder.mockRestore();
        }
      }),
    );

    await revalidatePrivateCatalog(database, VIEWER);

    const withRowDeletes = statementsByTransaction.filter((statements) =>
      statements.some((source) => source.startsWith('DELETE FROM board_climbs')),
    );
    expect(withRowDeletes).toHaveLength(1);
    const [purge] = withRowDeletes;
    expect(purge.some((source) => source.startsWith('DELETE FROM board_climb_stats'))).toBe(true);
    expect(purge.some((source) => source.includes("json_remove(value, '$.protected')"))).toBe(true);
    // No other transaction touched a protected cursor.
    const resets = statementsByTransaction.filter((statements) =>
      statements.some((source) => source.includes("json_remove(value, '$.protected')")),
    );
    expect(resets).toEqual([purge]);
  });

  it('rolls both back together when the revalidation fails after them, and stays closed', async () => {
    const exclusive = database.withExclusiveTransactionAsync.bind(database);
    vi.spyOn(database, 'withExclusiveTransactionAsync').mockImplementationOnce((task) =>
      exclusive(async (transaction) => {
        // The credential changes while the purge runs. The check that follows
        // the purge refuses to commit under it.
        auth.token = 'rotated-during-purge';
        await task(transaction);
      }),
    );

    await expect(revalidatePrivateCatalog(database, VIEWER)).rejects.toThrow('Account changed');

    // Neither half landed without the other: the row is still here, and so is
    // the cursor that covers it.
    expect(await foreignClimbs()).toEqual([{ uuid: 'theirs' }]);
    expect(await isScopeProtectedComplete(database, SCOPE_KEY)).toBe(true);
    // And nothing reads that row. The catalogue stays closed and protected
    // pulls stay held back until a revalidation succeeds.
    expect(needsPrivacyRevalidation()).toBe(true);
    expect(await canReadPrivateCatalog(database)).toBe(false);
    await expect(waitForPrivacyRevalidation()).rejects.toThrow('Privacy revalidation is required');
  });
});
