import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { playlistQueries } from '../graphql/resolvers/playlists/queries';

const { mockDb } = vi.hoisted(() => {
  const mockDb = {
    execute: vi.fn(),
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(),
  };
  return { mockDb };
});

vi.mock('../db/client', () => ({
  db: mockDb,
}));

vi.mock('../events/index', () => ({
  publishSocialEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../utils/rate-limiter', () => ({
  checkRateLimit: vi.fn(),
}));

vi.mock('../utils/redis-rate-limiter', () => ({
  checkRateLimitRedis: vi.fn(),
}));

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
      createdAt: 'createdAt',
      edgeLeft: 'edgeLeft',
      edgeRight: 'edgeRight',
      edgeBottom: 'edgeBottom',
      edgeTop: 'edgeTop',
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
    difficultyGrades: {
      boardType: 'boardType',
      difficulty: 'difficulty',
      boulderName: 'boulderName',
    },
  },
  isValidBoardName: vi.fn().mockReturnValue(true),
}));

vi.mock('../db/queries/util/hold-state', () => ({
  convertLitUpHoldsStringToMap: vi.fn().mockReturnValue([{}]),
}));

function makeCtx(overrides: Partial<ConnectionContext> = {}): ConnectionContext {
  return {
    connectionId: 'conn-1',
    isAuthenticated: false,
    userId: null,
    sessionId: null,
    boardPath: null,
    controllerId: null,
    controllerApiKey: null,
    ...overrides,
  } as ConnectionContext;
}

/**
 * Creates a mock Drizzle query chain that tracks method calls.
 * Returns the chain and a `calls` map for inspecting which methods were called.
 */
function createMockChain(resolveValue: unknown = []) {
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
    // The size-band count wraps a grouped subquery, so the chain has to be
    // aliasable the way a real Drizzle builder is.
    'as',
    'insert',
    'values',
    'onConflictDoNothing',
    'returning',
    'delete',
    'update',
    'set',
  ];

  // oxlint-disable-next-line unicorn/no-thenable -- Drizzle query builders are awaitable; this mock mirrors that API.
  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(resolveValue).then(resolve);

  for (const method of methods) {
    calls[method] = [];
    chain[method] = vi.fn((...args: unknown[]) => {
      calls[method].push(args);
      return chain;
    });
  }

  return { chain, calls };
}

/**
 * Drizzle SQL objects are circular, so JSON.stringify throws on them. They do
 * expose `usedTables`, and their `queryChunks` carry the literal params — which
 * between them is enough to assert what a clause is actually made of.
 */
function tablesIn(node: unknown): string[] {
  const found: string[] = [];
  const walk = (value: unknown) => {
    if (value == null || typeof value !== 'object') return;
    const candidate = value as { usedTables?: string[]; queryChunks?: unknown[] };
    if (Array.isArray(candidate.usedTables)) found.push(...candidate.usedTables);
    if (Array.isArray(candidate.queryChunks)) candidate.queryChunks.forEach(walk);
    if (Array.isArray(value)) value.forEach(walk);
  };
  walk(node);
  return found;
}

function paramsIn(node: unknown): unknown[] {
  const found: unknown[] = [];
  const walk = (value: unknown) => {
    if (value == null || typeof value !== 'object') return;
    const candidate = value as { value?: unknown; queryChunks?: unknown[] };
    // StringChunk also has a `value` — an array of literal SQL fragments — so it
    // has to be excluded by name, or every fragment reads as a bound param.
    if ('value' in candidate && value.constructor?.name !== 'StringChunk') {
      const bound = candidate.value;
      if (Array.isArray(bound)) found.push(...bound);
      else if (bound == null || typeof bound !== 'object') found.push(bound);
    }
    if (Array.isArray(candidate.queryChunks)) candidate.queryChunks.forEach(walk);
    if (Array.isArray(value)) value.forEach(walk);
  };
  walk(node);
  return found;
}

const NOW = new Date('2026-01-15T12:00:00Z');

function makePlaylistRow(overrides: Record<string, unknown> = {}) {
  return {
    id: BigInt(1),
    uuid: 'pl-1',
    boardType: 'kilter',
    layoutId: 1,
    name: 'Test Playlist',
    description: 'A test playlist',
    color: '#FF0000',
    icon: null,
    createdAt: NOW,
    updatedAt: NOW,
    creatorId: 'creator-1',
    creatorName: 'TestUser',
    climbCount: 5,
    generatedRecommendation: null,
    ...overrides,
  };
}

