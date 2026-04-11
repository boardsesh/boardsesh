import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GroupedNotificationsInputSchema } from '../validation/schemas';

// All mock variables must be inside vi.hoisted() to avoid "Cannot access before initialization" errors
const {
  mockExecute, mockSelect, mockFrom, mockWhere, mockSet, mockReturning, mockUpdate,
} = vi.hoisted(() => {
  const mockFrom = vi.fn();
  const mockWhere = vi.fn();
  const mockSet = vi.fn();
  const mockReturning = vi.fn();
  const mockUpdate = vi.fn();
  const mockSelect = vi.fn();
  const mockExecute = vi.fn();

  // Wire up chain: select().from().where()
  mockSelect.mockReturnValue({ from: mockFrom });
  mockFrom.mockReturnThis();

  // Wire up chain: update().set().where().returning()
  mockUpdate.mockReturnValue({ set: mockSet });
  mockSet.mockReturnValue({ where: mockWhere });
  mockWhere.mockReturnValue({ returning: mockReturning });

  return { mockExecute, mockSelect, mockFrom, mockWhere, mockSet, mockReturning, mockUpdate };
});

vi.mock('../db/client', () => {
  const mockDb = {
    execute: mockExecute,
    select: mockSelect,
    update: mockUpdate,
  };
  return {
    db: mockDb,
    createRequestDb: () => mockDb,
    withTransaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(mockDb),
  };
});

vi.mock('../pubsub/index', () => ({
  pubsub: { subscribeNotifications: vi.fn() },
}));

vi.mock('../graphql/resolvers/shared/async-iterators', () => ({
  createAsyncIterator: vi.fn(),
}));

vi.mock('../utils/rate-limiter', () => ({
  checkRateLimit: vi.fn(),
}));

vi.mock('../utils/redis-rate-limiter', () => ({
  checkRateLimitRedis: vi.fn(),
}));

import type { ConnectionContext } from '@boardsesh/shared-schema';
import { socialNotificationQueries, socialNotificationMutations } from '../graphql/resolvers/social/notifications';

function makeCtx(overrides: Partial<ConnectionContext> = {}): ConnectionContext {
  return {
    connectionId: 'conn-1',
    isAuthenticated: true,
    userId: 'user-123',
    sessionId: null,
    boardPath: null,
    controllerId: null,
    controllerApiKey: null,
    db: {
      execute: mockExecute,
      select: mockSelect,
      update: mockUpdate,
    } as unknown as ConnectionContext['db'],
    ...overrides,
  } as ConnectionContext;
}

// ============================================
// GroupedNotificationsInputSchema validation
// ============================================

describe('GroupedNotificationsInputSchema', () => {
  it('should accept empty input with defaults', () => {
    const result = GroupedNotificationsInputSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(20);
      expect(result.data.offset).toBe(0);
    }
  });

  it('should accept custom limit and offset', () => {
    const result = GroupedNotificationsInputSchema.safeParse({ limit: 10, offset: 5 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(10);
      expect(result.data.offset).toBe(5);
    }
  });

  it('should reject limit exceeding max (50)', () => {
    const result = GroupedNotificationsInputSchema.safeParse({ limit: 100 });
    expect(result.success).toBe(false);
  });

  it('should reject limit less than 1', () => {
    const result = GroupedNotificationsInputSchema.safeParse({ limit: 0 });
    expect(result.success).toBe(false);
  });

  it('should reject negative offset', () => {
    const result = GroupedNotificationsInputSchema.safeParse({ offset: -1 });
    expect(result.success).toBe(false);
  });

  it('should reject non-integer limit', () => {
    const result = GroupedNotificationsInputSchema.safeParse({ limit: 10.5 });
    expect(result.success).toBe(false);
  });

  it('should reject non-integer offset', () => {
    const result = GroupedNotificationsInputSchema.safeParse({ offset: 2.5 });
    expect(result.success).toBe(false);
  });
});

// ============================================
// groupedNotifications resolver
// ============================================

