import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { SupportDeletionIntent } from '@boardsesh/db/schema';

type OperationRow = {
  userId: string;
  state: string;
  operationId: string | null;
  ownerToken: string | null;
  leaseExpiresAt: Date | null;
  deletionIntent: SupportDeletionIntent | null;
};

const { store, mockDb, lockAccount } = vi.hoisted(() => ({
  store: { operation: null as OperationRow | null, transactionDepth: 0 },
  mockDb: { transaction: vi.fn(), select: vi.fn(), insert: vi.fn(), update: vi.fn() },
  lockAccount: vi.fn(),
}));
vi.mock('../db/client', () => ({ db: mockDb }));
vi.mock('../utils/logger', () => ({ logger: { warn: vi.fn() } }));
vi.mock('./stripe-support-lock', () => ({ lockSupportAccount: lockAccount }));

import { SUPPORT_OPERATION_LEASE_MS, withSupportOperation } from './stripe-support-operation';

function sqlParameters(chunk: unknown): unknown[] {
  if (typeof chunk === 'string') return [chunk];
  if (typeof chunk !== 'object' || chunk === null) return [];
  if ('queryChunks' in chunk && Array.isArray(chunk.queryChunks)) return chunk.queryChunks.flatMap(sqlParameters);
  return 'value' in chunk && !Array.isArray(chunk.value) ? [chunk.value] : [];
}

const intent: SupportDeletionIntent = { subscriptionId: 'sub_1', removeSetterName: true };

beforeEach(() => {
  vi.clearAllMocks();
  store.operation = null;
  store.transactionDepth = 0;
  lockAccount.mockResolvedValue({ id: 'user-1' });
  mockDb.transaction.mockImplementation(async (callback: (transaction: typeof mockDb) => Promise<unknown>) => {
    const previous = store.operation ? { ...store.operation } : null;
    store.transactionDepth += 1;
    try {
      return await callback(mockDb);
    } catch (error) {
      store.operation = previous;
      throw error;
    } finally {
      store.transactionDepth -= 1;
    }
  });
  mockDb.select.mockImplementation(() => ({
    from: () => ({ where: () => ({ limit: async () => (store.operation ? [{ ...store.operation }] : []) }) }),
  }));
  mockDb.insert.mockReturnValue({
    values: (operation: OperationRow) => ({
      onConflictDoUpdate: async () => {
        store.operation = { ...operation };
      },
    }),
  });
  mockDb.update.mockReturnValue({
    set: (changes: Partial<OperationRow>) => ({
      where: async (predicate: unknown) => {
        const parameters = sqlParameters(predicate);
        if (store.operation && store.operation.ownerToken === parameters.at(-1))
          Object.assign(store.operation, changes);
      },
    }),
  });
});

function existingOperation(state = 'checking_checkout', expired = false): OperationRow {
  return {
    userId: 'user-1',
    state,
    operationId: 'operation-original',
    ownerToken: 'owner-original',
    leaseExpiresAt: new Date(Date.now() + (expired ? -1 : SUPPORT_OPERATION_LEASE_MS)),
    deletionIntent: state === 'deleting' ? intent : null,
  };
}

function runRead(
  perform: (snapshot: string, operationId: string) => Promise<string> = vi.fn(async () => 'network-result'),
  finish = vi.fn(async () => 'finished'),
) {
  return withSupportOperation('user-1', 'checking_checkout', async () => 'snapshot', perform, finish);
}

