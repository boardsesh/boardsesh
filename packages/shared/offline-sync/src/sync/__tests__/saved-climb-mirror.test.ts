import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqlValue } from '../../database';
import { createTestDatabase, type TestSqliteDb } from '../../testing/sqlite-test-db';
import { runMigrations } from '../../db/migrations';
import { ensureMutationQueueTable } from '../../mutation-queue/schema';
import { __resetDrainerStateForTests } from '../../mutation-queue/drainer';
import { mirrorSavedClimb } from '../saved-climb-mirror';
import { stampLocalUserId } from '../local-user-owner';
import { getProtectedCheckpoint, setProtectedCheckpoint, type ProtectedCheckpoint } from '../checkpoints';
import { markScopeDownloaded } from '../../testing/downloaded-scope';
import { refreshRevisionFor } from '../table-config';
import { ensureHoldIndex } from '../../holds-index/hold-index';
import { getHoldSet } from '../../holds-index/query';
import { pullSync } from '../pull-client';

const scope = { boardType: 'spray', layoutId: 123, sizeId: 123 };
const scopeKey = 'spray:123:123';
// A spray wall has no reference stream: its climbs and stats are pulled through
// the protected one, so that is the cursor a mirror must leave alone.
const protectedCursor = (tableName: string): ProtectedCheckpoint => ({
  updatedAt: '2026-01-01T00:00:00.000Z',
  syncSeq: '1',
  complete: true,
  revision: refreshRevisionFor(tableName, 'spray') ?? 0,
});
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
    await markScopeDownloaded(db, scopeKey);
    for (const tableName of ['board_climbs', 'board_climb_stats']) {
      await setProtectedCheckpoint(db, `checkpoint:${tableName}:${scopeKey}`, protectedCursor(tableName));
    }
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
    for (const tableName of ['board_climbs', 'board_climb_stats']) {
      expect(await getProtectedCheckpoint(db, `checkpoint:${tableName}:${scopeKey}`)).toEqual(
        protectedCursor(tableName),
      );
    }
  });

  // `syncClimbDocuments` returns the stored first-ascent name. A mirrored climb
  // is a protected write, and those keep no name on the device (issue #6306).
  it('stores no first-ascent name, and clears one an earlier write left on the row', async () => {
    await db.runAsync(
      `INSERT INTO board_climb_stats (board_type, climb_uuid, angle, fa_username, fa_at, updated_at, sync_seq)
       VALUES ('spray', 'new-climb', 40, 'Stored earlier', '2025-01-01T00:00:00Z', '2026-01-01T00:00:00.000Z', 1)`,
    );
    const named = {
      ...fresh,
      stats: [{ ...fresh.stats[0], fa_username: 'First Ascensionist', fa_at: '2026-01-01T00:00:00Z' }],
    };

    expect(await mirrorSavedClimb(db, scope, 'new-climb', named, () => true)).toBe(true);

    expect(await db.getAllAsync('SELECT fa_username, fa_at, display_difficulty FROM board_climb_stats')).toEqual([
      { fa_username: null, fa_at: null, display_difficulty: 12 },
    ]);
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

  // The protected page in flight was built before the save, so it carries an
  // older version of the saved climb. Run once as an ordinary delta, and once as
  // the replay from the epoch a cursor behind the table's refresh revision takes.
  it.each([
    ['a delta from its cursor', false],
    ['a replay after a refresh revision bump', true],
  ])('keeps mirrored rows and indexes delayed rows when the page in flight is %s', async (_label, staleRevision) => {
    if (staleRevision) {
      await setProtectedCheckpoint(db, `checkpoint:board_climbs:${scopeKey}`, {
        ...protectedCursor('board_climbs'),
        revision: 0,
      });
    }
    const climbCursors: unknown[] = [];
    let releasePull!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releasePull = resolve;
    });
    let climbPageStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      climbPageStarted = resolve;
    });
    const oldCursor = { updatedAt: '2026-01-01T00:00:10.000Z', syncSeq: '50' };
    const fetch = async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
      const name = query.match(/\{\s*\n?\s*(sync[A-Za-z]+)\(/)?.[1];
      if (!name) throw new Error('Unexpected sync query');
      if (name === 'syncClimbs') {
        climbCursors.push(variables?.cursor);
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
    const pending = pullSync(db, { invalidateQueries: vi.fn() }, fetch, { enabledBoards: [scopeKey] });
    await started;
    await mirrorSavedClimb(db, scope, 'new-climb', fresh, () => true);
    const parseHoldRows = (_boardType: string, frames: string) => [{ holdId: Number(frames), holdState: 'STARTING' }];
    await ensureHoldIndex(db, scope, { parseHoldRows, yieldToHost: async () => {} });
    expect(await getHoldSet(db, 'new-climb')).toEqual([{ holdId: 11, role: 0 }]);
    releasePull();
    await pending;
    // The page invalidated the watermark the mirror's build had moved ahead of it.
    await ensureHoldIndex(db, scope, { parseHoldRows, yieldToHost: async () => {} });
    expect(await getHoldSet(db, 'delayed-climb')).toEqual([{ holdId: 22, role: 0 }]);
    expect(await db.getFirstAsync("SELECT name, sync_seq FROM board_climbs WHERE uuid = 'new-climb'")).toMatchObject({
      name: 'New climb',
      sync_seq: 100,
    });
    expect(await db.getFirstAsync('SELECT display_difficulty FROM board_climb_stats')).toMatchObject({
      display_difficulty: 12,
    });
    // One request either way: from the stored cursor, or from the epoch.
    expect(climbCursors).toEqual([staleRevision ? undefined : { updatedAt: '2026-01-01T00:00:00.000Z', syncSeq: '1' }]);
    expect(await getProtectedCheckpoint(db, `checkpoint:board_climbs:${scopeKey}`)).toEqual({
      ...oldCursor,
      complete: true,
      revision: refreshRevisionFor('board_climbs', 'spray'),
    });
  });
});
