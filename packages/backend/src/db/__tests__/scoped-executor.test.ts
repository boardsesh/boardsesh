import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const fixtures = vi.hoisted(() => {
  vi.resetModules();
  const primary = { select: vi.fn(() => 'primary'), transaction: vi.fn() };
  const replica = { select: vi.fn(() => 'replica') };
  return { primary, replica, warn: vi.fn() };
});

vi.mock('@boardsesh/db/client', () => ({
  createDb: () => fixtures.primary,
  createReadDb: () => fixtures.replica,
}));
vi.mock('../../utils/logger', () => ({ logger: { warn: fixtures.warn } }));

import { db, dbRead, deferDatabaseEffect, runWithDatabaseTransaction, type Database } from '../client';
import { afterCommit, transactionWithAfterCommit } from '../after-commit';

describe('delegated transaction scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixtures.primary.transaction.mockImplementation(async (work: (executor: Database) => Promise<unknown>) => {
      function executorAtDepth(depth: number): Database {
        return {
          select: () => (depth === 0 ? 'transaction' : `savepoint-${depth}`),
          transaction: async (nested: (nestedExecutor: Database) => Promise<unknown>) =>
            nested(executorAtDepth(depth + 1)),
        } as unknown as Database;
      }
      return work(executorAtDepth(0));
    });
  });

  it('leaves ordinary requests on their original primary and replica', () => {
    expect(db.select()).toBe('primary');
    expect(dbRead.select()).toBe('replica');
  });

  it('uses one transaction for resolver reads, writes, and nested savepoints', async () => {
    const results = await runWithDatabaseTransaction(async () => [
      db.select(),
      dbRead.select(),
      await db.transaction(async () => db.select()),
      await runWithDatabaseTransaction(async () => dbRead.select()),
    ]);
    expect(results).toEqual(['transaction', 'transaction', 'savepoint-1', 'transaction']);
    expect(fixtures.primary.transaction).toHaveBeenCalledTimes(1);
    expect(dbRead.select()).toBe('replica');
  });

  it('isolates concurrent delegated and ordinary requests', async () => {
    let resume: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const delegated = runWithDatabaseTransaction(async () => {
      await waiting;
      return dbRead.select();
    });
    expect(db.select()).toBe('primary');
    expect(dbRead.select()).toBe('replica');
    resume?.();
    expect(await delegated).toBe('transaction');
  });

  it('starts the requested snapshot before work and refuses a nested isolation change', async () => {
    const incompatibleWork = vi.fn();
    await runWithDatabaseTransaction(
      async () => {
        await runWithDatabaseTransaction(async () => expect(db.select()).toBe('transaction'), {
          isolationLevel: 'repeatable read',
        });
        await expect(
          runWithDatabaseTransaction(incompatibleWork, { isolationLevel: 'read committed' }),
        ).rejects.toThrow('existing isolation level');
      },
      { isolationLevel: 'repeatable read' },
    );
    expect(incompatibleWork).not.toHaveBeenCalled();
    expect(fixtures.primary.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'repeatable read',
    });
  });

  it('routes deeper resolver transactions to their own savepoint handle', async () => {
    await runWithDatabaseTransaction(async () => {
      await db.transaction(async () => {
        expect(db.select()).toBe('savepoint-1');
        await db.transaction(async () => {
          expect(dbRead.select()).toBe('savepoint-2');
        });
        expect(db.select()).toBe('savepoint-1');
      });
      expect(db.select()).toBe('transaction');
    });
  });

  it('runs deferred effects only after the actual outer commit', async () => {
    const order: string[] = [];
    const original = fixtures.primary.transaction.getMockImplementation()!;
    fixtures.primary.transaction.mockImplementation(async (work: (executor: Database) => Promise<unknown>) => {
      const result = await original(work);
      order.push('committed');
      return result;
    });
    await runWithDatabaseTransaction(async () => {
      await deferDatabaseEffect(() => {
        order.push('notification');
      });
      await transactionWithAfterCommit(async (transaction) => {
        afterCommit(transaction, () => {
          order.push('report event');
        });
        order.push('savepoint');
      });
      expect(order).toEqual(['savepoint']);
    });
    expect(order).toEqual(['savepoint', 'committed', 'notification', 'report event']);
  });

  it('drops every effect if execution or commit fails', async () => {
    const effect = vi.fn();
    await expect(
      runWithDatabaseTransaction(async () => {
        await deferDatabaseEffect(effect);
        await transactionWithAfterCommit(async (transaction) => {
          afterCommit(transaction, effect);
        });
        throw new Error('permission changed');
      }),
    ).rejects.toThrow('permission changed');
    expect(effect).not.toHaveBeenCalled();
    expect(db.select()).toBe('primary');
  });

  it('never gives escaped background work a completed transaction handle', async () => {
    let resume: (() => void) | undefined;
    let escaped: Promise<unknown> | undefined;
    await runWithDatabaseTransaction(async () => {
      const waiting = new Promise<void>((resolve) => {
        resume = resolve;
      });
      escaped = waiting.then(() => db.select());
    });
    resume?.();
    expect(await escaped).toBe('primary');
  });

  it('discards failed savepoint effects even when the caller catches the failure', async () => {
    const discarded = vi.fn();
    const committed = vi.fn();
    await runWithDatabaseTransaction(async () => {
      try {
        await db.transaction(async () => {
          await deferDatabaseEffect(discarded);
          throw new Error('savepoint refused');
        });
      } catch {
        await deferDatabaseEffect(committed);
      }
    });
    expect(discarded).not.toHaveBeenCalled();
    expect(committed).toHaveBeenCalledOnce();
  });

  it('does not report a committed write as failed when a notification fails', async () => {
    const result = await runWithDatabaseTransaction(async () => {
      await deferDatabaseEffect(() => {
        throw new Error('private notification contents');
      });
      return 'saved';
    });
    expect(result).toBe('saved');
    expect(fixtures.warn).toHaveBeenCalledWith('Delegated database effect failed after commit', { errorName: 'Error' });
  });
});
