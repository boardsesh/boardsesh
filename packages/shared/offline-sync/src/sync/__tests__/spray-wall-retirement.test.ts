import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OfflineDatabase, QueryInvalidator } from '../../database';
import { createTestDatabase, type TestSqliteDb } from '../../testing/sqlite-test-db';
import { runMigrations } from '../../db/migrations';
import { ensureMutationQueueTable } from '../../mutation-queue/schema';
import { __resetDrainerStateForTests, beginScopePurge, setBackgrounded } from '../../mutation-queue/drainer';
import { pullSync, type RowsDeletedSink } from '../pull-client';
import { scopeSyncMetaKeys } from '../scope-teardown';
import { TABLE_CONFIGS } from '../table-config';
import { isScopeDownloadComplete, markScopeDownloadComplete, setCheckpoint } from '../checkpoints';

let db: TestSqliteDb;
const queryClient: QueryInvalidator = { invalidateQueries: vi.fn() };
type Fetch = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;
const scopeKeys = ['spray:4:4', 'spray:5:5'];

async function seed(layoutId = 4): Promise<void> {
  await db.runAsync(
    `INSERT INTO spray_walls (layout_id, board_uuid, name, photo_key, updated_at, sync_seq)
    VALUES (?, ?, 'Wall', ?, '2026-06-01T00:00:00Z', 1)`,
    [layoutId, `board-${layoutId}`, `photo-${layoutId}`],
  );
  await db.runAsync(
    `INSERT INTO board_climbs (uuid, board_type, layout_id, name, updated_at, sync_seq)
    VALUES (?, 'spray', ?, 'Climb', '2026-06-01T00:00:00Z', 1)`,
    [`climb-${layoutId}`, layoutId],
  );
  await db.runAsync(
    `INSERT INTO board_climb_stats (board_type, climb_uuid, angle, updated_at, sync_seq)
    VALUES ('spray', ?, 40, '2026-06-01T00:00:00Z', 1)`,
    [`climb-${layoutId}`],
  );
  await db.runAsync(
    `INSERT INTO board_climb_grades (board_type, climb_uuid, angle, computed_at, sync_seq)
    VALUES ('spray', ?, 40, '2026-06-01T00:00:00Z', 1)`,
    [`climb-${layoutId}`],
  );
  await markScopeDownloadComplete(db, `spray:${layoutId}:${layoutId}`);
}
function fetchPages(
  confirmation: unknown = null,
  hook?: (query: string, variables?: Record<string, unknown>) => Promise<void>,
): Fetch {
  return (async (query: string, variables?: Record<string, unknown>) => {
    await hook?.(query, variables);
    if (query.includes('ConfirmSprayWallVisibility')) return { sprayWallByLayout: confirmation };
    if (query.includes('syncDeletions')) return { syncDeletions: { deletions: [], cursor: null, hasMore: false } };
    for (const config of Object.values(TABLE_CONFIGS)) {
      if (query.includes(config.queryName))
        return { [config.queryName]: { documents: [], cursor: null, hasMore: false } };
    }
    throw new Error('Unexpected query');
  }) as Fetch;
}
async function wallCount(): Promise<number> {
  return (await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM spray_walls'))?.count ?? 0;
}
beforeEach(async () => {
  __resetDrainerStateForTests();
  db = createTestDatabase();
  await ensureMutationQueueTable(db);
  await runMigrations(db);
});
afterEach(() => {
  db.close();
  __resetDrainerStateForTests();
});

describe('confirmed inaccessible spray walls', () => {
  it('removes every downloaded row and marker, and calls the photo sink after commit', async () => {
    await seed();
    await seed(5);
    await db.runAsync("INSERT INTO boardsesh_ticks (uuid, board_type, climb_uuid) VALUES ('tick', 'spray', 'climb-4')");
    for (const key of scopeSyncMetaKeys(scopeKeys[0])) {
      if (!key.startsWith('checkpoint:') && !key.startsWith('schema-refresh:')) {
        await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [key, '1']);
      }
    }
    await db.execAsync(
      "INSERT INTO holds_index_climbs (id, uuid) VALUES (4, 'climb-4'), (5, 'climb-5'); INSERT INTO board_climb_hold_sets (climb_id, holds) VALUES (4, X'01'), (5, X'01'); INSERT INTO board_climb_hold_postings (board_type, layout_id, hold_id, climb_ids) VALUES ('spray', 4, 1, X'01'), ('spray', 5, 1, X'01');",
    );
    await setCheckpoint(db, 'checkpoint:deletions', { updatedAt: '2026-06-01T00:00:00Z', syncSeq: '10' });
    const deleted: Record<string, unknown>[] = [];
    const onRowsDeleted: RowsDeletedSink = async ({ rows }) => {
      expect(await wallCount()).toBe(1);
      deleted.push(...rows);
    };
    await pullSync(db, queryClient, fetchPages(), { enabledBoards: [scopeKeys[0]], onRowsDeleted });
    expect(await wallCount()).toBe(1);
    for (const table of ['board_climbs', 'board_climb_stats', 'board_climb_grades']) {
      expect(
        await db.getFirstAsync(
          `SELECT 1 FROM ${table} WHERE ${table === 'board_climbs' ? 'uuid' : 'climb_uuid'} = 'climb-4'`,
        ),
      ).toBeNull();
      expect(
        await db.getFirstAsync(
          `SELECT 1 FROM ${table} WHERE ${table === 'board_climbs' ? 'uuid' : 'climb_uuid'} = 'climb-5'`,
        ),
      ).not.toBeNull();
    }
    expect(await isScopeDownloadComplete(db, scopeKeys[0])).toBe(false);
    expect(await db.getFirstAsync("SELECT 1 FROM sync_meta WHERE key = 'checkpoint:deletions'")).not.toBeNull();
    expect(deleted).toMatchObject([{ board_uuid: 'board-4', photo_key: 'photo-4' }]);
    expect(await db.getFirstAsync("SELECT 1 FROM boardsesh_ticks WHERE uuid = 'tick'")).not.toBeNull();
    for (const key of scopeSyncMetaKeys(scopeKeys[0]))
      expect(await db.getFirstAsync('SELECT 1 FROM sync_meta WHERE key = ?', [key])).toBeNull();
    expect(await db.getFirstAsync('SELECT 1 FROM board_climb_hold_sets WHERE climb_id = 4')).toBeNull();
    expect(await db.getFirstAsync('SELECT 1 FROM board_climb_hold_sets WHERE climb_id = 5')).not.toBeNull();
    expect(await db.getFirstAsync('SELECT 1 FROM board_climb_hold_postings WHERE layout_id = 4')).toBeNull();
  });
  it('invalidates only the retired wall renderer keys after the deletion sink finishes', async () => {
    await seed();
    await seed(5);
    let sinkFinished = false;
    const invalidateQueries = vi.fn((filters: Parameters<QueryInvalidator['invalidateQueries']>[0]) => {
      if (
        [
          'sprayWallByLayout',
          'sprayWallRenderData',
          'sprayWall',
          'sprayWallWithVersions',
          'sprayWallRevisionRenderData',
        ].includes(String(filters.queryKey[0]))
      ) {
        expect(sinkFinished).toBe(true);
      }
    });
    await pullSync(db, { invalidateQueries }, fetchPages(), {
      enabledBoards: [scopeKeys[0]],
      onRowsDeleted: async () => {
        await Promise.resolve();
        sinkFinished = true;
      },
    });
    const wallInvalidations = invalidateQueries.mock.calls
      .map(([filters]) => filters)
      .filter((filters) =>
        [
          'sprayWallByLayout',
          'sprayWallRenderData',
          'sprayWall',
          'sprayWallWithVersions',
          'sprayWallRevisionRenderData',
        ].includes(String(filters.queryKey[0])),
      );
    expect(wallInvalidations).toEqual([
      { queryKey: ['sprayWallByLayout', 4], exact: true },
      { queryKey: ['sprayWallRenderData', 'board-4'] },
      { queryKey: ['sprayWall', 'board-4'] },
      { queryKey: ['sprayWallWithVersions', 'board-4'] },
      { queryKey: ['sprayWallRevisionRenderData', 'board-4'] },
    ]);
    const cachedKeys = [
      ['sprayWallRenderData', 'board-4', { viewerGeneration: 1 }],
      ['sprayWallRenderData', 'board-4', 2],
      ['sprayWallWithVersions', 'board-4'],
      ['sprayWallRenderData', 'board-5', { viewerGeneration: 1 }],
    ];
    const invalidatedKeys = cachedKeys.filter((queryKey) =>
      wallInvalidations.some(
        (filters) =>
          (filters.exact ? filters.queryKey.length === queryKey.length : filters.queryKey.length <= queryKey.length) &&
          filters.queryKey.every((part, index) => part === queryKey[index]),
      ),
    );
    expect(invalidatedKeys).toEqual(cachedKeys.slice(0, 3));
    expect(await wallCount()).toBe(1);
  });
  it('captures the owner tombstone UUID once and clears renderer queries without confirmation', async () => {
    await seed();
    const sink = vi.fn();
    const fetch = vi.fn(async (query: string, variables?: Record<string, unknown>) => {
      if (query.includes('syncDeletions'))
        return {
          syncDeletions: {
            deletions: [{ tableName: 'spray_walls', recordId: '4', deletedAt: '2026-06-02T00:00:00Z' }],
            cursor: { updatedAt: '2026-06-02T00:00:00Z', syncSeq: '2' },
            hasMore: false,
          },
        };
      return fetchPages()(query, variables);
    });
    const invalidateQueries = vi.fn();
    await pullSync(db, { invalidateQueries }, fetch as Fetch, { enabledBoards: [scopeKeys[0]], onRowsDeleted: sink });
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0].rows).toEqual([{ layout_id: 4, board_uuid: 'board-4', photo_key: 'photo-4' }]);
    expect(fetch.mock.calls.some(([query]) => query.includes('ConfirmSprayWallVisibility'))).toBe(false);
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['sprayWallRenderData', 'board-4'] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['sprayWallByLayout', 4], exact: true });
  });
  it('keeps an unchanged or recently edited accessible wall after an empty delta', async () => {
    await seed();
    await pullSync(db, queryClient, fetchPages({ uuid: 'board-4' }), { enabledBoards: [scopeKeys[0]] });
    expect(await wallCount()).toBe(1);
    expect(await isScopeDownloadComplete(db, scopeKeys[0])).toBe(true);
  });
  it.each([undefined, {}, { uuid: null }, 'null'])(
    'rejects malformed confirmation %j without deleting',
    async (confirmation) => {
      await seed();
      // Explicit undefined must not use the helper default.
      const fetch = fetchPages(confirmation === undefined ? {} : confirmation);
      await expect(pullSync(db, queryClient, fetch, { enabledBoards: [scopeKeys[0]] })).rejects.toThrow(
        'Invalid spray wall visibility',
      );
      expect(await wallCount()).toBe(1);
    },
  );
  it('downloads from the beginning when access returns', async () => {
    await seed();
    await pullSync(db, queryClient, fetchPages(), { enabledBoards: [scopeKeys[0]] });
    const cursors: unknown[] = [];
    const fetch = (async (query: string, variables?: Record<string, unknown>) => {
      if (query.includes('syncSprayWalls')) {
        cursors.push(variables?.cursor);
        return {
          syncSprayWalls: {
            documents: [
              {
                layout_id: 4,
                board_uuid: 'board-4',
                name: 'Wall',
                photo_key: 'photo-4',
                updated_at: '2026-06-01T00:00:00Z',
                sync_seq: '1',
              },
            ],
            cursor: { updatedAt: '2026-06-01T00:00:00Z', syncSeq: '1' },
            hasMore: false,
          },
        };
      }
      return fetchPages({ uuid: 'board-4' })(query, variables);
    }) as Fetch;
    await pullSync(db, queryClient, fetch, { enabledBoards: [scopeKeys[0]] });
    expect(cursors).toEqual([undefined]);
    expect(await wallCount()).toBe(1);
    expect(await isScopeDownloadComplete(db, scopeKeys[0])).toBe(true);
  });
  it('preserves the cache when visibility lookup transport fails', async () => {
    await seed();
    await expect(
      pullSync(
        db,
        queryClient,
        fetchPages(null, async (query) => {
          if (query.includes('ConfirmSprayWallVisibility')) throw new Error('lookup offline');
        }),
        { enabledBoards: [scopeKeys[0]] },
      ),
    ).rejects.toThrow('lookup offline');
    expect(await wallCount()).toBe(1);
  });
  it('preserves staged removals if a later scope fetch fails', async () => {
    await seed();
    await seed(5);
    await expect(
      pullSync(
        db,
        queryClient,
        fetchPages(null, async (query, variables) => {
          if (query.includes('syncSprayWalls') && variables?.layoutId === 5) throw new Error('offline');
        }),
        { enabledBoards: scopeKeys },
      ),
    ).rejects.toThrow('offline');
    expect(await wallCount()).toBe(2);
  });
  it('rolls every candidate back when a later wall delete fails', async () => {
    await seed();
    await seed(5);
    await db.execAsync(
      "CREATE TRIGGER fail_second BEFORE DELETE ON spray_walls WHEN OLD.layout_id = 5 BEGIN SELECT RAISE(ABORT, 'second wall failed'); END",
    );
    const sink = vi.fn();
    await expect(
      pullSync(db, queryClient, fetchPages(), { enabledBoards: scopeKeys, onRowsDeleted: sink }),
    ).rejects.toThrow('second wall failed');
    expect(await wallCount()).toBe(2);
    expect(await isScopeDownloadComplete(db, scopeKeys[0])).toBe(true);
    expect(sink).not.toHaveBeenCalled();
    await db.execAsync('DROP TRIGGER fail_second');
    await pullSync(db, queryClient, fetchPages(), { enabledBoards: scopeKeys });
    expect(await wallCount()).toBe(0);
  });
  it('skips a wall changed after the server confirmation', async () => {
    await seed();
    await seed(5);
    await pullSync(
      db,
      queryClient,
      fetchPages(null, async (query, variables) => {
        if (query.includes('ConfirmSprayWallVisibility') && variables?.layoutId === 5)
          await db.runAsync('UPDATE spray_walls SET sync_seq = 2 WHERE layout_id = 4');
      }),
      { enabledBoards: scopeKeys },
    );
    expect(await wallCount()).toBe(1);
    expect(await isScopeDownloadComplete(db, scopeKeys[0])).toBe(true);
  });
  it.each(['purge', 'background'] as const)('rolls back when %s lands after the writer lock', async (interrupt) => {
    await seed();
    const original = db.withExclusiveTransactionAsync.bind(db);
    const guarded: OfflineDatabase = {
      execAsync: db.execAsync.bind(db),
      runAsync: db.runAsync.bind(db),
      getFirstAsync: db.getFirstAsync.bind(db),
      getAllAsync: db.getAllAsync.bind(db),
      withExclusiveTransactionAsync: async (task) =>
        original(async (transaction) => {
          await task({
            execAsync: transaction.execAsync.bind(transaction),
            runAsync: async (sql, ...params) => {
              const result = await transaction.runAsync(sql, ...params);
              if (sql.startsWith('DELETE FROM spray_walls')) {
                if (interrupt === 'purge') beginScopePurge('spray:4')();
                else {
                  setBackgrounded(true);
                  setBackgrounded(false);
                }
              }
              return result;
            },
            getFirstAsync: transaction.getFirstAsync.bind(transaction),
            getAllAsync: transaction.getAllAsync.bind(transaction),
          });
        }),
    };
    await pullSync(guarded, queryClient, fetchPages(), { enabledBoards: [scopeKeys[0]] });
    expect(await wallCount()).toBe(1);
  });
});
