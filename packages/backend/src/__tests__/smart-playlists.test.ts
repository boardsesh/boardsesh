import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { playlistQueries } from '../graphql/resolvers/playlists/queries';
import { sqlText } from '@boardsesh/db/test-utils';

const {
  mockDb,
  eqSpy,
  notInArraySpy,
  resolveTargetMock,
  selectRefsMock,
  countRefsMock,
  cardCountMock,
  activityAccessMock,
} = vi.hoisted(() => {
  const mockDb = {
    execute: vi.fn(),
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(),
  };
  return {
    mockDb,
    eqSpy: vi.fn(),
    notInArraySpy: vi.fn(),
    resolveTargetMock: vi.fn(),
    selectRefsMock: vi.fn(),
    countRefsMock: vi.fn(),
    cardCountMock: vi.fn(),
    activityAccessMock: vi.fn(),
  };
});

vi.mock('../db/client', () => ({ db: mockDb }));
vi.mock('../services/privacy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/privacy')>()),
  canViewUserActivity: activityAccessMock,
}));

// Recommendation helpers are exercised by their own DB-backed paths; here we mock
// them so the logbook-playlist + counts tests don't need to stub the catalog
// queries, and so the recommendation-specific tests can drive return values.
vi.mock('../graphql/resolvers/playlists/helpers/recommendation-board-target', () => ({
  resolveRecommendationBoardTarget: resolveTargetMock,
}));
vi.mock('../graphql/resolvers/playlists/helpers/recommendation-refs', () => ({
  selectRecommendationClimbRefs: selectRefsMock,
  countRecommendationClimbRefs: countRefsMock,
  countRecommendationCardClimbs: cardCountMock,
}));

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: (...args: Parameters<typeof actual.eq>) => {
      eqSpy(...args);
      return actual.eq(...args);
    },
    notInArray: (...args: Parameters<typeof actual.notInArray>) => {
      notInArraySpy(...args);
      return actual.notInArray(...args);
    },
  };
});

vi.mock('../db/queries/util/table-select', () => ({
  UNIFIED_TABLES: {
    climbs: {
      uuid: 'uuid',
      layoutId: 'layoutId',
      boardType: 'boardType',
      setterUsername: 'setterUsername',
      name: 'name',
      description: 'description',
      frames: 'frames',
      userId: 'userId',
    },
    climbStats: {
      climbUuid: 'climbUuid',
      boardType: 'boardType',
      angle: 'angle',
      ascensionistCount: 'ascensionistCount',
      qualityAverage: 'qualityAverage',
      difficultyAverage: 'difficultyAverage',
      displayDifficulty: 'displayDifficulty',
      benchmarkDifficulty: 'benchmarkDifficulty',
    },
  },
  isValidBoardName: vi.fn().mockReturnValue(true),
}));

function makeCtx(overrides: Partial<ConnectionContext> = {}): ConnectionContext {
  return {
    connectionId: 'conn-1',
    isAuthenticated: true,
    userId: 'user-123',
    sessionId: null,
    boardPath: null,
    controllerId: null,
    controllerApiKey: null,
    ...overrides,
  } as ConnectionContext;
}

/**
 * Mock Drizzle chain that records every method invocation. Terminal awaits
 * resolve to `resolveValue`. Subsequent .then() calls also resolve to
 * resolveValue (we reuse the same chain for nested subqueries).
 */
function makeChain(resolveValue: unknown = []) {
  const calls: Record<string, unknown[][]> = {};
  const chain: Record<string, unknown> = {};
  const methods = [
    'select',
    'from',
    'where',
    'leftJoin',
    'innerJoin',
    'groupBy',
    'having',
    'orderBy',
    'limit',
    'offset',
    'as',
  ];
  for (const method of methods) {
    calls[method] = [];
    chain[method] = vi.fn((...args: unknown[]) => {
      calls[method].push(args);
      return chain;
    });
  }
  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(resolveValue).then(resolve);
  return { chain, calls };
}

const USER_ROW = {
  id: 'user-123',
  name: 'Marco',
  image: 'https://img/marco.jpg',
  displayName: 'Marco D',
  avatarUrl: 'https://img/marco-avatar.jpg',
};

