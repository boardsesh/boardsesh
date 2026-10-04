import { describe, it, expect, beforeEach } from 'vitest';
import { getCheckpoint, getCheckpointKey, runMigrations, setCheckpoint } from '@boardsesh/offline-sync';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';

import {
  MAX_SPRAY_PHOTO_ATTEMPTS,
  clearSprayPhotoPending,
  recordSprayPhotoFailure,
  sprayScopeKey,
} from '../spray-photo-retry';

/**
 * The retry that keeps a failed photograph from being lost forever (#5448).
 *
 * The whole hazard is the cursor: the presigned URL arrives WITH the row, and
 * `syncSprayWalls` pages on a strict `>`, so once the row's checkpoint advances
 * an unchanged wall is never offered again. A download that failed after that
 * point leaves a board the climber has been told is downloaded, with no
 * photograph, and no path back to one.
 */

const LAYOUT_ID = 4;
const PHOTO_KEY = 'spray-walls/wall-4/photo-2.jpg';
const CHECKPOINT_KEY = getCheckpointKey('spray_walls', sprayScopeKey(LAYOUT_ID));

let db: TestSqliteDb;

async function seedCheckpoint(): Promise<void> {
  await setCheckpoint(db, CHECKPOINT_KEY, { updatedAt: '2026-06-01T00:00:00Z', syncSeq: '12' });
}

beforeEach(async () => {
  db = createTestDatabase();
  await runMigrations(db);
  await db.runAsync('INSERT INTO spray_walls (layout_id, board_uuid, photo_key) VALUES (?, ?, ?)', [
    LAYOUT_ID,
    'wall-4',
    PHOTO_KEY,
  ]);
});

