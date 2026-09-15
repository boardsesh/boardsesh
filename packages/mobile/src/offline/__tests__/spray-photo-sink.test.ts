import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getCheckpoint, getCheckpointKey, runMigrations, setCheckpoint } from '@boardsesh/offline-sync';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';

/**
 * The two sinks that keep a wall's photograph in step with its row (#5448).
 *
 * The photo store is mocked because the point here is the DECISIONS — retry or
 * give up, prune or leave alone, delete on a tombstone — not the filesystem,
 * which `spray-photo-store.test.ts` covers against a fake disk.
 */

const { stored, deleted, pruned, storeResult } = vi.hoisted(() => ({
  stored: [] as { photoKey: string; photoUrl: string }[],
  deleted: [] as string[],
  pruned: [] as string[][],
  storeResult: { ok: true },
}));

vi.mock('../../lib/spray/spray-photo-store', () => ({
  SPRAY_PHOTO_STORE_AVAILABLE: true,
  storeSprayPhoto: vi.fn(async (photoKey: string, photoUrl: string) => {
    stored.push({ photoKey, photoUrl });
    return storeResult.ok ? `/documents/spray-wall-photos/${photoKey}` : null;
  }),
  deleteStoredSprayPhoto: vi.fn((photoKey: string) => {
    deleted.push(photoKey);
  }),
  pruneStoredSprayPhotos: vi.fn((liveKeys: Iterable<string>) => {
    pruned.push([...liveKeys]);
    return 0;
  }),
}));

const { sprayWallDeletedSink, sprayWallPhotoSink } = await import('../spray-photo-sink');
const { MAX_SPRAY_PHOTO_ATTEMPTS, sprayScopeKey } = await import('../spray-photo-retry');

const LAYOUT_ID = 4;
const PHOTO_KEY = 'spray-walls/wall-4/photo-2.jpg';
const PHOTO_URL = 'https://private.example/photo?sig=1';
const CHECKPOINT_KEY = getCheckpointKey('spray_walls', sprayScopeKey(LAYOUT_ID));

let db: TestSqliteDb;

function wallDocument(overrides: Record<string, unknown> = {}) {
  return { layout_id: LAYOUT_ID, photo_key: PHOTO_KEY, photo_url: PHOTO_URL, ...overrides };
}

async function insertWallRow(layoutId = LAYOUT_ID, photoKey: string | null = PHOTO_KEY): Promise<void> {
  await db.runAsync('INSERT INTO spray_walls (layout_id, board_uuid, photo_key) VALUES (?, ?, ?)', [
    layoutId,
    `board-${layoutId}`,
    photoKey,
  ]);
}

const pull = (documents: Record<string, unknown>[], tableName = 'spray_walls') =>
  sprayWallPhotoSink({ tableName, documents, db });

beforeEach(async () => {
  db = createTestDatabase();
  await runMigrations(db);
  stored.length = 0;
  deleted.length = 0;
  pruned.length = 0;
  storeResult.ok = true;
  await setCheckpoint(db, CHECKPOINT_KEY, { updatedAt: '2026-06-01T00:00:00Z', syncSeq: '12' });
});

