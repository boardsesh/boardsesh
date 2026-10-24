import { beforeEach, describe, expect, it, vi } from 'vitest';
import { markUserDataComplete, runMigrations, stampLocalUserId, USER_DATA_COMPLETE_KEY } from '@boardsesh/offline-sync';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';
import { getFavoriteStatusLocal } from '../get-favorite-status-local';

let db: TestSqliteDb;

async function insertFavorite(
  climbUuid: string,
  {
    boardName = 'kilter',
    angle = 40,
    userId = 'user-a',
  }: { boardName?: string; angle?: number; userId?: string | null } = {},
): Promise<void> {
  await db.runAsync('INSERT INTO user_favorites (board_name, climb_uuid, angle, user_id) VALUES (?, ?, ?, ?)', [
    boardName,
    climbUuid,
    angle,
    userId,
  ]);
}

beforeEach(async () => {
  db = createTestDatabase();
  await runMigrations(db);
  await stampLocalUserId(db, 'user-a');
  await markUserDataComplete(db);
});

describe('getFavoriteStatusLocal', () => {
  it('matches the UUID-only server identity across angles and old board stamps', async () => {
    await insertFavorite('liked', { angle: 40 });
    await insertFavorite('liked', { angle: 25 });
    await insertFavorite('liked', { boardName: 'tension' });
    await insertFavorite('other-requested', { boardName: 'moonboard' });
    await insertFavorite('not-requested');

    expect(await getFavoriteStatusLocal(db, ['liked', 'not-liked', 'liked', 'other-requested'], 'user-a')).toEqual({
      favorites: ['liked', 'other-requested'],
    });
  });

  it("excludes other accounts while retaining this device's legacy ownerless writes", async () => {
    await insertFavorite('mine');
    await insertFavorite('legacy', { userId: null });
    await insertFavorite('other-user', { userId: 'user-b' });

    expect(await getFavoriteStatusLocal(db, ['mine', 'legacy', 'other-user'], 'user-a')).toEqual({
      favorites: ['mine', 'legacy'],
    });
  });

  it('returns a legitimate empty subset when the complete user data has no favorites', async () => {
    expect(await getFavoriteStatusLocal(db, ['missing'], 'user-a')).toEqual({ favorites: [] });
  });

  it('does not scan favorites for an empty request', async () => {
    await insertFavorite('mine');
    const reads = vi.spyOn(db, 'getAllAsync');
    expect(await getFavoriteStatusLocal(db, [], 'user-a')).toEqual({ favorites: [] });
    expect(reads).not.toHaveBeenCalled();
  });

  it('deduplicates the request and stays below the SQLite binding limit', async () => {
    const climbUuids = Array.from({ length: 950 }, (_, index) => `climb-${index}`);
    for (const climbUuid of [climbUuids[0], climbUuids[420], climbUuids[949]]) await insertFavorite(climbUuid);
    const reads = vi.spyOn(db, 'getAllAsync');

    expect(await getFavoriteStatusLocal(db, [...climbUuids, ...climbUuids], 'user-a')).toEqual({
      favorites: [climbUuids[0], climbUuids[420], climbUuids[949]],
    });
    expect(reads).toHaveBeenCalledTimes(3);
    expect(reads.mock.calls.map(([, params]) => (Array.isArray(params) ? params.length : 0))).toEqual([401, 401, 151]);
  });

  it.each(['other-owner', 'no-stamp', 'incomplete', 'signed-out'])(
    'declines instead of claiming no favorites for %s',
    async (gateState) => {
      await insertFavorite('mine');
      if (gateState === 'other-owner') await stampLocalUserId(db, 'user-b');
      if (gateState === 'no-stamp') await db.runAsync("DELETE FROM sync_meta WHERE key = 'local_user_id'", []);
      if (gateState === 'incomplete')
        await db.runAsync('DELETE FROM sync_meta WHERE key = ?', [USER_DATA_COMPLETE_KEY]);
      const reads = vi.spyOn(db, 'getAllAsync');

      expect(await getFavoriteStatusLocal(db, ['mine'], gateState === 'signed-out' ? '' : 'user-a')).toBeNull();
      expect(reads).not.toHaveBeenCalled();
    },
  );

  it('discards rows after an ownership change during the SQL read', async () => {
    await insertFavorite('mine');
    const originalRead = db.getAllAsync.bind(db);
    vi.spyOn(db, 'getAllAsync').mockImplementationOnce(async (source, ...params) => {
      const rows = await originalRead(source, ...(params as [never]));
      await stampLocalUserId(db, 'user-b');
      return rows;
    });

    expect(await getFavoriteStatusLocal(db, ['mine'], 'user-a')).toBeNull();
  });

  it('does not publish any chunk if ownership changes between SQLite statements', async () => {
    const climbUuids = Array.from({ length: 401 }, (_, index) => `climb-${index}`);
    await insertFavorite(climbUuids[0]);
    const originalRead = db.getAllAsync.bind(db);
    vi.spyOn(db, 'getAllAsync').mockImplementationOnce(async (source, ...params) => {
      const rows = await originalRead(source, ...(params as [never]));
      await stampLocalUserId(db, 'user-b');
      return rows;
    });

    expect(await getFavoriteStatusLocal(db, climbUuids, 'user-a')).toBeNull();
  });
});