describe('recordSprayPhotoFailure', () => {
  it('checks wall presence after entering the writer transaction', async () => {
    await seedCheckpoint();
    const originalTransaction = db.withExclusiveTransactionAsync.bind(db);
    db.withExclusiveTransactionAsync = async (task) => {
      await db.runAsync('DELETE FROM spray_walls WHERE layout_id = ?', [LAYOUT_ID]);
      await originalTransaction(task);
    };

    expect(await recordSprayPhotoFailure(db, LAYOUT_ID, PHOTO_KEY)).toBe(false);
    expect(await getCheckpoint(db, CHECKPOINT_KEY)).not.toBeNull();
    expect(
      await db.getFirstAsync('SELECT key FROM sync_meta WHERE key = ?', [`spray-photo-pending:${LAYOUT_ID}`]),
    ).toBeNull();
  });

  it.each(['removed', 'replaced'])('ignores a failure after the wall was %s', async (change) => {
    await seedCheckpoint();
    if (change === 'removed') {
      await db.runAsync('DELETE FROM spray_walls WHERE layout_id = ?', [LAYOUT_ID]);
    } else {
      await db.runAsync('UPDATE spray_walls SET photo_key = ? WHERE layout_id = ?', ['new-photo', LAYOUT_ID]);
    }

    expect(await recordSprayPhotoFailure(db, LAYOUT_ID, PHOTO_KEY)).toBe(false);
    expect(await getCheckpoint(db, CHECKPOINT_KEY)).not.toBeNull();
    expect(
      await db.getFirstAsync('SELECT key FROM sync_meta WHERE key = ?', [`spray-photo-pending:${LAYOUT_ID}`]),
    ).toBeNull();
  });

  it('rewinds the wall cursor so the next pull re-offers the row', async () => {
    // Re-offering the row is the ONLY way to get a fresh signature: the one that
    // failed is dead in fifteen minutes and the bucket is private.
    await seedCheckpoint();

    const retried = await recordSprayPhotoFailure(db, LAYOUT_ID, PHOTO_KEY);

    expect(retried).toBe(true);
    expect(await getCheckpoint(db, CHECKPOINT_KEY)).toBeNull();
  });

  it('keys the scope as spray:<layoutId>:<layoutId>', async () => {
    // A wall is its own size, so this is the scope key the download and the
    // teardown both use. Get it wrong and the rewind clears nothing.
    expect(sprayScopeKey(LAYOUT_ID)).toBe('spray:4:4');
  });

  it('gives up after the attempt budget instead of rewinding forever', async () => {
    // A photograph that can never be stored — the object is gone, the disk is
    // full — would otherwise cost a query every cycle for the life of the install.
    for (let attempt = 1; attempt <= MAX_SPRAY_PHOTO_ATTEMPTS; attempt += 1) {
      await seedCheckpoint();
      expect(await recordSprayPhotoFailure(db, LAYOUT_ID, PHOTO_KEY)).toBe(true);
    }

    await seedCheckpoint();
    expect(await recordSprayPhotoFailure(db, LAYOUT_ID, PHOTO_KEY)).toBe(false);
    // And the cursor is left alone, so the wall is not re-pulled any more.
    expect(await getCheckpoint(db, CHECKPOINT_KEY)).not.toBeNull();
  });

  it('starts the budget again when the wall publishes a NEW photo', async () => {
    // A reset is a different problem, not the old one continuing — otherwise a
    // wall that once exhausted its budget could never fetch another photograph.
    for (let attempt = 1; attempt <= MAX_SPRAY_PHOTO_ATTEMPTS + 2; attempt += 1) {
      await recordSprayPhotoFailure(db, LAYOUT_ID, PHOTO_KEY);
    }
    await seedCheckpoint();

    await db.runAsync('UPDATE spray_walls SET photo_key = ? WHERE layout_id = ?', [
      'spray-walls/wall-4/photo-3.jpg',
      LAYOUT_ID,
    ]);
    const retried = await recordSprayPhotoFailure(db, LAYOUT_ID, 'spray-walls/wall-4/photo-3.jpg');

    expect(retried).toBe(true);
    expect(await getCheckpoint(db, CHECKPOINT_KEY)).toBeNull();
  });

  it('counts each wall separately', async () => {
    for (let attempt = 1; attempt <= MAX_SPRAY_PHOTO_ATTEMPTS + 1; attempt += 1) {
      await recordSprayPhotoFailure(db, LAYOUT_ID, PHOTO_KEY);
    }

    await db.runAsync('INSERT INTO spray_walls (layout_id, board_uuid, photo_key) VALUES (?, ?, ?)', [
      9,
      'wall-9',
      'spray-walls/wall-9/photo-1.jpg',
    ]);
    expect(await recordSprayPhotoFailure(db, 9, 'spray-walls/wall-9/photo-1.jpg')).toBe(true);
  });
});

describe('clearSprayPhotoPending', () => {
  it('keeps the retry marker for a newer photo when an old download succeeds', async () => {
    await recordSprayPhotoFailure(db, LAYOUT_ID, PHOTO_KEY);
    await clearSprayPhotoPending(db, LAYOUT_ID, 'older-photo');
    expect(
      await db.getFirstAsync('SELECT key FROM sync_meta WHERE key = ?', [`spray-photo-pending:${LAYOUT_ID}`]),
    ).not.toBeNull();
  });

  it('resets the budget, so a later failure retries from scratch', async () => {
    for (let attempt = 1; attempt <= MAX_SPRAY_PHOTO_ATTEMPTS + 1; attempt += 1) {
      await recordSprayPhotoFailure(db, LAYOUT_ID, PHOTO_KEY);
    }
    expect(await recordSprayPhotoFailure(db, LAYOUT_ID, PHOTO_KEY)).toBe(false);

    await clearSprayPhotoPending(db, LAYOUT_ID);
    await seedCheckpoint();

    expect(await recordSprayPhotoFailure(db, LAYOUT_ID, PHOTO_KEY)).toBe(true);
  });

  it('is a no-op for a wall with nothing pending', async () => {
    await expect(clearSprayPhotoPending(db, 77)).resolves.toBeUndefined();
  });
});