describe('groupedNotifications resolver', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Re-setup mock chain after reset
    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnThis();
    mockWhere.mockReturnValue({ returning: mockReturning });
    mockSet.mockReturnValue({ where: mockWhere });
    mockUpdate.mockReturnValue({ set: mockSet });
  });

  it('should throw for unauthenticated users', async () => {
    const ctx = makeCtx({ isAuthenticated: false });
    await expect(
      socialNotificationQueries.groupedNotifications(null, {}, ctx),
    ).rejects.toThrow('Authentication required');
  });

  it('should reject invalid input (limit too high)', async () => {
    const ctx = makeCtx();
    await expect(
      socialNotificationQueries.groupedNotifications(null, { limit: 999 }, ctx),
    ).rejects.toThrow();
  });

  it('should return empty groups when no notifications', async () => {
    const ctx = makeCtx();
    mockExecute.mockResolvedValueOnce({ rows: [] });
    mockFrom.mockReturnValueOnce({ where: vi.fn().mockResolvedValueOnce([{ count: 0 }]) });

    const result = await socialNotificationQueries.groupedNotifications(null, {}, ctx);
    expect(result.groups).toEqual([]);
    expect(result.totalCount).toBe(0);
    expect(result.hasMore).toBe(false);
  });

  it('should map grouped rows correctly', async () => {
    const ctx = makeCtx();
    const now = new Date('2024-01-15T12:00:00Z');

    mockExecute.mockResolvedValueOnce({
      rows: [
        {
          type: 'vote',
          entityType: 'climb',
          entityId: 'climb-1',
          actorCount: '3',
          latestUuid: 'notif-uuid-1',
          latestCreatedAt: now,
          allRead: false,
          commentBody: null,
          actorIds: ['user-a', 'user-b', 'user-c'],
          actorDisplayNames: ['Alice', 'Bob', 'Charlie'],
          actorAvatarUrls: ['https://example.com/a.png', null, 'https://example.com/c.png'],
          totalGroupCount: '1',
        },
      ],
    });
    mockFrom.mockReturnValueOnce({ where: vi.fn().mockResolvedValueOnce([{ count: 2 }]) });

    const result = await socialNotificationQueries.groupedNotifications(null, {}, ctx);

    expect(result.groups).toHaveLength(1);
    const group = result.groups[0];
    expect(group.uuid).toBe('notif-uuid-1');
    expect(group.type).toBe('vote');
    expect(group.entityType).toBe('climb');
    expect(group.entityId).toBe('climb-1');
    expect(group.actorCount).toBe(3);
    expect(group.isRead).toBe(false);
    expect(group.createdAt).toBe('2024-01-15T12:00:00.000Z');
    expect(group.actors).toEqual([
      { id: 'user-a', displayName: 'Alice', avatarUrl: 'https://example.com/a.png' },
      { id: 'user-b', displayName: 'Bob', avatarUrl: undefined },
      { id: 'user-c', displayName: 'Charlie', avatarUrl: 'https://example.com/c.png' },
    ]);
    expect(result.unreadCount).toBe(2);
  });

  it('should truncate long comment bodies', async () => {
    const ctx = makeCtx();
    const longComment = 'A'.repeat(150);

    mockExecute.mockResolvedValueOnce({
      rows: [
        {
          type: 'comment',
          entityType: 'climb',
          entityId: 'climb-2',
          actorCount: '1',
          latestUuid: 'notif-uuid-2',
          latestCreatedAt: new Date('2024-01-15T12:00:00Z'),
          allRead: true,
          commentBody: longComment,
          actorIds: ['user-a'],
          actorDisplayNames: ['Alice'],
          actorAvatarUrls: [null],
          totalGroupCount: '1',
        },
      ],
    });
    mockFrom.mockReturnValueOnce({ where: vi.fn().mockResolvedValueOnce([{ count: 0 }]) });

    const result = await socialNotificationQueries.groupedNotifications(null, {}, ctx);

    expect(result.groups[0].commentBody).toBe('A'.repeat(100) + '...');
  });

  it('should compute hasMore correctly', async () => {
    const ctx = makeCtx();
    const now = new Date();

    const rows = Array.from({ length: 20 }, (_, i) => ({
      type: 'vote',
      entityType: 'climb',
      entityId: `climb-${i}`,
      actorCount: '1',
      latestUuid: `uuid-${i}`,
      latestCreatedAt: now,
      allRead: true,
      commentBody: null,
      actorIds: [`user-${i}`],
      actorDisplayNames: [`User ${i}`],
      actorAvatarUrls: [null],
      totalGroupCount: '25',
    }));

    mockExecute.mockResolvedValueOnce({ rows });
    mockFrom.mockReturnValueOnce({ where: vi.fn().mockResolvedValueOnce([{ count: 0 }]) });

    const result = await socialNotificationQueries.groupedNotifications(null, {}, ctx);

    // 25 total groups, 20 returned at offset 0 → hasMore = true
    expect(result.totalCount).toBe(25);
    expect(result.hasMore).toBe(true);
  });

  it('should filter null actor ids', async () => {
    const ctx = makeCtx();

    mockExecute.mockResolvedValueOnce({
      rows: [
        {
          type: 'vote',
          entityType: 'climb',
          entityId: 'climb-1',
          actorCount: '2',
          latestUuid: 'uuid-1',
          latestCreatedAt: new Date(),
          allRead: false,
          commentBody: null,
          actorIds: ['user-a', null],
          actorDisplayNames: ['Alice', null],
          actorAvatarUrls: [null, null],
          totalGroupCount: '1',
        },
      ],
    });
    mockFrom.mockReturnValueOnce({ where: vi.fn().mockResolvedValueOnce([{ count: 1 }]) });

    const result = await socialNotificationQueries.groupedNotifications(null, {}, ctx);

    // null actor id should be filtered out
    expect(result.groups[0].actors).toHaveLength(1);
    expect(result.groups[0].actors[0].id).toBe('user-a');
  });
});

