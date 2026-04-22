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

import type { ConnectionContext } from '@boardsesh/shared-schema';
import { playlistQueries, getPlaylistFollowStats } from '../graphql/resolvers/playlists/queries';

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

function createMockChain(resolveValue: unknown = []): Record<string, unknown> {
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
    chain[method] = vi.fn((..._: unknown[]) => chain);
  }

  return chain;
}

describe('getPlaylistFollowStats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return empty map for empty input', async () => {
    const result = await getPlaylistFollowStats([], null);
    expect(result.size).toBe(0);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('should return followerCount and isFollowedByMe for each playlist', async () => {
    // 1. Follower counts query
    const followerCountChain = createMockChain([
      { playlistUuid: 'pl-1', count: 5 },
      { playlistUuid: 'pl-2', count: 0 },
    ]);
    mockDb.select.mockReturnValueOnce(followerCountChain);

    // 2. Is-followed-by-me query
    const followedChain = createMockChain([{ playlistUuid: 'pl-1' }]);
    mockDb.select.mockReturnValueOnce(followedChain);

    const result = await getPlaylistFollowStats(['pl-1', 'pl-2'], 'user-123');

    expect(result.get('pl-1')).toEqual({ followerCount: 5, isFollowedByMe: true });
    expect(result.get('pl-2')).toEqual({ followerCount: 0, isFollowedByMe: false });
  });

  it('should skip follow check when userId is null', async () => {
    // Only follower counts query — no follow check query
    const followerCountChain = createMockChain([{ playlistUuid: 'pl-1', count: 3 }]);
    mockDb.select.mockReturnValueOnce(followerCountChain);

    const result = await getPlaylistFollowStats(['pl-1'], null);

    expect(result.get('pl-1')).toEqual({ followerCount: 3, isFollowedByMe: false });
    // Only one select call (no follow check)
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });
});

