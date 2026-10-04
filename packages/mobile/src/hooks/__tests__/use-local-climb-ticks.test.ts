// Verifies useLocalClimbTicks against the REAL v1 DDL via node:sqlite: which
// rows it serves, to whom, and how Aurora's duplicate ascents collapse.
//
// React surface is stubbed the same way as use-local-ticks.test.ts: useQuery is
// a shim that runs the queryFn and exposes its promise, so the hook's gate and
// SQL are exercised outside a render tree.

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { markUserDataComplete, runMigrations, stampLocalUserId } from '@boardsesh/offline-sync';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';
import type { LogbookEntry } from '@boardsesh/board-react';

let db: TestSqliteDb | null;

vi.mock('../../db', () => ({
  getDatabaseHandle: () => db,
}));

let offlineEnabled = true;
vi.mock('../../providers/feature-flags-provider', () => ({
  useOfflineDownloadsEnabled: () => offlineEnabled,
}));

// The signed-in climber, as the phone knows them without the network.
let viewerId: string | undefined = 'user-a';
vi.mock('../use-current-user-id', () => ({
  useStoredUserId: () => ({ userId: viewerId, isLoading: false }),
}));

type QueryArgs<T> = { queryKey: readonly unknown[]; queryFn: () => Promise<T>; enabled?: boolean };
const lastQuery: { result: unknown; key: readonly unknown[]; ran: boolean } = {
  result: undefined,
  key: [],
  ran: false,
};
vi.mock('@tanstack/react-query', () => ({
  useQuery: <T>({ queryKey, queryFn, enabled }: QueryArgs<T>) => {
    lastQuery.key = queryKey;
    lastQuery.ran = enabled !== false;
    lastQuery.result = enabled === false ? Promise.resolve(undefined) : queryFn();
    return { data: undefined };
  },
}));

import { useLocalClimbTicks } from '../use-local-climb-ticks';

async function runHook(
  boardName: string | null = 'kilter',
  climbUuid: string | null = 'climb-1',
  enabled = true,
): Promise<LogbookEntry[] | null | undefined> {
  useLocalClimbTicks(boardName, climbUuid, enabled);
  return (await lastQuery.result) as LogbookEntry[] | null | undefined;
}

type TickRow = {
  uuid: string;
  userId?: string | null;
  boardType?: string;
  climbUuid?: string;
  angle?: number;
  isMirror?: number;
  status?: string;
  attemptCount?: number;
  quality?: number | null;
  difficulty?: number | null;
  isBenchmark?: number;
  comment?: string;
  climbedAt?: string;
};