/** A full page of recommendation refs, as `selectRecommendationClimbRefs` returns them. */
function makeRecommendationRefs(count: number) {
  return Array.from({ length: count }, (_, index) => ({ climbUuid: `rec-${index}`, boardType: 'kilter' }));
}

/** The hydrator row `hydrateClimbsByRefs` selects for one of those refs. */
function hydratedRowFor(ref: { climbUuid: string; boardType: string }) {
  return {
    climbUuid: ref.climbUuid,
    layoutId: 8,
    boardType: ref.boardType,
    setter_username: 'u',
    name: `climb ${ref.climbUuid}`,
    description: '',
    frames: '',
    statsAngle: 45,
    ascensionist_count: 5,
    difficulty_id: 20,
    quality_average: 5,
    difficulty_error: 0,
    benchmark_difficulty: null,
  };
}

describe('smartPlaylist resolver', () => {
  beforeEach(() => {
    // resetAllMocks (not clearAllMocks) so the `mockReturnValueOnce` queues
    // drain between tests — clearAllMocks only resets call history, leaving
    // unused queued return values to leak into the next test.
    vi.resetAllMocks();
    activityAccessMock.mockResolvedValue(true);
  });

  it('FIVE_STARS uses LIMIT/OFFSET for pagination and only returns the requested page', async () => {
    const ctx = makeCtx();

    // user lookup
    mockDb.select.mockReturnValueOnce(makeChain([USER_ROW]).chain);
    // page query
    const { chain: pageChain, calls: pageCalls } = makeChain([
      { climbUuid: 'c1', boardType: 'kilter', latestClimbedAt: '2026-01-01' },
    ]);
    mockDb.select.mockReturnValueOnce(pageChain);
    // count query
    mockDb.select.mockReturnValueOnce(makeChain([{ count: 42 }]).chain);
    // hydrate
    mockDb.select.mockReturnValueOnce(
      makeChain([
        {
          climbUuid: 'c1',
          layoutId: 1,
          boardType: 'kilter',
          setter_username: 'u',
          name: 'n',
          description: '',
          frames: '',
          statsAngle: 40,
          ascensionist_count: 5,
          difficulty_id: 20,
          quality_average: 5,
          difficulty_error: 0,
          benchmark_difficulty: null,
        },
      ]).chain,
    );

    const result = await playlistQueries.smartPlaylist(
      null,
      {
        input: { type: 'FIVE_STARS', userId: 'user-123', page: 2, pageSize: 10 },
      },
      ctx,
    );

    expect(result.totalCount).toBe(42);
    expect(result.hasMore).toBe(true); // 30 / 42
    expect(result.meta).toMatchObject({ userId: 'user-123', userName: 'Marco D', climbCount: 42 });
    expect(pageCalls.limit[0]).toEqual([10]);
    expect(pageCalls.offset[0]).toEqual([20]);
    // The page and count queries must both filter by quality = 5.
    const qualityFilters = eqSpy.mock.calls.filter(
      ([col, val]) => col === dbSchema.boardseshTicks.quality && val === 5,
    );
    expect(qualityFilters.length).toBeGreaterThanOrEqual(2);
  });

  it('MOST_REPEATED applies HAVING SUM > 1 and orders by total attempts', async () => {
    const ctx = makeCtx();

    mockDb.select.mockReturnValueOnce(makeChain([USER_ROW]).chain);
    const { chain: pageChain, calls: pageCalls } = makeChain([]);
    mockDb.select.mockReturnValueOnce(pageChain);
    mockDb.select.mockReturnValueOnce(makeChain([{ count: 0 }]).chain); // count subquery wrapper
    mockDb.select.mockReturnValueOnce(makeChain([{ count: 0 }]).chain); // count outer

    await playlistQueries.smartPlaylist(
      null,
      {
        input: { type: 'MOST_REPEATED', userId: 'user-123' },
      },
      ctx,
    );

    expect(pageCalls.having.length).toBe(1);
    expect(pageCalls.orderBy.length).toBe(1);
    expect(pageCalls.groupBy.length).toBe(1);
  });

  it('PROJECTS aggregates the logbook per climb, then reads each climb row once', async () => {
    const ctx = makeCtx();

    mockDb.select.mockReturnValueOnce(makeChain([USER_ROW]).chain);

    // The page and the count each build the per-climb subquery first, then
    // select from it: five selects with the user lookup. Behaviour (which
    // climbs count as projects, before and after a hold moves) is asserted
    // against a real database in climb-edit-in-place.test.ts.
    const { chain: pageLoggedChain, calls: pageLoggedCalls } = makeChain([]);
    mockDb.select.mockReturnValueOnce(pageLoggedChain);
    const { chain: pageChain, calls: pageCalls } = makeChain([]);
    mockDb.select.mockReturnValueOnce(pageChain);
    const { chain: countLoggedChain, calls: countLoggedCalls } = makeChain([]);
    mockDb.select.mockReturnValueOnce(countLoggedChain);
    const { chain: countChain, calls: countCalls } = makeChain([{ count: 0 }]);
    mockDb.select.mockReturnValueOnce(countChain);

    await playlistQueries.smartPlaylist(
      null,
      {
        input: { type: 'PROJECTS', userId: 'user-123', boardName: 'kilter' },
      },
      ctx,
    );

    for (const calls of [pageLoggedCalls, countLoggedCalls]) {
      // The user's ticks, grouped on BOTH columns: a sent Kilter climb must not
      // stand in for a Tension climb that shares its uuid.
      expect(calls.from[0][0]).toBe(dbSchema.boardseshTicks);
      expect(calls.groupBy[0]).toEqual([dbSchema.boardseshTicks.climbUuid, dbSchema.boardseshTicks.boardType]);
      expect(calls.as[0]).toEqual(['logged']);
      // The climb row is not read per tick.
      expect(calls.leftJoin).toHaveLength(0);
    }
    for (const calls of [pageCalls, countCalls]) {
      // One board_climbs lookup per logged climb, and the two-sided epoch test.
      expect(calls.leftJoin).toHaveLength(1);
      expect(calls.leftJoin[0][0]).toBe(dbSchema.boardClimbs);
      // Only climbs whose holds have moved: the partial-index predicate.
      expect(sqlText(calls.leftJoin[0][1])).toMatch(/ > 1/);
      expect(calls.where).toHaveLength(1);
      const rendered = sqlText(calls.where[0][0]);
      expect(rendered).toMatch(/COALESCE\(, 0\) >= COALESCE\(, 1\)\s+AND NOT COALESCE\(, 0\) >= COALESCE\(, 1\)/);
    }
    expect(pageCalls.limit[0]).toEqual([20]);
    expect(pageCalls.offset[0]).toEqual([0]);

    expect(notInArraySpy).not.toHaveBeenCalled();
  });

  it('LIKED_CLIMBS reads user_favorites, applies board filter, dedups across angles, orders by latest like', async () => {
    const ctx = makeCtx();

    // user lookup
    mockDb.select.mockReturnValueOnce(makeChain([USER_ROW]).chain);
    // page query — favorites have an angle column, so we dedupe via GROUP BY
    // (board_name, climb_uuid) to avoid returning the same climb twice when a
    // user has favourited it at multiple angles.
    const { chain: pageChain, calls: pageCalls } = makeChain([
      { climbUuid: 'fav1', boardType: 'kilter' },
      { climbUuid: 'fav2', boardType: 'kilter' },
    ]);
    mockDb.select.mockReturnValueOnce(pageChain);
    // count query
    const { chain: countChain, calls: countCalls } = makeChain([{ count: 7 }]);
    mockDb.select.mockReturnValueOnce(countChain);
    // hydrate (called with refs array)
    mockDb.select.mockReturnValueOnce(makeChain([]).chain);

    const result = await playlistQueries.smartPlaylist(
      null,
      {
        input: { type: 'LIKED_CLIMBS', userId: 'user-123', boardName: 'kilter', page: 1, pageSize: 5 },
      },
      ctx,
    );

    expect(result.totalCount).toBe(7);
    expect(result.hasMore).toBe(false); // (1+1)*5 = 10 >= 7
    expect(pageCalls.limit[0]).toEqual([5]);
    expect(pageCalls.offset[0]).toEqual([5]);

    // Dedup: GROUP BY (climbUuid, boardName)
    expect(pageCalls.groupBy.length).toBe(1);
    expect(pageCalls.groupBy[0]).toEqual([dbSchema.userFavorites.climbUuid, dbSchema.userFavorites.boardName]);
    // Ordered (by max(createdAt) DESC); we just assert orderBy was called
    expect(pageCalls.orderBy.length).toBe(1);

    // Both page and count must filter by both userId and boardName — a missing
    // boardName filter on either side would make the count card show all-boards
    // while the detail page is board-scoped (or vice versa).
    const userIdFilters = eqSpy.mock.calls.filter(
      ([col, val]) => col === dbSchema.userFavorites.userId && val === 'user-123',
    );
    expect(userIdFilters.length).toBeGreaterThanOrEqual(2);
    const boardFilters = eqSpy.mock.calls.filter(
      ([col, val]) => col === dbSchema.userFavorites.boardName && val === 'kilter',
    );
    expect(boardFilters.length).toBeGreaterThanOrEqual(2);
    for (const calls of [pageCalls, countCalls]) {
      const rendered = sqlText(calls.where[0][0]);
      expect(rendered).toContain('privacy_reference_climb');
      expect(rendered).toContain('public_consent_revision');
      expect(rendered).toContain('privacy_revision');
    }
  });

  it('LIKED_CLIMBS without boardName does not filter by board (cross-board view)', async () => {
    const ctx = makeCtx();
    mockDb.select.mockReturnValueOnce(makeChain([USER_ROW]).chain);
    mockDb.select.mockReturnValueOnce(makeChain([]).chain);
    mockDb.select.mockReturnValueOnce(makeChain([{ count: 0 }]).chain);
    // Defensive: hydrate currently short-circuits on an empty refs[], so this
    // mock is unused today. Kept so the test doesn't blow up cryptically if
    // that short-circuit is ever removed.
    mockDb.select.mockReturnValueOnce(makeChain([]).chain);

    await playlistQueries.smartPlaylist(
      null,
      {
        input: { type: 'LIKED_CLIMBS', userId: 'user-123' },
      },
      ctx,
    );

    const boardFilters = eqSpy.mock.calls.filter(([col]) => col === dbSchema.userFavorites.boardName);
    expect(boardFilters.length).toBe(0);
  });

  it('throws when user does not exist', async () => {
    const ctx = makeCtx();
    activityAccessMock.mockResolvedValue(false);

    await expect(
      playlistQueries.smartPlaylist(
        null,
        {
          input: { type: 'FIVE_STARS', userId: 'missing' },
        },
        ctx,
      ),
    ).rejects.toThrow('Playlist not found');
  });

  it('is callable without authentication (public)', async () => {
    const ctx = makeCtx({ isAuthenticated: false, userId: undefined });

    mockDb.select.mockReturnValueOnce(makeChain([USER_ROW]).chain);
    mockDb.select.mockReturnValueOnce(makeChain([]).chain);
    mockDb.select.mockReturnValueOnce(makeChain([{ count: 0 }]).chain);

    const result = await playlistQueries.smartPlaylist(
      null,
      {
        input: { type: 'FIVE_STARS', userId: 'user-123' },
      },
      ctx,
    );
    expect(result.meta.userId).toBe('user-123');
  });

  it('hides a private logbook from an unapproved viewer before loading metadata or climbs', async () => {
    activityAccessMock.mockResolvedValue(false);
    await expect(
      playlistQueries.smartPlaylist(null, { input: { type: 'FIVE_STARS', userId: 'private-owner' } }, makeCtx()),
    ).rejects.toThrow('Playlist not found');
    expect(activityAccessMock).toHaveBeenCalledWith('user-123', 'private-owner');
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('RECOMMENDED_* returns an empty result for a non-owner without any user lookup', async () => {
    const ctx = makeCtx({ userId: 'someone-else' });

    const result = await playlistQueries.smartPlaylist(
      null,
      { input: { type: 'RECOMMENDED_CROWD_FAVORITES', userId: 'user-123' } },
      ctx,
    );

    expect(result.climbs).toEqual([]);
    expect(result.totalCount).toBe(0);
    expect(result.hasMore).toBe(false);
    // No user lookup (no existence probing) and no board resolution for non-owners.
    expect(mockDb.select).not.toHaveBeenCalled();
    expect(resolveTargetMock).not.toHaveBeenCalled();
  });

  it('accepts a negative angle (Aurora boards support negative tilt) instead of rejecting the input', async () => {
    // Non-owner short-circuit keeps this cheap (no DB/board-resolution mocks
    // needed) while still proving angle: -5 clears GetSmartPlaylistInputSchema
    // validation rather than throwing.
    const ctx = makeCtx({ userId: 'someone-else' });

    const result = await playlistQueries.smartPlaylist(
      null,
      { input: { type: 'RECOMMENDED_CROWD_FAVORITES', userId: 'user-123', angle: -5 } },
      ctx,
    );

    expect(result.climbs).toEqual([]);
    expect(result.totalCount).toBe(0);
  });

  it('rejects angle -91 (outside the -90..90 board-tilt range) before any DB or board-resolution work', async () => {
    const ctx = makeCtx({ userId: 'someone-else' });

    await expect(
      playlistQueries.smartPlaylist(
        null,
        { input: { type: 'RECOMMENDED_CROWD_FAVORITES', userId: 'user-123', angle: -91 } },
        ctx,
      ),
    ).rejects.toThrow();
    expect(mockDb.select).not.toHaveBeenCalled();
    expect(resolveTargetMock).not.toHaveBeenCalled();
  });

  it('RECOMMENDED_* returns an empty result (not a throw) when no board resolves', async () => {
    const ctx = makeCtx();
    resolveTargetMock.mockResolvedValueOnce(null);

    const result = await playlistQueries.smartPlaylist(
      null,
      { input: { type: 'RECOMMENDED_AT_LEVEL', userId: 'user-123' } },
      ctx,
    );

    expect(result.totalCount).toBe(0);
    expect(result.climbs).toEqual([]);
  });

  it('RECOMMENDED_* returns recommendations for the owner, hydrated at the board angle', async () => {
    const ctx = makeCtx();
    resolveTargetMock.mockResolvedValueOnce({
      boardType: 'kilter',
      layoutId: 8,
      sizeId: 25,
      angle: 45,
      setIds: null,
    });
    selectRefsMock.mockResolvedValueOnce([{ climbUuid: 'c1', boardType: 'kilter' }]);
    countRefsMock.mockResolvedValueOnce(3);
    // fetchUserMeta, then hydrate.
    mockDb.select.mockReturnValueOnce(makeChain([USER_ROW]).chain);
    mockDb.select.mockReturnValueOnce(
      makeChain([
        {
          climbUuid: 'c1',
          layoutId: 1,
          boardType: 'kilter',
          setter_username: 'u',
          name: 'n',
          description: '',
          frames: '',
          statsAngle: 45,
          ascensionist_count: 5,
          difficulty_id: 20,
          quality_average: 5,
          difficulty_error: 0,
          benchmark_difficulty: null,
        },
      ]).chain,
    );

    const result = await playlistQueries.smartPlaylist(
      null,
      { input: { type: 'RECOMMENDED_CROWD_FAVORITES', userId: 'user-123' } },
      ctx,
    );

    expect(result.totalCount).toBe(3);
    expect(result.climbs).toHaveLength(1);
    expect(result.climbs[0]).toMatchObject({ uuid: 'c1', angle: 45 });
    expect(selectRefsMock).toHaveBeenCalledTimes(1);
  });

  it('RECOMMENDED_* keeps hasMore true below the offset clamp when more climbs remain', async () => {
    const ctx = makeCtx();
    const refs = makeRecommendationRefs(20);
    resolveTargetMock.mockResolvedValueOnce({ boardType: 'kilter', layoutId: 8, sizeId: 25, angle: 45, setIds: null });
    selectRefsMock.mockResolvedValueOnce(refs);
    countRefsMock.mockResolvedValueOnce(1000);
    // fetchUserMeta, then the hydrator's data select.
    mockDb.select.mockReturnValueOnce(makeChain([USER_ROW]).chain);
    mockDb.select.mockReturnValueOnce(makeChain(refs.map(hydratedRowFor)).chain);

    const result = await playlistQueries.smartPlaylist(
      null,
      { input: { type: 'RECOMMENDED_CROWD_FAVORITES', userId: 'user-123', page: 5, pageSize: 20 } },
      ctx,
    );

    expect(result.climbs).toHaveLength(20);
    expect(result.hasMore).toBe(true);
  });

  it('RECOMMENDED_* terminates paging at the offset clamp even when totalCount says more remain', async () => {
    const ctx = makeCtx();
    const refs = makeRecommendationRefs(20);
    resolveTargetMock.mockResolvedValueOnce({ boardType: 'kilter', layoutId: 8, sizeId: 25, angle: 45, setIds: null });
    selectRefsMock.mockResolvedValueOnce(refs);
    countRefsMock.mockResolvedValueOnce(1000);
    mockDb.select.mockReturnValueOnce(makeChain([USER_ROW]).chain);
    mockDb.select.mockReturnValueOnce(makeChain(refs.map(hydratedRowFor)).chain);

    // MAX_RECOMMENDATION_OFFSET (500) / pageSize (20) clamps at page 25 — any
    // request past it re-serves that same page, so hasMore must go false there
    // or infinite scroll refetches the identical page forever.
    const result = await playlistQueries.smartPlaylist(
      null,
      { input: { type: 'RECOMMENDED_CROWD_FAVORITES', userId: 'user-123', page: 30, pageSize: 20 } },
      ctx,
    );

    expect(result.climbs).toHaveLength(20);
    expect(result.hasMore).toBe(false);
    // Trailing expect.anything() is the executor the resolver threads down (#4235).
    expect(selectRefsMock).toHaveBeenCalledWith(
      'RECOMMENDED_CROWD_FAVORITES',
      expect.anything(),
      'user-123',
      25,
      20,
      expect.anything(),
    );
  });
});

/**
 * Queue the counts-CTE result.
 *
 * `mySmartPlaylistCounts` runs inside `withSerialPlan` (#4235). `mockDb` has no
 * `transaction`, so the helper takes its execute-only fallback and the FIRST
 * `execute` is the `SET LOCAL max_parallel_workers_per_gather = 0` guard — the
 * CTE result has to be queued behind it or the guard eats it.
 */
function queueCountsRows(rows: unknown) {
  mockDb.execute.mockResolvedValueOnce([]); // SET LOCAL guard
  mockDb.execute.mockResolvedValueOnce(rows);
}

/** The SQL the resolver actually ran, i.e. the call after the guard. */
function countsSqlArg() {
  return mockDb.execute.mock.calls[1][0] as { queryChunks?: unknown[] } | undefined;
}

describe('mySmartPlaylistCounts resolver', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('requires authentication', async () => {
    const ctx = makeCtx({ isAuthenticated: false, userId: undefined });
    await expect(playlistQueries.mySmartPlaylistCounts(null, undefined, ctx)).rejects.toThrow(
      'Authentication required',
    );
  });

  it('returns one entry per smart-playlist type from a single CTE roundtrip', async () => {
    const ctx = makeCtx();

    // One CTE roundtrip returns three rows. Order returned from the resolver is
    // fixed (FIVE_STARS, MOST_REPEATED, PROJECTS) regardless of SQL row order.
    queueCountsRows([
      { type: 'PROJECTS', count: 5 },
      { type: 'FIVE_STARS', count: 7 },
      { type: 'MOST_REPEATED', count: 3 },
    ]);

    const result = await playlistQueries.mySmartPlaylistCounts(null, undefined, ctx);
    expect(result).toEqual([
      { type: 'FIVE_STARS', count: 7 },
      { type: 'MOST_REPEATED', count: 3 },
      { type: 'PROJECTS', count: 5 },
      { type: 'LIKED_CLIMBS', count: 0 },
    ]);
    // The guard plus the CTE — still one roundtrip for all four counts.
    expect(mockDb.execute).toHaveBeenCalledTimes(2);
  });

  it('handles the {rows: ...} shape some postgres clients return', async () => {
    const ctx = makeCtx();

    queueCountsRows({
      rows: [
        { type: 'FIVE_STARS', count: 1 },
        { type: 'MOST_REPEATED', count: 2 },
        { type: 'PROJECTS', count: 3 },
      ],
    });

    const result = await playlistQueries.mySmartPlaylistCounts(null, undefined, ctx);
    expect(result).toEqual([
      { type: 'FIVE_STARS', count: 1 },
      { type: 'MOST_REPEATED', count: 2 },
      { type: 'PROJECTS', count: 3 },
      { type: 'LIKED_CLIMBS', count: 0 },
    ]);
  });

  it('returns 0 for any type missing from the CTE result', async () => {
    const ctx = makeCtx();

    queueCountsRows([{ type: 'FIVE_STARS', count: 9 }]);

    const result = await playlistQueries.mySmartPlaylistCounts(null, undefined, ctx);
    expect(result).toEqual([
      { type: 'FIVE_STARS', count: 9 },
      { type: 'MOST_REPEATED', count: 0 },
      { type: 'PROJECTS', count: 0 },
      { type: 'LIKED_CLIMBS', count: 0 },
    ]);
  });

  it('surfaces a non-zero LIKED_CLIMBS count from the CTE', async () => {
    const ctx = makeCtx();

    queueCountsRows([
      { type: 'FIVE_STARS', count: 7 },
      { type: 'MOST_REPEATED', count: 3 },
      { type: 'PROJECTS', count: 5 },
      { type: 'LIKED_CLIMBS', count: 12 },
    ]);

    const result = await playlistQueries.mySmartPlaylistCounts(null, undefined, ctx);
    expect(result).toContainEqual({ type: 'LIKED_CLIMBS', count: 12 });
  });

  it('CTE counts projects per (board_type, climb_uuid), reading each climb row once', async () => {
    // Pin the joint scoping: a kilter send must NOT exclude a tension climb
    // sharing the same UUID from the projects count. The pure SQL of the CTE is
    // what enforces this, so this test asserts on the SQL string rather than on
    // db result rows.
    const ctx = makeCtx();
    queueCountsRows([]);

    await playlistQueries.mySmartPlaylistCounts(null, undefined, ctx);

    expect(mockDb.execute).toHaveBeenCalledTimes(2);
    const rendered = sqlText(countsSqlArg());

    // The per-climb aggregate groups on both columns, and its join to the climb
    // row matches both.
    expect(rendered).toMatch(/FROM base\s+GROUP BY climb_uuid, board_type/);
    expect(rendered).toMatch(
      /logged_climb\.board_type = logged\.board_type AND logged_climb\.uuid = logged\.climb_uuid/,
    );
    // The join repeats the partial-index predicate, so it reads only the climbs
    // whose holds have moved and never probes board_climbs once per climb.
    expect(rendered).toMatch(/logged\.climb_uuid\s+AND logged_climb\.holds_revision_number > 1/);
    // Tried on the current holds, and not sent on them (#6023).
    expect(rendered).toMatch(
      /COALESCE\(logged\.latest_revision, 0\) >= COALESCE\(logged_climb\.holds_revision_number, 1\)\s+AND NOT COALESCE\(logged\.latest_sent_revision, 0\) >= COALESCE\(logged_climb\.holds_revision_number, 1\)/,
    );
    // The base scan, shared by all three cards, does not read board_climbs.
    expect(rendered.slice(0, rendered.indexOf('logged AS'))).not.toMatch(/JOIN/);
  });

  it('appends RECOMMENDED_* counts when a board resolves', async () => {
    const ctx = makeCtx();
    queueCountsRows([{ type: 'FIVE_STARS', count: 1 }]);
    resolveTargetMock.mockResolvedValueOnce({ boardType: 'kilter', layoutId: 8, sizeId: 25, angle: 40, setIds: null });
    cardCountMock.mockResolvedValue(7);

    const result = await playlistQueries.mySmartPlaylistCounts(null, undefined, ctx);

    const recCounts = result.filter((entry) => entry.type.startsWith('RECOMMENDED_'));
    expect(recCounts).toHaveLength(4);
    expect(recCounts.every((entry) => entry.count === 7)).toBe(true);
    expect(result).toContainEqual({ type: 'FIVE_STARS', count: 1 });
    // Cards take the cached catalog-minus-sends count; the exact per-user count
    // is reserved for the playlist page's hero.
    expect(cardCountMock).toHaveBeenCalledTimes(4);
    expect(countRefsMock).not.toHaveBeenCalled();
  });

  it('omits RECOMMENDED_* counts when no board resolves', async () => {
    const ctx = makeCtx();
    queueCountsRows([{ type: 'FIVE_STARS', count: 1 }]);
    resolveTargetMock.mockResolvedValueOnce(null);

    const result = await playlistQueries.mySmartPlaylistCounts(null, undefined, ctx);
    expect(result.some((entry) => entry.type.startsWith('RECOMMENDED_'))).toBe(false);
    expect(result).toHaveLength(4);
  });
});