describe('persistent support operation coordination', () => {
  it('commits reservation before Stripe I/O and finalizes under a separate lock', async () => {
    const phases: number[] = [];
    const result = await withSupportOperation(
      'user-1',
      'checking_checkout',
      async () => {
        phases.push(store.transactionDepth);
        return 'snapshot';
      },
      async (snapshot, operationId) => {
        phases.push(store.transactionDepth);
        expect(snapshot).toBe('snapshot');
        expect(store.operation?.operationId).toBe(operationId);
        return 'network-result';
      },
      async (_transaction, snapshot, networkResult) => {
        phases.push(store.transactionDepth);
        expect(snapshot).toBe('snapshot');
        expect(networkResult).toBe('network-result');
        return 'finished';
      },
    );
    expect(result).toBe('finished');
    expect(phases).toEqual([1, 0, 1]);
    expect(lockAccount).toHaveBeenCalledTimes(2);
    expect(store.operation?.state).toBe('idle');
  });

  it('returns null for a missing account without any external operation', async () => {
    lockAccount.mockResolvedValue(null);
    const perform = vi.fn();
    expect(await runRead(perform)).toBeNull();
    expect(perform).not.toHaveBeenCalled();
  });

  it('rejects an active lease before invoking external work', async () => {
    store.operation = existingOperation();
    const perform = vi.fn();
    await expect(runRead(perform)).rejects.toMatchObject({ extensions: { code: 'SUPPORT_OPERATION_PENDING' } });
    expect(perform).not.toHaveBeenCalled();
  });

  it('recovers an expired read operation with a new operation identity', async () => {
    store.operation = existingOperation('reconciling', true);
    const perform = vi.fn(async (_snapshot: string, operationId: string) => {
      expect(operationId).not.toBe('operation-original');
      return 'network-result';
    });
    expect(await runRead(perform)).toBe('finished');
  });

  it('never lets a read operation replace expired deletion intent', async () => {
    store.operation = existingOperation('deleting', true);
    await expect(runRead()).rejects.toMatchObject({ extensions: { code: 'SUPPORT_OPERATION_PENDING' } });
    expect(store.operation.operationId).toBe('operation-original');
    expect(store.operation.deletionIntent).toEqual(intent);
  });

  it('resumes expired deletion with its original intent and Stripe key but a fresh owner', async () => {
    store.operation = existingOperation('deleting', true);
    await withSupportOperation(
      'user-1',
      'deleting',
      async (_transaction, priorIntent) => {
        expect(priorIntent).toEqual(intent);
        if (!priorIntent) throw new Error('Missing persisted deletion intent');
        return priorIntent;
      },
      async (_snapshot: SupportDeletionIntent, operationId: string) => {
        expect(operationId).toBe('operation-original');
        expect(store.operation?.ownerToken).not.toBe('owner-original');
        return undefined;
      },
      async () => undefined,
      { deletionIntent: () => ({ subscriptionId: 'different', removeSetterName: false }) },
    );
    expect(store.operation?.state).toBe('idle');
  });

  it('retains a new deletion intent and stable operation key after uncertain Stripe failure', async () => {
    await expect(
      withSupportOperation(
        'user-1',
        'deleting',
        async () => intent,
        async () => {
          throw new Error('Stripe timeout');
        },
        async () => undefined,
        { deletionIntent: (snapshot) => snapshot },
      ),
    ).rejects.toThrow('Stripe timeout');
    expect(store.operation?.state).toBe('deleting');
    expect(store.operation?.operationId).toBeTruthy();
    expect(store.operation?.deletionIntent).toEqual(intent);
    expect(store.operation?.leaseExpiresAt?.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('retains deletion intent when database finalization fails after Stripe succeeds', async () => {
    await expect(
      withSupportOperation(
        'user-1',
        'deleting',
        async () => intent,
        async () => undefined,
        async () => {
          throw new Error('Database failed');
        },
        { deletionIntent: (snapshot) => snapshot },
      ),
    ).rejects.toThrow('Database failed');
    expect(store.operation?.state).toBe('deleting');
    expect(store.operation?.deletionIntent).toEqual(intent);
    expect(store.operation?.operationId).toBeTruthy();
  });

  it('releases a failed read operation for immediate retry', async () => {
    await expect(
      runRead(async () => {
        throw new Error('Stripe timeout');
      }),
    ).rejects.toThrow('Stripe timeout');
    expect(store.operation?.state).toBe('idle');
    expect(store.operation?.ownerToken).toBeNull();
  });

  it('fences a stale owner without releasing a successor operation', async () => {
    const finish = vi.fn(async () => 'finished');
    const perform = vi.fn(async () => {
      store.operation = { ...store.operation!, ownerToken: 'new-owner' };
      return 'network-result';
    });
    await expect(runRead(perform, finish)).rejects.toMatchObject({ extensions: { code: 'SUPPORT_OPERATION_STALE' } });
    expect(finish).not.toHaveBeenCalled();
    expect(store.operation?.ownerToken).toBe('new-owner');
    expect(store.operation?.state).toBe('checking_checkout');
  });

  it('rejects expired read finalization, but permits the unchanged deletion owner', async () => {
    const expire = async () => {
      store.operation!.leaseExpiresAt = new Date(0);
      return 'network-result';
    };
    const finish = vi.fn(async () => 'finished');
    await expect(runRead(vi.fn(expire), finish)).rejects.toMatchObject({
      extensions: { code: 'SUPPORT_OPERATION_STALE' },
    });
    expect(finish).not.toHaveBeenCalled();
    expect(
      await withSupportOperation('user-1', 'deleting', async () => intent, expire, finish, {
        deletionIntent: (snapshot) => snapshot,
      }),
    ).toBe('finished');
  });
});
