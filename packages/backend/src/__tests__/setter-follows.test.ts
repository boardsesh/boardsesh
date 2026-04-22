import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// All mock variables must be inside vi.hoisted() to avoid "Cannot access before initialization" errors
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
      userId: 'userId',
      isDraft: 'isDraft',
      compatibleSizeIds: 'compatibleSizeIds',
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
import { setterFollowMutations, setterFollowQueries } from '../graphql/resolvers/social/setter-follows';

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
 * Create a chainable mock object that resolves at any point.
 * Each method returns the same chain, and the chain is also a thenable
 * that resolves with the provided value (for await).
 */
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

  // Make the chain a thenable (for destructuring awaits like `const [x] = await db.select()...`)
  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(resolveValue).then(resolve);

  for (const method of methods) {
    chain[method] = vi.fn((..._: unknown[]) => chain);
  }

  return chain;
}

describe('followSetter mutation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should throw for unauthenticated users', async () => {
    const ctx = makeCtx({ isAuthenticated: false });
    await expect(
      setterFollowMutations.followSetter(null, { input: { setterUsername: 'setter1' } }, ctx),
    ).rejects.toThrow('Authentication required');
  });

  it('should throw if setter does not exist', async () => {
    const ctx = makeCtx();

    // select().from().where().limit() → [{ count: 0 }]
    const existsChain = createMockChain([{ count: 0 }]);
    mockDb.select.mockReturnValueOnce(existsChain);

    await expect(
      setterFollowMutations.followSetter(null, { input: { setterUsername: 'nonexistent' } }, ctx),
    ).rejects.toThrow('Setter not found');
  });

  it('should insert follow and return true', async () => {
    const ctx = makeCtx();

    // 1. Setter exists check → count: 1
    const existsChain = createMockChain([{ count: 1 }]);
    mockDb.select.mockReturnValueOnce(existsChain);

    // 2. Insert follow → returns row (new follow)
    const insertChain = createMockChain([{ id: 1, followerId: 'user-123', setterUsername: 'setter1' }]);
    mockDb.insert.mockReturnValueOnce(insertChain);

    // 3. Check linked user → no linked users
    const linkedChain = createMockChain([]);
    mockDb.select.mockReturnValueOnce(linkedChain);

    const result = await setterFollowMutations.followSetter(null, { input: { setterUsername: 'setter1' } }, ctx);

    expect(result).toBe(true);
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it('should handle idempotent follow (onConflictDoNothing returns empty)', async () => {
    const ctx = makeCtx();

    // Setter exists
    const existsChain = createMockChain([{ count: 1 }]);
    mockDb.select.mockReturnValueOnce(existsChain);

    // Insert returns empty (conflict, already following)
    const insertChain = createMockChain([]);
    mockDb.insert.mockReturnValueOnce(insertChain);

    const result = await setterFollowMutations.followSetter(null, { input: { setterUsername: 'setter1' } }, ctx);

    expect(result).toBe(true);
    // No additional insert for user_follows since result was empty
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
  });

  it('should create user_follows when setter has linked Boardsesh account', async () => {
    const ctx = makeCtx();

    // 1. Setter exists
    const existsChain = createMockChain([{ count: 1 }]);
    mockDb.select.mockReturnValueOnce(existsChain);

    // 2. Insert follow returns new row
    const insertChain = createMockChain([{ id: 1 }]);
    mockDb.insert.mockReturnValueOnce(insertChain);

    // 3. Linked user found
    const linkedChain = createMockChain([{ userId: 'linked-user-456' }]);
    mockDb.select.mockReturnValueOnce(linkedChain);

    // 4. user_follows insert
    const userFollowInsertChain = createMockChain(undefined);
    mockDb.insert.mockReturnValueOnce(userFollowInsertChain);

    const result = await setterFollowMutations.followSetter(null, { input: { setterUsername: 'setter1' } }, ctx);

    expect(result).toBe(true);
    // Insert called twice: once for setter_follows, once for user_follows
    expect(mockDb.insert).toHaveBeenCalledTimes(2);
  });
});

describe('unfollowSetter mutation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should throw for unauthenticated users', async () => {
    const ctx = makeCtx({ isAuthenticated: false });
    await expect(
      setterFollowMutations.unfollowSetter(null, { input: { setterUsername: 'setter1' } }, ctx),
    ).rejects.toThrow('Authentication required');
  });

  it('should delete follow and return true', async () => {
    const ctx = makeCtx();

    // Delete setter_follows
    const deleteChain = createMockChain(undefined);
    mockDb.delete.mockReturnValueOnce(deleteChain);

    // Check linked user → no linked users
    const linkedChain = createMockChain([]);
    mockDb.select.mockReturnValueOnce(linkedChain);

    const result = await setterFollowMutations.unfollowSetter(null, { input: { setterUsername: 'setter1' } }, ctx);

    expect(result).toBe(true);
    expect(mockDb.delete).toHaveBeenCalledTimes(1);
  });

  it('should also delete user_follows when setter has linked account', async () => {
    const ctx = makeCtx();

    // Delete setter_follows
    const deleteChain = createMockChain(undefined);
    mockDb.delete.mockReturnValueOnce(deleteChain);

    // Check linked user → found
    const linkedChain = createMockChain([{ userId: 'linked-user-456' }]);
    mockDb.select.mockReturnValueOnce(linkedChain);

    // Delete user_follows
    const deleteUserFollowChain = createMockChain(undefined);
    mockDb.delete.mockReturnValueOnce(deleteUserFollowChain);

    const result = await setterFollowMutations.unfollowSetter(null, { input: { setterUsername: 'setter1' } }, ctx);

    expect(result).toBe(true);
    // Delete called twice: setter_follows and user_follows
    expect(mockDb.delete).toHaveBeenCalledTimes(2);
  });
});

