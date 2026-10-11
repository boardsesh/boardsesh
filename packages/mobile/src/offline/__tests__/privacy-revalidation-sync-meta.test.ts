// What a privacy revalidation does to the device, and what it leaves exactly as
// it was (issue #6306).
//
// It runs on every launch, reconnect and token refresh, and whenever any climber
// changes something privacy-related. It used to delete every board cursor and
// every completion marker, and abort every transfer in flight, so each of those
// events made the phone crawl its boards again from nothing.
//
// A published climb is public whoever set it, so an event now touches a
// catalogue board not at all. It withdraws spray walls, whose visibility does
// depend on privacy, and resets their protected cursors. What used to ride on
// every event and is really about the ACCOUNT (other people's drafts and
// unlisted climbs, the previous account's cursors, stored first-ascent names)
// runs once per account instead.
//
// The engine's own suites model an event as `simulatePrivacyRevalidation` in the
// two-stream fixtures. The first describe pins that the REAL function changes
// `sync_meta` in exactly that way, so the model cannot drift from it unnoticed.

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
  CATALOGUE_PREPARED_FOR_KEY,
  USER_DATA_TABLES,
  capturePurgeToken,
  ensureHoldIndex,
  ensureMutationQueueTable,
  getCheckpointKey,
  hasProtectedWithdrawalLanded,
  hasPurgeLanded,
  isScopeDownloadComplete,
  isScopeProtectedComplete,
  resetPrivacyScopedProtectedSyncState,
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
  auth.viewer = VIEWER;
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

const PREPARED_FOR_VIEWER = `2:0:${VIEWER}`;

async function insertClimb(
  uuid: string,
  climb: {
    boardType?: string;
    layoutId?: number;
    owner?: string | null;
    draft?: boolean;
    listed?: boolean;
    syncSeq?: number | null;
    frames?: string;
  } = {},
): Promise<void> {
  const boardType = climb.boardType ?? 'kilter';
  await database.runAsync(
    `INSERT INTO board_climbs
       (uuid, board_type, layout_id, user_id, compatible_size_ids, frames, is_draft, is_listed, is_hidden, updated_at, sync_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, '2026-01-01T00:00:00Z', ?)`,
    [
      uuid,
      boardType,
      climb.layoutId ?? (boardType === 'spray' ? 7 : 1),
      climb.owner === undefined ? null : climb.owner,
      boardType === 'spray' ? '[7]' : '[10]',
      climb.frames ?? 'p1r13p2r13',
      climb.draft ? 1 : 0,
      climb.listed === false ? 0 : 1,
      climb.syncSeq === undefined ? 5 : climb.syncSeq,
    ],
  );
  await database.runAsync(
    `INSERT INTO board_climb_stats (board_type, climb_uuid, angle, fa_username, fa_at) VALUES (?, ?, 40, 'A Name', '2020-01-01')`,
    [boardType, uuid],
  );
  await database.runAsync('INSERT INTO board_climb_grades (board_type, climb_uuid, angle) VALUES (?, ?, 40)', [
    boardType,
    uuid,
  ]);
}
const uuidsIn = async (table: string, column: string): Promise<string[]> =>
  (await database.getAllAsync<Record<string, string>>(`SELECT ${column} FROM ${table} ORDER BY ${column}`)).map(
    (row) => row[column],
  );