describe('sprayWallPhotoSink', () => {
  it('stores the photograph the page carried', async () => {
    await insertWallRow();

    await pull([wallDocument()]);

    expect(stored).toEqual([{ photoKey: PHOTO_KEY, photoUrl: PHOTO_URL }]);
    // The cursor stays where the page left it: nothing to retry.
    expect(await getCheckpoint(db, CHECKPOINT_KEY)).not.toBeNull();
  });

  it('rewinds the cursor when the download fails, so the wall is offered again', async () => {
    // Without this the row is never re-served, the scope is marked complete, and
    // the climber reaches the garage with no photograph.
    storeResult.ok = false;
    await insertWallRow();

    await pull([wallDocument()]);

    expect(await getCheckpoint(db, CHECKPOINT_KEY)).toBeNull();
  });

  it('stops rewinding once the attempt budget is spent', async () => {
    storeResult.ok = false;
    await insertWallRow();

    for (let attempt = 1; attempt <= MAX_SPRAY_PHOTO_ATTEMPTS; attempt += 1) {
      await setCheckpoint(db, CHECKPOINT_KEY, { updatedAt: '2026-06-01T00:00:00Z', syncSeq: '12' });
      await pull([wallDocument()]);
    }
    await setCheckpoint(db, CHECKPOINT_KEY, { updatedAt: '2026-06-01T00:00:00Z', syncSeq: '12' });

    await pull([wallDocument()]);

    expect(await getCheckpoint(db, CHECKPOINT_KEY)).not.toBeNull();
  });

  it('clears the pending state once the photograph lands', async () => {
    // A wall that failed once and then succeeded must not carry a spent budget
    // into its next reset.
    storeResult.ok = false;
    await insertWallRow();
    await pull([wallDocument()]);

    storeResult.ok = true;
    await setCheckpoint(db, CHECKPOINT_KEY, { updatedAt: '2026-06-01T00:00:00Z', syncSeq: '12' });
    await pull([wallDocument()]);

    const pending = await db.getFirstAsync<{ key: string }>('SELECT key FROM sync_meta WHERE key LIKE ?', [
      'spray-photo-pending:%',
    ]);
    expect(pending).toBeNull();
  });

  it('prunes against the live rows, not the page', async () => {
    // A page names one wall; the device may hold ten, and deleting the other
    // nine's photographs is the failure the database read exists to avoid.
    await insertWallRow(LAYOUT_ID, PHOTO_KEY);
    await insertWallRow(9, 'spray-walls/wall-9/photo-1.jpg');

    await pull([wallDocument()]);

    expect(pruned).toHaveLength(1);
    expect(pruned[0].sort()).toEqual([PHOTO_KEY, 'spray-walls/wall-9/photo-1.jpg'].sort());
  });

  it('does not prune when nothing was stored', async () => {
    storeResult.ok = false;
    await insertWallRow();

    await pull([wallDocument()]);

    expect(pruned).toEqual([]);
  });

  it('ignores a wall with no published photo, and every other table', async () => {
    await pull([wallDocument({ photo_key: null, photo_url: null })]);
    await pull([wallDocument()], 'board_climbs');

    expect(stored).toEqual([]);
    expect(await getCheckpoint(db, CHECKPOINT_KEY)).not.toBeNull();
  });
});

describe('sprayWallDeletedSink', () => {
  it('deletes the photograph a tombstone orphaned', async () => {
    // The row is already gone, so this capture is the only thing that still
    // names the file — board teardown and the prune both look at rows.
    await sprayWallDeletedSink({
      tableName: 'spray_walls',
      rows: [{ layout_id: LAYOUT_ID, photo_key: PHOTO_KEY }],
      db,
    });

    expect(deleted).toEqual([PHOTO_KEY]);
  });

  it('clears the wall’s pending-photo state', async () => {
    // Left behind, it would keep rewinding a cursor for a row the server will
    // never serve again.
    await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
      `spray-photo-pending:${LAYOUT_ID}`,
      JSON.stringify({ photoKey: PHOTO_KEY, attempts: 3 }),
    ]);

    await sprayWallDeletedSink({
      tableName: 'spray_walls',
      rows: [{ layout_id: LAYOUT_ID, photo_key: PHOTO_KEY }],
      db,
    });

    const pending = await db.getFirstAsync<{ key: string }>('SELECT key FROM sync_meta WHERE key = ?', [
      `spray-photo-pending:${LAYOUT_ID}`,
    ]);
    expect(pending).toBeNull();
  });

  it('ignores a wall that never had a photograph, and every other table', async () => {
    await sprayWallDeletedSink({ tableName: 'spray_walls', rows: [{ layout_id: 7, photo_key: null }], db });
    await sprayWallDeletedSink({ tableName: 'playlists', rows: [{ photo_key: PHOTO_KEY }], db });

    expect(deleted).toEqual([]);
  });
});
