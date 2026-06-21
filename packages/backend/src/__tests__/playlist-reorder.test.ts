import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';

const { mockDb } = vi.hoisted(() => {
  const mockDb = {
    execute: vi.fn(),
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  };
  return { mockDb };
});

vi.mock('../db/client', () => ({ db: mockDb }));
vi.mock('../utils/rate-limiter', () => ({ checkRateLimit: vi.fn() }));
vi.mock('../utils/redis-rate-limiter', () => ({ checkRateLimitRedis: vi.fn() }));

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

/** A thenable Drizzle-style chain resolving to `resolveValue` when awaited. */
function createMockChain(resolveValue: unknown = []): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  const methods = ['select', 'from', 'where', 'innerJoin', 'limit', 'orderBy', 'for', 'set', 'update', 'returning'];
  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(resolveValue).then(resolve);
  for (const method of methods) chain[method] = vi.fn((..._args: unknown[]) => chain);
  return chain;
}

type ClimbRow = { id: number; climbUuid: string; position: number };

/**
 * Mock a transaction whose `tx.select(...).for('update')` yields `rows` and
 * whose `tx.update(...).set(x)` records `x`. The resolver does at most two
 * updates: one batched `{ position: <CASE sql> }` for the shifted climbs, then
 * the parent playlist's `{ updatedAt }`.
 */
function primeTransaction(rows: ClimbRow[]) {
  const setCalls: Array<Record<string, unknown>> = [];
  const selectChain = createMockChain(rows);
  const tx = {
    select: vi.fn(() => selectChain),
    update: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      chain.set = vi.fn((arg: Record<string, unknown>) => {
        setCalls.push(arg);
        return chain;
      });
      chain.where = vi.fn(() => chain);
      chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve([]).then(resolve);
      return chain;
    }),
  };
  mockDb.transaction.mockImplementationOnce(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));
  return { setCalls };
}

/** How many of the captured updates rewrote climb positions (the batched CASE). */
function positionUpdateCount(setCalls: Array<Record<string, unknown>>): number {
  return setCalls.filter((call) => 'position' in call).length;
}

const ROWS: ClimbRow[] = [
  { id: 1, climbUuid: 'climb-a', position: 0 },
  { id: 2, climbUuid: 'climb-b', position: 1 },
  { id: 3, climbUuid: 'climb-c', position: 2 },
];

describe('reorderPlaylistClimb mutation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renumbers via a single batched position update and bumps the playlist', async () => {
    mockDb.select.mockReturnValueOnce(createMockChain([{ id: 1 }])); // ownership
    const { setCalls } = primeTransaction(ROWS.map((row) => ({ ...row })));

    const result = await playlistMutations.reorderPlaylistClimb(
      null,
      { input: { playlistId: 'p-uuid', climbUuid: 'climb-c', newIndex: 0 } },
      makeCtx(),
    );

    expect(result).toBe(true);
    // Exactly one position rewrite (the CASE statement), not a write per row.
    expect(positionUpdateCount(setCalls)).toBe(1);
    // The parent playlist's updatedAt is bumped as the final set.
    expect('updatedAt' in setCalls[setCalls.length - 1]).toBe(true);
  });

  it('skips the position update for a no-op move but still bumps the playlist', async () => {
    mockDb.select.mockReturnValueOnce(createMockChain([{ id: 1 }]));
    const { setCalls } = primeTransaction(ROWS.map((row) => ({ ...row })));

    // climb-a is already at index 0.
    const result = await playlistMutations.reorderPlaylistClimb(
      null,
      { input: { playlistId: 'p-uuid', climbUuid: 'climb-a', newIndex: 0 } },
      makeCtx(),
    );

    expect(result).toBe(true);
    expect(positionUpdateCount(setCalls)).toBe(0);
    expect('updatedAt' in setCalls[setCalls.length - 1]).toBe(true);
  });

  it('throws when the climb is not in the playlist', async () => {
    mockDb.select.mockReturnValueOnce(createMockChain([{ id: 1 }]));
    primeTransaction(ROWS.map((row) => ({ ...row })));

    await expect(
      playlistMutations.reorderPlaylistClimb(
        null,
        { input: { playlistId: 'p-uuid', climbUuid: 'climb-missing', newIndex: 0 } },
        makeCtx(),
      ),
    ).rejects.toThrow('Climb not found in playlist');
  });

  it('rejects a non-owner before touching the transaction', async () => {
    mockDb.select.mockReturnValueOnce(createMockChain([])); // no ownership row

    await expect(
      playlistMutations.reorderPlaylistClimb(
        null,
        { input: { playlistId: 'p-uuid', climbUuid: 'climb-a', newIndex: 0 } },
        makeCtx(),
      ),
    ).rejects.toThrow('you do not have permission');

    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('requires authentication', async () => {
    await expect(
      playlistMutations.reorderPlaylistClimb(
        null,
        { input: { playlistId: 'p-uuid', climbUuid: 'climb-a', newIndex: 0 } },
        makeCtx({ isAuthenticated: false, userId: undefined }),
      ),
    ).rejects.toThrow();

    expect(mockDb.select).not.toHaveBeenCalled();
  });
});