describe('what a privacy event changes in sync_meta', () => {
  // A device already prepared for this account, which is every event but the
  // first after an account signs in (see the last describe).
  beforeEach(async () => {
    await revalidatePrivateCatalog(database, VIEWER);
  });

  it('changes exactly what the engine’s wall-only reset changes, plus its own two keys', async () => {
    await seedEverySyncMetaFamily(database);
    const before = await syncMeta();
    // The same starting state, with only the engine's reset applied.
    const reference = createTestDatabase();
    await runMigrations(reference);
    await seedEverySyncMetaFamily(reference);
    await resetPrivacyScopedProtectedSyncState(reference);
    const expected = await syncMeta(reference);
    reference.close();

    await revalidatePrivateCatalog(database, VIEWER);

    const after = await syncMeta();
    const ownKeys = [CATALOG_VIEWER_KEY, CATALOGUE_PREPARED_FOR_KEY];
    for (const key of ownKeys) after.delete(key);
    expect([...after]).toEqual([...expected]);
    // And the reset did do something: this is not a comparison of two no-ops.
    expect([...expected]).not.toEqual([...before]);
  });

  it('leaves a catalogue board’s cursors byte for byte, the protected ones included', async () => {
    await seedEverySyncMetaFamily(database);
    const before = await syncMeta();

    await revalidatePrivateCatalog(database, VIEWER);

    const after = await syncMeta();
    for (const scopeKey of ['kilter:1:10', 'tension:9:6']) {
      for (const tableName of BOARD_DATA_TABLES) {
        const key = getCheckpointKey(tableName, scopeKey);
        expect(after.get(key)).toEqual(before.get(key));
      }
      expect(await isScopeProtectedComplete(database, scopeKey)).toBe(true);
      expect(await isScopeDownloadComplete(database, scopeKey)).toBe(true);
    }
  });

  it('resets a wall’s protected cursors, and keeps its completion marker', async () => {
    await seedEverySyncMetaFamily(database);

    await revalidatePrivateCatalog(database, VIEWER);

    expect(await isScopeProtectedComplete(database, 'spray:7:7')).toBe(false);
    expect(await isScopeDownloadComplete(database, 'spray:7:7')).toBe(true);
    for (const tableName of BOARD_DATA_TABLES) {
      expect((await syncMeta()).has(getCheckpointKey(tableName, 'spray:7:7'))).toBe(false);
    }
  });

  it('writes the same thing on every later event', async () => {
    await seedEverySyncMetaFamily(database);
    await revalidatePrivateCatalog(database, VIEWER);
    const afterFirst = await syncMeta();

    await revalidatePrivateCatalog(database, VIEWER);
    await revalidatePrivateCatalog(database, VIEWER);

    expect([...(await syncMeta())]).toEqual([...afterFirst]);
    expect(afterFirst.get(CATALOGUE_PREPARED_FOR_KEY)).toBe(PREPARED_FOR_VIEWER);
  });
});

