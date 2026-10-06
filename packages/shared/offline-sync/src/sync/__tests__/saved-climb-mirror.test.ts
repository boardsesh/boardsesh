import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqlValue } from '../../database';
import { createTestDatabase, type TestSqliteDb } from '../../testing/sqlite-test-db';
import { runMigrations } from '../../db/migrations';
import { ensureMutationQueueTable } from '../../mutation-queue/schema';
import { __resetDrainerStateForTests } from '../../mutation-queue/drainer';
import { mirrorSavedClimb } from '../saved-climb-mirror';
import { stampLocalUserId } from '../local-user-owner';
import { markScopeDownloadComplete, setCheckpoint, getCheckpoint } from '../checkpoints';
import { markSchemaRefreshComplete, schemaRefreshKey } from '../schema-refresh';
import { ensureHoldIndex } from '../../holds-index/hold-index';
import { getHoldSet } from '../../holds-index/query';
import { pullSync } from '../pull-client';

const scope = { boardType: 'spray', layoutId: 123, sizeId: 123 };
const scopeKey = 'spray:123:123';
const checkpoint = { updatedAt: '2026-01-01T00:00:00.000Z', syncSeq: '1' };
const fresh = {
  viewerId: 'setter',
  climb: {
    uuid: 'new-climb',
    board_type: 'spray',
    layout_id: 123,
    name: 'New climb',
    user_id: 'setter',
    frames: '11',
    is_draft: false,
    is_listed: true,
    is_hidden: false,
    retired_by_reset: false,
    compatible_size_ids: [123],
    updated_at: '2026-01-01T00:00:20.000123Z',
    sync_seq: '100',
  },
  stats: [
    {
      board_type: 'spray',
      climb_uuid: 'new-climb',
      angle: 40,
      display_difficulty: 12,
      updated_at: '2026-01-01T00:00:20.000123Z',
      sync_seq: '101',
    },
  ],
};

