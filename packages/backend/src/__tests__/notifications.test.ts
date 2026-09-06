import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { GroupedNotificationsInputSchema } from '../validation/schemas';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { socialNotificationQueries, socialNotificationMutations } from '../graphql/resolvers/social/notifications';

// All mock variables must be inside vi.hoisted() to avoid "Cannot access before initialization" errors
const {
  mockExecute,
  mockSelect,
  mockFrom,
  mockWhere,
  mockSet,
  mockReturning,
  mockUpdate,
  mockBatchEnrichUserProfiles,
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

  const mockBatchEnrichUserProfiles = vi.fn();

  return {
    mockExecute,
    mockSelect,
    mockFrom,
    mockWhere,
    mockSet,
    mockReturning,
    mockUpdate,
    mockBatchEnrichUserProfiles,
  };
});

vi.mock('../db/client', () => ({
  db: {
    execute: mockExecute,
    select: mockSelect,
    update: mockUpdate,
  },
}));

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

vi.mock('../graphql/resolvers/social/helpers', () => ({
  batchEnrichUserProfiles: mockBatchEnrichUserProfiles,
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
    await expect(socialNotificationQueries.groupedNotifications(null, {}, ctx)).rejects.toThrow(
      'Authentication required',
    );
  });

  it('should reject invalid input (limit too high)', async () => {
    const ctx = makeCtx();
    await expect(socialNotificationQueries.groupedNotifications(null, { limit: 999 }, ctx)).rejects.toThrow();
  });

  it('should return empty groups when no notifications', async () => {
    const ctx = makeCtx();
    mockExecute.mockResolvedValueOnce([]);
    mockFrom.mockReturnValueOnce({ where: vi.fn().mockResolvedValueOnce([{ count: 0 }]) });

    const result = await socialNotificationQueries.groupedNotifications(null, {}, ctx);
    expect(result.groups).toEqual([]);
    expect(result.totalCount).toBe(0);
    expect(result.hasMore).toBe(false);
  });

  it('should map grouped rows correctly', async () => {
    const ctx = makeCtx();
    const now = new Date('2024-01-15T12:00:00Z');

    mockExecute.mockResolvedValueOnce([
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
    ]);
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

    mockExecute.mockResolvedValueOnce([
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
    ]);
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

    mockExecute.mockResolvedValueOnce(rows);
    mockFrom.mockReturnValueOnce({ where: vi.fn().mockResolvedValueOnce([{ count: 0 }]) });

    const result = await socialNotificationQueries.groupedNotifications(null, {}, ctx);

    // 25 total groups, 20 returned at offset 0 → hasMore = true
    expect(result.totalCount).toBe(25);
    expect(result.hasMore).toBe(true);
  });

  it('exposes the proposal type on proposal groups', async () => {
    // A `proposal_on_your_climb` row reads "reported your climb" for a hide and
    // "proposed a grade change" for a grade. The client can only tell them
    // apart from `proposalType`, so the resolver must batch-fetch it alongside
    // the climb the proposal points at.
    const ctx = makeCtx();

    mockExecute.mockResolvedValueOnce([
      {
        type: 'proposal_on_your_climb',
        entityType: 'proposal',
        entityId: 'proposal-uuid-1',
        actorCount: '1',
        latestUuid: 'notif-uuid-9',
        latestCreatedAt: new Date('2024-01-15T12:00:00Z'),
        allRead: false,
        commentBody: null,
        actorIds: ['user-a'],
        actorDisplayNames: ['Alice'],
        actorAvatarUrls: [null],
        totalGroupCount: '1',
      },
    ]);

    // 1) proposals batch, 2) climbs behind those proposals, 3) unread count
    mockFrom.mockReturnValueOnce({
      where: vi.fn().mockResolvedValueOnce([
        {
          uuid: 'proposal-uuid-1',
          climbUuid: 'climb-uuid-1',
          boardType: 'kilter',
          type: 'hide',
        },
      ]),
    });
    mockFrom.mockReturnValueOnce({
      where: vi.fn().mockResolvedValueOnce([
        {
          uuid: 'climb-uuid-1',
          name: 'Reported Boulder',
          boardType: 'kilter',
          setterUsername: 'setter_joe',
          layoutId: 8,
          angle: 40,
        },
      ]),
    });
    mockFrom.mockReturnValueOnce({ where: vi.fn().mockResolvedValueOnce([{ count: 1 }]) });

    const result = await socialNotificationQueries.groupedNotifications(null, {}, ctx);

    const group = result.groups[0];
    expect(group.proposalUuid).toBe('proposal-uuid-1');
    expect(group.proposalType).toBe('hide');
    expect(group.climbUuid).toBe('climb-uuid-1');
    expect(group.climbName).toBe('Reported Boulder');
    expect(group.boardType).toBe('kilter');
    expect(group.climbLayoutId).toBe(8);
  });

  it('leaves proposalType undefined for non-proposal groups', async () => {
    const ctx = makeCtx();

    mockExecute.mockResolvedValueOnce([
      {
        type: 'new_follower',
        entityType: null,
        entityId: null,
        actorCount: '1',
        latestUuid: 'notif-uuid-10',
        latestCreatedAt: new Date('2024-01-15T12:00:00Z'),
        allRead: false,
        commentBody: null,
        actorIds: ['user-a'],
        actorDisplayNames: ['Alice'],
        actorAvatarUrls: [null],
        totalGroupCount: '1',
      },
    ]);
    mockFrom.mockReturnValueOnce({ where: vi.fn().mockResolvedValueOnce([{ count: 0 }]) });

    const result = await socialNotificationQueries.groupedNotifications(null, {}, ctx);

    expect(result.groups[0].proposalType).toBeUndefined();
  });

  it('should filter null actor ids', async () => {
    const ctx = makeCtx();

    mockExecute.mockResolvedValueOnce([
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
    ]);
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
    await expect(socialNotificationMutations.markGroupNotificationsRead(null, { type: 'vote' }, ctx)).rejects.toThrow(
      'Authentication required',
    );
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

    const count = await socialNotificationMutations.markGroupNotificationsRead(null, { type: 'new_follower' }, ctx);

    expect(count).toBe(2);
  });
});

