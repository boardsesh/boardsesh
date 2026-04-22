import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

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

import { playlistQueries } from '../graphql/resolvers/playlists/queries';

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
    'orderBy',
    'limit',
    'offset',
    'insert',
    'values',
    'onConflictDoNothing',
    'returning',
    'delete',
    'update',
    'set',
  ];

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
    ...overrides,
  };
}

describe('discoverPlaylists resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return playlists without boardType or layoutId filter', async () => {
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

    const result = await playlistQueries.discoverPlaylists(null, { input: {} });

    expect(result.totalCount).toBe(2);
    expect(result.playlists).toHaveLength(2);
    expect(result.playlists[0]).toMatchObject({ uuid: 'pl-1', boardType: 'kilter' });
    expect(result.playlists[1]).toMatchObject({ uuid: 'pl-2', boardType: 'tension' });

    // Verify both queries used where() (at minimum isPublic filter + owner role)
    expect(countCalls.where.length).toBe(1);
    expect(resultsCalls.where.length).toBe(1);

    // Verify exactly 2 select calls (count + results)
    expect(mockDb.select).toHaveBeenCalledTimes(2);
  });

  it('should filter by boardType when provided', async () => {
    const { chain: countChain, calls: countCalls } = createMockChain([{ count: 1 }]);
    mockDb.select.mockReturnValueOnce(countChain);

    const { chain: resultsChain, calls: resultsCalls } = createMockChain([
      makePlaylistRow({ uuid: 'pl-1', boardType: 'kilter' }),
    ]);
    mockDb.select.mockReturnValueOnce(resultsChain);

    const result = await playlistQueries.discoverPlaylists(null, { input: { boardType: 'kilter' } });

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
    const { chain: countChain, calls: countCalls } = createMockChain([{ count: 1 }]);
    mockDb.select.mockReturnValueOnce(countChain);

    const { chain: resultsChain, calls: resultsCalls } = createMockChain([
      makePlaylistRow({ uuid: 'pl-1', boardType: 'kilter', layoutId: 8 }),
    ]);
    mockDb.select.mockReturnValueOnce(resultsChain);

    const result = await playlistQueries.discoverPlaylists(null, { input: { boardType: 'kilter', layoutId: 8 } });

    expect(result.totalCount).toBe(1);
    expect(result.playlists).toHaveLength(1);
    expect(result.playlists[0]).toMatchObject({ boardType: 'kilter', layoutId: 8 });

    // Both queries should have where()
    expect(countCalls.where.length).toBe(1);
    expect(resultsCalls.where.length).toBe(1);
  });

  it('should paginate correctly with hasMore', async () => {
    const { chain: countChain } = createMockChain([{ count: 25 }]);
    mockDb.select.mockReturnValueOnce(countChain);

    const rows = Array.from({ length: 11 }, (_, i) =>
      makePlaylistRow({ uuid: `pl-${i}`, id: BigInt(i + 1), name: `Playlist ${i}` }),
    );
    const { chain: resultsChain, calls: resultsCalls } = createMockChain(rows);
    mockDb.select.mockReturnValueOnce(resultsChain);

    const result = await playlistQueries.discoverPlaylists(null, { input: { pageSize: 10, page: 0 } });

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
    const { chain: countChain } = createMockChain([{ count: 0 }]);
    mockDb.select.mockReturnValueOnce(countChain);

    const { chain: resultsChain } = createMockChain([]);
    mockDb.select.mockReturnValueOnce(resultsChain);

    const result = await playlistQueries.discoverPlaylists(null, { input: { boardType: 'tension', layoutId: 99 } });

    expect(result.totalCount).toBe(0);
    expect(result.playlists).toHaveLength(0);
    expect(result.hasMore).toBe(false);
  });

  it('should support name filter', async () => {
    const { chain: countChain } = createMockChain([{ count: 1 }]);
    mockDb.select.mockReturnValueOnce(countChain);

    const { chain: resultsChain } = createMockChain([makePlaylistRow({ uuid: 'pl-1', name: 'Hard Boulders' })]);
    mockDb.select.mockReturnValueOnce(resultsChain);

    const result = await playlistQueries.discoverPlaylists(null, { input: { name: 'boulders' } });

    expect(result.playlists).toHaveLength(1);
    expect(result.playlists[0]).toMatchObject({ name: 'Hard Boulders' });
  });

  it('should not require authentication', async () => {
    const { chain: countChain } = createMockChain([{ count: 1 }]);
    mockDb.select.mockReturnValueOnce(countChain);

    const { chain: resultsChain } = createMockChain([makePlaylistRow()]);
    mockDb.select.mockReturnValueOnce(resultsChain);

    const result = await playlistQueries.discoverPlaylists(null, { input: {} });

    expect(result.playlists).toHaveLength(1);
  });

  it('should support sortBy popular', async () => {
    const { chain: countChain } = createMockChain([{ count: 2 }]);
    mockDb.select.mockReturnValueOnce(countChain);

    const { chain: resultsChain, calls: resultsCalls } = createMockChain([
      makePlaylistRow({ uuid: 'pl-popular', climbCount: 50 }),
      makePlaylistRow({ uuid: 'pl-small', climbCount: 2, id: BigInt(2) }),
    ]);
    mockDb.select.mockReturnValueOnce(resultsChain);

    const result = await playlistQueries.discoverPlaylists(null, { input: { sortBy: 'popular' } });

    expect(result.playlists).toHaveLength(2);
    expect(result.playlists[0]).toMatchObject({ uuid: 'pl-popular' });

    // Verify orderBy was called (popular sort uses follower count)
    expect(resultsCalls.orderBy.length).toBe(1);
  });

  it('should use correct page offset for page > 0', async () => {
    const { chain: countChain } = createMockChain([{ count: 50 }]);
    mockDb.select.mockReturnValueOnce(countChain);

    const rows = Array.from({ length: 5 }, (_, i) => makePlaylistRow({ uuid: `pl-${i}`, id: BigInt(i + 1) }));
    const { chain: resultsChain, calls: resultsCalls } = createMockChain(rows);
    mockDb.select.mockReturnValueOnce(resultsChain);

    const result = await playlistQueries.discoverPlaylists(null, { input: { page: 2, pageSize: 5 } });

    expect(result.playlists).toHaveLength(5);
    expect(result.hasMore).toBe(false);

    // Verify offset = page * pageSize = 2 * 5 = 10
    expect(resultsCalls.offset[0][0]).toBe(10);
    // Verify limit = pageSize + 1 = 6
    expect(resultsCalls.limit[0][0]).toBe(6);
  });
});
