import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';

const { mockDb, mockTx } = vi.hoisted(() => {
  // The compare-and-swap added in #1934 runs the ownership check, the locked
  // read and the write inside one transaction, so the mock needs a `tx` of its
  // own; everything after the commit still goes through `db`.
  const mockTx = {
    select: vi.fn(),
    update: vi.fn(),
  };
  const mockDb = {
    execute: vi.fn(),
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(async (callback: (tx: typeof mockTx) => unknown) => callback(mockTx)),
  };
  return { mockDb, mockTx };
});

vi.mock('../db/client', () => ({ db: mockDb }));
vi.mock('../events/index', () => ({ publishSocialEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../utils/rate-limiter', () => ({ checkRateLimit: vi.fn() }));
vi.mock('../utils/redis-rate-limiter', () => ({ checkRateLimitRedis: vi.fn() }));
// Mock the follow-stats helper so we don't have to stand in for its own queries.
vi.mock('../graphql/resolvers/playlists/queries', () => ({
  getPlaylistFollowStats: vi.fn(async () => new Map([['p-uuid', { followerCount: 0, isFollowedByMe: false }]])),
}));

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
  const methods = ['select', 'from', 'where', 'innerJoin', 'limit', 'set', 'update', 'returning', 'for'];
  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(resolveValue).then(resolve);
  for (const method of methods) chain[method] = vi.fn((..._args: unknown[]) => chain);
  return chain;
}

const updatedRow = {
  id: 1,
  uuid: 'p-uuid',
  boardType: 'kilter',
  layoutId: 1,
  name: 'P',
  description: null,
  isPublic: false,
  color: null,
  icon: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

/**
 * Mock the resolver's db sequence: inside the transaction, ownership select →
 * locked playlist select → update; after it commits, climbCount select → pin
 * select.
 */
function primeDb() {
  mockTx.select.mockReturnValueOnce(createMockChain([{ playlistId: 1 }])); // ownership
  mockTx.select.mockReturnValueOnce(createMockChain([updatedRow])); // locked read
  const updateChain = createMockChain([updatedRow]);
  mockTx.update.mockReturnValueOnce(updateChain);
  mockDb.select.mockReturnValueOnce(createMockChain([{ count: 0 }])); // climbCount
  mockDb.select.mockReturnValueOnce(createMockChain([])); // pin lookup
  return updateChain;
}

describe('updatePlaylist mutation — clearing optional fields', () => {
  beforeEach(() => vi.clearAllMocks());

  it("normalizes the '' clear signal to NULL for description/colour/icon", async () => {
    const ctx = makeCtx();
    const updateChain = primeDb();

    await playlistMutations.updatePlaylist(
      null,
      { input: { playlistId: 'p-uuid', description: '', color: '', icon: '' } },
      ctx,
    );

    const setArg = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(setArg.description).toBeNull();
    expect(setArg.color).toBeNull();
    expect(setArg.icon).toBeNull();
  });

  it('leaves omitted fields unchanged (undefined → not written)', async () => {
    const ctx = makeCtx();
    const updateChain = primeDb();

    await playlistMutations.updatePlaylist(null, { input: { playlistId: 'p-uuid', name: 'Renamed' } }, ctx);

    const setArg = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(setArg.name).toBe('Renamed');
    expect('description' in setArg).toBe(false);
    expect('color' in setArg).toBe(false);
    expect('icon' in setArg).toBe(false);
  });

  it('keeps a real colour value', async () => {
    const ctx = makeCtx();
    const updateChain = primeDb();

    await playlistMutations.updatePlaylist(null, { input: { playlistId: 'p-uuid', color: '#AABBCC' } }, ctx);

    const setArg = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(setArg.color).toBe('#AABBCC');
  });
});
