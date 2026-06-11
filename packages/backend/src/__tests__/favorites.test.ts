import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';

const { mockDb, eqSpy, inArraySpy } = vi.hoisted(() => {
  const mockDb = {
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
  };
  return {
    mockDb,
    eqSpy: vi.fn(),
    inArraySpy: vi.fn(),
  };
});

vi.mock('../db/client', () => ({ db: mockDb }));

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
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

function makeSelectChain(resolveValue: unknown = []) {
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'where', 'limit']) {
    chain[method] = vi.fn(() => chain);
  }
  // eslint-disable-next-line unicorn/no-thenable -- Drizzle resolver mocks are awaited query builders.
  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(resolveValue).then(resolve);
  return chain;
}

describe('favorite resolvers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queries favorites by user and climb UUID only', async () => {
    mockDb.select.mockReturnValueOnce(makeSelectChain([{ climbUuid: 'c1' }, { climbUuid: 'c2' }]));

    const result = await favoriteQueries.favorites(null, { climbUuids: ['c1', 'c2'] }, makeCtx());

    expect(result).toEqual(['c1', 'c2']);
    expect(inArraySpy).toHaveBeenCalledWith(dbSchema.userFavorites.climbUuid, ['c1', 'c2']);
    expect(eqSpy).toHaveBeenCalledTimes(1);
    expect(eqSpy).toHaveBeenCalledWith(dbSchema.userFavorites.userId, 'user-123');
  });

  it('inserts a favorite using only user and climb UUID', async () => {
    mockDb.select.mockReturnValueOnce(makeSelectChain([]));
    const values = vi.fn(async () => undefined);
    mockDb.insert.mockReturnValueOnce({ values });

    const result = await favoriteMutations.toggleFavorite(null, { input: { climbUuid: 'c1' } }, makeCtx());

    expect(result).toEqual({ favorited: true });
    expect(values).toHaveBeenCalledWith({ userId: 'user-123', climbUuid: 'c1' });
    expect(eqSpy).toHaveBeenCalledTimes(2);
    expect(eqSpy).toHaveBeenCalledWith(dbSchema.userFavorites.userId, 'user-123');
    expect(eqSpy).toHaveBeenCalledWith(dbSchema.userFavorites.climbUuid, 'c1');
  });

  it('deletes an existing favorite using the UUID-only key', async () => {
    mockDb.select.mockReturnValueOnce(makeSelectChain([{ id: 1, climbUuid: 'c1' }]));
    const deleteChain = { where: vi.fn(async () => undefined) };
    mockDb.delete.mockReturnValueOnce(deleteChain);

    const result = await favoriteMutations.toggleFavorite(null, { input: { climbUuid: 'c1' } }, makeCtx());

    expect(result).toEqual({ favorited: false });
    expect(mockDb.delete).toHaveBeenCalledWith(dbSchema.userFavorites);
    expect(deleteChain.where).toHaveBeenCalledTimes(1);
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(eqSpy).toHaveBeenCalledTimes(2);
  });
});
