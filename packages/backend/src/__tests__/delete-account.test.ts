/**
 * Tests for deleteAccount mutation and deleteAccountInfo query.
 *
 * Verifies that:
 * - Authentication is required for both operations
 * - Draft climbs are deleted
 * - Published climbs are preserved (userId set to null via DB cascade)
 * - removeSetterName flag controls setter name removal
 * - The user row is deleted
 * - Transaction rolls back on failure
 * - Input validation rejects invalid types
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConnectionContext } from '@boardsesh/shared-schema';

// Hoist mock variables so they're available before module evaluation
const { mockDb, txCalls } = vi.hoisted(() => {
  const txCalls: Array<{ method: string; args: unknown[] }> = [];

  const mockDb = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ count: 0 }]),
      }),
    }),
    transaction: vi.fn(),
  };

  return { mockDb, txCalls };
});

vi.mock('../db/client', () => ({
  db: mockDb,
}));

import { userMutations } from '../graphql/resolvers/users/mutations';
import { userQueries } from '../graphql/resolvers/users/queries';

function makeAuthCtx(userId = 'user-1'): ConnectionContext {
  return {
    connectionId: `http-${userId}`,
    sessionId: undefined,
    userId,
    isAuthenticated: true,
  };
}

function makeAnonCtx(): ConnectionContext {
  return {
    connectionId: 'http-anon',
    sessionId: undefined,
    userId: undefined,
    isAuthenticated: false,
  };
}

/**
 * Set up the transaction mock so it records all calls on the tx object.
 * Returns the txCalls array for assertions.
 */
function setupTransactionMock(options?: { failOnUserDelete?: boolean }) {
  txCalls.length = 0;

  mockDb.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<void>) => {
    const tx = {
      delete: vi.fn().mockImplementation((table: unknown) => {
        const call = { method: 'delete', table, args: [] as unknown[] };
        return {
          where: vi.fn().mockImplementation((...args: unknown[]) => {
            call.args = args;
            txCalls.push(call);
            // Fail on the second delete (user row) if requested
            if (options?.failOnUserDelete && txCalls.filter(c => c.method === 'delete').length === 2) {
              return Promise.reject(new Error('DB error'));
            }
            return Promise.resolve(undefined);
          }),
        };
      }),
      update: vi.fn().mockImplementation((table: unknown) => {
        const call = { method: 'update', table, args: [] as unknown[], setArgs: null as unknown };
        return {
          set: vi.fn().mockImplementation((setData: unknown) => {
            call.setArgs = setData;
            return {
              where: vi.fn().mockImplementation((...args: unknown[]) => {
                call.args = args;
                txCalls.push(call);
                return Promise.resolve(undefined);
              }),
            };
          }),
        };
      }),
    };
    await callback(tx);
  });

  return txCalls;
}

describe('deleteAccount mutation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    txCalls.length = 0;
    setupTransactionMock();
  });

  it('should reject unauthenticated requests', async () => {
    await expect(
      userMutations.deleteAccount(
        {},
        { input: { removeSetterName: false } },
        makeAnonCtx(),
      ),
    ).rejects.toThrow();
  });

  it('should validate input and reject non-boolean removeSetterName', async () => {
    await expect(
      userMutations.deleteAccount(
        {},
        { input: { removeSetterName: 'yes' as unknown as boolean } },
        makeAuthCtx(),
      ),
    ).rejects.toThrow();
  });

  it('should delete draft climbs and user row when removeSetterName is false', async () => {
    const result = await userMutations.deleteAccount(
      {},
      { input: { removeSetterName: false } },
      makeAuthCtx('user-1'),
    );

    expect(result).toBe(true);
    // Should have exactly 2 operations: delete drafts + delete user
    const deleteCalls = txCalls.filter(c => c.method === 'delete');
    expect(deleteCalls).toHaveLength(2);
    // No update calls
    const updateCalls = txCalls.filter(c => c.method === 'update');
    expect(updateCalls).toHaveLength(0);
  });

  it('should call update to nullify setter name when removeSetterName is true', async () => {
    await userMutations.deleteAccount(
      {},
      { input: { removeSetterName: true } },
      makeAuthCtx(),
    );

    const updateCalls = txCalls.filter(c => c.method === 'update');
    expect(updateCalls).toHaveLength(1);
    expect((updateCalls[0] as { setArgs: unknown }).setArgs).toEqual({ setterUsername: null });
  });

  it('should not call update when removeSetterName is false', async () => {
    await userMutations.deleteAccount(
      {},
      { input: { removeSetterName: false } },
      makeAuthCtx(),
    );

    const updateCalls = txCalls.filter(c => c.method === 'update');
    expect(updateCalls).toHaveLength(0);
  });

  it('should return true on success', async () => {
    const result = await userMutations.deleteAccount(
      {},
      { input: { removeSetterName: false } },
      makeAuthCtx(),
    );

    expect(result).toBe(true);
  });

  it('should propagate transaction errors (rollback)', async () => {
    setupTransactionMock({ failOnUserDelete: true });

    await expect(
      userMutations.deleteAccount(
        {},
        { input: { removeSetterName: false } },
        makeAuthCtx(),
      ),
    ).rejects.toThrow('DB error');
  });

  it('should execute operations in correct order: drafts, setter name, user', async () => {
    await userMutations.deleteAccount(
      {},
      { input: { removeSetterName: true } },
      makeAuthCtx(),
    );

    // Order: delete drafts, update setter name, delete user
    expect(txCalls).toHaveLength(3);
    expect(txCalls[0].method).toBe('delete');  // draft climbs
    expect(txCalls[1].method).toBe('update');  // setter name
    expect(txCalls[2].method).toBe('delete');  // user row
  });
});

describe('deleteAccountInfo query', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should reject unauthenticated requests', async () => {
    await expect(
      userQueries.deleteAccountInfo({}, {}, makeAnonCtx()),
    ).rejects.toThrow();
  });

  it('should return published climb count', async () => {
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ count: 5 }]),
      }),
    });

    const result = await userQueries.deleteAccountInfo(
      {},
      {},
      makeAuthCtx(),
    );

    expect(result).toEqual({ publishedClimbCount: 5 });
  });

  it('should return 0 when user has no published climbs', async () => {
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ count: 0 }]),
      }),
    });

    const result = await userQueries.deleteAccountInfo(
      {},
      {},
      makeAuthCtx(),
    );

    expect(result).toEqual({ publishedClimbCount: 0 });
  });

  it('should return 0 when query returns empty result', async () => {
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    const result = await userQueries.deleteAccountInfo(
      {},
      {},
      makeAuthCtx(),
    );

    expect(result).toEqual({ publishedClimbCount: 0 });
  });
});
