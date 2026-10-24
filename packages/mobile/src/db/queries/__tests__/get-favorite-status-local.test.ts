import { beforeEach, describe, expect, it, vi } from 'vitest';
import { markUserDataComplete, runMigrations, stampLocalUserId, USER_DATA_COMPLETE_KEY } from '@boardsesh/offline-sync';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';
import { getFavoriteStatusLocal, getPendingFavoriteOverridesLocal } from '../get-favorite-status-local';

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

describe('getPendingFavoriteOverridesLocal', () => {
  let nextFixtureId = 0;
  async function queueFavorite(
    climbUuid: string,
    operation: string,
    { status = 'pending', boardName = 'kilter', angle = 40, tableName = 'user_favorites' } = {},
  ): Promise<void> {
    await db.runAsync(
      'INSERT INTO pending_mutations (table_name, operation, payload, status, idempotency_key) VALUES (?, ?, ?, ?, ?)',
      [tableName, operation, JSON.stringify({ climbUuid, boardName, angle }), status, `fixture-${nextFixtureId++}`],
    );
  }

  it('keeps the latest queued intent by climb UUID across boards and angles', async () => {
    await queueFavorite('add', 'create');
    await queueFavorite('remove', 'delete');
    await queueFavorite('changed', 'create', { angle: 25 });
    await queueFavorite('changed', 'delete', { boardName: 'tension' });
    await queueFavorite('dead-letter', 'create', { status: 'dead_letter' });
    await queueFavorite('not-requested', 'create');
    await queueFavorite('wrong-table', 'create', { tableName: 'boardsesh_ticks' });
    await queueFavorite('unsupported-operation', 'update');

    expect(
      await getPendingFavoriteOverridesLocal(
        db,
        ['add', 'remove', 'changed', 'dead-letter', 'wrong-table', 'unsupported-operation'],
        'user-a',
      ),
    ).toEqual(
      new Map([
        ['add', true],
        ['remove', false],
        ['changed', false],
        ['dead-letter', true],
      ]),
    );
  });

  it('does not require completed pull sync to retain this account’s unsent writes', async () => {
    await queueFavorite('add', 'create');
    await db.runAsync('DELETE FROM sync_meta WHERE key = ?', [USER_DATA_COMPLETE_KEY]);
    expect(await getPendingFavoriteOverridesLocal(db, ['add'], 'user-a')).toEqual(new Map([['add', true]]));
  });

  it('uses drain order when a revived older row now has the newest intent', async () => {
    await queueFavorite('same-climb', 'create', { boardName: 'kilter' });
    await queueFavorite('same-climb', 'delete', { boardName: 'tension' });
    await db.runAsync("UPDATE pending_mutations SET created_at = '2026-10-01T12:00:00Z' WHERE operation = 'create'");
    await db.runAsync("UPDATE pending_mutations SET created_at = '2026-10-01T10:00:00Z' WHERE operation = 'delete'");

    expect(await getPendingFavoriteOverridesLocal(db, ['same-climb'], 'user-a')).toEqual(
      new Map([['same-climb', true]]),
    );
  });

  it.each(['other-owner', 'no-stamp', 'signed-out'])('does not overlay rows for %s', async (gateState) => {
    await queueFavorite('add', 'create');
    if (gateState === 'other-owner') await stampLocalUserId(db, 'user-b');
    if (gateState === 'no-stamp') await db.runAsync("DELETE FROM sync_meta WHERE key = 'local_user_id'");
    const reads = vi.spyOn(db, 'getAllAsync');
    expect(await getPendingFavoriteOverridesLocal(db, ['add'], gateState === 'signed-out' ? '' : 'user-a')).toEqual(
      new Map(),
    );
    expect(reads).not.toHaveBeenCalled();
  });

  it('drops captured intent if the owner changes while reading the outbox', async () => {
    await queueFavorite('add', 'create');
    const originalRead = db.getAllAsync.bind(db);
    vi.spyOn(db, 'getAllAsync').mockImplementationOnce(async (source, ...params) => {
      const rows = await originalRead(source, ...(params as [never]));
      await stampLocalUserId(db, 'user-b');
      return rows;
    });
    expect(await getPendingFavoriteOverridesLocal(db, ['add'], 'user-a')).toEqual(new Map());
  });
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
