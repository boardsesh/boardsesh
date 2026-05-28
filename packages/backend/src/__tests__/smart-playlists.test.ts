import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { playlistQueries } from '../graphql/resolvers/playlists/queries';

const { mockDb, eqSpy, notInArraySpy } = vi.hoisted(() => {
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
  };
});

vi.mock('../db/client', () => ({ db: mockDb }));

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

describe('smartPlaylist resolver', () => {
  beforeEach(() => {
    // resetAllMocks (not clearAllMocks) so the `mockReturnValueOnce` queues
    // drain between tests — clearAllMocks only resets call history, leaving
    // unused queued return values to leak into the next test.
    vi.resetAllMocks();
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

  it('PROJECTS uses a NOT EXISTS scoped by both board_type and climb_uuid', async () => {
    const ctx = makeCtx();

    mockDb.select.mockReturnValueOnce(makeChain([USER_ROW]).chain);

    // No separate sent-subquery select — the NOT EXISTS lives inside the
    // where() arg as a sql`` fragment. Just three top-level selects:
    // user lookup, page query, count query.
    const { chain: pageChain, calls: pageCalls } = makeChain([]);
    mockDb.select.mockReturnValueOnce(pageChain);
    const { chain: countChain, calls: countCalls } = makeChain([{ count: 0 }]);
    mockDb.select.mockReturnValueOnce(countChain);

    await playlistQueries.smartPlaylist(
      null,
      {
        input: { type: 'PROJECTS', userId: 'user-123', boardName: 'kilter' },
      },
      ctx,
    );

    // Both page and count call where() exactly once with a composed condition
    // that includes the NOT EXISTS sentinel. Stringifying the sql fragment so
    // the test can assert on its shape without coupling to drizzle's AST.
    expect(pageCalls.where.length).toBe(1);
    expect(countCalls.where.length).toBe(1);

    // The NOT EXISTS SQL fragment must reference both board_type and climb_uuid
    // — that is the joint-scoping fix for the UUID-collision bug. Drizzle
    // serialises the sql template's `queryChunks` so we can inspect them.
    const renderSql = (whereArg: unknown): string => {
      // drizzle wraps the fragment as `{ queryChunks: [...] }`. Recurse for nested.
      const seen = new WeakSet<object>();
      const walk = (node: unknown): string => {
        if (node === null || node === undefined) return '';
        if (typeof node === 'string') return node;
        if (typeof node !== 'object') return '';
        if (seen.has(node)) return '';
        seen.add(node);
        const obj = node as Record<string, unknown>;
        if (Array.isArray(obj.queryChunks)) {
          return (obj.queryChunks as unknown[]).map(walk).join(' ');
        }
        if (Array.isArray((obj as { value?: unknown[] }).value)) {
          return (obj.value as unknown[]).map(walk).join(' ');
        }
        return Object.values(obj).map(walk).join(' ');
      };
      return walk(whereArg);
    };
    for (const calls of [pageCalls, countCalls]) {
      const rendered = renderSql(calls.where[0][0]);
      // Inner subquery aliases boardsesh_ticks as `sent` and references the
      // outer scope by bare `boardsesh_ticks.<col>`. Pin both halves of the
      // correlation so a future Drizzle interpolation regression can't
      // silently turn the subquery into `sent.x = sent.x` (always-true) or
      // `boardsesh_ticks.x = boardsesh_ticks.x` (no correlation at all).
      expect(rendered.toUpperCase()).toMatch(/NOT EXISTS/);
      expect(rendered).toMatch(/FROM\s+boardsesh_ticks\s+AS\s+sent/i);
      expect(rendered).toMatch(/sent\.board_type\s*=\s*boardsesh_ticks\.board_type/i);
      expect(rendered).toMatch(/sent\.climb_uuid\s*=\s*boardsesh_ticks\.climb_uuid/i);
      expect(rendered).toMatch(/sent\.status\s+IN\s*\(\s*'flash'\s*,\s*'send'\s*\)/i);
    }

    // Sanity: notInArray is no longer used anywhere (we replaced it with NOT EXISTS).
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
    mockDb.select.mockReturnValueOnce(makeChain([{ count: 7 }]).chain);
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
    mockDb.select.mockReturnValueOnce(makeChain([]).chain);

    await expect(
      playlistQueries.smartPlaylist(
        null,
        {
          input: { type: 'FIVE_STARS', userId: 'missing' },
        },
        ctx,
      ),
    ).rejects.toThrow('User not found');
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
});

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

    // Single db.execute call returns three rows. Order returned from the
    // resolver is fixed (FIVE_STARS, MOST_REPEATED, PROJECTS) regardless of
    // SQL row order.
    mockDb.execute.mockResolvedValueOnce([
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
    expect(mockDb.execute).toHaveBeenCalledTimes(1);
  });

  it('handles the {rows: ...} shape some postgres clients return', async () => {
    const ctx = makeCtx();

    mockDb.execute.mockResolvedValueOnce({
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

    mockDb.execute.mockResolvedValueOnce([{ type: 'FIVE_STARS', count: 9 }]);

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

    mockDb.execute.mockResolvedValueOnce([
      { type: 'FIVE_STARS', count: 7 },
      { type: 'MOST_REPEATED', count: 3 },
      { type: 'PROJECTS', count: 5 },
      { type: 'LIKED_CLIMBS', count: 12 },
    ]);

    const result = await playlistQueries.mySmartPlaylistCounts(null, undefined, ctx);
    expect(result).toContainEqual({ type: 'LIKED_CLIMBS', count: 12 });
  });

  it('CTE scopes the sent-climbs check by both board_type and climb_uuid', async () => {
    // Pin the joint-scoping fix: a kilter send must NOT exclude a tension
    // climb sharing the same UUID from the projects count. The pure SQL of
    // the CTE is what enforces this, so this test asserts on the SQL string
    // rather than on db result rows.
    const ctx = makeCtx();
    mockDb.execute.mockResolvedValueOnce([]);

    await playlistQueries.mySmartPlaylistCounts(null, undefined, ctx);

    expect(mockDb.execute).toHaveBeenCalledTimes(1);
    const sqlArg = mockDb.execute.mock.calls[0][0] as { queryChunks?: unknown[] } | undefined;
    const rendered = (sqlArg?.queryChunks ?? [])
      .map((chunk) => (typeof chunk === 'string' ? chunk : ((chunk as { value?: string }).value ?? '')))
      .join(' ');

    // sent CTE projects (climb_uuid, board_type) — not just climb_uuid.
    expect(rendered).toMatch(/SELECT\s+DISTINCT\s+climb_uuid,\s+board_type\s+FROM\s+base/i);
    // projects CTE checks NOT EXISTS with both columns matched.
    expect(rendered.toUpperCase()).toContain('NOT EXISTS');
    expect(rendered).toMatch(/sent\.climb_uuid\s*=\s*base\.climb_uuid/i);
    expect(rendered).toMatch(/sent\.board_type\s*=\s*base\.board_type/i);
  });
});
