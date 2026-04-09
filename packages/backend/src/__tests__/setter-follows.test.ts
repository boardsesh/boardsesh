import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  getBoardTables: vi.fn().mockReturnValue({
    climbs: { uuid: 'uuid', layoutId: 'layoutId', boardType: 'boardType', setterUsername: 'setterUsername', name: 'name', description: 'description', frames: 'frames', createdAt: 'createdAt' },
    climbStats: { climbUuid: 'climbUuid', boardType: 'boardType', angle: 'angle', ascensionistCount: 'ascensionistCount', qualityAverage: 'qualityAverage', difficultyAverage: 'difficultyAverage', displayDifficulty: 'displayDifficulty', benchmarkDifficulty: 'benchmarkDifficulty' },
    difficultyGrades: { boardType: 'boardType', difficulty: 'difficulty', boulderName: 'boulderName' },
  }),
  isValidBoardName: vi.fn().mockReturnValue(true),
}));

vi.mock('../db/queries/util/hold-state', () => ({
  convertLitUpHoldsStringToMap: vi.fn().mockReturnValue([{}]),
}));

import type { ConnectionContext } from '@boardsesh/shared-schema';
import { setterFollowMutations } from '../graphql/resolvers/social/setter-follows';

function makeCtx(overrides: Partial<ConnectionContext> = {}): ConnectionContext {
  return {
    connectionId: 'conn-1',
    isAuthenticated: true,
    userId: 'user-123',
    sessionId: undefined,
    db: mockDb,
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
    'select', 'from', 'where', 'leftJoin', 'innerJoin',
    'groupBy', 'orderBy', 'limit', 'offset',
    'insert', 'values', 'onConflictDoNothing', 'returning',
    'delete', 'update', 'set',
  ];

  // Make the chain a thenable (for destructuring awaits like `const [x] = await db.select()...`)
  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(resolveValue).then(resolve);

  for (const method of methods) {
    chain[method] = vi.fn((..._args: unknown[]) => chain);
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

    const result = await setterFollowMutations.followSetter(
      null,
      { input: { setterUsername: 'setter1' } },
      ctx,
    );

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

    const result = await setterFollowMutations.followSetter(
      null,
      { input: { setterUsername: 'setter1' } },
      ctx,
    );

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

    const result = await setterFollowMutations.followSetter(
      null,
      { input: { setterUsername: 'setter1' } },
      ctx,
    );

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

    const result = await setterFollowMutations.unfollowSetter(
      null,
      { input: { setterUsername: 'setter1' } },
      ctx,
    );

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

    const result = await setterFollowMutations.unfollowSetter(
      null,
      { input: { setterUsername: 'setter1' } },
      ctx,
    );

    expect(result).toBe(true);
    // Delete called twice: setter_follows and user_follows
    expect(mockDb.delete).toHaveBeenCalledTimes(2);
  });
});