// ============================================
// markGroupNotificationsRead mutation
// ============================================

describe('markGroupNotificationsRead mutation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnThis();
    mockWhere.mockReturnValue({ returning: mockReturning });
    mockSet.mockReturnValue({ where: mockWhere });
    mockUpdate.mockReturnValue({ set: mockSet });
  });

  it('should throw for unauthenticated users', async () => {
    const ctx = makeCtx({ isAuthenticated: false });
    await expect(
      socialNotificationMutations.markGroupNotificationsRead(null, { type: 'vote' }, ctx),
    ).rejects.toThrow('Authentication required');
  });

  it('should return count of marked notifications', async () => {
    const ctx = makeCtx();
    mockReturning.mockResolvedValueOnce([{ uuid: 'a' }, { uuid: 'b' }, { uuid: 'c' }]);

    const count = await socialNotificationMutations.markGroupNotificationsRead(
      null,
      { type: 'vote', entityType: 'climb', entityId: 'climb-1' },
      ctx,
    );

    expect(count).toBe(3);
  });

  it('should return 0 when no notifications to mark', async () => {
    const ctx = makeCtx();
    mockReturning.mockResolvedValueOnce([]);

    const count = await socialNotificationMutations.markGroupNotificationsRead(
      null,
      { type: 'vote', entityType: 'climb', entityId: 'climb-1' },
      ctx,
    );

    expect(count).toBe(0);
  });

  it('should handle null entityType and entityId', async () => {
    const ctx = makeCtx();
    mockReturning.mockResolvedValueOnce([{ uuid: 'a' }]);

    const count = await socialNotificationMutations.markGroupNotificationsRead(
      null,
      { type: 'new_follower', entityType: null, entityId: null },
      ctx,
    );

    expect(count).toBe(1);
    // Verify update was called (the conditions handle NULL correctly)
    expect(mockUpdate).toHaveBeenCalled();
  });

  it('should handle undefined entityType and entityId', async () => {
    const ctx = makeCtx();
    mockReturning.mockResolvedValueOnce([{ uuid: 'a' }, { uuid: 'b' }]);

    const count = await socialNotificationMutations.markGroupNotificationsRead(
      null,
      { type: 'new_follower' },
      ctx,
    );

    expect(count).toBe(2);
  });
});