describe('canonical saved-climb mirror on real SQLite', () => {
  let db: TestSqliteDb;
  beforeEach(async () => {
    __resetDrainerStateForTests();
    db = createTestDatabase();
    await runMigrations(db);
    await ensureMutationQueueTable(db);
    await stampLocalUserId(db, 'setter');
    await markScopeDownloadComplete(db, scopeKey);
    await setCheckpoint(db, 'checkpoint:board_climbs:' + scopeKey, checkpoint);
    await setCheckpoint(db, 'checkpoint:board_climb_stats:' + scopeKey, checkpoint);
    await markSchemaRefreshComplete(db, 'board_climbs', scopeKey, checkpoint);
  });
  afterEach(() => db.close());

  it('writes both tables immediately without moving existing checkpoints', async () => {
    expect(await mirrorSavedClimb(db, scope, 'new-climb', fresh, () => true)).toBe(true);
    expect(await db.getFirstAsync('SELECT name, compatible_size_ids FROM board_climbs')).toMatchObject({
      name: 'New climb',
      compatible_size_ids: '[123]',
    });
    expect(await db.getFirstAsync('SELECT display_difficulty FROM board_climb_stats')).toMatchObject({
      display_difficulty: 12,
    });
    expect(await getCheckpoint(db, 'checkpoint:board_climbs:' + scopeKey)).toEqual(checkpoint);
    expect(await getCheckpoint(db, 'checkpoint:board_climb_stats:' + scopeKey)).toEqual(checkpoint);
  });

  it('stamps the authenticated viewer while retaining another setter attribution', async () => {
    const ownerEdit = { ...fresh, climb: { ...fresh.climb, user_id: 'other-setter' } };
    expect(await mirrorSavedClimb(db, scope, 'new-climb', ownerEdit, () => true)).toBe(true);
    expect(await db.getFirstAsync('SELECT user_id FROM board_climbs')).toMatchObject({ user_id: 'other-setter' });
    expect(
      await mirrorSavedClimb(db, scope, 'new-climb', { ...ownerEdit, viewerId: 'other-account' }, () => true),
    ).toBe(false);
  });

  it('rolls back the first table when account generation changes during a bridge await', async () => {
    let generationCurrent = true;
    const original = db.withExclusiveTransactionAsync.bind(db);
    vi.spyOn(db, 'withExclusiveTransactionAsync').mockImplementation((task) =>
      original(async (transaction) => {
        const run = transaction.runAsync.bind(transaction);
        transaction.runAsync = async (query: string, ...params: (SqlValue | SqlValue[])[]) => {
          const bindParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : (params as SqlValue[]);
          const result = await run(query, bindParams);
          if (query.startsWith('INSERT INTO board_climbs')) generationCurrent = false;
          return result;
        };
        await task(transaction);
      }),
    );
    expect(await mirrorSavedClimb(db, scope, 'new-climb', fresh, () => generationCurrent)).toBe(false);
    expect(await db.getFirstAsync('SELECT uuid FROM board_climbs')).toBeNull();
    expect(await db.getFirstAsync('SELECT climb_uuid FROM board_climb_stats')).toBeNull();
  });

  it('declines a mismatched account owner and rejects a mismatched document scope', async () => {
    await stampLocalUserId(db, 'another-account');
    expect(await mirrorSavedClimb(db, scope, 'new-climb', fresh, () => true)).toBe(false);
    await expect(mirrorSavedClimb(db, { ...scope, layoutId: 124 }, 'new-climb', fresh, () => true)).rejects.toThrow(
      'scope',
    );
    expect(await db.getFirstAsync('SELECT uuid FROM board_climbs')).toBeNull();
  });

  it.each([false, true])('keeps mirrored rows and indexes delayed rows during refresh=%s', async (refresh) => {
    if (refresh) await db.runAsync('DELETE FROM sync_meta WHERE key = ?', [schemaRefreshKey('board_climbs', scopeKey)]);
    let climbReads = 0;
    let releasePull!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releasePull = resolve;
    });
    let climbPageStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      climbPageStarted = resolve;
    });
    const oldCursor = { updatedAt: '2026-01-01T00:00:10.000Z', syncSeq: '50' };
    const fetch = async <T>(query: string): Promise<T> => {
      const name = query.match(/\{\s*\n?\s*(sync[A-Za-z]+)\(/)?.[1];
      if (!name) throw new Error('Unexpected sync query');
      if (name === 'syncClimbs') {
        climbReads += 1;
        if (refresh && climbReads === 1)
          return { syncClimbs: { documents: [], cursor: checkpoint, hasMore: false } } as T;
        climbPageStarted();
        await blocked;
      }
      const documents =
        name === 'syncClimbs'
          ? [
              {
                ...fresh.climb,
                uuid: 'delayed-climb',
                name: 'Delayed climb',
                frames: '22',
                updated_at: oldCursor.updatedAt,
                sync_seq: '40',
              },
              { ...fresh.climb, name: 'Old climb', updated_at: oldCursor.updatedAt, sync_seq: '50' },
            ]
          : name === 'syncClimbStats'
            ? [{ ...fresh.stats[0], display_difficulty: 1, updated_at: oldCursor.updatedAt, sync_seq: '51' }]
            : [];
      const cursor = name === 'syncClimbStats' ? { ...oldCursor, syncSeq: '51' } : oldCursor;
      return {
        [name]:
          name === 'syncDeletions'
            ? { deletions: [], cursor: oldCursor, hasMore: false }
            : { documents, cursor, hasMore: false },
      } as T;
    };
    const pending = pullSync(db, { invalidateQueries: vi.fn() }, fetch, {
      enabledBoards: [scopeKey],
      isOnUnmeteredNetwork: async () => refresh,
    });
    await started;
    await mirrorSavedClimb(db, scope, 'new-climb', fresh, () => true);
    const parseHoldRows = (_boardType: string, frames: string) => [{ holdId: Number(frames), holdState: 'STARTING' }];
    await ensureHoldIndex(db, scope, { parseHoldRows, yieldToHost: async () => {} });
    expect(await getHoldSet(db, 'new-climb')).toEqual([{ holdId: 11, role: 0 }]);
    releasePull();
    await pending;
    // Both ordinary and refresh pages invalidate the ahead-of-pull watermark.
    await ensureHoldIndex(db, scope, { parseHoldRows, yieldToHost: async () => {} });
    expect(await getHoldSet(db, 'delayed-climb')).toEqual([{ holdId: 22, role: 0 }]);
    expect(await db.getFirstAsync("SELECT name, sync_seq FROM board_climbs WHERE uuid = 'new-climb'")).toMatchObject({
      name: 'New climb',
      sync_seq: 100,
    });
    expect(await db.getFirstAsync('SELECT display_difficulty FROM board_climb_stats')).toMatchObject({
      display_difficulty: 12,
    });
  });
});
