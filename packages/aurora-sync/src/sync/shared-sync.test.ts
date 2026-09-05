import { beforeEach, describe, expect, it, vi } from 'vitest';
import { notifications, setterFollows, userBoardMappings, userFollows } from '@boardsesh/db/schema';
import type { ClimbStats, SyncData } from '../api/sync-api-types';
import type { SyncOptions } from '../api/types';

const { mockSharedSync, mockPopulateDenormalizedColumns, mockConvertLitUpHolds, mockSnapshotHistory } = vi.hoisted(
  () => ({
    mockSharedSync: vi.fn(),
    mockPopulateDenormalizedColumns: vi.fn().mockResolvedValue(undefined),
    mockConvertLitUpHolds: vi.fn().mockReturnValue({}),
    mockSnapshotHistory: vi.fn().mockResolvedValue({ written: 0, skipped: true }),
  }),
);

vi.mock('../api/shared-sync-api', () => ({
  sharedSync: mockSharedSync,
}));

vi.mock('@boardsesh/db/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@boardsesh/db/queries')>();
  return {
    // Spread first so any other export from this module stays real. Listing
    // only the stubs would leave every unlisted import silently undefined the
    // moment shared-sync.ts reaches for one.
    ...actual,
    populateDenormalizedColumns: mockPopulateDenormalizedColumns,
    snapshotClimbStatsHistoryIfDue: mockSnapshotHistory,
    // setterSyncNotificationUuid deliberately NOT stubbed: the deterministic
    // uuid IS the duplicate-notification backstop, so a stub would stop
    // covering it.
  };
});

vi.mock('@boardsesh/board-constants/hold-states', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@boardsesh/board-constants/hold-states')>();
  // Only the parser is stubbed. `isSentinelHoldState` stays real so this file
  // tests the writer against the same predicate production uses.
  return { ...actual, convertLitUpHoldsStringToMap: mockConvertLitUpHolds };
});

// drizzle() returns a client we never actually issue queries against; the
// shim below replaces its surface area entirely. We only mock `drizzle`
// itself so the import doesn't fail.
vi.mock('drizzle-orm/postgres-js', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm/postgres-js')>('drizzle-orm/postgres-js');
  return {
    ...actual,
    drizzle: vi.fn(() => createDbShim()),
  };
});

import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  climbListingConflictSet,
  climbStatsUpstreamConflictSet,
  createSetterSyncNotifications,
  healRequiredSetIds,
  parseDifficultyFields,
  REQUIRED_SET_ID_DRAIN_LIMIT,
  shouldHealRequiredSetIds,
  syncSharedData,
} from './shared-sync';

/**
 * Minimal db shim. Drizzle's query builder is fluent — every call returns
 * `this` until awaited. We don't care about the SQL produced; we only need
 * the `transaction` callback and the `select`/`insert` chains to be
 * thenable. The fluent shim short-circuits all chained methods to itself
 * and resolves to an empty array for SELECTs.
 */
/**
 * Every row handed to a `.values(...)` call on the shim, in call order.
 * Module-level because the shim is built inside the mocked `drizzle()`
 * factory, which the test never gets a handle on. Suites that read it clear
 * it in their own `beforeEach` and filter by climb uuid, so rows written by
 * another suite cannot be mistaken for theirs.
 */
const shimInsertedRows: Array<Record<string, unknown>> = [];

/**
 * Every `set` object handed to an `.onConflictDoUpdate(...)` call on the
 * shim, in call order. Lets a test assert on the conflict clause the query
 * builder actually RECORDED for a write — rebuilding the same clause by
 * calling the production helper again would be a tautology that stays green
 * even if the write path stops using the helper.
 */
const shimConflictSets: Array<Record<string, unknown>> = [];
const shimExistingClimbStatRows: Array<{ climbUuid: string; angle: number }> = [];
const shimClimbStatSelectPredicates: SQL[] = [];

function createDbShim() {
  const fluent: Record<string, unknown> = {};
  const proxy: ProxyHandler<typeof fluent> = {
    get(_target, prop) {
      if (prop === 'then') return undefined; // not a thenable, just chainable
      if (prop === Symbol.toPrimitive) return undefined;
      if (prop === 'transaction') {
        return async (cb: (tx: typeof shim) => Promise<void>) => cb(shim);
      }
      if (prop === 'execute') return async () => undefined;
      if (prop === 'select') {
        return (selectedColumns: Record<string, unknown>) => {
          const isClimbStatKeySelect = 'climbUuid' in selectedColumns && 'angle' in selectedColumns;
          const rows = isClimbStatKeySelect ? [...shimExistingClimbStatRows] : [];
          const terminal = Object.assign(Promise.resolve(rows), {
            limit: () => Promise.resolve(rows),
          });
          return {
            from: () => ({
              where: (predicate: SQL) => {
                if (isClimbStatKeySelect) shimClimbStatSelectPredicates.push(predicate);
                return terminal;
              },
            }),
          };
        };
      }
      // Every method (insert, select, values, where, onConflictDoUpdate, etc.)
      // returns the same fluent object, so chains keep flowing. The terminal
      // `await` resolves to whatever the proxy is — fine for INSERTs (we don't
      // read the result) and SELECTs that hit `.from(...)`.
      return new Proxy(() => shim, {
        apply: (_target, _thisArg, args: unknown[]) => {
          // Record INSERT payloads so a test can assert on what would hit
          // the database without needing a real one.
          if (prop === 'values' && Array.isArray(args[0])) {
            shimInsertedRows.push(...(args[0] as Array<Record<string, unknown>>));
          }
          // Record conflict clauses so a test can assert on the SET a write
          // actually shipped, not on a helper re-invoked inside the test.
          if (prop === 'onConflictDoUpdate' && args[0] != null && typeof args[0] === 'object') {
            const { set } = args[0] as { set?: Record<string, unknown> };
            if (set != null) shimConflictSets.push(set);
          }
          return shim;
        },
      });
    },
  };
  const shim = new Proxy(fluent, proxy) as Record<string, unknown> & {
    transaction: (cb: (tx: unknown) => Promise<void>) => Promise<void>;
  };
  return shim;
}

function complete(payload: Partial<SyncData>): SyncData {
  return { _complete: true, ...payload };
}

function partial(payload: Partial<SyncData>): SyncData {
  return { _complete: false, ...payload };
}