describe('playlistClimbs resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should throw when playlist not found', async () => {
    const ctx = makeCtx();

    // Playlist lookup → empty
    const selectChain = createMockChain([]);
    mockDb.select.mockReturnValueOnce(selectChain);

    await expect(playlistQueries.playlistClimbs(null, { input: { playlistId: 'nonexistent' } }, ctx)).rejects.toThrow(
      'Playlist not found or access denied',
    );
  });

  it('should throw for private playlist when not authenticated', async () => {
    const ctx = makeCtx({ isAuthenticated: false, userId: null });

    // Playlist exists but is private
    const playlistChain = createMockChain([{ id: BigInt(1), isPublic: false }]);
    mockDb.select.mockReturnValueOnce(playlistChain);

    await expect(playlistQueries.playlistClimbs(null, { input: { playlistId: 'private-pl' } }, ctx)).rejects.toThrow(
      'Playlist not found or access denied',
    );
  });

  it('should return climbs in all-boards mode when boardName is omitted', async () => {
    const ctx = makeCtx();

    // 1. Playlist exists and is public
    const playlistChain = createMockChain([{ id: BigInt(1), isPublic: true }]);
    mockDb.select.mockReturnValueOnce(playlistChain);

    // 2. Count query
    const countChain = createMockChain([{ count: 2 }]);
    mockDb.select.mockReturnValueOnce(countChain);

    // 3. Climbs query (all-boards mode — no boardName filter)
    const climbsChain = createMockChain([
      {
        climbUuid: 'climb-1',
        position: 0,
        playlistAngle: 40,
        uuid: 'climb-1',
        layoutId: 1,
        boardType: 'kilter',
        setter_username: 'setter1',
        name: 'Kilter Climb',
        description: '',
        frames: '',
        statsAngle: 40,
        ascensionist_count: 10,
        difficulty: 'V5',
        quality_average: 3.5,
        difficulty_error: 0.2,
        benchmark_difficulty: null,
      },
      {
        climbUuid: 'climb-2',
        position: 1,
        playlistAngle: null,
        uuid: 'climb-2',
        layoutId: 2,
        boardType: 'tension',
        setter_username: 'setter2',
        name: 'Tension Climb',
        description: '',
        frames: '',
        statsAngle: 30,
        ascensionist_count: 5,
        difficulty: 'V3',
        quality_average: 2.0,
        difficulty_error: 0.1,
        benchmark_difficulty: null,
      },
    ]);
    mockDb.select.mockReturnValueOnce(climbsChain);

    const result = await playlistQueries.playlistClimbs(null, { input: { playlistId: 'test-pl' } }, ctx);

    expect(result.totalCount).toBe(2);
    expect(result.climbs).toHaveLength(2);
    expect(result.hasMore).toBe(false);

    // Check first climb is kilter
    expect(result.climbs[0].uuid).toBe('climb-1');
    expect(result.climbs[0].boardType).toBe('kilter');
    expect(result.climbs[0].name).toBe('Kilter Climb');

    // Check second climb is tension (cross-board!)
    expect(result.climbs[1].uuid).toBe('climb-2');
    expect(result.climbs[1].boardType).toBe('tension');
    expect(result.climbs[1].name).toBe('Tension Climb');
  });

  it('should return climbs in specific-board mode when boardName is provided', async () => {
    const ctx = makeCtx();

    // 1. Playlist exists and is public
    const playlistChain = createMockChain([{ id: BigInt(1), isPublic: true }]);
    mockDb.select.mockReturnValueOnce(playlistChain);

    // 2. Count query
    const countChain = createMockChain([{ count: 1 }]);
    mockDb.select.mockReturnValueOnce(countChain);

    // 3. Climbs query (specific-board mode)
    const climbsChain = createMockChain([
      {
        climbUuid: 'climb-1',
        playlistAngle: 40,
        position: 0,
        uuid: 'climb-1',
        layoutId: 1,
        setter_username: 'setter1',
        name: 'Kilter Climb',
        description: '',
        frames: '',
        ascensionist_count: 10,
        difficulty: 'V5',
        quality_average: 3.5,
        difficulty_error: 0.2,
        benchmark_difficulty: null,
      },
    ]);
    mockDb.select.mockReturnValueOnce(climbsChain);

    const result = await playlistQueries.playlistClimbs(
      null,
      {
        input: {
          playlistId: 'test-pl',
          boardName: 'kilter',
          layoutId: 1,
          sizeId: 10,
          angle: 40,
        },
      },
      ctx,
    );

    expect(result.totalCount).toBe(1);
    expect(result.climbs).toHaveLength(1);
    expect(result.climbs[0].boardType).toBe('kilter');
  });

  it('should paginate correctly with hasMore', async () => {
    const ctx = makeCtx();

    // 1. Playlist exists
    const playlistChain = createMockChain([{ id: BigInt(1), isPublic: true }]);
    mockDb.select.mockReturnValueOnce(playlistChain);

    // 2. Count query (more than page size)
    const countChain = createMockChain([{ count: 25 }]);
    mockDb.select.mockReturnValueOnce(countChain);

    // 3. Return pageSize + 1 results to indicate hasMore
    const climbResults = Array.from({ length: 21 }, (_, i) => ({
      climbUuid: `climb-${i}`,
      position: i,
      playlistAngle: 40,
      uuid: `climb-${i}`,
      layoutId: 1,
      boardType: 'kilter',
      setter_username: 'setter1',
      name: `Climb ${i}`,
      description: '',
      frames: '',
      statsAngle: 40,
      ascensionist_count: 1,
      difficulty: 'V1',
      quality_average: 1.0,
      difficulty_error: 0,
      benchmark_difficulty: null,
    }));
    const climbsChain = createMockChain(climbResults);
    mockDb.select.mockReturnValueOnce(climbsChain);

    const result = await playlistQueries.playlistClimbs(
      null,
      { input: { playlistId: 'test-pl', page: 0, pageSize: 20 } },
      ctx,
    );

    expect(result.hasMore).toBe(true);
    expect(result.climbs).toHaveLength(20); // Trimmed to pageSize
    expect(result.totalCount).toBe(25);
  });
});