describe('userClimbs query', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should reject empty userId', async () => {
    await expect(setterFollowQueries.userClimbs(null, { input: { userId: '' } })).rejects.toThrow();
  });

  it('should return climbs for user with no linked usernames', async () => {
    // 1. userBoardMappings lookup → no mappings
    const mappingsChain = createMockChain([]);
    mockDb.select.mockReturnValueOnce(mappingsChain);

    // 2. Count query → 1 climb
    const countChain = createMockChain([{ count: 1 }]);
    mockDb.select.mockReturnValueOnce(countChain);

    // 3. Climbs query via db.execute() → one result (returns {rows: [...]})
    mockDb.execute.mockResolvedValueOnce({
      rows: [
        {
          uuid: 'climb-1',
          layout_id: 1,
          board_type: 'kilter',
          setter_username: 'setter1',
          name: 'Test Climb',
          description: '',
          frames: 'abc',
          stats_angle: 40,
          ascensionist_count: 10,
          difficulty_id: 20,
          quality_average: 3.5,
          difficulty_error: 0.1,
          benchmark_difficulty: null,
        },
      ],
    });

    const result = await setterFollowQueries.userClimbs(null, { input: { userId: 'user-123' } });

    expect(result.totalCount).toBe(1);
    expect(result.hasMore).toBe(false);
    expect(result.climbs).toHaveLength(1);
    expect(result.climbs[0].uuid).toBe('climb-1');
    expect(result.climbs[0].name).toBe('Test Climb');
  });

  it('should include Aurora-linked climbs via board mappings', async () => {
    // 1. userBoardMappings → linked username
    const mappingsChain = createMockChain([{ boardUsername: 'aurora-setter' }]);
    mockDb.select.mockReturnValueOnce(mappingsChain);

    // 2. Count query → 2 climbs
    const countChain = createMockChain([{ count: 2 }]);
    mockDb.select.mockReturnValueOnce(countChain);

    // 3. Climbs query via db.execute() → two results (returns {rows: [...]})
    mockDb.execute.mockResolvedValueOnce({
      rows: [
        {
          uuid: 'climb-direct',
          layout_id: 1,
          board_type: 'kilter',
          setter_username: 'user-123',
          name: 'Direct Climb',
          description: '',
          frames: '',
          stats_angle: 40,
          ascensionist_count: 5,
          difficulty_id: 18,
          quality_average: 4,
          difficulty_error: 0,
          benchmark_difficulty: null,
        },
        {
          uuid: 'climb-aurora',
          layout_id: 1,
          board_type: 'kilter',
          setter_username: 'aurora-setter',
          name: 'Aurora Climb',
          description: '',
          frames: '',
          stats_angle: 40,
          ascensionist_count: 20,
          difficulty_id: 22,
          quality_average: 3,
          difficulty_error: 0.2,
          benchmark_difficulty: null,
        },
      ],
    });

    const result = await setterFollowQueries.userClimbs(null, { input: { userId: 'user-123' } });

    expect(result.totalCount).toBe(2);
    expect(result.climbs).toHaveLength(2);
    expect(result.climbs.map((c) => c.uuid)).toEqual(['climb-direct', 'climb-aurora']);
  });

  it('should handle pagination with hasMore', async () => {
    // 1. Mappings → none
    const mappingsChain = createMockChain([]);
    mockDb.select.mockReturnValueOnce(mappingsChain);

    // 2. Count → 3
    const countChain = createMockChain([{ count: 3 }]);
    mockDb.select.mockReturnValueOnce(countChain);

    // 3. Climbs via db.execute() → limit+1 results (3 results for limit=2, indicating hasMore)
    mockDb.execute.mockResolvedValueOnce({
      rows: [
        {
          uuid: 'c1',
          layout_id: 1,
          board_type: 'kilter',
          setter_username: '',
          name: 'A',
          description: '',
          frames: '',
          stats_angle: 40,
          ascensionist_count: 0,
          difficulty_id: null,
          quality_average: 0,
          difficulty_error: 0,
          benchmark_difficulty: null,
        },
        {
          uuid: 'c2',
          layout_id: 1,
          board_type: 'kilter',
          setter_username: '',
          name: 'B',
          description: '',
          frames: '',
          stats_angle: 40,
          ascensionist_count: 0,
          difficulty_id: null,
          quality_average: 0,
          difficulty_error: 0,
          benchmark_difficulty: null,
        },
        {
          uuid: 'c3',
          layout_id: 1,
          board_type: 'kilter',
          setter_username: '',
          name: 'C',
          description: '',
          frames: '',
          stats_angle: 40,
          ascensionist_count: 0,
          difficulty_id: null,
          quality_average: 0,
          difficulty_error: 0,
          benchmark_difficulty: null,
        },
      ],
    });

    const result = await setterFollowQueries.userClimbs(null, { input: { userId: 'user-123', limit: 2 } });

    expect(result.hasMore).toBe(true);
    expect(result.climbs).toHaveLength(2);
    expect(result.totalCount).toBe(3);
  });

  it('should return empty climbs for user with no climbs', async () => {
    // 1. Mappings → none
    const mappingsChain = createMockChain([]);
    mockDb.select.mockReturnValueOnce(mappingsChain);

    // 2. Count → 0
    const countChain = createMockChain([{ count: 0 }]);
    mockDb.select.mockReturnValueOnce(countChain);

    // 3. Climbs via db.execute() → empty
    mockDb.execute.mockResolvedValueOnce({ rows: [] });

    const result = await setterFollowQueries.userClimbs(null, { input: { userId: 'user-123' } });

    expect(result.totalCount).toBe(0);
    expect(result.hasMore).toBe(false);
    expect(result.climbs).toHaveLength(0);
  });
});