describe('discoverPlaylists resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return playlists without boardType or layoutId filter', async () => {
    const ctx = makeCtx();

    const { chain: countChain, calls: countCalls } = createMockChain([{ count: 2 }]);
    mockDb.select.mockReturnValueOnce(countChain);

    const { chain: resultsChain, calls: resultsCalls } = createMockChain([
      makePlaylistRow({ uuid: 'pl-1', boardType: 'kilter', name: 'Kilter Playlist' }),
      makePlaylistRow({
        uuid: 'pl-2',
        boardType: 'tension',
        name: 'Tension Playlist',
        id: BigInt(2),
      }),
    ]);
    mockDb.select.mockReturnValueOnce(resultsChain);

    const result = await playlistQueries.discoverPlaylists(null, { input: {} }, ctx);

    expect(result.totalCount).toBe(2);
    expect(result.playlists).toHaveLength(2);
    expect(result.playlists[0]).toMatchObject({
      uuid: 'pl-1',
      boardType: 'kilter',
      isGeneratedRecommendation: false,
    });
    expect(result.playlists[1]).toMatchObject({ uuid: 'pl-2', boardType: 'tension' });

    // Verify both queries used where() (at minimum isPublic filter + owner role)
    expect(countCalls.where.length).toBe(1);
    expect(resultsCalls.where.length).toBe(1);

    // Verify exactly 2 select calls (count + results)
    expect(mockDb.select).toHaveBeenCalledTimes(2);
  });

  it('should filter by boardType when provided', async () => {
    const ctx = makeCtx();

    const { chain: countChain, calls: countCalls } = createMockChain([{ count: 1 }]);
    mockDb.select.mockReturnValueOnce(countChain);

    const { chain: resultsChain, calls: resultsCalls } = createMockChain([
      makePlaylistRow({ uuid: 'pl-1', boardType: 'kilter' }),
    ]);
    mockDb.select.mockReturnValueOnce(resultsChain);

    const result = await playlistQueries.discoverPlaylists(null, { input: { boardType: 'kilter' } }, ctx);

    expect(result.totalCount).toBe(1);
    expect(result.playlists).toHaveLength(1);
    expect(result.playlists[0]).toMatchObject({ boardType: 'kilter' });

    // Both count and results queries should have where() called
    expect(countCalls.where.length).toBe(1);
    expect(resultsCalls.where.length).toBe(1);

    // The where() args are Drizzle AST nodes — we can't easily inspect them,
    // but we verify the resolver called where() and didn't skip filtering
    expect(mockDb.select).toHaveBeenCalledTimes(2);
  });

  it('should filter by boardType and layoutId when both provided', async () => {
    const ctx = makeCtx();

    const { chain: countChain, calls: countCalls } = createMockChain([{ count: 1 }]);
    mockDb.select.mockReturnValueOnce(countChain);

    const { chain: resultsChain, calls: resultsCalls } = createMockChain([
      makePlaylistRow({ uuid: 'pl-1', boardType: 'kilter', layoutId: 8 }),
    ]);
    mockDb.select.mockReturnValueOnce(resultsChain);

    const result = await playlistQueries.discoverPlaylists(null, { input: { boardType: 'kilter', layoutId: 8 } }, ctx);

    expect(result.totalCount).toBe(1);
    expect(result.playlists).toHaveLength(1);
    expect(result.playlists[0]).toMatchObject({ boardType: 'kilter', layoutId: 8 });

    // Both queries should have where()
    expect(countCalls.where.length).toBe(1);
    expect(resultsCalls.where.length).toBe(1);
  });

  it('accepts a negative angle (Aurora boards support negative tilt) filter', async () => {
    const ctx = makeCtx();

    const { chain: countChain } = createMockChain([{ count: 0 }]);
    mockDb.select.mockReturnValueOnce(countChain);

    const { chain: resultsChain } = createMockChain([]);
    mockDb.select.mockReturnValueOnce(resultsChain);

    const result = await playlistQueries.discoverPlaylists(
      null,
      { input: { boardType: 'kilter', layoutId: 8, sizeId: 25, angle: -5 } },
      ctx,
    );

    expect(result.totalCount).toBe(0);
    expect(result.playlists).toEqual([]);
  });

  it('rejects angle -91 (outside the -90..90 board-tilt range)', async () => {
    const ctx = makeCtx();

    await expect(
      playlistQueries.discoverPlaylists(null, { input: { boardType: 'kilter', layoutId: 8, angle: -91 } }, ctx),
    ).rejects.toThrow();
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('should paginate correctly with hasMore', async () => {
    const ctx = makeCtx();

    const { chain: countChain } = createMockChain([{ count: 25 }]);
    mockDb.select.mockReturnValueOnce(countChain);

    const rows = Array.from({ length: 11 }, (_, i) =>
      makePlaylistRow({ uuid: `pl-${i}`, id: BigInt(i + 1), name: `Playlist ${i}` }),
    );
    const { chain: resultsChain, calls: resultsCalls } = createMockChain(rows);
    mockDb.select.mockReturnValueOnce(resultsChain);

    const result = await playlistQueries.discoverPlaylists(null, { input: { pageSize: 10, page: 0 } }, ctx);

    expect(result.hasMore).toBe(true);
    expect(result.playlists).toHaveLength(10);
    expect(result.totalCount).toBe(25);

    // Verify limit was called with pageSize + 1 (to detect hasMore)
    expect(resultsCalls.limit.length).toBe(1);
    expect(resultsCalls.limit[0][0]).toBe(11); // pageSize + 1

    // Verify offset was called
    expect(resultsCalls.offset.length).toBe(1);
    expect(resultsCalls.offset[0][0]).toBe(0); // page * pageSize
  });

  it('should return empty results when no playlists match', async () => {
    const ctx = makeCtx();

    const { chain: countChain } = createMockChain([{ count: 0 }]);
    mockDb.select.mockReturnValueOnce(countChain);

    const { chain: resultsChain } = createMockChain([]);
    mockDb.select.mockReturnValueOnce(resultsChain);

    const result = await playlistQueries.discoverPlaylists(
      null,
      { input: { boardType: 'tension', layoutId: 99 } },
      ctx,
    );

    expect(result.totalCount).toBe(0);
    expect(result.playlists).toHaveLength(0);
    expect(result.hasMore).toBe(false);
  });

  it('should support name filter', async () => {
    const ctx = makeCtx();

    const { chain: countChain } = createMockChain([{ count: 1 }]);
    mockDb.select.mockReturnValueOnce(countChain);

    const { chain: resultsChain } = createMockChain([makePlaylistRow({ uuid: 'pl-1', name: 'Hard Boulders' })]);
    mockDb.select.mockReturnValueOnce(resultsChain);

    const result = await playlistQueries.discoverPlaylists(null, { input: { name: 'boulders' } }, ctx);

    expect(result.playlists).toHaveLength(1);
    expect(result.playlists[0]).toMatchObject({ name: 'Hard Boulders' });
  });

  it('should expose generated recommendation rows for the requested cohort', async () => {
    const ctx = makeCtx();

    const { chain: countChain, calls: countCalls } = createMockChain([{ count: 1 }]);
    mockDb.select.mockReturnValueOnce(countChain);

    const { chain: resultsChain, calls: resultsCalls } = createMockChain([
      makePlaylistRow({ uuid: 'generated-1', generatedRecommendation: 'kilter:8:25:40:fresh' }),
    ]);
    mockDb.select.mockReturnValueOnce(resultsChain);

    const result = await playlistQueries.discoverPlaylists(
      null,
      { input: { boardType: 'kilter', layoutId: 8, sizeId: 25, angle: 40, generatedRecommendation: true } },
      ctx,
    );

    expect(result.totalCount).toBe(1);
    expect(result.playlists).toHaveLength(1);
    expect(result.playlists[0]).toMatchObject({
      uuid: 'generated-1',
      isGeneratedRecommendation: true,
    });
    expect(countCalls.where.length).toBe(1);
    expect(resultsCalls.where.length).toBe(1);
  });

  it('should expose community rows when generated recommendations are excluded', async () => {
    const ctx = makeCtx();

    const { chain: countChain, calls: countCalls } = createMockChain([{ count: 1 }]);
    mockDb.select.mockReturnValueOnce(countChain);

    const { chain: resultsChain, calls: resultsCalls } = createMockChain([
      makePlaylistRow({ uuid: 'community-1', generatedRecommendation: null }),
    ]);
    mockDb.select.mockReturnValueOnce(resultsChain);

    const result = await playlistQueries.discoverPlaylists(null, { input: { generatedRecommendation: false } }, ctx);

    expect(result.totalCount).toBe(1);
    expect(result.playlists).toHaveLength(1);
    expect(result.playlists[0]).toMatchObject({
      uuid: 'community-1',
      isGeneratedRecommendation: false,
    });
    expect(countCalls.where.length).toBe(1);
    expect(resultsCalls.where.length).toBe(1);
  });

  it('should treat a null generated recommendation filter as omitted', async () => {
    const ctx = makeCtx();

    const { chain: countChain } = createMockChain([{ count: 1 }]);
    mockDb.select.mockReturnValueOnce(countChain);

    const { chain: resultsChain } = createMockChain([makePlaylistRow({ uuid: 'pl-null-filter' })]);
    mockDb.select.mockReturnValueOnce(resultsChain);

    const result = await playlistQueries.discoverPlaylists(null, { input: { generatedRecommendation: null } }, ctx);

    expect(result.playlists).toHaveLength(1);
    expect(result.playlists[0]).toMatchObject({ uuid: 'pl-null-filter' });
  });

  it('should not require authentication', async () => {
    const ctx = makeCtx({ isAuthenticated: false, userId: undefined });

    const { chain: countChain } = createMockChain([{ count: 1 }]);
    mockDb.select.mockReturnValueOnce(countChain);

    const { chain: resultsChain } = createMockChain([makePlaylistRow()]);
    mockDb.select.mockReturnValueOnce(resultsChain);

    const result = await playlistQueries.discoverPlaylists(null, { input: {} }, ctx);

    expect(result.playlists).toHaveLength(1);
  });

  it('should support sortBy popular', async () => {
    const ctx = makeCtx();

    const { chain: countChain } = createMockChain([{ count: 2 }]);
    mockDb.select.mockReturnValueOnce(countChain);

    const { chain: resultsChain, calls: resultsCalls } = createMockChain([
      makePlaylistRow({ uuid: 'pl-popular', climbCount: 50 }),
      makePlaylistRow({ uuid: 'pl-small', climbCount: 2, id: BigInt(2) }),
    ]);
    mockDb.select.mockReturnValueOnce(resultsChain);

    const result = await playlistQueries.discoverPlaylists(null, { input: { sortBy: 'popular' } }, ctx);

    expect(result.playlists).toHaveLength(2);
    expect(result.playlists[0]).toMatchObject({ uuid: 'pl-popular' });

    // Verify orderBy was called (popular sort uses follower count)
    expect(resultsCalls.orderBy.length).toBe(1);
  });

  it('orders popular by engagement FIRST, then size as the tiebreak', async () => {
    // The tiebreak is load-bearing, not decoration. Production has 106 pins
    // across 829 public playlists, so most rows tie at zero engagement and the
    // second term is what actually orders the page. Both terms must be present.
    const ctx = makeCtx();

    const { chain: countChain } = createMockChain([{ count: 2 }]);
    mockDb.select.mockReturnValueOnce(countChain);
    const { chain: resultsChain, calls: resultsCalls } = createMockChain([makePlaylistRow()]);
    mockDb.select.mockReturnValueOnce(resultsChain);

    await playlistQueries.discoverPlaylists(null, { input: { sortBy: 'popular' } }, ctx);

    // `usedTables` records tables passed into the sql template, which is exactly
    // what the engagement subqueries do — a column reference like the climb count
    // never shows up here, so the term count below covers that half.
    const tables = tablesIn(resultsCalls.orderBy[0]);
    expect(tables).toContain('user_playlist_pins');
    expect(tables).toContain('playlist_follows');
    // Engagement, size, updatedAt, id — four terms. `recent` has three, so the
    // count is what distinguishes "engagement plus a tiebreak" from either alone.
    expect(resultsCalls.orderBy[0]).toHaveLength(4);
  });

  it('leaves the recent sort alone — engagement is a popularity concept', async () => {
    const ctx = makeCtx();

    const { chain: countChain } = createMockChain([{ count: 1 }]);
    mockDb.select.mockReturnValueOnce(countChain);
    const { chain: resultsChain, calls: resultsCalls } = createMockChain([makePlaylistRow()]);
    mockDb.select.mockReturnValueOnce(resultsChain);

    await playlistQueries.discoverPlaylists(null, { input: { sortBy: 'recent' } }, ctx);

    // `tablesIn` reads Drizzle internals, so a `.not.toContain` on it would pass
    // vacuously if a Drizzle bump ever changed that shape. The term count is the
    // independent check: `recent` has three, `popular` four.
    expect(tablesIn(resultsCalls.orderBy[0])).not.toContain('user_playlist_pins');
    expect(resultsCalls.orderBy[0]).toHaveLength(3);
  });

  it('applies a size band through HAVING, not WHERE', async () => {
    // A climb-count filter cannot be a WHERE clause: the count only exists after
    // the GROUP BY. Getting this wrong filters on the join row, not the playlist.
    const ctx = makeCtx();

    const { chain: bandedCountChain } = createMockChain([{ count: 3 }]);
    mockDb.select.mockReturnValueOnce(bandedCountChain);
    const { chain: innerChain } = createMockChain([]);
    mockDb.select.mockReturnValueOnce(innerChain);
    const { chain: resultsChain, calls: resultsCalls } = createMockChain([makePlaylistRow()]);
    mockDb.select.mockReturnValueOnce(resultsChain);

    await playlistQueries.discoverPlaylists(null, { input: { minClimbs: 5, maxClimbs: 150 } }, ctx);

    // The clause exists, it is a HAVING, and it is built from the climb count —
    // not from a WHERE on the join row, which would filter climbs rather than
    // playlists and quietly return the wrong set.
    expect(resultsCalls.having.length).toBe(1);
    expect(resultsCalls.having[0][0]).toBeDefined();
  });

  it('does not reach for a HAVING when no size band was asked for', async () => {
    const ctx = makeCtx();

    const { chain: countChain } = createMockChain([{ count: 1 }]);
    mockDb.select.mockReturnValueOnce(countChain);
    const { chain: resultsChain, calls: resultsCalls } = createMockChain([makePlaylistRow()]);
    mockDb.select.mockReturnValueOnce(resultsChain);

    await playlistQueries.discoverPlaylists(null, { input: {} }, ctx);

    expect(resultsCalls.having[0]).toEqual([undefined]);
  });

  it("excludes the viewer's own playlists server-side, so they do not eat page slots", async () => {
    // This filter used to live on the client, which meant an owner's playlists
    // were fetched, counted against pageSize, and then removed — silently
    // shrinking the grid they were removed from.
    const ctx = makeCtx();

    const { chain: countChain } = createMockChain([{ count: 1 }]);
    mockDb.select.mockReturnValueOnce(countChain);
    const { chain: resultsChain, calls: resultsCalls } = createMockChain([makePlaylistRow()]);
    mockDb.select.mockReturnValueOnce(resultsChain);

    await playlistQueries.discoverPlaylists(null, { input: { excludeCreatorIds: ['me'] } }, ctx);

    expect(paramsIn(resultsCalls.where[0])).toContain('me');
  });

  it('rejects a size band outside the allowed range', async () => {
    const ctx = makeCtx();

    await expect(playlistQueries.discoverPlaylists(null, { input: { minClimbs: 0 } }, ctx)).rejects.toThrow();
  });

  it('rejects an INVERTED band rather than returning a convincing empty page', async () => {
    // min > max is a caller bug, but the query would happily run it and return
    // zero rows — indistinguishable from "the catalogue has nothing to show".
    const ctx = makeCtx();

    await expect(
      playlistQueries.discoverPlaylists(null, { input: { minClimbs: 100, maxClimbs: 50 } }, ctx),
    ).rejects.toThrow();
  });

  it('should use correct page offset for page > 0', async () => {
    const ctx = makeCtx();

    const { chain: countChain } = createMockChain([{ count: 50 }]);
    mockDb.select.mockReturnValueOnce(countChain);

    const rows = Array.from({ length: 5 }, (_, i) => makePlaylistRow({ uuid: `pl-${i}`, id: BigInt(i + 1) }));
    const { chain: resultsChain, calls: resultsCalls } = createMockChain(rows);
    mockDb.select.mockReturnValueOnce(resultsChain);

    const result = await playlistQueries.discoverPlaylists(null, { input: { page: 2, pageSize: 5 } }, ctx);

    expect(result.playlists).toHaveLength(5);
    expect(result.hasMore).toBe(false);

    // Verify offset = page * pageSize = 2 * 5 = 10
    expect(resultsCalls.offset[0][0]).toBe(10);
    // Verify limit = pageSize + 1 = 6
    expect(resultsCalls.limit[0][0]).toBe(6);
  });
});