describe('syncSharedData loop', () => {
  beforeEach(() => {
    mockSharedSync.mockReset();
    mockPopulateDenormalizedColumns.mockReset();
    mockPopulateDenormalizedColumns.mockResolvedValue(undefined);
  });

  it('exits after one batch when Aurora reports _complete', async () => {
    mockSharedSync.mockResolvedValueOnce(complete({ shared_syncs: [] }));

    const result = await syncSharedData(fakePostgresClient(), 'decoy', 'token');

    expect(mockSharedSync).toHaveBeenCalledTimes(1);
    expect(result.complete).toBe(true);
    expect(result.newClimbs).toEqual([]);
  });

  it('keeps looping while _complete is false', async () => {
    mockSharedSync
      .mockResolvedValueOnce(
        partial({ shared_syncs: [{ table_name: 'climbs', last_synchronized_at: '2026-01-01 00:00:00' }] }),
      )
      .mockResolvedValueOnce(
        partial({ shared_syncs: [{ table_name: 'climbs', last_synchronized_at: '2026-02-01 00:00:00' }] }),
      )
      .mockResolvedValueOnce(
        complete({ shared_syncs: [{ table_name: 'climbs', last_synchronized_at: '2026-03-01 00:00:00' }] }),
      );

    await syncSharedData(fakePostgresClient(), 'decoy', 'token');

    expect(mockSharedSync).toHaveBeenCalledTimes(3);
  });

  it('stops at MAX_SYNC_ATTEMPTS even when Aurora never reports _complete', async () => {
    // Always partial — never complete.
    mockSharedSync.mockResolvedValue(partial({ shared_syncs: [] }));

    const result = await syncSharedData(fakePostgresClient(), 'decoy', 'token');

    expect(mockSharedSync).toHaveBeenCalledTimes(100); // MAX_SYNC_ATTEMPTS
    expect(result.complete).toBe(false);
  });
});

describe('board_climb_holds writes', () => {
  beforeEach(() => {
    mockSharedSync.mockReset();
    mockConvertLitUpHolds.mockReset();
    mockPopulateDenormalizedColumns.mockReset();
    mockPopulateDenormalizedColumns.mockResolvedValue(undefined);
    shimInsertedRows.length = 0;
  });

  it('never writes a hold row whose state is the unmapped-role sentinel (#3948)', async () => {
    // An unmapped role code decodes to the `{holdId}={code}` sentinel rather
    // than a real hold state. `backfill-board-climb-holds.ts` already drops
    // those; if this writer keeps them they poison the fingerprint backfill
    // and the similarity signatures built on top of it.
    mockConvertLitUpHolds.mockReturnValue({
      0: {
        100: { state: 'STARTING', color: '#00FF00', displayColor: '#00FF00' },
        200: { state: '200=999', color: '#FFF', displayColor: '#FFF' },
      },
    });
    mockSharedSync.mockResolvedValueOnce(
      complete({
        climbs: [{ uuid: 'CLIMB-1', frames: 'p100r1p200r999', layout_id: 1, name: 'sentinel climb' }],
      } as Partial<SyncData>),
    );

    await syncSharedData(fakePostgresClient(), 'decoy', 'token');

    const holdRows = shimInsertedRows.filter((row) => 'holdId' in row && row.climbUuid === 'CLIMB-1');
    expect(holdRows).toEqual([
      { boardType: 'decoy', climbUuid: 'CLIMB-1', frameNumber: 0, holdId: 100, holdState: 'STARTING' },
    ]);
  });

  it('writes one row per (frame, hold) for the states that do resolve', async () => {
    mockConvertLitUpHolds.mockReturnValue({
      0: { 100: { state: 'STARTING', color: '#00FF00', displayColor: '#00FF00' } },
      1: {
        100: { state: 'STARTING', color: '#00FF00', displayColor: '#00FF00' },
        300: { state: 'HAND', color: '#0000FF', displayColor: '#4444FF' },
      },
    });
    mockSharedSync.mockResolvedValueOnce(
      complete({
        climbs: [{ uuid: 'CLIMB-2', frames: 'p100r1,"p300r2', layout_id: 1, name: 'two frames' }],
      } as Partial<SyncData>),
    );

    await syncSharedData(fakePostgresClient(), 'decoy', 'token');

    const holdRows = shimInsertedRows.filter((row) => 'holdId' in row && row.climbUuid === 'CLIMB-2');
    expect(holdRows).toEqual([
      { boardType: 'decoy', climbUuid: 'CLIMB-2', frameNumber: 0, holdId: 100, holdState: 'STARTING' },
      { boardType: 'decoy', climbUuid: 'CLIMB-2', frameNumber: 1, holdId: 100, holdState: 'STARTING' },
      { boardType: 'decoy', climbUuid: 'CLIMB-2', frameNumber: 1, holdId: 300, holdState: 'HAND' },
    ]);
  });
});

describe('board_climb_stats fa_username / fa_at sanitization (issue #3536)', () => {
  beforeEach(() => {
    mockSharedSync.mockReset();
    mockPopulateDenormalizedColumns.mockReset();
    mockPopulateDenormalizedColumns.mockResolvedValue(undefined);
    shimInsertedRows.length = 0;
  });

  function climbStat(over: Partial<ReturnType<typeof baseClimbStat>>) {
    return { ...baseClimbStat(), ...over };
  }

  function baseClimbStat() {
    return {
      climb_uuid: 'CLIMB-STATS',
      angle: 40,
      display_difficulty: 20,
      benchmark_difficulty: 20,
      ascensionist_count: 5,
      difficulty_average: 20.1,
      quality_average: 3,
      fa_username: 'somebody',
      fa_at: '2024-03-15T12:34:56.000Z',
    };
  }

  it('nulls fa_username/fa_at for a future fa_at (2033 garbage) via the real syncSharedData write path', async () => {
    mockSharedSync.mockResolvedValueOnce(
      complete({
        climb_stats: [climbStat({ climb_uuid: 'CLIMB-FUTURE', fa_at: '2033-01-01T00:00:00.000Z' })],
      } as Partial<SyncData>),
    );

    await syncSharedData(fakePostgresClient(), 'decoy', 'token');

    const statsRows = shimInsertedRows.filter(
      (row) => 'upstreamQualityAverage' in row && row.climbUuid === 'CLIMB-FUTURE',
    );
    expect(statsRows).toHaveLength(1);
    expect(statsRows[0]).toMatchObject({ faUsername: null, faAt: null });
  });

  it('nulls fa_username/fa_at for a pre-2016 fa_at via the real syncSharedData write path', async () => {
    mockSharedSync.mockResolvedValueOnce(
      complete({
        climb_stats: [climbStat({ climb_uuid: 'CLIMB-PAST', fa_at: '2006-01-01T00:00:00.000Z' })],
      } as Partial<SyncData>),
    );

    await syncSharedData(fakePostgresClient(), 'decoy', 'token');

    const statsRows = shimInsertedRows.filter(
      (row) => 'upstreamQualityAverage' in row && row.climbUuid === 'CLIMB-PAST',
    );
    expect(statsRows).toHaveLength(1);
    expect(statsRows[0]).toMatchObject({ faUsername: null, faAt: null });
  });

  it('preserves a valid fa_at and fa_username verbatim via the real syncSharedData write path', async () => {
    mockSharedSync.mockResolvedValueOnce(
      complete({
        climb_stats: [climbStat({ climb_uuid: 'CLIMB-VALID' })],
      } as Partial<SyncData>),
    );

    await syncSharedData(fakePostgresClient(), 'decoy', 'token');

    const statsRows = shimInsertedRows.filter(
      (row) => 'upstreamQualityAverage' in row && row.climbUuid === 'CLIMB-VALID',
    );
    expect(statsRows).toHaveLength(1);
    expect(statsRows[0]).toMatchObject({ faUsername: 'somebody', faAt: '2024-03-15T12:34:56.000Z' });
  });
});

