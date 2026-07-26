import { beforeEach, describe, expect, it, vi } from 'vitest';
import { notifications, setterFollows, userBoardMappings, userFollows } from '@boardsesh/db/schema';
import type { SyncData } from '../api/sync-api-types';
import type { SyncOptions } from '../api/types';

const {
  mockSharedSync,
  mockPopulateDenormalizedColumns,
  mockConvertLitUpHolds,
  mockBlendedQualityAverageSql,
  mockSnapshotHistory,
} = vi.hoisted(() => ({
  mockSharedSync: vi.fn(),
  mockPopulateDenormalizedColumns: vi.fn().mockResolvedValue(undefined),
  mockConvertLitUpHolds: vi.fn().mockReturnValue({}),
  // Never invoked here (these tests process no climb_stats); stubbed only so
  // the shared-sync import of blendedQualityAverageSql resolves.
  mockBlendedQualityAverageSql: vi.fn(),
  mockSnapshotHistory: vi.fn().mockResolvedValue({ written: 0, skipped: true }),
}));

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
    blendedQualityAverageSql: mockBlendedQualityAverageSql,
    snapshotClimbStatsHistoryIfDue: mockSnapshotHistory,
    // setterSyncNotificationUuid deliberately NOT stubbed: the deterministic
    // uuid IS the duplicate-notification backstop, so a stub would stop
    // covering it.
  };
});

vi.mock('@boardsesh/board-constants/hold-states', () => ({
  convertLitUpHoldsStringToMap: mockConvertLitUpHolds,
}));

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
      // Every method (insert, select, values, where, onConflictDoUpdate, etc.)
      // returns the same fluent object, so chains keep flowing. The terminal
      // `await` resolves to whatever the proxy is — fine for INSERTs (we don't
      // read the result) and SELECTs that hit `.from(...)`.
      return new Proxy(() => shim, {
        apply: () => shim,
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
    expect(parseDifficultyFields({ difficulty_average: 15.4, display_difficulty: 16 })).toEqual({
      difficultyAverage: 15.4,
      displayDifficulty: 16,
    });
  });

  it('preserves NULL difficulty instead of coercing to grade 0', () => {
    expect(parseDifficultyFields({ difficulty_average: null, display_difficulty: null })).toEqual({
      difficultyAverage: null,
      displayDifficulty: null,
    });
  });

  it('falls back display_difficulty to the average when Aurora omits it', () => {
    expect(parseDifficultyFields({ difficulty_average: 22.1, display_difficulty: null })).toEqual({
      difficultyAverage: 22.1,
      displayDifficulty: 22.1,
    });
  });

  it('keeps an explicit display value when the average is null', () => {
    expect(parseDifficultyFields({ difficulty_average: null, display_difficulty: 18 })).toEqual({
      difficultyAverage: null,
      displayDifficulty: 18,
    });
  });
});

describe('climb conflict policies (SQL)', () => {
  const dialect = new PgDialect();
  const render = (fragment: Parameters<typeof dialect.sqlToQuery>[0]) => dialect.sqlToQuery(fragment).sql.toLowerCase();

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
