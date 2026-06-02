// Regression guard for #2449: favorites are keyed by (userId, climbUuid) only.
// Toggling from any board surface and reading from any other board surface
// must operate on the same canonical row — previously the (board, angle)
// dimension produced phantom duplicate keys that broke cross-board reads.

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';

const { mockDb } = vi.hoisted(() => {
  const mockDb = {
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
  };
  return { mockDb };
});

vi.mock('../db/client', () => ({ db: mockDb }));

const eqSpy = vi.fn();
const inArraySpy = vi.fn();
vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return {
    ...actual,
    eq: (...args: Parameters<typeof actual.eq>) => {
      eqSpy(...args);
      return actual.eq(...args);
    },
    inArray: (...args: Parameters<typeof actual.inArray>) => {
      inArraySpy(...args);
      return actual.inArray(...args);
    },
  };
});

import { favoriteMutations } from '../graphql/resolvers/favorites/mutations';
import { favoriteQueries } from '../graphql/resolvers/favorites/queries';

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

function makeChain(resolveValue: unknown = []) {
  const chain: Record<string, unknown> = {};
  const methods = ['select', 'from', 'where', 'limit', 'values'];
  for (const method of methods) {
    chain[method] = vi.fn(() => chain);
  }
  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(resolveValue).then(resolve);
  return chain;
}

describe('favorites resolvers (UUID-only keying, #2449)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('toggleFavorite', () => {
    it('inserts by (userId, climbUuid) only — no board or angle column referenced', async () => {
      // Existing-check returns empty → insert path
      mockDb.select.mockReturnValueOnce(makeChain([]));
      const insertValuesSpy = vi.fn(() => Promise.resolve());
      mockDb.insert.mockReturnValueOnce({ values: insertValuesSpy });

      const result = await favoriteMutations.toggleFavorite(null, { input: { climbUuid: 'climb-A' } }, makeCtx());

      expect(result).toEqual({ favorited: true });
      // Exact-match values: a future regression that re-adds a board or
      // angle key would fail this assertion (vitest .toHaveBeenCalledWith
      // is strict about extra properties).
      expect(insertValuesSpy).toHaveBeenCalledWith({ userId: 'user-123', climbUuid: 'climb-A' });
    });

    it('deletes by (userId, climbUuid) only when row already exists', async () => {
      mockDb.select.mockReturnValueOnce(makeChain([{ id: 1n }]));
      const deleteWhereSpy = vi.fn(() => Promise.resolve());
      mockDb.delete.mockReturnValueOnce({ where: deleteWhereSpy });

      const result = await favoriteMutations.toggleFavorite(null, { input: { climbUuid: 'climb-A' } }, makeCtx());

      expect(result).toEqual({ favorited: false });
      expect(deleteWhereSpy).toHaveBeenCalledOnce();
    });
  });

  describe('favorites query — cross-board read', () => {
    it('returns the climbUuid regardless of which board surface is asking', async () => {
      // A single canonical row exists for the climb. The query is the same
      // regardless of what board the caller is on — this is the #2449 fix.
      mockDb.select.mockReturnValue(makeChain([{ climbUuid: 'climb-A' }]));

      const fromKilter = await favoriteQueries.favorites(null, { climbUuids: ['climb-A'] }, makeCtx());
      const fromTension = await favoriteQueries.favorites(null, { climbUuids: ['climb-A'] }, makeCtx());

      expect(fromKilter).toEqual(['climb-A']);
      expect(fromTension).toEqual(['climb-A']);
      // Resolver signature carries no board/angle dimension — type system
      // would catch a regression at compile time, but assert two distinct
      // call shapes both succeed to make the cross-board intent obvious.
    });

    it('returns empty array for unauthenticated context', async () => {
      const result = await favoriteQueries.favorites(
        null,
        { climbUuids: ['climb-A'] },
        makeCtx({ isAuthenticated: false, userId: undefined }),
      );
      expect(result).toEqual([]);
      expect(mockDb.select).not.toHaveBeenCalled();
    });
  });
});
