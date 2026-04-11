import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  createRequestDb: () => mockDb,
  withTransaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(mockDb),
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
  getBoardTables: vi.fn().mockReturnValue({
    climbs: { uuid: 'uuid', layoutId: 'layoutId', boardType: 'boardType', setterUsername: 'setterUsername', name: 'name', description: 'description', frames: 'frames', createdAt: 'createdAt', edgeLeft: 'edgeLeft', edgeRight: 'edgeRight', edgeBottom: 'edgeBottom', edgeTop: 'edgeTop' },
    climbStats: { climbUuid: 'climbUuid', boardType: 'boardType', angle: 'angle', ascensionistCount: 'ascensionistCount', qualityAverage: 'qualityAverage', difficultyAverage: 'difficultyAverage', displayDifficulty: 'displayDifficulty', benchmarkDifficulty: 'benchmarkDifficulty' },
    difficultyGrades: { boardType: 'boardType', difficulty: 'difficulty', boulderName: 'boulderName' },
  }),
  isValidBoardName: vi.fn().mockReturnValue(true),
}));

vi.mock('../db/queries/util/hold-state', () => ({
  convertLitUpHoldsStringToMap: vi.fn().mockReturnValue([{}]),
}));

import type { ConnectionContext } from '@boardsesh/shared-schema';
import { playlistQueries } from '../graphql/resolvers/playlists/queries';

function makeCtx(overrides: Partial<ConnectionContext> = {}): ConnectionContext {
  return {
    connectionId: 'conn-1',
    isAuthenticated: true,
    userId: 'user-123',
    sessionId: null,
    boardPath: null,
    controllerId: null,
    controllerApiKey: null,
    db: mockDb as unknown as ConnectionContext['db'],
    ...overrides,
  } as ConnectionContext;
}

const NOW = new Date('2026-01-15T12:00:00Z');

/**
 * Creates a mock Drizzle query chain that tracks method calls.
 */
