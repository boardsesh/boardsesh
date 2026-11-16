// runPullWrite's ladder sizing, guard placement and telemetry (issue #5851).
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { OfflineDatabase, SqlExecutor } from '../../database';
import { getSqliteWriteSite, runGuardedPullWrite, runPullWrite, setPullWriteSettledReporter } from '../pull-write';

function lockError(): Error {
  return new Error(
    "Call to function 'NativeDatabase.execAsync' has been rejected.\n→ Caused by: Error code 5: database is locked",
  );
}

/**
 * A database whose first `lockedAttempts` transactions lose the lock at
 * `BEGIN IMMEDIATE`. Records each transaction's statements.
 */
function scriptedDatabase(lockedAttempts: number) {
  const transactions: string[][] = [];
  let remainingLocks = lockedAttempts;
  const db = {
    withExclusiveTransactionAsync: vi.fn(async (task: (txn: SqlExecutor) => Promise<void>) => {
      const statements: string[] = [];
      transactions.push(statements);
      const txn = {
        execAsync: vi.fn(async (sql: string) => {
          statements.push(sql);
          if (sql === 'BEGIN IMMEDIATE' && remainingLocks > 0) {
            remainingLocks -= 1;
            throw lockError();
          }
        }),
        runAsync: vi.fn(async (sql: string) => {
          statements.push(sql);
          return { changes: 1, lastInsertRowId: 0 };
        }),
        getFirstAsync: vi.fn(async () => null),
        getAllAsync: vi.fn(async () => []),
      } as unknown as SqlExecutor;
      await task(txn);
    }),
  } as unknown as OfflineDatabase;
  return { db, transactions };
}

afterEach(() => {
  setPullWriteSettledReporter(() => {})();
});

describe('runPullWrite (#5851)', () => {
  it('returns the task result and stays silent when the first attempt commits', async () => {
    const reporter = vi.fn();
    setPullWriteSettledReporter(reporter);
    const { db, transactions } = scriptedDatabase(0);

    await expect(runPullWrite(db, async () => 42, { site: 'test-site' })).resolves.toBe(42);

    expect(transactions).toHaveLength(1);
    expect(reporter).not.toHaveBeenCalled();
  });

  it('reports a contended write once, with its site, when a later attempt recovers it', async () => {
    const reporter = vi.fn();
    setPullWriteSettledReporter(reporter);
    const { db, transactions } = scriptedDatabase(1);

    await runPullWrite(db, async (txn) => void (await txn.runAsync('INSERT 1', [])), { site: 'deletions-coverage' });

    expect(transactions).toHaveLength(2);
    expect(reporter).toHaveBeenCalledTimes(1);
    expect(reporter).toHaveBeenCalledWith(
      expect.objectContaining({ site: 'deletions-coverage', sizing: 'background', attempts: 2, outcome: 'committed' }),
    );
  });

  it('leaves the site on the original error when the ladder gives up', async () => {
    const reporter = vi.fn();
    setPullWriteSettledReporter(reporter);
    const { db, transactions } = scriptedDatabase(99);

    const failure = await runPullWrite(db, async () => {}, { site: 'scope-complete' }).catch((error: unknown) => error);

    expect(transactions).toHaveLength(3);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('database is locked');
    expect(getSqliteWriteSite(failure)).toBe('scope-complete');
    expect(reporter).toHaveBeenCalledWith(expect.objectContaining({ site: 'scope-complete', outcome: 'exhausted' }));
  });

  it('does not report or tag a task that threw something other than a lost lock', async () => {
    const reporter = vi.fn();
    setPullWriteSettledReporter(reporter);
    const { db } = scriptedDatabase(0);
    const abort = new Error('aborted by a guard');

    await expect(
      runPullWrite(
        db,
        async () => {
          throw abort;
        },
        { site: 'pull-page' },
      ),
    ).rejects.toBe(abort);

    expect(reporter).not.toHaveBeenCalled();
    expect(getSqliteWriteSite(abort)).toBeNull();
  });

  it('reports a write that lost attempt 1 and then hit its own abort sentinel as aborted', async () => {
    // The teardown race the event exists for: attempt 1 waits out a removal and
    // loses; attempt 2 finds the scope gone and throws its sentinel. The last
    // error is that sentinel, not a lock, and the report must still go out.
    const reporter = vi.fn();
    setPullWriteSettledReporter(reporter);
    const { db } = scriptedDatabase(1);
    const sentinel = new Error('scope torn down');

    await expect(
      runPullWrite(
        db,
        async () => {
          throw sentinel;
        },
        { site: 'deletions-page' },
      ),
    ).rejects.toBe(sentinel);

    expect(reporter).toHaveBeenCalledTimes(1);
    expect(reporter).toHaveBeenCalledWith(
      expect.objectContaining({ site: 'deletions-page', attempts: 2, outcome: 'aborted' }),
    );
  });

  it('reports a write whose retry was refused by its guard as refused, not committed', async () => {
    const reporter = vi.fn();
    setPullWriteSettledReporter(reporter);
    const { db } = scriptedDatabase(1);

    const wrote = await runGuardedPullWrite(db, { site: 'scope-complete', canWrite: () => false }, async () => {});

    expect(wrote).toBe(false);
    expect(reporter).toHaveBeenCalledWith(
      expect.objectContaining({ site: 'scope-complete', attempts: 2, outcome: 'refused' }),
    );
  });

  it('sizes a foreground write for the tap: two attempts, 2.5 s then 1.5 s', async () => {
    const { db, transactions } = scriptedDatabase(99);

    await expect(
      runPullWrite(db, async () => {}, { site: 'bootstrap-retry-restore', sizing: 'foreground' }),
    ).rejects.toThrow('database is locked');

    expect(transactions.map((statements) => statements[0])).toEqual([
      'PRAGMA busy_timeout = 2500',
      'PRAGMA busy_timeout = 1500',
    ]);
  });
});

describe('runGuardedPullWrite (#5851)', () => {
  it('runs the guard after BEGIN IMMEDIATE, on every attempt, and writes nothing once it refuses', async () => {
    const { db, transactions } = scriptedDatabase(1);
    const canWrite = vi.fn(() => true);
    // The teardown lands while attempt 1 is waiting for the lock it then loses.
    canWrite.mockImplementationOnce(() => false);
    const task = vi.fn(async (txn: SqlExecutor) => void (await txn.runAsync('INSERT marker', [])));

    const wrote = await runGuardedPullWrite(db, { site: 'scope-complete', canWrite: () => canWrite() }, task);

    // Attempt 1 lost the lock before the guard ran; attempt 2 took it, asked, and was refused.
    expect(transactions).toHaveLength(2);
    expect(transactions[1]).toEqual(['PRAGMA busy_timeout = 5000', 'COMMIT', 'BEGIN IMMEDIATE']);
    expect(canWrite).toHaveBeenCalledTimes(1);
    expect(task).not.toHaveBeenCalled();
    expect(wrote).toBe(false);
  });

  it('resolves true once the task committed', async () => {
    const { db } = scriptedDatabase(0);

    await expect(
      runGuardedPullWrite(db, { site: 'user-data-complete', canWrite: () => true }, async () => {}),
    ).resolves.toBe(true);
  });
});