// ============================================
// groupedNotifications enrichment
// ============================================

/** A `board_climbs` row shaped like NOTIFICATION_CLIMB_COLUMNS selects it. */
function makeClimbRow(overrides: Record<string, unknown> = {}) {
  return {
    uuid: 'climb-1',
    name: 'Blue Ridge',
    boardType: 'kilter',
    setterUsername: 'setter1',
    layoutId: 8,
    angle: 40,
    frames: 'p1080r12p1122r13',
    compatibleSizeIds: [17, 18],
    ...overrides,
  };
}

/** One grouped row off the CTE, with the fields every branch reads. */
function makeGroupRow(overrides: Record<string, unknown> = {}) {
  return {
    type: 'new_climb',
    entityType: 'climb',
    entityId: 'climb-1',
    actorCount: '1',
    latestUuid: 'notif-1',
    latestCreatedAt: new Date('2024-01-15T12:00:00Z'),
    allRead: false,
    commentBody: null,
    actorIds: ['user-a'],
    actorDisplayNames: ['Alice'],
    actorAvatarUrls: [null],
    totalGroupCount: '1',
    ...overrides,
  };
}

/** Queue one `db.select().from().where()` result, in call order. */
function queueSelect(rows: unknown[]) {
  mockFrom.mockReturnValueOnce({ where: vi.fn().mockResolvedValueOnce(rows) });
}