function createMockChain(resolveValue: unknown = []) {
  const calls: Record<string, unknown[][]> = {};
  const chain: Record<string, unknown> = {};
  const methods = [
    'select', 'from', 'where', 'leftJoin', 'innerJoin',
    'groupBy', 'orderBy', 'limit', 'offset',
    'insert', 'values', 'onConflictDoNothing', 'returning',
    'delete', 'update', 'set',
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

function makePlaylistRow(overrides: Record<string, unknown> = {}) {
  return {
    id: BigInt(1),
    uuid: 'pl-1',
    boardType: 'kilter',
    layoutId: 1,
    name: 'Test Playlist',
    description: 'A test playlist',
    isPublic: true,
    color: '#FF0000',
    icon: null,
    createdAt: NOW,
    updatedAt: NOW,
    lastAccessedAt: null,
    role: 'owner',
    ...overrides,
  };
}

describe('allUserPlaylists resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should require authentication', async () => {
    const ctx = makeCtx({ isAuthenticated: false, userId: null });

    await expect(
      playlistQueries.allUserPlaylists(null, { input: {} }, ctx),
    ).rejects.toThrow('Authentication required');
  });

  it('should return all playlists when no filters provided', async () => {
    const ctx = makeCtx();

    // Main query
    const { chain: mainChain, calls: mainCalls } = createMockChain([
      makePlaylistRow({ uuid: 'pl-1', boardType: 'kilter', layoutId: 1 }),
      makePlaylistRow({ uuid: 'pl-2', boardType: 'tension', layoutId: 2, id: BigInt(2) }),
    ]);
    mockDb.select.mockReturnValueOnce(mainChain);

    // Climb counts query
    const { chain: countChain } = createMockChain([
      { playlistId: BigInt(1), count: 5 },
      { playlistId: BigInt(2), count: 3 },
    ]);
    mockDb.select.mockReturnValueOnce(countChain);

    // Follow stats: follower counts
    const { chain: followerChain } = createMockChain([]);
    mockDb.select.mockReturnValueOnce(followerChain);

    // Follow stats: is followed by me
    const { chain: followedChain } = createMockChain([]);
    mockDb.select.mockReturnValueOnce(followedChain);

    const result = await playlistQueries.allUserPlaylists(null, { input: {} }, ctx);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ uuid: 'pl-1', boardType: 'kilter', climbCount: 5 });
    expect(result[1]).toMatchObject({ uuid: 'pl-2', boardType: 'tension', climbCount: 3 });

    // Verify main query used where() and innerJoin()
    expect(mainCalls.where.length).toBe(1);
    expect(mainCalls.innerJoin.length).toBe(1);
  });

  it('should filter by boardType only when only boardType provided', async () => {
    const ctx = makeCtx();

    const { chain: mainChain, calls: mainCalls } = createMockChain([
      makePlaylistRow({ uuid: 'pl-1', boardType: 'kilter' }),
    ]);
    mockDb.select.mockReturnValueOnce(mainChain);

    const { chain: countChain } = createMockChain([
      { playlistId: BigInt(1), count: 10 },
    ]);
    mockDb.select.mockReturnValueOnce(countChain);

    const { chain: followerChain } = createMockChain([]);
    mockDb.select.mockReturnValueOnce(followerChain);

    const { chain: followedChain } = createMockChain([]);
    mockDb.select.mockReturnValueOnce(followedChain);

    const result = await playlistQueries.allUserPlaylists(
      null,
      { input: { boardType: 'kilter' } },
      ctx,
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ uuid: 'pl-1', boardType: 'kilter' });

    // Verify where() was called with conditions (userId + boardType)
    expect(mainCalls.where.length).toBe(1);
  });

  it('should filter by both boardType and layoutId when both provided', async () => {
    const ctx = makeCtx();

    const { chain: mainChain, calls: mainCalls } = createMockChain([
      makePlaylistRow({ uuid: 'pl-1', boardType: 'kilter', layoutId: 8 }),
    ]);
    mockDb.select.mockReturnValueOnce(mainChain);

    const { chain: countChain } = createMockChain([
      { playlistId: BigInt(1), count: 7 },
    ]);
    mockDb.select.mockReturnValueOnce(countChain);

    const { chain: followerChain } = createMockChain([]);
    mockDb.select.mockReturnValueOnce(followerChain);

    const { chain: followedChain } = createMockChain([]);
    mockDb.select.mockReturnValueOnce(followedChain);

    const result = await playlistQueries.allUserPlaylists(
      null,
      { input: { boardType: 'kilter', layoutId: 8 } },
      ctx,
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ uuid: 'pl-1', boardType: 'kilter', layoutId: 8 });

    // Verify where() was called (userId + boardType + layoutId or null)
    expect(mainCalls.where.length).toBe(1);
  });

  it('should include playlists with null layoutId when filtering by layoutId', async () => {
    const ctx = makeCtx();

    // Simulate returning a playlist with null layoutId (Aurora-synced circuit)
    const { chain: mainChain } = createMockChain([
      makePlaylistRow({ uuid: 'pl-1', boardType: 'kilter', layoutId: 8 }),
      makePlaylistRow({ uuid: 'pl-circuit', boardType: 'kilter', layoutId: null, id: BigInt(2) }),
    ]);
    mockDb.select.mockReturnValueOnce(mainChain);

    const { chain: countChain } = createMockChain([
      { playlistId: BigInt(1), count: 5 },
      { playlistId: BigInt(2), count: 3 },
    ]);
    mockDb.select.mockReturnValueOnce(countChain);

    const { chain: followerChain } = createMockChain([]);
    mockDb.select.mockReturnValueOnce(followerChain);

    const { chain: followedChain } = createMockChain([]);
    mockDb.select.mockReturnValueOnce(followedChain);

    const result = await playlistQueries.allUserPlaylists(
      null,
      { input: { boardType: 'kilter', layoutId: 8 } },
      ctx,
    );

    // Both playlists should be returned (layoutId=8 match + layoutId=null circuit)
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ uuid: 'pl-1', layoutId: 8 });
    expect(result[1]).toMatchObject({ uuid: 'pl-circuit', layoutId: null });
  });

  it('should return empty array when no playlists match', async () => {
    const ctx = makeCtx();

    const { chain: mainChain } = createMockChain([]);
    mockDb.select.mockReturnValueOnce(mainChain);

    // No climb counts or follow stats queries needed for empty result

    const result = await playlistQueries.allUserPlaylists(
      null,
      { input: { boardType: 'tension', layoutId: 99 } },
      ctx,
    );

    expect(result).toHaveLength(0);
  });

  it('should return playlists ordered by last accessed/updated', async () => {
    const ctx = makeCtx();

    const { chain: mainChain, calls: mainCalls } = createMockChain([
      makePlaylistRow({ uuid: 'pl-recent', lastAccessedAt: new Date('2026-01-15') }),
      makePlaylistRow({ uuid: 'pl-old', lastAccessedAt: new Date('2026-01-01'), id: BigInt(2) }),
    ]);
    mockDb.select.mockReturnValueOnce(mainChain);

    const { chain: countChain } = createMockChain([]);
    mockDb.select.mockReturnValueOnce(countChain);

    const { chain: followerChain } = createMockChain([]);
    mockDb.select.mockReturnValueOnce(followerChain);

    const { chain: followedChain } = createMockChain([]);
    mockDb.select.mockReturnValueOnce(followedChain);

    const result = await playlistQueries.allUserPlaylists(null, { input: {} }, ctx);

    expect(result).toHaveLength(2);
    // Verify orderBy was called
    expect(mainCalls.orderBy.length).toBe(1);
  });
});