describe('syncSharedData cursor merge', () => {
  beforeEach(() => {
    mockSharedSync.mockReset();
    mockPopulateDenormalizedColumns.mockReset();
    mockPopulateDenormalizedColumns.mockResolvedValue(undefined);
  });

  it('keeps the cursor for tables Aurora did not return in the latest batch', async () => {
    // Batch 1: Aurora returns shared_syncs only for climbs. Other tables
    // (products, holes, etc.) had no new data; their cursors must not reset.
    mockSharedSync
      .mockResolvedValueOnce(
        partial({
          shared_syncs: [{ table_name: 'climbs', last_synchronized_at: '2026-04-01 00:00:00' }],
        }),
      )
      .mockResolvedValueOnce(complete({ shared_syncs: [] }));

    await syncSharedData(fakePostgresClient(), 'decoy', 'token');

    // The second call's syncOptions.sharedSyncs should still contain all 15
    // tables, with `climbs` advanced to 2026-04-01 and the rest at the
    // default floor (2024-05-01) since the in-memory map was seeded empty.
    const secondCallOptions = mockSharedSync.mock.calls[1][1] as SyncOptions;
    const cursors = new Map((secondCallOptions.sharedSyncs ?? []).map((s) => [s.table_name, s.last_synchronized_at]));
    expect(cursors.get('climbs')).toBe('2026-04-01 00:00:00');
    expect(cursors.get('products')).toBe('2024-05-01 00:00:00.000000');
    expect(cursors.get('holes')).toBe('2024-05-01 00:00:00.000000');
    // 15 entries — every shared-sync table is represented every batch.
    expect(secondCallOptions.sharedSyncs?.length).toBe(15);
  });

  it('advances cursors progressively as Aurora returns updates over multiple batches', async () => {
    mockSharedSync
      .mockResolvedValueOnce(
        partial({
          shared_syncs: [{ table_name: 'climbs', last_synchronized_at: '2026-01-01 00:00:00' }],
        }),
      )
      .mockResolvedValueOnce(
        partial({
          shared_syncs: [{ table_name: 'climbs', last_synchronized_at: '2026-02-01 00:00:00' }],
        }),
      )
      .mockResolvedValueOnce(
        complete({
          shared_syncs: [{ table_name: 'climbs', last_synchronized_at: '2026-03-01 00:00:00' }],
        }),
      );

    await syncSharedData(fakePostgresClient(), 'decoy', 'token');

    const climbsCursors = mockSharedSync.mock.calls.map((call) => {
      const opts = call[1] as SyncOptions;
      return opts.sharedSyncs?.find((s) => s.table_name === 'climbs')?.last_synchronized_at;
    });
    expect(climbsCursors).toEqual([
      '2024-05-01 00:00:00.000000', // batch 1: in-memory map empty → default floor
      '2026-01-01 00:00:00', // batch 2: after batch 1's response merged
      '2026-02-01 00:00:00', // batch 3: after batch 2's response merged
    ]);
  });

  it('floors a missing cursor at 2024-05-01 rather than 1970', async () => {
    mockSharedSync.mockResolvedValueOnce(complete({ shared_syncs: [] }));

    await syncSharedData(fakePostgresClient(), 'decoy', 'token');

    const firstCallOptions = mockSharedSync.mock.calls[0][1] as SyncOptions;
    expect(firstCallOptions.sharedSyncs?.[0].last_synchronized_at).toBe('2024-05-01 00:00:00.000000');
  });
});

/**
 * postgres.js client stub. `syncSharedData` only uses it as the argument to
 * `drizzle()` — which we mock to return our shim — so the real client is
 * never invoked. Casting is fine here because no method on the actual client
 * surface is called.
 */
function fakePostgresClient(): never {
  return {} as never;
}

type FollowerRow = { followerId: string; setterUsername: string };
type MappingRow = { userId: string; boardUsername: string };
type UserFollowRow = { followerId: string; followingId: string };
type CapturedInsert = { table: unknown; rows: Array<Record<string, unknown>> };

/**
 * DB shim tailored to `createSetterSyncNotifications`. Returns seeded rows
 * for the three SELECT call shapes the function makes (setterFollows,
 * userBoardMappings, userFollows) and captures every insert chunk so tests
 * can assert on chunking and per-row payloads.
 */
