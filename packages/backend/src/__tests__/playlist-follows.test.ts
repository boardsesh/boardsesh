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

import type { ConnectionContext } from '@boardsesh/shared-schema';
import { playlistMutations } from '../graphql/resolvers/playlists/mutations';

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

describe('followPlaylist mutation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should throw for unauthenticated users', async () => {
    const ctx = makeCtx({ isAuthenticated: false });
    await expect(
      playlistMutations.followPlaylist(null, { input: { playlistUuid: 'playlist-1' } }, ctx),
    ).rejects.toThrow('Authentication required');
  });

  it('should throw if playlist not found', async () => {
    const ctx = makeCtx();

    // select().from().where().limit() → empty array (not found)
    const selectChain = createMockChain([]);
    mockDb.select.mockReturnValueOnce(selectChain);

    await expect(
      playlistMutations.followPlaylist(null, { input: { playlistUuid: 'nonexistent' } }, ctx),
    ).rejects.toThrow('Playlist not found');
  });

  it('should throw if playlist is private', async () => {
    const ctx = makeCtx();

    // select() → playlist found but not public
    const selectChain = createMockChain([{ uuid: 'playlist-1', isPublic: false }]);
    mockDb.select.mockReturnValueOnce(selectChain);

    await expect(
      playlistMutations.followPlaylist(null, { input: { playlistUuid: 'playlist-1' } }, ctx),
    ).rejects.toThrow('Cannot follow a private playlist');
  });

  it('should insert follow and return true', async () => {
    const ctx = makeCtx();

    // 1. Playlist exists and is public
    const selectChain = createMockChain([{ uuid: 'playlist-1', isPublic: true }]);
    mockDb.select.mockReturnValueOnce(selectChain);

    // 2. Insert follow (onConflictDoNothing)
    const insertChain = createMockChain([{ id: 1 }]);
    mockDb.insert.mockReturnValueOnce(insertChain);

    const result = await playlistMutations.followPlaylist(null, { input: { playlistUuid: 'playlist-1' } }, ctx);

    expect(result).toBe(true);
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
  });

  it('should handle idempotent follow (already following)', async () => {
    const ctx = makeCtx();

    // 1. Playlist exists and is public
    const selectChain = createMockChain([{ uuid: 'playlist-1', isPublic: true }]);
    mockDb.select.mockReturnValueOnce(selectChain);

    // 2. Insert follow → onConflictDoNothing returns empty (already exists)
    const insertChain = createMockChain([]);
    mockDb.insert.mockReturnValueOnce(insertChain);

    const result = await playlistMutations.followPlaylist(null, { input: { playlistUuid: 'playlist-1' } }, ctx);

    expect(result).toBe(true);
  });
});

describe('unfollowPlaylist mutation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should throw for unauthenticated users', async () => {
    const ctx = makeCtx({ isAuthenticated: false });
    await expect(
      playlistMutations.unfollowPlaylist(null, { input: { playlistUuid: 'playlist-1' } }, ctx),
    ).rejects.toThrow('Authentication required');
  });

  it('should delete follow and return true', async () => {
    const ctx = makeCtx();

    // delete().where() → affected 1 row
    const deleteChain = createMockChain([{ id: 1 }]);
    mockDb.delete.mockReturnValueOnce(deleteChain);

    const result = await playlistMutations.unfollowPlaylist(null, { input: { playlistUuid: 'playlist-1' } }, ctx);

    expect(result).toBe(true);
    expect(mockDb.delete).toHaveBeenCalledTimes(1);
  });

  it('should handle unfollowing when not following (no-op)', async () => {
    const ctx = makeCtx();

    // delete().where() → affected 0 rows
    const deleteChain = createMockChain([]);
    mockDb.delete.mockReturnValueOnce(deleteChain);

    const result = await playlistMutations.unfollowPlaylist(null, { input: { playlistUuid: 'playlist-1' } }, ctx);

    expect(result).toBe(true);
  });
});
