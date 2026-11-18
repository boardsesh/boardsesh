import { beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '@boardsesh/offline-sync';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';
import { readClimbArtLocal } from '../get-climb-art-local';

let db: TestSqliteDb;

async function insertClimb(
  uuid: string,
  {
    boardType = 'kilter',
    frames = 'p1r12',
    layoutId = 1,
    sizes = '[10,11]',
    draft = 0,
    userId = null as string | null,
  } = {},
): Promise<void> {
  await db.runAsync(
    `INSERT INTO board_climbs (uuid, board_type, layout_id, frames, compatible_size_ids, is_draft, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [uuid, boardType, layoutId, frames, sizes, draft, userId],
  );
}

beforeEach(async () => {
  db = createTestDatabase();
  await runMigrations(db);
});

describe('readClimbArtLocal', () => {
  it('reads the frames, layout and sizes of the climbs asked for', async () => {
    await insertClimb('climb-1');
    await insertClimb('climb-2', { boardType: 'tension', layoutId: 9, sizes: 'not json' });
    await insertClimb('climb-3');
    const art = await readClimbArtLocal(
      db,
      [
        { boardType: 'kilter', climbUuid: 'climb-1' },
        { boardType: 'tension', climbUuid: 'climb-2' },
        { boardType: 'kilter', climbUuid: 'missing' },
      ],
      'user-a',
    );
    expect(art).toEqual(
      expect.arrayContaining([
        { boardType: 'kilter', climbUuid: 'climb-1', frames: 'p1r12', layoutId: 1, compatibleSizeIds: [10, 11] },
        { boardType: 'tension', climbUuid: 'climb-2', frames: 'p1r12', layoutId: 9, compatibleSizeIds: [] },
      ]),
    );
    expect(art).toHaveLength(2);
  });

  it('serves a draft only to the climber who set it', async () => {
    await insertClimb('draft', { draft: 1, userId: 'user-a' });
    expect(await readClimbArtLocal(db, [{ boardType: 'kilter', climbUuid: 'draft' }], 'user-a')).toHaveLength(1);
    expect(await readClimbArtLocal(db, [{ boardType: 'kilter', climbUuid: 'draft' }], 'user-b')).toHaveLength(0);
  });

  it('leaves out a climb without frames', async () => {
    await insertClimb('bare', { frames: '' });
    expect(await readClimbArtLocal(db, [{ boardType: 'kilter', climbUuid: 'bare' }], 'user-a')).toEqual([]);
  });
});
