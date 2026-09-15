import { describe, it, expect, beforeEach } from 'vitest';
import { runMigrations, stampLocalUserId } from '@boardsesh/offline-sync';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';

import { getSprayWallLocal } from '../get-spray-wall-local';

/**
 * The auth-scoping half of #5448's acceptance: "a private wall of another user
 * never lands in the local DB".
 *
 * The server gate is what enforces that (`syncSprayWalls`, tested in
 * packages/backend/src/__tests__/sync-pull-spray-walls.test.ts). This file covers
 * the second layer — the one that has to hold when the first has already been
 * satisfied and then the device changes hands. Sign-out wipes `spray_walls`, but
 * that wipe is best-effort: a locked database or a crash mid-sign-out leaves the
 * previous account's rows on disk, and a wall row is a photograph of somebody's
 * garage. So the reader refuses unless the `local_user_id` stamp names the
 * climber asking.
 */

const OWNER = 'climber-a';
const SOMEONE_ELSE = 'climber-b';

let db: TestSqliteDb;

async function insertWall(
  params: {
    layoutId?: number;
    holds?: string | null;
    homography?: string | null;
    photoKey?: string | null;
    boardUuid?: string | null;
  } = {},
): Promise<void> {
  await db.runAsync(
    `INSERT INTO spray_walls
       (layout_id, board_uuid, name, reference_width, reference_height, current_version_number,
        photo_key, holds, homography, updated_at, sync_seq)
     VALUES (?, ?, 'Garage wall', 800, 620, 2, ?, ?, ?, '2026-06-01T00:00:00Z', 12)`,
    [
      params.layoutId ?? 4,
      params.boardUuid === undefined ? 'board-4' : params.boardUuid,
      params.photoKey === undefined ? 'spray-walls/wall-4/photo-2.jpg' : params.photoKey,
      params.holds === undefined
        ? JSON.stringify([
            { id: 101, cx: 100, cy: 120, r: 24, outline: [1, 0, 0, 1, -1, 0, 0, -1] },
            { id: 102, cx: 300, cy: 400, r: 30, outline: null },
          ])
        : params.holds,
      params.homography === undefined ? JSON.stringify([1, 0, 0, 0, 1, 0, 0, 0, 1]) : params.homography,
    ],
  );
}

beforeEach(async () => {
  db = createTestDatabase();
  await runMigrations(db);
});

describe('getSprayWallLocal — auth scoping', () => {
  it('serves the wall to the climber the stamp names', async () => {
    await stampLocalUserId(db, OWNER);
    await insertWall();

    const wall = await getSprayWallLocal(db, 4, OWNER);

    expect(wall).not.toBeNull();
    expect(wall?.boardUuid).toBe('board-4');
    expect(wall?.name).toBe('Garage wall');
  });

  it('refuses a DIFFERENT signed-in climber', async () => {
    // The wipe that should have run at sign-out failed, or never ran. This is the
    // whole reason the stamp exists.
    await stampLocalUserId(db, OWNER);
    await insertWall();

    expect(await getSprayWallLocal(db, 4, SOMEONE_ELSE)).toBeNull();
  });

  it('refuses a signed-out reader', async () => {
    await stampLocalUserId(db, OWNER);
    await insertWall();

    expect(await getSprayWallLocal(db, 4, null)).toBeNull();
    expect(await getSprayWallLocal(db, 4, undefined)).toBeNull();
    expect(await getSprayWallLocal(db, 4, '')).toBeNull();
  });

  it('refuses when the device carries no stamp at all', async () => {
    // A fresh or pre-upgrade database. There is no wall row here that a device
    // with no known owner should hand out, so "unknown" declines like a mismatch.
    await insertWall();

    expect(await getSprayWallLocal(db, 4, OWNER)).toBeNull();
  });
});

describe('getSprayWallLocal — payload', () => {
  beforeEach(async () => {
    await stampLocalUserId(db, OWNER);
  });

  it('returns the registry-shaped wall', async () => {
    await insertWall();

    const wall = await getSprayWallLocal(db, 4, OWNER);

    expect(wall).toEqual({
      layoutId: 4,
      boardUuid: 'board-4',
      name: 'Garage wall',
      referenceWidth: 800,
      referenceHeight: 620,
      version: 2,
      photoKey: 'spray-walls/wall-4/photo-2.jpg',
      homography: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      holds: [
        { id: 101, cx: 100, cy: 120, r: 24, outline: [1, 0, 0, 1, -1, 0, 0, -1] },
        { id: 102, cx: 300, cy: 400, r: 30, outline: null },
      ],
    });
  });

  it('answers null for a layout this device has not downloaded', async () => {
    await insertWall({ layoutId: 4 });

    expect(await getSprayWallLocal(db, 9, OWNER)).toBeNull();
    expect(await getSprayWallLocal(db, Number.NaN, OWNER)).toBeNull();
  });

  it('degrades a corrupt JSON column to no geometry rather than throwing', async () => {
    // The caller is a render path with no second source: a wall it cannot parse
    // is a board drawn without holds, never a crash.
    await insertWall({ holds: 'not json', homography: '{"a":1}' });

    const wall = await getSprayWallLocal(db, 4, OWNER);

    expect(wall?.holds).toEqual([]);
    expect(wall?.homography).toBeNull();
  });

  it('drops a hold whose geometry is not finite, keeping the rest', async () => {
    // A hold at NaN is painted somewhere nobody can tap.
    await insertWall({
      holds: JSON.stringify([
        { id: 1, cx: 10, cy: 10, r: 5 },
        { id: 2, cx: 'x', cy: 10, r: 5 },
        { id: 3, cx: 20, cy: 20, r: 5, outline: [1, 'no'] },
      ]),
    });

    const wall = await getSprayWallLocal(db, 4, OWNER);

    expect(wall?.holds.map((hold) => hold.id)).toEqual([1, 3]);
    // A ring that lost a coordinate is dropped whole — the renderer's fallback
    // circle is the right answer, a half-ring is not.
    expect(wall?.holds[1].outline).toBeNull();
  });

  it('drops a hold whose id did not survive as a number', async () => {
    // Every non-finite id arrives here as `null`, because that is what
    // `JSON.stringify` renders NaN and Infinity as and JSON.parse rejects a bare
    // `NaN` token — so this, not a literal NaN, is the reachable shape. A hold
    // with no usable id matches no placement and no frames entry, and the
    // renderer would draw something nothing can select.
    await insertWall({
      holds: '[{"id":1,"cx":10,"cy":10,"r":5},{"id":null,"cx":20,"cy":20,"r":5},{"id":"3","cx":30,"cy":30,"r":5}]',
    });

    const wall = await getSprayWallLocal(db, 4, OWNER);

    expect(wall?.holds.map((hold) => hold.id)).toEqual([1]);
  });

  it('answers null for a row with no board uuid, which nothing can query with', async () => {
    await insertWall({ boardUuid: null });

    expect(await getSprayWallLocal(db, 4, OWNER)).toBeNull();
  });
});