function createNotificationDbShim(opts: {
  setterFollowsRows?: FollowerRow[];
  userBoardMappingsRows?: MappingRow[];
  userFollowsRows?: UserFollowRow[];
}) {
  const inserts: CapturedInsert[] = [];
  const followerSeed = opts.setterFollowsRows ?? [];
  const mappingSeed = opts.userBoardMappingsRows ?? [];
  const userFollowSeed = opts.userFollowsRows ?? [];

  const db = {
    select(_cols: unknown) {
      return {
        from(table: unknown) {
          let rows: unknown[];
          if (table === setterFollows) rows = followerSeed;
          else if (table === userBoardMappings) rows = mappingSeed;
          else if (table === userFollows) rows = userFollowSeed;
          else rows = [];

          // Drizzle's chain is `.from(table).where(cond)` (awaited at the end).
          // `createSetterSyncNotifications` always calls `.where()`, so we
          // don't need to make `.from()` itself thenable.
          return {
            where: (_cond: unknown) => Promise.resolve(rows),
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values: (rows: Array<Record<string, unknown>>) => {
          inserts.push({ table, rows });
          const noop = () => Promise.resolve();
          return Object.assign(Promise.resolve(), {
            onConflictDoNothing: noop,
            onConflictDoUpdate: noop,
          });
        },
      };
    },
  };

  type DbArg = Parameters<typeof createSetterSyncNotifications>[0];
  return { db: db as unknown as DbArg, inserts };
}

describe('createSetterSyncNotifications', () => {
  it('chunks notification inserts when followers exceed BATCH_SIZE', async () => {
    const followers: FollowerRow[] = Array.from({ length: 2500 }, (_, i) => ({
      followerId: `user-${i}`,
      setterUsername: 'setter-a',
    }));
    const { db, inserts } = createNotificationDbShim({ setterFollowsRows: followers });

    await createSetterSyncNotifications(
      db,
      'decoy',
      [{ uuid: 'climb-1', setterUsername: 'setter-a', layoutId: 1 }],
      () => {},
    );

    const notificationInserts = inserts.filter((i) => i.table === notifications);
    expect(notificationInserts).toHaveLength(3);
    expect(notificationInserts.map((i) => i.rows.length)).toEqual([1000, 1000, 500]);

    const allRows = notificationInserts.flatMap((i) => i.rows);
    expect(allRows).toHaveLength(2500);
    const uuids = new Set(allRows.map((row) => row.uuid));
    expect(uuids.size).toBe(2500);
  });

  it('uses the first climb uuid as entityId when a setter has multiple new climbs', async () => {
    const followers: FollowerRow[] = Array.from({ length: 50 }, (_, i) => ({
      followerId: `user-${i}`,
      setterUsername: 'setter-a',
    }));
    const { db, inserts } = createNotificationDbShim({ setterFollowsRows: followers });

    await createSetterSyncNotifications(
      db,
      'decoy',
      [
        { uuid: 'c1', setterUsername: 'setter-a', layoutId: 1 },
        { uuid: 'c2', setterUsername: 'setter-a', layoutId: 1 },
        { uuid: 'c3', setterUsername: 'setter-a', layoutId: 1 },
      ],
      () => {},
    );

    const allRows = inserts.filter((i) => i.table === notifications).flatMap((i) => i.rows);
    expect(allRows).toHaveLength(50);
    expect(allRows.every((row) => row.entityId === 'c1')).toBe(true);
  });

  it('skips setters with zero followers', async () => {
    const { db, inserts } = createNotificationDbShim({ setterFollowsRows: [] });

    await createSetterSyncNotifications(
      db,
      'decoy',
      [{ uuid: 'climb-1', setterUsername: 'setter-a', layoutId: 1 }],
      () => {},
    );

    expect(inserts.filter((i) => i.table === notifications)).toHaveLength(0);
  });

  it('creates notifications for users who follow a linked board account', async () => {
    const { db, inserts } = createNotificationDbShim({
      setterFollowsRows: [],
      userBoardMappingsRows: [{ userId: 'linked-user-1', boardUsername: 'setter-a' }],
      userFollowsRows: [
        { followerId: 'follower-x', followingId: 'linked-user-1' },
        { followerId: 'follower-y', followingId: 'linked-user-1' },
      ],
    });

    await createSetterSyncNotifications(
      db,
      'decoy',
      [{ uuid: 'climb-1', setterUsername: 'setter-a', layoutId: 1 }],
      () => {},
    );

    const allRows = inserts.filter((i) => i.table === notifications).flatMap((i) => i.rows);
    expect(allRows).toHaveLength(2);
    const recipientIds = new Set(allRows.map((row) => row.recipientId));
    expect(recipientIds.has('follower-x')).toBe(true);
    expect(recipientIds.has('follower-y')).toBe(true);
  });

  it('deduplicates recipients who follow the setter both directly and via linked account', async () => {
    const { db, inserts } = createNotificationDbShim({
      setterFollowsRows: [{ followerId: 'shared-follower', setterUsername: 'setter-a' }],
      userBoardMappingsRows: [{ userId: 'linked-user-1', boardUsername: 'setter-a' }],
      userFollowsRows: [{ followerId: 'shared-follower', followingId: 'linked-user-1' }],
    });

    await createSetterSyncNotifications(
      db,
      'decoy',
      [{ uuid: 'climb-1', setterUsername: 'setter-a', layoutId: 1 }],
      () => {},
    );

    const allRows = inserts.filter((i) => i.table === notifications).flatMap((i) => i.rows);
    expect(allRows).toHaveLength(1);
    expect(allRows[0].recipientId).toBe('shared-follower');
  });

  it('does not reach userFollows when no setters have linked board accounts', async () => {
    // userBoardMappings returns nothing → linkedUserIds is empty → the
    // userFollows query is skipped entirely; userFollowsRows are unreachable.
    const { db, inserts } = createNotificationDbShim({
      setterFollowsRows: [{ followerId: 'direct-follower', setterUsername: 'setter-a' }],
      userBoardMappingsRows: [],
      userFollowsRows: [{ followerId: 'indirect-follower', followingId: 'some-user' }],
    });

    await createSetterSyncNotifications(
      db,
      'decoy',
      [{ uuid: 'climb-1', setterUsername: 'setter-a', layoutId: 1 }],
      () => {},
    );

    const allRows = inserts.filter((i) => i.table === notifications).flatMap((i) => i.rows);
    expect(allRows).toHaveLength(1);
    expect(allRows[0].recipientId).toBe('direct-follower');
  });
});

describe('parseDifficultyFields', () => {
  it('passes through numeric difficulty and display values', () => {
    expect(
      parseDifficultyFields({ difficulty_average: 15.4, display_difficulty: 16, benchmark_difficulty: 17 }),
    ).toEqual({
      difficultyAverage: 15.4,
      displayDifficulty: 16,
      benchmarkDifficulty: 17,
    });
  });

  it.each([0, 1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects invalid average/display/benchmark difficulty %s',
    (difficulty) => {
      expect(
        parseDifficultyFields({
          difficulty_average: difficulty,
          display_difficulty: difficulty,
          benchmark_difficulty: difficulty,
        }),
      ).toEqual({ difficultyAverage: null, displayDifficulty: null, benchmarkDifficulty: null });
    },
  );

  it('preserves NULL difficulty instead of coercing to grade 0', () => {
    expect(
      parseDifficultyFields({ difficulty_average: null, display_difficulty: null, benchmark_difficulty: null }),
    ).toEqual({
      difficultyAverage: null,
      displayDifficulty: null,
      benchmarkDifficulty: null,
    });
  });

  it.each([null, 0, 1, Number.NaN])('falls back display_difficulty %s to the valid average', (displayDifficulty) => {
    expect(
      parseDifficultyFields({
        difficulty_average: 22.1,
        display_difficulty: displayDifficulty,
        benchmark_difficulty: null,
      }),
    ).toEqual({
      difficultyAverage: 22.1,
      displayDifficulty: 22.1,
      benchmarkDifficulty: null,
    });
  });

  it('keeps an explicit display value when the average is null', () => {
    expect(
      parseDifficultyFields({ difficulty_average: null, display_difficulty: 18, benchmark_difficulty: 1 }),
    ).toEqual({
      difficultyAverage: null,
      displayDifficulty: 18,
      benchmarkDifficulty: null,
    });
  });
});

describe('board_climb_stats empty-row guard (issue #4068)', () => {
  const dialect = new PgDialect();
  const render = (fragment: Parameters<typeof dialect.sqlToQuery>[0]) => dialect.sqlToQuery(fragment).sql.toLowerCase();

  type RecordedStatsConflictSet = {
    upstreamAscensionistCount: SQL;
    ascensionistCount: SQL;
    qualityAverage: SQL;
  };

  type RecordedStatsPolicyInput = {
    incomingUpstreamCount: number | null;
    storedUpstreamCount: number | null;
    boardseshAscensionistCount: number;
    upstreamQualityAverage: number | null;
    boardseshQualitySum: number;
    boardseshQualityCount: number;
  };

  function normalizeSql(fragment: SQL): string {
    return render(fragment).replace(/\s+/g, ' ').trim();
  }

  function recordedStatsConflictSet(): RecordedStatsConflictSet {
    const statsConflictSets = shimConflictSets.filter((set) => 'upstreamQualityAverage' in set);
    expect(statsConflictSets).toHaveLength(1);
    return statsConflictSets[0] as unknown as RecordedStatsConflictSet;
  }

  function evaluateRenderedUpstreamCount(
    rendered: string,
    incomingUpstreamCount: number | null,
    storedUpstreamCount: number | null,
  ): number {
    const coalesceMatch = rendered.match(/^coalesce\(([^()]*)\)$/);
    if (!coalesceMatch) throw new Error(`not a bare COALESCE expression: ${rendered}`);

    for (const argument of coalesceMatch[1].split(',').map((part) => part.trim())) {
      if (argument === 'excluded.upstream_ascensionist_count') {
        if (incomingUpstreamCount != null) return incomingUpstreamCount;
      } else if (argument === '"board_climb_stats"."upstream_ascensionist_count"') {
        if (storedUpstreamCount != null) return storedUpstreamCount;
      } else {
        return Number(argument);
      }
    }

    throw new Error(`no COALESCE argument resolved in: ${rendered}`);
  }

  function evaluateRecordedStatsPolicy(
    conflictSet: RecordedStatsConflictSet,
    input: RecordedStatsPolicyInput,
  ): { upstreamCount: number; totalCount: number; blendedQualityAverage: number | null } {
    const effectiveCountSql = normalizeSql(conflictSet.upstreamAscensionistCount);
    const totalCountSql = normalizeSql(conflictSet.ascensionistCount);
    const blendSql = normalizeSql(conflictSet.qualityAverage);

    // The total and BOTH upstream-weight positions in the recorded blend must
    // reuse the exact incoming-first COALESCE emitted for the count update.
    // That ties these behavioral assertions to the query builder path that ran,
    // rather than to a separately reconstructed helper expression.
    expect(totalCountSql).toBe(
      `${effectiveCountSql} + coalesce("board_climb_stats"."boardsesh_ascensionist_count", 0)`,
    );
    expect(blendSql.split(effectiveCountSql)).toHaveLength(3);
    expect(blendSql).toContain('coalesce("board_climb_stats"."boardsesh_quality_sum", 0)');
    expect(blendSql).toContain('coalesce("board_climb_stats"."boardsesh_quality_count", 0)');

    const upstreamCount = evaluateRenderedUpstreamCount(
      effectiveCountSql,
      input.incomingUpstreamCount,
      input.storedUpstreamCount,
    );
    const totalCount = upstreamCount + input.boardseshAscensionistCount;
    const upstreamWeight = input.upstreamQualityAverage == null ? 0 : upstreamCount;
    const blendWeight = upstreamWeight + input.boardseshQualityCount;
    const weightedQualitySum =
      (input.upstreamQualityAverage == null ? 0 : input.upstreamQualityAverage * upstreamCount) +
      input.boardseshQualitySum;
    const blendedQualityAverage = blendWeight === 0 ? input.upstreamQualityAverage : weightedQualitySum / blendWeight;

    return { upstreamCount, totalCount, blendedQualityAverage };
  }

  beforeEach(() => {
    mockSharedSync.mockReset();
    mockPopulateDenormalizedColumns.mockReset();
    mockPopulateDenormalizedColumns.mockResolvedValue(undefined);
    shimInsertedRows.length = 0;
    shimConflictSets.length = 0;
    shimExistingClimbStatRows.length = 0;
    shimClimbStatSelectPredicates.length = 0;
  });

  function stat(overrides: Partial<ClimbStats> = {}) {
    return { ...emptyStat(), ...overrides };
  }

  function statWithRawCount(rawCount: unknown, overrides: Partial<ClimbStats> = {}): ClimbStats {
    return { ...stat(overrides), ascensionist_count: rawCount } as unknown as ClimbStats;
  }

  function emptyStat(): ClimbStats {
    return {
      climb_uuid: 'EMPTY-STAT',
      angle: 40,
      display_difficulty: null,
      benchmark_difficulty: null,
      ascensionist_count: 0,
      difficulty_average: null,
      quality_average: null,
      fa_username: null,
      fa_at: null,
    };
  }

  function writtenStatsRows() {
    return shimInsertedRows.filter((row) => 'upstreamQualityAverage' in row);
  }

  it('skips a fully empty NEW stats key', async () => {
    mockSharedSync.mockResolvedValueOnce(complete({ climb_stats: [emptyStat()] }));

    await syncSharedData(fakePostgresClient(), 'decoy', 'token');

    expect(writtenStatsRows()).toHaveLength(0);
    expect(shimConflictSets.filter((set) => 'upstreamQualityAverage' in set)).toHaveLength(0);
  });

  it('treats an omitted count as zero only when deciding a fully empty NEW row is empty', async () => {
    const statWithoutCount = emptyStat();
    delete statWithoutCount.ascensionist_count;
    mockSharedSync.mockResolvedValueOnce(complete({ climb_stats: [statWithoutCount] }));

    await syncSharedData(fakePostgresClient(), 'decoy', 'token');

    expect(writtenStatsRows()).toHaveLength(0);
  });

  it('inserts NULL counts when a NEW row omits its count but has other meaningful stats', async () => {
    const meaningfulStatWithoutCount = stat({ difficulty_average: 18 });
    delete meaningfulStatWithoutCount.ascensionist_count;
    mockSharedSync.mockResolvedValueOnce(complete({ climb_stats: [meaningfulStatWithoutCount] }));

    await syncSharedData(fakePostgresClient(), 'decoy', 'token');

    expect(writtenStatsRows()).toEqual([
      expect.objectContaining({
        climbUuid: 'EMPTY-STAT',
        difficultyAverage: 18,
        upstreamAscensionistCount: null,
        ascensionistCount: null,
      }),
    ]);
  });

  it.each([
    { label: 'omitted', rawCount: undefined, omitCount: true },
    { label: 'undefined', rawCount: undefined },
    { label: 'null', rawCount: null },
    { label: 'negative', rawCount: -1 },
    { label: 'fractional', rawCount: 1.5 },
    { label: 'NaN', rawCount: Number.NaN },
    { label: 'positive infinity', rawCount: Number.POSITIVE_INFINITY },
    { label: 'negative infinity', rawCount: Number.NEGATIVE_INFINITY },
    { label: 'unsafe integer', rawCount: Number.MAX_SAFE_INTEGER + 1 },
    { label: 'numeric string', rawCount: '7' },
    { label: 'boolean', rawCount: true },
  ])(
    "maps an EXISTING row's $label count to NULL so stored count and blend weight survive",
    async ({ rawCount, omitCount }) => {
      shimExistingClimbStatRows.push({ climbUuid: 'EMPTY-STAT', angle: 40 });
      const incomingStat = statWithRawCount(rawCount, { quality_average: 2 });
      if (omitCount) delete incomingStat.ascensionist_count;
      mockSharedSync.mockResolvedValueOnce(complete({ climb_stats: [incomingStat] }));

      await syncSharedData(fakePostgresClient(), 'decoy', 'token');

      expect(writtenStatsRows()).toEqual([
        expect.objectContaining({
          upstreamAscensionistCount: null,
          ascensionistCount: null,
          upstreamQualityAverage: 3,
        }),
      ]);
      expect(
        evaluateRecordedStatsPolicy(recordedStatsConflictSet(), {
          incomingUpstreamCount: null,
          storedUpstreamCount: 8,
          boardseshAscensionistCount: 2,
          upstreamQualityAverage: 3,
          boardseshQualitySum: 10,
          boardseshQualityCount: 2,
        }),
      ).toEqual({ upstreamCount: 8, totalCount: 10, blendedQualityAverage: 3.4 });
    },
  );

  it.each([
    ['explicit zero', 0, 0, 2, 5],
    ['positive safe integer', 4, 4, 6, 22 / 6],
  ] as const)(
    'keeps %s authoritative for an EXISTING row and its blend weight',
    async (_label, incomingCount, expectedUpstreamCount, expectedTotalCount, expectedBlend) => {
      shimExistingClimbStatRows.push({ climbUuid: 'EMPTY-STAT', angle: 40 });
      mockSharedSync.mockResolvedValueOnce(
        complete({ climb_stats: [stat({ ascensionist_count: incomingCount, quality_average: 2 })] }),
      );

      await syncSharedData(fakePostgresClient(), 'decoy', 'token');

      expect(writtenStatsRows()).toEqual([
        expect.objectContaining({
          upstreamAscensionistCount: incomingCount,
          ascensionistCount: incomingCount,
          upstreamQualityAverage: 3,
        }),
      ]);
      expect(
        evaluateRecordedStatsPolicy(recordedStatsConflictSet(), {
          incomingUpstreamCount: incomingCount,
          storedUpstreamCount: 8,
          boardseshAscensionistCount: 2,
          upstreamQualityAverage: 3,
          boardseshQualitySum: 10,
          boardseshQualityCount: 2,
        }),
      ).toEqual({
        upstreamCount: expectedUpstreamCount,
        totalCount: expectedTotalCount,
        blendedQualityAverage: expectedBlend,
      });
    },
  );

  it('bounds the existing-row pre-read by both candidate UUID and angle', async () => {
    mockSharedSync.mockResolvedValueOnce(
      complete({
        climb_stats: [stat({ climb_uuid: 'ANGLE-40', angle: 40 }), stat({ climb_uuid: 'ANGLE-50', angle: 50 })],
      }),
    );

    await syncSharedData(fakePostgresClient(), 'decoy', 'token');

    expect(shimClimbStatSelectPredicates).toHaveLength(1);
    const predicateQuery = dialect.sqlToQuery(shimClimbStatSelectPredicates[0]);
    expect(predicateQuery.sql).toContain('"climb_uuid" in');
    expect(predicateQuery.sql).toContain('"angle" in');
    expect(predicateQuery.params).toEqual(['decoy', 'ANGLE-40', 'ANGLE-50', 40, 50]);
  });

  it('skips the existing-row pre-read entirely when every payload in the batch is non-empty', async () => {
    mockSharedSync.mockResolvedValueOnce(
      complete({
        climb_stats: [stat({ climb_uuid: 'GRADED-40', angle: 40, difficulty_average: 18 })],
      }),
    );

    await syncSharedData(fakePostgresClient(), 'decoy', 'token');

    expect(shimClimbStatSelectPredicates).toHaveLength(0);
    expect(writtenStatsRows()).toHaveLength(1);
  });

  it('sanitizes invalid FA data before deciding a NEW row is empty', async () => {
    mockSharedSync.mockResolvedValueOnce(
      complete({
        climb_stats: [stat({ fa_username: 'Garbage', fa_at: '2033-01-01T00:00:00.000Z' })],
      }),
    );

    await syncSharedData(fakePostgresClient(), 'decoy', 'token');

    expect(writtenStatsRows()).toHaveLength(0);
  });

  it.each([
    ['grade', { difficulty_average: 18 }],
    ['benchmark', { benchmark_difficulty: 20 }],
    ['quality', { quality_average: 2 }],
    ['first ascent', { fa_username: 'Ari', fa_at: '2024-01-01T00:00:00.000Z' }],
  ])('retains a zero-count NEW row with %s data', async (_label, overrides) => {
    mockSharedSync.mockResolvedValueOnce(complete({ climb_stats: [stat(overrides)] }));

    await syncSharedData(fakePostgresClient(), 'decoy', 'token');

    expect(writtenStatsRows()).toHaveLength(1);
  });

  it('retains every positive-count NEW row even when display fields are empty', async () => {
    mockSharedSync.mockResolvedValueOnce(complete({ climb_stats: [stat({ ascensionist_count: 1 })] }));

    await syncSharedData(fakePostgresClient(), 'decoy', 'token');

    expect(writtenStatsRows()).toHaveLength(1);
  });

  it('sends an empty EXISTING row through conflict update and preserves Boardsesh-owned terms', async () => {
    shimExistingClimbStatRows.push({ climbUuid: 'EMPTY-STAT', angle: 40 });
    mockSharedSync.mockResolvedValueOnce(complete({ climb_stats: [emptyStat()] }));

    await syncSharedData(fakePostgresClient(), 'decoy', 'token');

    expect(writtenStatsRows()).toEqual([
      expect.objectContaining({
        climbUuid: 'EMPTY-STAT',
        upstreamAscensionistCount: 0,
        ascensionistCount: 0,
        difficultyAverage: null,
        displayDifficulty: null,
        benchmarkDifficulty: null,
        qualityAverage: null,
        upstreamQualityAverage: null,
        faUsername: null,
        faAt: null,
      }),
    ]);

    const [statsConflictSet] = shimConflictSets.filter((set) => 'upstreamQualityAverage' in set) as Array<
      Record<string, SQL>
    >;
    expect(statsConflictSet).toBeDefined();
    expect(render(statsConflictSet.ascensionistCount)).toContain('boardsesh_ascensionist_count');
    expect(render(statsConflictSet.qualityAverage)).toContain('boardsesh_quality_sum');
    expect(render(statsConflictSet.qualityAverage)).toContain('boardsesh_quality_count');
    expect(statsConflictSet).not.toHaveProperty('boardseshAscensionistCount');
    expect(statsConflictSet).not.toHaveProperty('boardseshQualitySum');
    expect(statsConflictSet).not.toHaveProperty('boardseshQualityCount');
  });
});

describe('climb conflict policies (SQL)', () => {
  const dialect = new PgDialect();
  const render = (fragment: Parameters<typeof dialect.sqlToQuery>[0]) => dialect.sqlToQuery(fragment).sql.toLowerCase();

  it('uses the authored-rule guard on actual shared-sync climb writes', async () => {
    mockSharedSync.mockReset();
    shimConflictSets.length = 0;
    mockSharedSync.mockResolvedValueOnce(
      complete({
        climbs: [{ uuid: 'RULE-ECHO', frames: '', layout_id: 1, description: 'No matching hands' }],
      } as Partial<SyncData>),
    );
    await syncSharedData(fakePostgresClient(), 'kilter', 'token');
    const [climbConflict] = shimConflictSets.filter((set) => 'characteristics' in set) as Array<Record<string, SQL>>;
    expect(climbConflict).toBeDefined();
    const ruleSql = render(climbConflict.characteristics);
    expect(ruleSql).toContain('"user_id" is not null');
    expect(ruleSql).toContain('"characteristics" is not null');
    expect(ruleSql).toContain('"is_draft" is false');
    expect(ruleSql).toContain('is not distinct from excluded.description');
    expect(ruleSql).toContain('excluded.characteristics');
  });

  it('is_listed / is_draft: verbatim from Aurora for non-user climbs, preserved for user climbs', () => {
    const { isListed, isDraft } = climbListingConflictSet();
    const listedSql = render(isListed);
    const draftSql = render(isDraft);
    // Ownership gate + verbatim incoming for catalog rows.
    expect(listedSql).toContain('user_id');
    expect(listedSql).toContain('is null');
    expect(listedSql).toContain('excluded.is_listed');
    expect(draftSql).toContain('excluded.is_draft');
    // The user branch keeps the stored value (never flips a Boardsesh climb).
    expect(listedSql).toContain('"is_listed"');
    expect(draftSql).toContain('"is_draft"');
    // No lingering "only flip toward visible" GREATEST/OR-style pinning.
    expect(listedSql).not.toContain('= false and excluded');
  });

  it('upstream_ascensionist_count: authoritative incoming, no GREATEST', () => {
    const { upstreamAscensionistCount, ascensionistCount } = climbStatsUpstreamConflictSet();
    const upSql = render(upstreamAscensionistCount);
    const totalSql = render(ascensionistCount);
    // Takes the incoming cursored value verbatim, so decreases propagate.
    expect(upSql).toContain('excluded.upstream_ascensionist_count');
    expect(upSql).not.toContain('greatest');
    // Total = incoming upstream + the independent boardsesh count.
    expect(totalSql).toContain('excluded.upstream_ascensionist_count');
    expect(totalSql).toContain('boardsesh_ascensionist_count');
    expect(totalSql).not.toContain('greatest');
  });

  /**
   * Evaluate the RENDERED COALESCE(...) expression for an (incoming, stored)
   * pair with Postgres semantics (first non-null argument wins). Parsing the
   * SQL the helper actually ships — instead of restating the intended policy —
   * means these assertions fail if anyone swaps the argument order or
   * reintroduces GREATEST, not just if the string changes cosmetically.
   */
  const evalUpstreamCoalesce = (rendered: string, incoming: number | null, stored: number | null): number => {
    const coalesceMatch = rendered.match(/^coalesce\(([^()]*)\)$/);
    if (!coalesceMatch) throw new Error(`not a bare COALESCE expression: ${rendered}`);
    for (const argument of coalesceMatch[1].split(',').map((part) => part.trim())) {
      if (argument === 'excluded.upstream_ascensionist_count') {
        if (incoming != null) return incoming;
      } else if (argument === '"board_climb_stats"."upstream_ascensionist_count"') {
        if (stored != null) return stored;
      } else {
        return Number(argument); // literal fallback (the trailing 0)
      }
    }
    throw new Error(`no COALESCE argument resolved in: ${rendered}`);
  };

  it('upstream count: a genuine numeric decrease lands; NULL incoming preserves stored (deliberate)', () => {
    const { upstreamAscensionistCount } = climbStatsUpstreamConflictSet();
    const upSql = render(upstreamAscensionistCount);
    // Non-null incoming ALWAYS wins — a decrease and an explicit 0 both land.
    expect(evalUpstreamCoalesce(upSql, 50, 100)).toBe(50);
    expect(evalUpstreamCoalesce(upSql, 0, 100)).toBe(0);
    // NULL incoming = "no data for this row", NOT "count is now zero" → the
    // stored count is preserved (see climbStatsUpstreamConflictSet docs).
    expect(evalUpstreamCoalesce(upSql, null, 100)).toBe(100);
    // A row that never carried a count on either side seeds at 0.
    expect(evalUpstreamCoalesce(upSql, null, null)).toBe(0);
  });

  it('fa_username / fa_at: the RECORDED stats conflict SET ships bare excluded.* (#3536)', async () => {
    // Renders the conflict clause captured from the query builder during a
    // real syncSharedData climb_stats write — NOT the production helper
    // re-invoked here, which would stay green even if upsertClimbStats
    // stopped using it. sanitizeFirstAscent runs once, at INSERT-value
    // construction, so the shipped ON CONFLICT clause must stay a plain
    // excluded.* with no GREATEST/COALESCE range check drifting out of sync
    // with the JS-side guard.
    mockSharedSync.mockReset();
    mockPopulateDenormalizedColumns.mockReset();
    mockPopulateDenormalizedColumns.mockResolvedValue(undefined);
    shimConflictSets.length = 0;
    mockSharedSync.mockResolvedValueOnce(
      complete({
        climb_stats: [
          {
            climb_uuid: 'CLIMB-CONFLICT-SET',
            angle: 40,
            display_difficulty: 20,
            benchmark_difficulty: 20,
            ascensionist_count: 5,
            difficulty_average: 20.1,
            quality_average: 3,
            fa_username: 'somebody',
            fa_at: '2024-03-15T12:34:56.000Z',
          },
        ],
      } as Partial<SyncData>),
    );

    await syncSharedData(fakePostgresClient(), 'decoy', 'token');

    // board_climb_stats is the only writer whose conflict set carries fa_at.
    const statsConflictSets = shimConflictSets.filter(
      (conflictSet) => 'faAt' in conflictSet && 'faUsername' in conflictSet,
    );
    expect(statsConflictSets).toHaveLength(1);
    const recordedSet = statsConflictSets[0] as { faUsername: SQL; faAt: SQL };
    expect(render(recordedSet.faUsername)).toBe('excluded.fa_username');
    expect(render(recordedSet.faAt)).toBe('excluded.fa_at');
  });
});

describe('shouldHealRequiredSetIds (gate)', () => {
  it('fires when the run synced climbs', () => {
    expect(shouldHealRequiredSetIds({ climbs: { synced: 3 } })).toBe(true);
  });

  it('fires on late placements even when no climbs moved (the cursor hole)', () => {
    expect(shouldHealRequiredSetIds({ climbs: { synced: 0 }, placements: { synced: 12 } })).toBe(true);
  });

  it('stays quiet on an idle run so it never scans the catalog', () => {
    expect(shouldHealRequiredSetIds({})).toBe(false);
    expect(shouldHealRequiredSetIds({ climbs: { synced: 0 }, placements: { synced: 0 } })).toBe(false);
    // Other tables moving (e.g. climb_stats) do not trigger the heal.
    expect(shouldHealRequiredSetIds({ climb_stats: { synced: 500 } })).toBe(false);
  });

  it('an idle syncSharedData run never reaches the drain (gate wired in)', async () => {
    mockSharedSync.mockReset();
    mockPopulateDenormalizedColumns.mockReset();
    mockPopulateDenormalizedColumns.mockResolvedValue(undefined);
    mockSharedSync.mockResolvedValueOnce(complete({ shared_syncs: [] }));

    await syncSharedData(fakePostgresClient(), 'decoy', 'token');

    // No climbs/placements moved → neither the per-batch denormalization nor
    // the tail drain touches populateDenormalizedColumns.
    expect(mockPopulateDenormalizedColumns).not.toHaveBeenCalled();
  });
});

describe('healRequiredSetIds (drain)', () => {
  const dialect = new PgDialect();

  /**
   * Targeted db shim for the drain's single SELECT: captures the where
   * condition and the limit, resolves to the given straggler rows.
   */
  function mockDrainDb(stragglerRows: Array<{ uuid: string }>) {
    const captured: { where?: unknown; limit?: number } = {};
    const db = {
      select: () => ({
        from: () => ({
          where: (condition: unknown) => {
            captured.where = condition;
            return {
              limit: (cap: number) => {
                captured.limit = cap;
                return Promise.resolve(stragglerRows);
              },
            };
          },
        }),
      }),
    };
    return { db: db as unknown as Parameters<typeof healRequiredSetIds>[0], captured };
  }

  beforeEach(() => {
    mockPopulateDenormalizedColumns.mockReset();
    mockPopulateDenormalizedColumns.mockResolvedValue(undefined);
  });

  it('caps the per-run drain at REQUIRED_SET_ID_DRAIN_LIMIT and heals exactly the returned uuids', async () => {
    const { db, captured } = mockDrainDb([{ uuid: 'c1' }, { uuid: 'c2' }]);
    const logs: string[] = [];
    await healRequiredSetIds(db, 'tension', (message) => logs.push(message));
    expect(captured.limit).toBe(REQUIRED_SET_ID_DRAIN_LIMIT);
    expect(REQUIRED_SET_ID_DRAIN_LIMIT).toBe(2000);
    expect(mockPopulateDenormalizedColumns).toHaveBeenCalledTimes(1);
    expect(mockPopulateDenormalizedColumns).toHaveBeenCalledWith(db, 'tension', ['c1', 'c2']);
    expect(logs.join('\n')).toContain('healed required_set_ids for 2');
  });

  it('is a silent no-op when no stragglers remain', async () => {
    const { db } = mockDrainDb([]);
    const logs: string[] = [];
    await healRequiredSetIds(db, 'tension', (message) => logs.push(message));
    expect(mockPopulateDenormalizedColumns).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
  });

  it('selects only synced, listed rows missing set ids (user-authored climbs excluded)', async () => {
    const { db, captured } = mockDrainDb([]);
    await healRequiredSetIds(db, 'tension', () => {});
    // Render the REAL where condition the drain issued — the assertion fails if
    // someone drops the ownership fence (or any other predicate) from the query.
    const whereSql = dialect.sqlToQuery(captured.where as Parameters<typeof dialect.sqlToQuery>[0]).sql.toLowerCase();
    expect(whereSql).toContain('"user_id" is null');
    expect(whereSql).toContain('"is_listed" =');
    expect(whereSql).toContain('"required_set_ids" is null');
    expect(whereSql).toContain('"frames" is not null');
  });
});
