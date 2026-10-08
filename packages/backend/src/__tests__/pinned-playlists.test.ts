import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { sqlText } from '@boardsesh/db/test-utils';
import { playlistMutations } from '../graphql/resolvers/playlists/mutations';
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

const NOW = new Date('2026-05-06T12:00:00Z');

/** Drizzle-shaped chain mock — matches the helper in playlist-follows.test.ts. */
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

function makePinnedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: BigInt(1),
    uuid: 'pl-1',
    boardType: 'kilter',
    layoutId: 1,
    name: 'Test Playlist',
    description: null,
    isPublic: false,
    color: null,
    icon: null,
    createdAt: NOW,
    updatedAt: NOW,
    lastAccessedAt: null,
    pinnedAt: NOW,
    ...overrides,
  };
}

describe('pinPlaylist mutation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('rejects unauthenticated users', async () => {
    const ctx = makeCtx({ isAuthenticated: false, userId: undefined });
    await expect(playlistMutations.pinPlaylist(null, { input: { playlistUuid: 'pl-1' } }, ctx)).rejects.toThrow(
      'Authentication required',
    );
  });

  it('rejects when the playlist does not exist', async () => {
    const ctx = makeCtx();
    // verifyPlaylistAccess does a single select on playlists by uuid.
    const { chain } = createMockChain([]);
    mockDb.select.mockReturnValueOnce(chain);

    await expect(playlistMutations.pinPlaylist(null, { input: { playlistUuid: 'nope' } }, ctx)).rejects.toThrow(
      'Playlist not found or access denied',
    );
  });

  it('rejects pinning a private playlist owned by someone else', async () => {
    const ctx = makeCtx();
    // verifyPlaylistAccess applies authorization in SQL, before returning a row.
    const { chain: playlistLookup, calls } = createMockChain([]);
    mockDb.select.mockReturnValueOnce(playlistLookup);

    await expect(playlistMutations.pinPlaylist(null, { input: { playlistUuid: 'pl-1' } }, ctx)).rejects.toThrow(
      'Playlist not found or access denied',
    );
    expect(sqlText(calls.where[0][0])).toContain('public_consent_revision');
  });

  it('pins a public playlist owned by another user (idempotent)', async () => {
    const ctx = makeCtx();
    // verifyPlaylistAccess: public playlist, no ownership check needed.
    const { chain: playlistLookup } = createMockChain([{ id: BigInt(42), isPublic: true }]);
    mockDb.select.mockReturnValueOnce(playlistLookup);

    // Insert pin via onConflictDoNothing — chain resolves successfully.
    const { chain: insertChain, calls: insertCalls } = createMockChain([]);
    mockDb.insert.mockReturnValueOnce(insertChain);

    const result = await playlistMutations.pinPlaylist(null, { input: { playlistUuid: 'pl-1' } }, ctx);

    expect(result).toBe(true);
    expect(insertCalls.values.length).toBe(1);
    expect(insertCalls.values[0][0]).toMatchObject({ userId: 'user-123', playlistId: BigInt(42) });
    expect(insertCalls.onConflictDoNothing.length).toBe(1);
  });

  it('pins the user’s own private playlist', async () => {
    const ctx = makeCtx();
    // private playlist
    const { chain: playlistLookup } = createMockChain([{ id: BigInt(99), isPublic: false }]);
    mockDb.select.mockReturnValueOnce(playlistLookup);

    const { chain: insertChain } = createMockChain([]);
    mockDb.insert.mockReturnValueOnce(insertChain);

    const result = await playlistMutations.pinPlaylist(null, { input: { playlistUuid: 'pl-1' } }, ctx);
    expect(result).toBe(true);
  });
});

describe('unpinPlaylist mutation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('rejects unauthenticated users', async () => {
    const ctx = makeCtx({ isAuthenticated: false, userId: undefined });
    await expect(playlistMutations.unpinPlaylist(null, { input: { playlistUuid: 'pl-1' } }, ctx)).rejects.toThrow(
      'Authentication required',
    );
  });

  it('returns true even when the playlist no longer exists (idempotent)', async () => {
    const ctx = makeCtx();
    // uuid -> id lookup returns empty
    const { chain: lookup } = createMockChain([]);
    mockDb.select.mockReturnValueOnce(lookup);

    const result = await playlistMutations.unpinPlaylist(null, { input: { playlistUuid: 'gone' } }, ctx);
    expect(result).toBe(true);
    // Should NOT have attempted the delete when the row doesn't exist.
    expect(mockDb.delete).not.toHaveBeenCalled();
  });

  it('deletes the pin row by (userId, playlistId)', async () => {
    const ctx = makeCtx();
    const { chain: lookup } = createMockChain([{ id: BigInt(7) }]);
    mockDb.select.mockReturnValueOnce(lookup);

    const { chain: deleteChain, calls: deleteCalls } = createMockChain([]);
    mockDb.delete.mockReturnValueOnce(deleteChain);

    const result = await playlistMutations.unpinPlaylist(null, { input: { playlistUuid: 'pl-1' } }, ctx);
    expect(result).toBe(true);
    expect(mockDb.delete).toHaveBeenCalledTimes(1);
    expect(deleteCalls.where.length).toBe(1);
  });

  it('treats a missing pin row as success (delete-where-no-match returns 0 rows)', async () => {
    const ctx = makeCtx();
    const { chain: lookup } = createMockChain([{ id: BigInt(7) }]);
    mockDb.select.mockReturnValueOnce(lookup);

    // Drizzle's delete returns void / row count, not row data — chain resolves [].
    const { chain: deleteChain } = createMockChain([]);
    mockDb.delete.mockReturnValueOnce(deleteChain);

    const result = await playlistMutations.unpinPlaylist(null, { input: { playlistUuid: 'pl-1' } }, ctx);
    expect(result).toBe(true);
  });
});