async function insertTick(row: TickRow): Promise<void> {
  await db!.runAsync(
    `INSERT INTO boardsesh_ticks
       (uuid, user_id, board_type, climb_uuid, angle, is_mirror, status, attempt_count, quality, difficulty,
        is_benchmark, comment, climbed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.uuid,
      row.userId === undefined ? 'user-a' : row.userId,
      row.boardType ?? 'kilter',
      row.climbUuid ?? 'climb-1',
      row.angle ?? 40,
      row.isMirror ?? 0,
      row.status ?? 'send',
      row.attemptCount ?? 3,
      row.quality ?? null,
      row.difficulty ?? null,
      row.isBenchmark ?? 0,
      row.comment ?? '',
      row.climbedAt ?? '2026-05-30T10:00:00.000Z',
    ],
  );
}

const uuidsOf = (entries: LogbookEntry[] | null | undefined) => (entries ?? []).map((entry) => entry.uuid).sort();

beforeEach(async () => {
  db = createTestDatabase();
  await runMigrations(db);
  // The state every signed-in, fully synced phone is in.
  await stampLocalUserId(db, 'user-a');
  await markUserDataComplete(db);
  offlineEnabled = true;
  viewerId = 'user-a';
  lastQuery.result = undefined;
});

describe('useLocalClimbTicks', () => {
  it("returns the climber's ticks on the climb in the shape the logbook card renders", async () => {
    await insertTick({
      uuid: 'tick-1',
      angle: 45,
      isMirror: 1,
      status: 'flash',
      attemptCount: 1,
      quality: 4,
      difficulty: 18,
      comment: 'left heel',
      climbedAt: '2026-05-30T10:00:00.000Z',
    });

    expect(await runHook()).toEqual([
      {
        uuid: 'tick-1',
        climb_uuid: 'climb-1',
        angle: 45,
        is_mirror: true,
        tries: 1,
        quality: 4,
        effectiveQuality: 4,
        difficulty: 18,
        comment: 'left heel',
        climbed_at: '2026-05-30T10:00:00.000Z',
        is_ascent: true,
        status: 'flash',
        // The phone holds no social counts. They read 0 until the server answers.
        upvotes: 0,
        downvotes: 0,
        commentCount: 0,
      },
    ]);
  });

  it('leaves out other climbs and other boards', async () => {
    await insertTick({ uuid: 'mine' });
    await insertTick({ uuid: 'other-climb', climbUuid: 'climb-2' });
    await insertTick({ uuid: 'other-board', boardType: 'tension' });

    expect(uuidsOf(await runHook())).toEqual(['mine']);
  });

  it('keeps a tick logged offline, which has no owner yet', async () => {
    await insertTick({ uuid: 'synced' });
    await insertTick({ uuid: 'offline-write', userId: null, climbedAt: '2026-05-31T10:00:00.000Z' });

    expect(uuidsOf(await runHook())).toEqual(['offline-write', 'synced']);
  });

  describe('the owner gate', () => {
    it("serves nothing when the rows on disk are another account's", async () => {
      // A sign-out whose wipe failed: user-a's rows and stamp are still here.
      await insertTick({ uuid: 'user-a-tick' });
      viewerId = 'user-b';

      expect(await runHook()).toBeNull();
    });

    it('serves nothing when no owner is stamped', async () => {
      await db!.runAsync(`DELETE FROM sync_meta WHERE key = 'local_user_id'`, []);
      await insertTick({ uuid: 'unowned', userId: null });

      expect(await runHook()).toBeNull();
    });

    it('serves nothing until every user table has synced to its tail', async () => {
      await db!.runAsync(`DELETE FROM sync_meta WHERE key = 'checkpoint:user_data_complete'`, []);
      await insertTick({ uuid: 'first-page' });

      expect(await runHook()).toBeNull();
    });

    it("leaves out a row stamped with somebody else's id even when the gate passes", async () => {
      await insertTick({ uuid: 'mine' });
      await insertTick({ uuid: 'leftover', userId: 'user-b', climbedAt: '2026-05-29T10:00:00.000Z' });

      expect(uuidsOf(await runHook())).toEqual(['mine']);
    });

    it('does not run without a signed-in climber', async () => {
      viewerId = undefined;
      await insertTick({ uuid: 'tick-1' });

      expect(await runHook()).toBeUndefined();
      expect(lastQuery.ran).toBe(false);
    });

    it('keys the cache by the viewer, so one account never reads another account’s answer', async () => {
      await runHook();
      const keyForUserA = lastQuery.key;
      viewerId = 'user-b';
      await runHook();

      expect(lastQuery.key).not.toEqual(keyForUserA);
      // Under the prefix a tick save, a drain and a pull all invalidate.
      expect(lastQuery.key.slice(0, 2)).toEqual(['localTicks', 'climb-1']);
    });
  });

  describe("Aurora's duplicate ascents", () => {
    it('collapses rows with the same natural key and payload to the smallest uuid', async () => {
      await insertTick({ uuid: 'twin-b' });
      await insertTick({ uuid: 'twin-a' });
      await insertTick({ uuid: 'twin-c' });

      expect(uuidsOf(await runHook())).toEqual(['twin-a']);
    });

    it.each([
      ['a different instant', { climbedAt: '2026-05-30T10:00:01.000Z' }],
      ['a different angle', { angle: 45 }],
      ['a different result', { status: 'attempt' }],
      ['a different try count', { attemptCount: 4 }],
      ['a different comment', { comment: 'second go' }],
      ['a different grade', { difficulty: 20 }],
      ['a different rating', { quality: 5 }],
      ['the mirrored side', { isMirror: 1 }],
      ['a benchmark flag', { isBenchmark: 1 }],
    ])('keeps two logs that differ by %s', async (_label, difference) => {
      await insertTick({ uuid: 'log-1' });
      await insertTick({ uuid: 'log-2', ...difference });

      expect(uuidsOf(await runHook())).toEqual(['log-1', 'log-2']);
    });
  });

  it.each([
    ['the caller turned it off', () => runHook('kilter', 'climb-1', false)],
    ['the offline engine is off', () => ((offlineEnabled = false), runHook())],
    ['there is no climb', () => runHook('kilter', null)],
    ['the board is not resolved', () => runHook(null)],
  ])('does not read when %s', async (_label, run) => {
    await insertTick({ uuid: 'tick-1' });

    expect(await run()).toBeUndefined();
    expect(lastQuery.ran).toBe(false);
  });

  it('serves nothing when there is no database handle', async () => {
    db = null;
    expect(await runHook()).toBeNull();
  });
});