describe('groupedNotifications enrichment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnThis();
  });

  it('gives a climb row the frames and sizes a thumbnail needs', async () => {
    const ctx = makeCtx();
    mockExecute.mockResolvedValueOnce([makeGroupRow()]);
    queueSelect([makeClimbRow()]); // climbs
    queueSelect([{ count: 0 }]); // unread count

    const [group] = (await socialNotificationQueries.groupedNotifications(null, {}, ctx)).groups;

    expect(group.climbUuid).toBe('climb-1');
    expect(group.climbName).toBe('Blue Ridge');
    expect(group.climbLayoutId).toBe(8);
    expect(group.climbFrames).toBe('p1080r12p1122r13');
    expect(group.climbCompatibleSizeIds).toEqual([17, 18]);
  });

  it('resolves a comment on an ascent to its thread AND its climb', async () => {
    const ctx = makeCtx();
    mockExecute.mockResolvedValueOnce([
      makeGroupRow({ type: 'comment_on_tick', entityType: 'tick', entityId: 'tick-9' }),
    ]);
    queueSelect([{ uuid: 'tick-9', climbUuid: 'climb-1', boardType: 'kilter' }]); // ticks
    queueSelect([makeClimbRow()]); // climbs
    queueSelect([{ count: 0 }]); // unread count

    const [group] = (await socialNotificationQueries.groupedNotifications(null, {}, ctx)).groups;

    expect(group.threadEntityType).toBe('tick');
    expect(group.threadEntityId).toBe('tick-9');
    // The climb rides along so the row can draw board art like a climb row.
    expect(group.climbUuid).toBe('climb-1');
    expect(group.climbFrames).toBe('p1080r12p1122r13');
  });

  it('resolves a vote on a comment to the thread the comment lives in', async () => {
    const ctx = makeCtx();
    mockExecute.mockResolvedValueOnce([
      makeGroupRow({ type: 'vote_on_comment', entityType: 'comment', entityId: 'comment-3' }),
    ]);
    queueSelect([{ uuid: 'comment-3', entityType: 'session', entityId: 'session-7' }]); // comments
    queueSelect([{ count: 0 }]); // unread count

    const [group] = (await socialNotificationQueries.groupedNotifications(null, {}, ctx)).groups;

    // The thread is the session the comment sits under, NOT the comment uuid.
    expect(group.threadEntityType).toBe('session');
    expect(group.threadEntityId).toBe('session-7');
  });

  it('chains a vote on an ascent comment all the way to the climb', async () => {
    const ctx = makeCtx();
    mockExecute.mockResolvedValueOnce([
      makeGroupRow({ type: 'vote_on_comment', entityType: 'comment', entityId: 'comment-3' }),
    ]);
    queueSelect([{ uuid: 'comment-3', entityType: 'tick', entityId: 'tick-9' }]); // comments
    queueSelect([{ uuid: 'tick-9', climbUuid: 'climb-1', boardType: 'kilter' }]); // ticks
    queueSelect([makeClimbRow()]); // climbs
    queueSelect([{ count: 0 }]); // unread count

    const [group] = (await socialNotificationQueries.groupedNotifications(null, {}, ctx)).groups;

    expect(group.threadEntityType).toBe('tick');
    expect(group.threadEntityId).toBe('tick-9');
    expect(group.climbUuid).toBe('climb-1');
  });

  it('leaves a follower row without a thread or a climb', async () => {
    const ctx = makeCtx();
    mockExecute.mockResolvedValueOnce([makeGroupRow({ type: 'new_follower', entityType: null, entityId: 'user-123' })]);
    queueSelect([{ count: 0 }]); // unread count

    const [group] = (await socialNotificationQueries.groupedNotifications(null, {}, ctx)).groups;

    expect(group.threadEntityId).toBeUndefined();
    expect(group.climbUuid).toBeUndefined();
    expect(group.climbFrames).toBeUndefined();
  });
});

// ============================================
// notificationActors
// ============================================