describe('myPinnedPlaylists query', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('rejects unauthenticated users', async () => {
    const ctx = makeCtx({ isAuthenticated: false, userId: undefined });
    await expect(playlistQueries.myPinnedPlaylists(null, { input: {} }, ctx)).rejects.toThrow(
      'Authentication required',
    );
  });

  it('returns empty array when the user has no pins', async () => {
    const ctx = makeCtx();
    // main pinned-rows query
    const { chain: mainChain } = createMockChain([]);
    mockDb.select.mockReturnValueOnce(mainChain);
    // No further queries should run when rows are empty.
    const result = await playlistQueries.myPinnedPlaylists(null, { input: {} }, ctx);
    expect(result).toEqual([]);
  });

  it('returns pinned playlists ordered by pin recency, capped at PINNED_LIMIT', async () => {
    const ctx = makeCtx();
    // Single-query design: role rides on the row from the LEFT JOIN to
    // playlistOwnership scoped to the current user.
    const { chain: mainChain, calls: mainCalls } = createMockChain([
      makePinnedRow({ uuid: 'pl-recent', id: BigInt(1), role: 'owner' }),
      makePinnedRow({ uuid: 'pl-older', id: BigInt(2), role: 'owner' }),
    ]);
    mockDb.select.mockReturnValueOnce(mainChain);

    // Climb counts
    const { chain: climbCounts } = createMockChain([]);
    mockDb.select.mockReturnValueOnce(climbCounts);

    // Follow stats: follower counts + isFollowedByMe
    const { chain: followerChain } = createMockChain([]);
    mockDb.select.mockReturnValueOnce(followerChain);
    const { chain: followedChain } = createMockChain([]);
    mockDb.select.mockReturnValueOnce(followedChain);

    const result = await playlistQueries.myPinnedPlaylists(null, { input: {} }, ctx);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ uuid: 'pl-recent', userRole: 'owner', isPinnedByMe: true });
    expect(result[1]).toMatchObject({ uuid: 'pl-older', userRole: 'owner', isPinnedByMe: true });

    // Single query with LEFT JOIN gives us role + ordering + limit in one go.
    expect(mainCalls.leftJoin.length).toBe(1);
    expect(mainCalls.limit.length).toBe(1);
    expect(mainCalls.orderBy.length).toBe(1);
  });

  it('falls back to viewer role when the user does not own a pinned public playlist', async () => {
    const ctx = makeCtx();
    // LEFT JOIN to playlistOwnership returns null role for non-owners.
    const { chain: mainChain } = createMockChain([
      makePinnedRow({ uuid: 'pl-public', id: BigInt(50), isPublic: true, role: null }),
    ]);
    mockDb.select.mockReturnValueOnce(mainChain);

    const { chain: climbCounts } = createMockChain([]);
    mockDb.select.mockReturnValueOnce(climbCounts);
    const { chain: followerChain } = createMockChain([]);
    mockDb.select.mockReturnValueOnce(followerChain);
    const { chain: followedChain } = createMockChain([]);
    mockDb.select.mockReturnValueOnce(followedChain);

    const result = await playlistQueries.myPinnedPlaylists(null, { input: {} }, ctx);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ uuid: 'pl-public', userRole: 'viewer', isPinnedByMe: true });
  });

  it('applies the boardType + layoutId filter', async () => {
    const ctx = makeCtx();
    const { chain: mainChain, calls: mainCalls } = createMockChain([
      makePinnedRow({ uuid: 'pl-1', boardType: 'kilter', layoutId: 8, role: 'owner' }),
    ]);
    mockDb.select.mockReturnValueOnce(mainChain);
    const { chain: climbCounts } = createMockChain([]);
    mockDb.select.mockReturnValueOnce(climbCounts);
    const { chain: followerChain } = createMockChain([]);
    mockDb.select.mockReturnValueOnce(followerChain);
    const { chain: followedChain } = createMockChain([]);
    mockDb.select.mockReturnValueOnce(followedChain);

    const result = await playlistQueries.myPinnedPlaylists(null, { input: { boardType: 'kilter', layoutId: 8 } }, ctx);
    expect(result).toHaveLength(1);
    // Single .where() call carries all conditions (drizzle-style and(...)).
    expect(mainCalls.where.length).toBe(1);
  });
});
