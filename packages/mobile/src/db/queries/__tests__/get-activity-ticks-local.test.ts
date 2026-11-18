import { beforeEach, describe, expect, it } from 'vitest';
import { markUserDataComplete, runMigrations, stampLocalUserId } from '@boardsesh/offline-sync';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';
import { readActivityTicksLocal } from '../get-activity-ticks-local';

let db: TestSqliteDb;

async function insertTick(
  uuid: string,
  {
    ownerId = 'user-a',
    boardType = 'kilter',
    climbUuid = 'climb-1',
    angle = 40,
    status = 'send',
    difficulty = null,
    climbedAt = '2026-11-17T18:00:00.000Z',
  }: {
    ownerId?: string | null;
    boardType?: string;
    climbUuid?: string;
    angle?: number;
    status?: string;
    difficulty?: number | null;
    climbedAt?: string;
  } = {},
): Promise<void> {
  await db.runAsync(
    `INSERT INTO boardsesh_ticks
       (uuid, climb_uuid, user_id, board_type, angle, is_mirror, status, attempt_count,
        quality, difficulty, comment, climbed_at, is_benchmark)
     VALUES (?, ?, ?, ?, ?, 0, ?, 1, NULL, ?, '', ?, 0)`,
    [uuid, climbUuid, ownerId, boardType, angle, status, difficulty, climbedAt],
  );
}

beforeEach(async () => {
  db = createTestDatabase();
  await runMigrations(db);
  await stampLocalUserId(db, 'user-a');
  await markUserDataComplete(db);
});

describe('readActivityTicksLocal', () => {
  it('reads every board, with the climber grade first and the consensus as fallback', async () => {
    await db.runAsync(
      `INSERT INTO board_climbs (uuid, board_type, layout_id, name) VALUES ('climb-1', 'kilter', 8, 'Jolly Roger')`,
    );
    await db.runAsync(
      `INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty)
       VALUES ('kilter', 'climb-1', 40, 21.6)`,
    );
    await insertTick('own-grade', { difficulty: 18 });
    await insertTick('consensus', { status: 'flash', climbedAt: '2026-11-16T18:00:00.000Z' });
    await insertTick('other-board', { boardType: 'tension', climbUuid: 'climb-9', status: 'attempt' });

    const rows = await readActivityTicksLocal(db, 'user-a');
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'send', difficulty: 18, climbName: 'Jolly Roger', layoutId: 8 }),
        expect.objectContaining({ status: 'flash', difficulty: 22, climbName: 'Jolly Roger' }),
        expect.objectContaining({ boardType: 'tension', difficulty: null, climbName: null, layoutId: null }),
      ]),
    );
  });

  it('collapses Aurora twins and leaves out another account', async () => {
    await insertTick('twin-a');
    await insertTick('twin-b');
    await insertTick('legacy', { ownerId: null, climbedAt: '2026-11-15T10:00:00.000Z' });
    await insertTick('someone-else', { ownerId: 'user-b', climbedAt: '2026-11-14T10:00:00.000Z' });

    expect(await readActivityTicksLocal(db, 'user-a')).toHaveLength(2);
  });

  it('declines for a viewer the rows do not belong to', async () => {
    await insertTick('mine');
    expect(await readActivityTicksLocal(db, 'user-b')).toBeNull();
  });
});