describe('what a privacy event stops, and what it does not', () => {
  it('raises the protected fence and no purge', () => {
    const token = capturePurgeToken();

    requirePrivacyRevalidation();

    // The one thing fenced: a wall page or a saved-climb mirror in flight.
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

describe('what a privacy event does to a catalogue board', () => {
  beforeEach(async () => {
    // The device has already been prepared for this account.
    await revalidatePrivateCatalog(database, VIEWER);
    await insertClimb('manufacturer');
    await insertClimb('another-climbers', { owner: 'somebody-else' });
    await insertClimb('mine', { owner: VIEWER });
    await insertClimb('my-draft', { owner: VIEWER, draft: true, listed: false });
  });

  it('deletes none of its climbs, other climbers’ published ones included', async () => {
    await revalidatePrivateCatalog(database, VIEWER);

    const everything = ['another-climbers', 'manufacturer', 'mine', 'my-draft'];
    expect(await uuidsIn('board_climbs', 'uuid')).toEqual(everything);
    expect(await uuidsIn('board_climb_stats', 'climb_uuid')).toEqual(everything);
    expect(await uuidsIn('board_climb_grades', 'climb_uuid')).toEqual(everything);
  });

  it('does not read through board_climbs to do it', async () => {
    const plans: string[] = [];
    const exclusive = database.withExclusiveTransactionAsync.bind(database);
    vi.spyOn(database, 'withExclusiveTransactionAsync').mockImplementation((task) =>
      exclusive(async (transaction) => {
        const read = transaction.getAllAsync.bind(transaction);
        const recorder = vi.spyOn(transaction, 'getAllAsync').mockImplementation(async (source, ...params) => {
          if (source.includes('FROM board_climbs')) {
            const plan = await read<{ detail: string }>(`EXPLAIN QUERY PLAN ${source}`, ...params);
            plans.push(...plan.map((step) => step.detail));
          }
          return read(source, ...params);
        });
        try {
          await task(transaction);
        } finally {
          recorder.mockRestore();
        }
      }),
    );

    await revalidatePrivateCatalog(database, VIEWER);

    // The wall rows are found through the board-type index, never by walking a
    // downloaded catalogue of several hundred thousand climbs. This runs on
    // every launch.
    const climbSteps = plans.filter((detail) => detail.includes('board_climbs'));
    expect(climbSteps).not.toEqual([]);
    for (const detail of climbSteps) expect(detail).toMatch(/^SEARCH board_climbs USING (COVERING )?INDEX/);
  });

  it('writes nothing to a board table', async () => {
    const written: string[] = [];
    const exclusive = database.withExclusiveTransactionAsync.bind(database);
    vi.spyOn(database, 'withExclusiveTransactionAsync').mockImplementation((task) =>
      exclusive(async (transaction) => {
        const run = transaction.runAsync.bind(transaction);
        const recorder = vi.spyOn(transaction, 'runAsync').mockImplementation(async (source, ...params) => {
          const result = await run(source, ...params);
          if (result.changes > 0 && /board_climb/.test(source)) written.push(source);
          return result;
        });
        try {
          await task(transaction);
        } finally {
          recorder.mockRestore();
        }
      }),
    );

    await revalidatePrivateCatalog(database, VIEWER);

    expect(written).toEqual([]);
  });
});

describe('what a privacy event withdraws: spray walls', () => {
  beforeEach(async () => {
    await revalidatePrivateCatalog(database, VIEWER);
    await insertClimb('my-wall-climb', { boardType: 'spray', owner: VIEWER });
    await insertClimb('their-wall-climb', { boardType: 'spray', owner: 'somebody-else' });
    await insertClimb('ownerless-wall-climb', { boardType: 'spray', owner: null });
    await insertClimb('catalogue', { owner: 'somebody-else' });
    await database.runAsync(
      "INSERT INTO spray_walls (layout_id, board_uuid, name, reference_width, reference_height, holds) VALUES (7, 'wall', 'Garage', 1, 1, '[]')",
    );
    await database.runAsync("INSERT INTO followed_author_snapshots (user_id, snapshot) VALUES ('viewer', '{}')");
    await markScopeDownloaded(database, 'spray:7:7');
  });

  it('deletes every wall climb that is not the climber’s own, with its stats and grades, and every wall', async () => {
    await revalidatePrivateCatalog(database, VIEWER);

    expect(await uuidsIn('board_climbs', 'uuid')).toEqual(['catalogue', 'my-wall-climb']);
    expect(await uuidsIn('board_climb_stats', 'climb_uuid')).toEqual(['catalogue', 'my-wall-climb']);
    expect(await uuidsIn('board_climb_grades', 'climb_uuid')).toEqual(['catalogue', 'my-wall-climb']);
    expect(await database.getAllAsync('SELECT layout_id FROM spray_walls')).toEqual([]);
    expect(await database.getAllAsync('SELECT user_id FROM followed_author_snapshots')).toEqual([]);
  });

  it('keeps a wall climb that may be unsynced work or that a queued write refers to, and stays closed', async () => {
    await insertClimb('their-unsynced', { boardType: 'spray', owner: 'somebody-else', syncSeq: null });
    await insertClimb('queued', { boardType: 'spray', owner: 'somebody-else' });
    await database.runAsync(
      "INSERT INTO pending_mutations (table_name, operation, payload, idempotency_key) VALUES ('boardsesh_ticks', 'insert', ?, 'queued')",
      [JSON.stringify({ climbUuid: 'queued' })],
    );

    await revalidatePrivateCatalog(database, VIEWER);

    expect(await uuidsIn('board_climbs', 'uuid')).toEqual(['catalogue', 'my-wall-climb', 'queued', 'their-unsynced']);
    expect(await canReadPrivateCatalog(database)).toBe(false);
  });

  it('takes a withdrawn wall climb out of the holds index', async () => {
    const WALL = { boardType: 'spray', layoutId: 7, sizeId: 7 };
    const parseHoldRows = (_boardType: string, frames: string) =>
      [...frames.matchAll(/p(\d+)r\d+/g)].map((match) => ({ holdId: Number(match[1]), holdState: 'HAND' }));
    expect((await ensureHoldIndex(database, WALL, { parseHoldRows, yieldToHost: async () => {} })).status).toBe(
      'complete',
    );
    const indexedUuids = () => uuidsIn('holds_index_climbs', 'uuid');
    expect(await indexedUuids()).toContain('their-wall-climb');

    await revalidatePrivateCatalog(database, VIEWER);

    expect(await indexedUuids()).toEqual(['my-wall-climb']);
    expect(
      await database.getAllAsync("SELECT hold_id FROM board_climb_hold_postings WHERE board_type = 'spray'"),
    ).toEqual([]);
    // And it is not rebuilt until the wall's rows are back.
    expect((await ensureHoldIndex(database, WALL, { parseHoldRows, yieldToHost: async () => {} })).status).toBe(
      'not-downloaded',
    );
  });

  describe('in one transaction, with the cursors that covered the rows', () => {
    const wallClimbs = () => uuidsIn('board_climbs', 'uuid');

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
      expect(purge.some((source) => source.startsWith('DELETE FROM spray_walls'))).toBe(true);
      expect(purge.some((source) => source.includes("json_remove(value, '$.protected')"))).toBe(true);
      // No other transaction touched a protected cursor.
      const resets = statementsByTransaction.filter((statements) =>
        statements.some((source) => source.includes("json_remove(value, '$.protected')")),
      );
      expect(resets).toEqual([purge]);
    });

    it('rolls both back together when the revalidation fails after them, and stays closed', async () => {
      const exclusive = database.withExclusiveTransactionAsync.bind(database);
      let transactions = 0;
      vi.spyOn(database, 'withExclusiveTransactionAsync').mockImplementation((task) =>
        exclusive(async (transaction) => {
          transactions += 1;
          // The credential changes while the purge runs. The check that follows
          // the purge refuses to commit under it.
          auth.token = 'rotated-during-purge';
          await task(transaction);
        }),
      );

      await expect(revalidatePrivateCatalog(database, VIEWER)).rejects.toThrow('Account changed');

      expect(transactions).toBe(1);
      // Neither half landed without the other: the rows are still here, and so
      // is the cursor that covers them.
      expect(await wallClimbs()).toContain('their-wall-climb');
      expect(await isScopeProtectedComplete(database, 'spray:7:7')).toBe(true);
      // And nothing reads those rows. The catalogue stays closed and wall pulls
      // stay held back until a revalidation succeeds.
      expect(needsPrivacyRevalidation()).toBe(true);
      expect(await canReadPrivateCatalog(database)).toBe(false);
      await expect(waitForPrivacyRevalidation()).rejects.toThrow('Privacy revalidation is required');
    });
  });
});

// A draft or an unlisted climb is sent to its owner alone. A device that ran a
// bundle from before that rule holds everybody's, and a device another account
// used holds theirs.
describe('preparing the catalogue for an account, once', () => {
  const allClimbs = () => uuidsIn('board_climbs', 'uuid');

  beforeEach(async () => {
    await insertClimb('published', { owner: 'somebody-else' });
    await insertClimb('their-draft', { owner: 'somebody-else', draft: true, listed: false });
    await insertClimb('their-unlisted', { owner: 'somebody-else', listed: false });
    await insertClimb('ownerless-draft', { owner: null, draft: true });
    await insertClimb('ownerless-unlisted', { owner: null, listed: false });
    await insertClimb('my-draft', { owner: VIEWER, draft: true, listed: false });
    await insertClimb('my-unlisted', { owner: VIEWER, listed: false });
  });

  it('deletes the drafts and unlisted climbs that are not the climber’s own, with their stats and grades', async () => {
    await revalidatePrivateCatalog(database, VIEWER);

    const kept = ['my-draft', 'my-unlisted', 'published'];
    expect(await allClimbs()).toEqual(kept);
    expect(await uuidsIn('board_climb_stats', 'climb_uuid')).toEqual(kept);
    expect(await uuidsIn('board_climb_grades', 'climb_uuid')).toEqual(kept);
    expect(await canReadPrivateCatalog(database)).toBe(true);
  });

  // The server's test is `is_draft IS NOT TRUE AND is_listed IS TRUE`. No row
  // in production has a NULL in either column (0 of 917,002 on 2026-10-11), and
  // if one ever does the device reads it the same way.
  it('reads a missing flag as the server does: not a draft, and not listed', async () => {
    await database.runAsync(
      `INSERT INTO board_climbs (uuid, board_type, layout_id, user_id, is_draft, is_listed, sync_seq) VALUES
         ('no-listed-flag', 'kilter', 1, 'somebody-else', 0, NULL, 5),
         ('no-draft-flag', 'kilter', 1, 'somebody-else', NULL, 1, 6),
         ('mine-with-no-flags', 'kilter', 1, ?, NULL, NULL, 7)`,
      [VIEWER],
    );

    await revalidatePrivateCatalog(database, VIEWER);

    expect(await allClimbs()).toEqual(['mine-with-no-flags', 'my-draft', 'my-unlisted', 'no-draft-flag', 'published']);
    expect(await canReadPrivateCatalog(database)).toBe(true);
  });

  it('keeps a row with no server sequence and a row a queued write refers to, and keeps the catalogue closed while they stay', async () => {
    await insertClimb('their-unsynced-draft', { owner: 'somebody-else', draft: true, syncSeq: null });
    await insertClimb('queued-draft', { owner: 'somebody-else', draft: true });
    await database.runAsync(
      "INSERT INTO pending_mutations (table_name, operation, payload, idempotency_key) VALUES ('boardsesh_ticks', 'insert', ?, 'queued')",
      [JSON.stringify({ climbUuid: 'queued-draft' })],
    );

    await revalidatePrivateCatalog(database, VIEWER);

    expect(await allClimbs()).toEqual(['my-draft', 'my-unlisted', 'published', 'queued-draft', 'their-unsynced-draft']);
    expect(await canReadPrivateCatalog(database)).toBe(false);

    // It looks again on the next event, and opens once they are gone.
    await database.runAsync("DELETE FROM pending_mutations WHERE idempotency_key = 'queued'");
    await database.runAsync("DELETE FROM board_climbs WHERE uuid = 'their-unsynced-draft'");
    await revalidatePrivateCatalog(database, VIEWER);

    expect(await allClimbs()).toEqual(['my-draft', 'my-unlisted', 'published']);
    expect(await canReadPrivateCatalog(database)).toBe(true);
  });

  it('runs once: a draft that arrives later is not this pass’s business, and no later event walks the table', async () => {
    await revalidatePrivateCatalog(database, VIEWER);
    // The server sends the climber only their own; this row stands for anything
    // that is on the device afterwards.
    await insertClimb('arrived-later', { owner: 'somebody-else', draft: true });
    const reads: string[] = [];
    const read = database.getAllAsync.bind(database);
    vi.spyOn(database, 'getAllAsync').mockImplementation((source, ...params) => {
      reads.push(source);
      return read(source, ...params);
    });

    await revalidatePrivateCatalog(database, VIEWER);
    const readsDuringTheEvent = [...reads];

    expect(await allClimbs()).toContain('arrived-later');
    // The only reads of the climbs table are the event's own seek for wall rows.
    const climbReads = readsDuringTheEvent.filter((source) => /FROM board_climbs\b/.test(source));
    expect(climbReads.filter((source) => !source.includes("board_type = 'spray'"))).toEqual([]);
  });

  it('runs again for another account: their rows go, and every protected cursor is forgotten', async () => {
    await revalidatePrivateCatalog(database, VIEWER);
    await markScopeDownloaded(database, 'kilter:1:10');
    await setCheckpoint(database, getCheckpointKey('board_climbs', 'kilter:1:10'), REFERENCE_CURSOR);
    expect(await isScopeProtectedComplete(database, 'kilter:1:10')).toBe(true);

    // Another account signs in on this device. An earlier bundle's sign-out
    // left the first account's protected cursor and their own drafts behind.
    auth.viewer = 'next-climber';
    auth.token = 'next-token';
    auth.generation += 1;
    await revalidatePrivateCatalog(database, 'next-climber');

    expect(await allClimbs()).toEqual(['published']);
    expect(await isScopeProtectedComplete(database, 'kilter:1:10')).toBe(false);
    // The public catalogue's cursor and the completed download are untouched.
    expect((await syncMeta()).get(getCheckpointKey('board_climbs', 'kilter:1:10'))).toBe(
      JSON.stringify(REFERENCE_CURSOR),
    );
    expect(await isScopeDownloadComplete(database, 'kilter:1:10')).toBe(true);
    expect((await syncMeta()).get(CATALOGUE_PREPARED_FOR_KEY)).toBe('2:0:next-climber');
  });

  it('runs again after an earlier bundle ran, which deletes the note that it was done', async () => {
    await revalidatePrivateCatalog(database, VIEWER);
    // What that bundle's revalidation does to the stats checkpoints.
    await database.runAsync("DELETE FROM sync_meta WHERE key LIKE 'checkpoint:board_climb_stats:%'");
    await insertClimb('pulled-by-the-earlier-bundle', { owner: 'somebody-else', draft: true });

    await revalidatePrivateCatalog(database, VIEWER);

    expect(await allClimbs()).toEqual(['my-draft', 'my-unlisted', 'published']);
  });

  it('takes a deleted climb out of the holds index, and leaves the index of a layout that lost nothing', async () => {
    const KILTER = { boardType: 'kilter', layoutId: 1, sizeId: 10 };
    const parseHoldRows = (_boardType: string, frames: string) =>
      [...frames.matchAll(/p(\d+)r\d+/g)].map((match) => ({ holdId: Number(match[1]), holdState: 'HAND' }));
    // An earlier bundle indexed this one while it was listed.
    await insertClimb('unlisted-since', { owner: 'somebody-else' });
    await markScopeDownloaded(database, 'kilter:1:10');
    expect((await ensureHoldIndex(database, KILTER, { parseHoldRows, yieldToHost: async () => {} })).status).toBe(
      'complete',
    );
    await database.runAsync("UPDATE board_climbs SET is_listed = 0 WHERE uuid = 'unlisted-since'");

    await revalidatePrivateCatalog(database, VIEWER);

    expect(await uuidsIn('holds_index_climbs', 'uuid')).not.toContain('unlisted-since');
    expect(
      await database.getAllAsync(
        'SELECT hic.uuid FROM holds_index_climbs hic JOIN board_climb_hold_sets hs ON hs.climb_id = hic.id ORDER BY hic.uuid',
      ),
    ).toEqual([{ uuid: 'published' }]);
  });

  it('deletes tens of thousands in short transactions', async () => {
    const strangers = 4500;
    await database.execAsync('BEGIN');
    for (let index = 0; index < strangers; index += 1) {
      await insertClimb(`unlisted-${index}`, { owner: null, listed: false });
    }
    await database.execAsync('COMMIT');
    let deletingTransactions = 0;
    const exclusive = database.withExclusiveTransactionAsync.bind(database);
    vi.spyOn(database, 'withExclusiveTransactionAsync').mockImplementation((task) =>
      exclusive(async (transaction) => {
        const run = transaction.runAsync.bind(transaction);
        let deleted = false;
        const recorder = vi.spyOn(transaction, 'runAsync').mockImplementation((source, ...params) => {
          if (source.startsWith('DELETE FROM board_climbs')) deleted = true;
          return run(source, ...params);
        });
        try {
          await task(transaction);
        } finally {
          recorder.mockRestore();
          if (deleted) deletingTransactions += 1;
        }
      }),
    );

    await revalidatePrivateCatalog(database, VIEWER);

    expect(await allClimbs()).toEqual(['my-draft', 'my-unlisted', 'published']);
    expect(await uuidsIn('board_climb_stats', 'climb_uuid')).toEqual(['my-draft', 'my-unlisted', 'published']);
    // 4,504 rows at 2,000 a transaction.
    expect(deletingTransactions).toBe(3);
  });

  // The device no longer stores a first-ascent name or date: no reader selects
  // them. What an earlier bundle stored is blanked once, on every row.
  describe('first-ascent names an earlier bundle stored', () => {
    const names = async () =>
      Object.fromEntries(
        (
          await database.getAllAsync<{ climb_uuid: string; fa_username: string | null; fa_at: string | null }>(
            'SELECT climb_uuid, fa_username, fa_at FROM board_climb_stats',
          )
        ).map((row) => [row.climb_uuid, [row.fa_username, row.fa_at]]),
      );

    it('are blanked, with their dates, whatever climb they are on', async () => {
      await insertClimb('manufacturer', { owner: null });
      await insertClimb('wall-climb', { boardType: 'spray', owner: VIEWER });
      await database.runAsync(
        "INSERT INTO board_climb_stats (board_type, climb_uuid, angle, fa_username) VALUES ('kilter', 'no-climb-row', 40, 'A Name')",
      );
      await database.runAsync(
        "INSERT INTO board_climb_stats (board_type, climb_uuid, angle, fa_at) VALUES ('kilter', 'date-only', 40, '2020-01-01')",
      );

      await revalidatePrivateCatalog(database, VIEWER);

      expect(await names()).toEqual({
        manufacturer: [null, null],
        published: [null, null],
        'my-draft': [null, null],
        'my-unlisted': [null, null],
        'wall-climb': [null, null],
        'no-climb-row': [null, null],
        'date-only': [null, null],
      });
    });

    it('are not looked at again by a later event', async () => {
      await revalidatePrivateCatalog(database, VIEWER);
      await database.runAsync(
        "UPDATE board_climb_stats SET fa_username = 'Delivered Later' WHERE climb_uuid = 'published'",
      );

      await revalidatePrivateCatalog(database, VIEWER);

      expect((await names()).published).toEqual(['Delivered Later', null]);
    });
  });
});