describe('notificationActors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnThis();
  });

  /** Queue the grouped-actor query's chain: from().where().groupBy().orderBy().limit().offset(). */
  function queueActorPage(rows: unknown[]) {
    mockFrom.mockReturnValueOnce({
      where: vi.fn().mockReturnValue({
        groupBy: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({ offset: vi.fn().mockResolvedValue(rows) }),
          }),
        }),
      }),
    });
  }

  it('requires authentication', async () => {
    const ctx = makeCtx({ isAuthenticated: false });
    await expect(
      socialNotificationQueries.notificationActors(null, { input: { type: 'new_follower' } }, ctx),
    ).rejects.toThrow('Authentication required');
  });

  it('rejects a limit above the cap', async () => {
    const ctx = makeCtx();
    await expect(
      socialNotificationQueries.notificationActors(null, { input: { type: 'new_follower', limit: 999 } }, ctx),
    ).rejects.toThrow();
  });

  it('rejects a type that is not a notification type', async () => {
    const ctx = makeCtx();
    await expect(
      socialNotificationQueries.notificationActors(null, { input: { type: 'not_a_type' } }, ctx),
    ).rejects.toThrow();
  });

  it('returns actors newest-first with follow state', async () => {
    const ctx = makeCtx();
    queueSelect([{ count: 5 }]); // distinct actor count
    queueActorPage([{ actorId: 'user-b' }, { actorId: 'user-a' }]);
    // Identities come back in whatever order Postgres likes — reversed here on
    // purpose, so the assertion proves the result follows the actor order.
    mockFrom.mockReturnValueOnce({
      leftJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          { id: 'user-a', userName: 'Alice', userImage: null, displayName: null, avatarUrl: 'a.png' },
          { id: 'user-b', userName: null, userImage: 'b-fallback.png', displayName: 'Bob', avatarUrl: null },
        ]),
      }),
    });
    mockBatchEnrichUserProfiles.mockResolvedValueOnce(
      new Map([
        ['user-a', { followerCount: 3, followingCount: 1, isFollowedByMe: false }],
        ['user-b', { followerCount: 9, followingCount: 4, isFollowedByMe: true }],
      ]),
    );

    const result = await socialNotificationQueries.notificationActors(
      null,
      { input: { type: 'new_follower', limit: 2 } },
      ctx,
    );

    expect(result.users.map((user) => user.id)).toEqual(['user-b', 'user-a']);
    expect(result.users[0]).toMatchObject({ displayName: 'Bob', avatarUrl: 'b-fallback.png', isFollowedByMe: true });
    expect(result.users[1]).toMatchObject({ displayName: 'Alice', avatarUrl: 'a.png', isFollowedByMe: false });
    expect(result.totalCount).toBe(5);
    expect(result.hasMore).toBe(true);
    expect(mockBatchEnrichUserProfiles).toHaveBeenCalledWith(['user-b', 'user-a'], 'user-123');
  });

  it('drops an actor whose account is gone rather than emitting a blank row', async () => {
    const ctx = makeCtx();
    queueSelect([{ count: 2 }]);
    queueActorPage([{ actorId: 'user-a' }, { actorId: 'deleted-user' }]);
    mockFrom.mockReturnValueOnce({
      leftJoin: vi.fn().mockReturnValue({
        where: vi
          .fn()
          .mockResolvedValue([
            { id: 'user-a', userName: 'Alice', userImage: null, displayName: null, avatarUrl: null },
          ]),
      }),
    });
    mockBatchEnrichUserProfiles.mockResolvedValueOnce(new Map());

    const result = await socialNotificationQueries.notificationActors(null, { input: { type: 'new_follower' } }, ctx);

    expect(result.users).toHaveLength(1);
    expect(result.users[0].id).toBe('user-a');
    // hasMore counts the page the DB returned, not the rows that survived.
    expect(result.hasMore).toBe(false);
  });

  it('short-circuits without touching the identity fetch when the group is empty', async () => {
    const ctx = makeCtx();
    queueSelect([{ count: 0 }]);
    queueActorPage([]);

    const result = await socialNotificationQueries.notificationActors(null, { input: { type: 'new_follower' } }, ctx);

    expect(result).toEqual({ users: [], totalCount: 0, hasMore: false });
    expect(mockBatchEnrichUserProfiles).not.toHaveBeenCalled();
  });
});
