import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestSqliteDb } from '../../testing/sqlite-test-db';
import { runMigrations } from '../../db/migrations';
import { removeDeletedClimbLocally } from '../deleted-climb-local';
import { ensureHoldIndex } from '../../holds-index/hold-index';
import { getHoldSet } from '../../holds-index/query';
import { markScopeDownloaded } from '../../testing/downloaded-scope';

const scope = { boardType: 'spray', layoutId: 123, sizeId: 123 };
const parseHoldRows = (_boardType: string, frames: string) => [{ holdId: Number(frames), holdState: 'STARTING' }];

async function seedClimb(db: TestSqliteDb, uuid: string, frames: string): Promise<void> {
  await db.runAsync(
    `INSERT INTO board_climbs (uuid, board_type, layout_id, name, frames, is_draft, is_listed, compatible_size_ids, sync_seq)
     VALUES (?, 'spray', 123, ?, ?, 0, 1, '[123]', ?)`,
    [uuid, `Climb ${uuid}`, frames, Number(frames)],
  );
  await db.runAsync(
    `INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty) VALUES ('spray', ?, 40, 12)`,
    [uuid],
  );
  await db.runAsync(
    `INSERT INTO board_climb_grades (board_type, climb_uuid, angle, confidence)
     VALUES ('spray', ?, 40, 'low')`,
    [uuid],
  );
  await db.runAsync(`INSERT INTO user_favorites (board_name, climb_uuid, angle) VALUES ('spray', ?, 40)`, [uuid]);
  await db.runAsync(
    `INSERT INTO playlist_climbs (playlist_uuid, climb_uuid, angle, position) VALUES ('p1', ?, 40, 0)`,
    [uuid],
  );
}

const countRows = async (db: TestSqliteDb, table: string, column: string, uuid: string) =>
  (await db.getFirstAsync<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`, [uuid]))!.n;

async function rowsFor(db: TestSqliteDb, uuid: string) {
  return {
    board_climbs: await countRows(db, 'board_climbs', 'uuid', uuid),
    board_climb_stats: await countRows(db, 'board_climb_stats', 'climb_uuid', uuid),
    board_climb_grades: await countRows(db, 'board_climb_grades', 'climb_uuid', uuid),
    user_favorites: await countRows(db, 'user_favorites', 'climb_uuid', uuid),
    playlist_climbs: await countRows(db, 'playlist_climbs', 'climb_uuid', uuid),
  };
}

const allZero = { board_climbs: 0, board_climb_stats: 0, board_climb_grades: 0, user_favorites: 0, playlist_climbs: 0 };
const allOne = { board_climbs: 1, board_climb_stats: 1, board_climb_grades: 1, user_favorites: 1, playlist_climbs: 1 };

describe('removeDeletedClimbLocally (#5960)', () => {
  let db: TestSqliteDb;
  beforeEach(async () => {
    db = createTestDatabase();
    await runMigrations(db);
    // The holds index only builds for a fully downloaded scope.
    await markScopeDownloaded(db, 'spray:123:123');
    await seedClimb(db, 'gone', '11');
    await seedClimb(db, 'kept', '22');
    await ensureHoldIndex(db, scope, { parseHoldRows, yieldToHost: async () => {} });
  });
  afterEach(() => db.close());

  it('removes the climb, its stats, grades, favourite, playlist entry and holds-index postings', async () => {
    expect(await getHoldSet(db, 'gone')).toEqual([{ holdId: 11, role: 0 }]);

    expect(await removeDeletedClimbLocally(db, { uuid: 'gone', boardType: 'spray' }, () => true)).toBe(true);

    expect(await rowsFor(db, 'gone')).toEqual(allZero);
    expect(await getHoldSet(db, 'gone')).toBeNull();
    // A neighbour on the same wall is untouched.
    expect(await rowsFor(db, 'kept')).toEqual(allOne);
    expect(await getHoldSet(db, 'kept')).toEqual([{ holdId: 22, role: 0 }]);
  });

  it('writes nothing once the account it was started for is gone', async () => {
    expect(await removeDeletedClimbLocally(db, { uuid: 'gone', boardType: 'spray' }, () => false)).toBe(false);
    expect(await rowsFor(db, 'gone')).toEqual(allOne);
  });

  it('answers false for a climb this device never had', async () => {
    expect(await removeDeletedClimbLocally(db, { uuid: 'never', boardType: 'spray' }, () => true)).toBe(false);
    expect(await rowsFor(db, 'kept')).toEqual(allOne);
  });
});
