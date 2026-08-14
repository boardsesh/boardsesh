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

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { userMutations } from '../graphql/resolvers/users/mutations';
import { userQueries } from '../graphql/resolvers/users/queries';

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
 *
 * `draftClimbs` seeds what the initial `tx.select(...).from(boardClimbs)...`
 * lookup returns — the (uuid, boardType) pairs deleteAccount uses to clean up
 * dependent rows before deleting the drafts themselves. Defaults to none, so
 * existing tests that don't care about this keep their original call counts.
 */
function setupTransactionMock(options?: {
  failOnUserDelete?: boolean;
  draftClimbs?: Array<{ uuid: string; boardType: string }>;
}) {
  txCalls.length = 0;

  mockDb.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<void>) => {
    const tx = {
      select: vi.fn().mockImplementation((columns: unknown) => {
        const call = { method: 'select', columns, args: [] as unknown[] };
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockImplementation((...args: unknown[]) => {
              call.args = args;
              txCalls.push(call);
              return Promise.resolve(options?.draftClimbs ?? []);
            }),
          }),
        };
      }),
      delete: vi.fn().mockImplementation((table: unknown) => {
        const call = { method: 'delete', table, args: [] as unknown[] };
        return {
          where: vi.fn().mockImplementation((...args: unknown[]) => {
            call.args = args;
            txCalls.push(call);
            // Fail on the second delete (user row) if requested
            if (options?.failOnUserDelete && txCalls.filter((c) => c.method === 'delete').length === 2) {
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
      userMutations.deleteAccount({}, { input: { removeSetterName: false } }, makeAnonCtx()),
    ).rejects.toThrow();
  });

  it('should validate input and reject non-boolean removeSetterName', async () => {
    await expect(
      userMutations.deleteAccount({}, { input: { removeSetterName: 'yes' as unknown as boolean } }, makeAuthCtx()),
    ).rejects.toThrow();
  });

  it('should delete draft climbs and user row when removeSetterName is false', async () => {
    const result = await userMutations.deleteAccount({}, { input: { removeSetterName: false } }, makeAuthCtx('user-1'));

    expect(result).toBe(true);
    // Should have exactly 2 operations: delete drafts + delete user
    const deleteCalls = txCalls.filter((c) => c.method === 'delete');
    expect(deleteCalls).toHaveLength(2);
    // No update calls
    const updateCalls = txCalls.filter((c) => c.method === 'update');
    expect(updateCalls).toHaveLength(0);
  });

  it('should call update to nullify setter name when removeSetterName is true', async () => {
    await userMutations.deleteAccount({}, { input: { removeSetterName: true } }, makeAuthCtx());

    const updateCalls = txCalls.filter((c) => c.method === 'update');
    expect(updateCalls).toHaveLength(1);
    expect((updateCalls[0] as unknown as { setArgs: unknown }).setArgs).toEqual({ setterUsername: null });
  });

  it('should not call update when removeSetterName is false', async () => {
    await userMutations.deleteAccount({}, { input: { removeSetterName: false } }, makeAuthCtx());

    const updateCalls = txCalls.filter((c) => c.method === 'update');
    expect(updateCalls).toHaveLength(0);
  });

  it('should return true on success', async () => {
    const result = await userMutations.deleteAccount({}, { input: { removeSetterName: false } }, makeAuthCtx());

    expect(result).toBe(true);
  });

  it('should propagate transaction errors (rollback)', async () => {
    setupTransactionMock({ failOnUserDelete: true });

    await expect(
      userMutations.deleteAccount({}, { input: { removeSetterName: false } }, makeAuthCtx()),
    ).rejects.toThrow('DB error');
  });

  it('should execute operations in correct order: select drafts, delete drafts, setter name, user', async () => {
    await userMutations.deleteAccount({}, { input: { removeSetterName: true } }, makeAuthCtx());

    // Order: select this user's draft climbs, delete drafts, update setter name, delete user
    expect(txCalls).toHaveLength(4);
    expect(txCalls[0].method).toBe('select'); // this user's draft climbs
    expect(txCalls[1].method).toBe('delete'); // draft climbs
    expect(txCalls[2].method).toBe('update'); // setter name
    expect(txCalls[3].method).toBe('delete'); // user row
  });

  it('cleans up board_climb_stats/history/beta_links for a draft climb before deleting the drafts', async () => {
    setupTransactionMock({ draftClimbs: [{ uuid: 'draft-1', boardType: 'kilter' }] });

    await userMutations.deleteAccount({}, { input: { removeSetterName: false } }, makeAuthCtx());

    // select drafts, delete stats, delete history, delete beta links, delete drafts, delete user.
    // The dependent-row cleanup (3 deletes) must land between the select and the drafts delete.
    expect(txCalls.map((call) => call.method)).toEqual(['select', 'delete', 'delete', 'delete', 'delete', 'delete']);
    const deleteCalls = txCalls.filter((call) => call.method === 'delete');
    expect(deleteCalls).toHaveLength(5);
  });

  it('groups dependent-row cleanup by board type when drafts span multiple boards', async () => {
    setupTransactionMock({
      draftClimbs: [
        { uuid: 'draft-1', boardType: 'kilter' },
        { uuid: 'draft-2', boardType: 'tension' },
      ],
    });

    await userMutations.deleteAccount({}, { input: { removeSetterName: false } }, makeAuthCtx());

    // 3 dependent-row deletes per board type (2 boards) + the drafts delete + the user delete.
    const deleteCalls = txCalls.filter((call) => call.method === 'delete');
    expect(deleteCalls).toHaveLength(2 * 3 + 2);
  });

  it('skips dependent-row cleanup when the user has no draft climbs', async () => {
    setupTransactionMock({ draftClimbs: [] });

    await userMutations.deleteAccount({}, { input: { removeSetterName: false } }, makeAuthCtx());

    // Only the (empty) drafts delete + the user delete — no dependent-row deletes fire.
    const deleteCalls = txCalls.filter((call) => call.method === 'delete');
    expect(deleteCalls).toHaveLength(2);
  });
});

describe('deleteAccountInfo query', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should reject unauthenticated requests', async () => {
    await expect(userQueries.deleteAccountInfo({}, {}, makeAnonCtx())).rejects.toThrow();
  });

  it('should return published climb count', async () => {
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ count: 5 }]),
      }),
    });

    const result = await userQueries.deleteAccountInfo({}, {}, makeAuthCtx());

    expect(result).toEqual({ publishedClimbCount: 5 });
  });

  it('should return 0 when user has no published climbs', async () => {
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ count: 0 }]),
      }),
    });

    const result = await userQueries.deleteAccountInfo({}, {}, makeAuthCtx());

    expect(result).toEqual({ publishedClimbCount: 0 });
  });

  it('should return 0 when query returns empty result', async () => {
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    const result = await userQueries.deleteAccountInfo({}, {}, makeAuthCtx());

    expect(result).toEqual({ publishedClimbCount: 0 });
  });
});
