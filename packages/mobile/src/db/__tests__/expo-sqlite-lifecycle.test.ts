import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import type { SQLiteDatabase } from 'expo-sqlite';
import { runLocalWriteWithRetry } from '@boardsesh/offline-sync';
import { describe, expect, it, vi } from 'vitest';

const retainedOpen = vi.hoisted(() => vi.fn());
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: retainedOpen }));
vi.mock('../../lib/error-reporting', () => ({ reportError: vi.fn() }));

import { retainDatabaseConnection, resetConnectionRetentionForTests } from '../connection-retention';

// Execute the installed dependency, including its real statement/result helpers.
// Removing only ESM declarations avoids React Native's Flow entrypoint in Node;
// the injected bindings replace the native boundary, never the database logic.
const require = createRequire(import.meta.url);
const sqliteBuildDirectory = join(dirname(require.resolve('expo-sqlite/package.json')), 'build');

function loadInstalledModule(
  filename: string,
  bindings: Record<string, unknown>,
  exports: string[],
): Record<string, unknown> {
  const source = readFileSync(join(sqliteBuildDirectory, filename), 'utf8')
    .replace(/^import\s[\s\S]*?;\s*$/gm, '')
    .replace(/^export\s/gm, '');
  return runInNewContext(`${source}\n;({ ${exports.join(', ')} });`, bindings, { filename }) as Record<string, unknown>;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

type Stage = 'prepare' | 'execute' | 'finalize';
type FixtureOptions = {
  pauseAt?: Stage;
  prepareError?: unknown;
  executeError?: unknown;
  readError?: unknown;
  finalizeError?: unknown;
  rollbackError?: unknown;
  closeError?: unknown;
};

function fixture(options: FixtureOptions = {}) {
  const enteredPause = deferred();
  const resume = deferred();
  const events: string[] = [];
  let references = 0;
  let freed = false;

  async function stage(name: Stage): Promise<void> {
    events.push(name);
    if (options.pauseAt === name) {
      enteredPause.resolve();
      await resume.promise;
    }
    if (freed) throw new Error(`${name} accessed a closed native connection`);
  }

  const finalize = vi.fn(async (): Promise<void> => {
    await stage('finalize');
    if (options.finalizeError !== undefined) throw options.finalizeError;
  });
  class NativeStatement {
    finalizeAsync = finalize;
    async runAsync(): Promise<{ lastInsertRowId: number; changes: number; firstRowValues: number[] }> {
      await stage('execute');
      if (options.executeError !== undefined) throw options.executeError;
      return { lastInsertRowId: 1, changes: 1, firstRowValues: [1] };
    }
    async getColumnNamesAsync(): Promise<string[]> {
      if (options.readError !== undefined) throw options.readError;
      return ['id'];
    }
    async getAllAsync(): Promise<number[][]> {
      return [[2]];
    }
    async stepAsync(): Promise<null> {
      return null;
    }
  }

  const close = vi.fn(async (): Promise<void> => {
    events.push('close');
    references -= 1;
    if (references === 0) freed = true;
    if (options.closeError !== undefined) throw options.closeError;
  });
  const exec = vi.fn(async (source: string): Promise<void> => {
    events.push(source);
    if (freed) throw new Error('exec accessed a closed native connection');
    if (source === 'ROLLBACK' && options.rollbackError !== undefined) throw options.rollbackError;
  });
  const closeSync = vi.fn((): void => {
    references -= 1;
    if (references === 0) freed = true;
  });
  class NativeDatabase {
    constructor() {
      references += 1;
    }
    async initAsync(): Promise<void> {}
    closeAsync = close;
    closeSync = closeSync;
    execAsync = exec;
    async prepareAsync(): Promise<void> {
      await stage('prepare');
      if (options.prepareError !== undefined) throw options.prepareError;
    }
  }

  const parameterBindings = loadInstalledModule('paramUtils.js', {}, ['composeRow', 'composeRows', 'normalizeParams']);
  const statementBindings = loadInstalledModule('SQLiteStatement.js', parameterBindings, ['SQLiteStatement']);
  const { SQLiteDatabase: InstalledDatabase } = loadInstalledModule(
    'SQLiteDatabase.js',
    {
      ...statementBindings,
      Platform: { OS: 'android' },
      ExpoSQLite: { NativeStatement, NativeDatabase },
      flattenOpenOptions: (openOptions: unknown) => openOptions,
      unregisterDatabaseForDevToolsAsync: vi.fn(),
      registerDatabaseForDevToolsAsync: vi.fn(),
    },
    ['SQLiteDatabase'],
  );
  const DatabaseConstructor = InstalledDatabase as new (
    path: string,
    openOptions: Record<string, unknown>,
    native: NativeDatabase,
  ) => SQLiteDatabase;
  function openWrapper(): SQLiteDatabase {
    return new DatabaseConstructor('/data/boardsesh.db', {}, new NativeDatabase());
  }

  return {
    database: openWrapper(),
    openWrapper,
    enteredPause: enteredPause.promise,
    resume: resume.resolve,
    events,
    finalize,
    close,
    closeSync,
    exec,
    isFreed: () => freed,
  };
}

// Give an incorrectly immediate native close enough microtasks to become visible,
// without a clock-dependent delay or touching the operation's stage gates.
async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function returnIterator(iterator: AsyncIterableIterator<unknown>): Promise<IteratorResult<unknown>> {
  if (iterator.return === undefined) throw new Error('SQLite iterator must support cleanup through return()');
  return iterator.return();
}

function runHelper(
  database: SQLiteDatabase,
  helper: 'runAsync' | 'getFirstAsync' | 'getAllAsync',
  source: string,
): Promise<unknown> {
  if (helper === 'runAsync') return database.runAsync(source);
  if (helper === 'getFirstAsync') return database.getFirstAsync(source);
  return database.getAllAsync(source);
}

describe('installed expo-sqlite async connection lifetime', () => {
  it.each<Stage>(['prepare', 'execute', 'finalize'])(
    'drains a query paused during %s before closing',
    async (pauseAt) => {
      const native = fixture({ pauseAt });
      const query = native.database.runAsync('INSERT INTO ticks DEFAULT VALUES');
      // Observe rejection immediately, including on the unpatched dependency.
      const observedQuery = query.then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      await native.enteredPause;
      const closing = native.database.closeAsync();
      await flushMicrotasks();
      const closeCallsBeforeResume = native.close.mock.calls.length;
      native.resume();
      const outcome = await observedQuery;
      await closing;

      expect(closeCallsBeforeResume).toBe(0);
      expect(outcome).toMatchObject({ result: { changes: 1 } });
      expect(native.events).toEqual(['prepare', 'execute', 'finalize', 'close']);
      expect(native.finalize).toHaveBeenCalledTimes(1);
    },
  );

  it('shares one close promise and releases its native reference once', async () => {
    const native = fixture();
    const firstClose = native.database.closeAsync();
    const secondClose = native.database.closeAsync();
    await Promise.all([firstClose, secondClose]);

    expect(secondClose).toBe(firstClose);
    expect(native.close).toHaveBeenCalledTimes(1);
    await native.database.closeAsync();
    expect(native.close).toHaveBeenCalledTimes(1);
  });

  it('rejects new helpers as soon as close begins', async () => {
    const native = fixture({ pauseAt: 'finalize' });
    const admittedQuery = native.database.runAsync('INSERT INTO ticks DEFAULT VALUES');
    const observedQuery = admittedQuery.catch((error: unknown) => error);
    await native.enteredPause;
    const closing = native.database.closeAsync();
    const rejectedQueries = [
      native.database.runAsync('INSERT INTO ticks DEFAULT VALUES'),
      native.database.getFirstAsync('SELECT id FROM ticks'),
      native.database.getAllAsync('SELECT id FROM ticks'),
      native.database.getEachAsync('SELECT id FROM ticks').next(),
      Promise.resolve().then(() => native.database.execAsync('DELETE FROM ticks')),
    ];
    const outcomes = Promise.allSettled(rejectedQueries);
    native.resume();
    const results = await outcomes;
    await observedQuery;
    await closing;

    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(native.events.filter((event) => event === 'prepare')).toHaveLength(1);
    expect(native.exec).not.toHaveBeenCalled();
  });

  it('keeps a shared native connection alive until both wrappers drain', async () => {
    const native = fixture({ pauseAt: 'finalize' });
    const secondWrapper = native.openWrapper();
    const query = native.database.runAsync('INSERT INTO ticks DEFAULT VALUES');
    const observedQuery = query.catch((error: unknown) => error);
    await native.enteredPause;
    await secondWrapper.closeAsync();
    const closing = native.database.closeAsync();
    await flushMicrotasks();
    const freedBeforeFinalize = native.isFreed();
    native.resume();
    await observedQuery;
    await closing;

    expect(freedBeforeFinalize).toBe(false);
    expect(native.isFreed()).toBe(true);
    expect(native.events).toEqual(['prepare', 'execute', 'finalize', 'close', 'close']);
  });

  it('drains an iterator finalizer after an early return', async () => {
    const native = fixture({ pauseAt: 'finalize' });
    const iterator = native.database.getEachAsync<{ id: number }>('SELECT id FROM ticks');
    expect(await iterator.next()).toMatchObject({ done: false, value: { id: 1 } });
    const iteratorReturn = returnIterator(iterator);
    const observedReturn = iteratorReturn.catch((error: unknown) => error);
    await native.enteredPause;
    const closing = native.database.closeAsync();
    await flushMicrotasks();
    const closeCallsBeforeResume = native.close.mock.calls.length;
    native.resume();
    await observedReturn;
    await closing;

    expect(closeCallsBeforeResume).toBe(0);
    expect(native.finalize).toHaveBeenCalledTimes(1);
    expect(native.events.at(-1)).toBe('close');
  });

  it('keeps a yielded iterator alive until its caller returns it', async () => {
    const native = fixture();
    const iterator = native.database.getEachAsync('SELECT id FROM ticks');
    await iterator.next();
    const closing = native.database.closeAsync();
    await flushMicrotasks();
    const closeCallsWhileYielded = native.close.mock.calls.length;
    const observedReturn = await returnIterator(iterator).catch((error: unknown) => error);
    await closing;

    expect(closeCallsWhileYielded).toBe(0);
    expect(observedReturn).toMatchObject({ done: true });
    expect(native.finalize).toHaveBeenCalledTimes(1);
  });

  it('protects provider-owned work even when the process-lifetime retain fails', async () => {
    resetConnectionRetentionForTests();
    retainedOpen.mockRejectedValueOnce(new Error('retention open failed'));
    expect(await retainDatabaseConnection()).toBeNull();
    const native = fixture({ pauseAt: 'finalize' });
    const observedQuery = native.database.runAsync('INSERT INTO ticks DEFAULT VALUES').catch((error: unknown) => error);
    await native.enteredPause;
    // SQLiteProvider teardown has only its original reference in this failure path.
    const closing = native.database.closeAsync();
    await flushMicrotasks();
    const freedBeforeCleanup = native.isFreed();
    native.resume();
    await observedQuery;
    await closing;

    expect(freedBeforeCleanup).toBe(false);
    expect(native.events).toEqual(['prepare', 'execute', 'finalize', 'close']);
    resetConnectionRetentionForTests();
  });

  it('drains an exclusive transaction through subsequent work and its own close', async () => {
    const native = fixture();
    const enteredTask = deferred();
    const resumeTask = deferred();
    const transaction = native.database.withExclusiveTransactionAsync(async (transactionDatabase) => {
      enteredTask.resolve();
      await resumeTask.promise;
      await transactionDatabase.runAsync('INSERT INTO ticks DEFAULT VALUES');
    });
    const observedTransaction = transaction.then(
      () => 'committed',
      (error: unknown) => error,
    );
    await enteredTask.promise;
    const closing = native.database.closeAsync();
    await flushMicrotasks();
    const closeCallsWhileTaskActive = native.close.mock.calls.length;
    resumeTask.resolve();
    const outcome = await observedTransaction;
    await closing;

    expect(closeCallsWhileTaskActive).toBe(0);
    expect(outcome).toBe('committed');
    expect(native.events).toEqual(['BEGIN', 'prepare', 'execute', 'finalize', 'COMMIT', 'close', 'close']);
  });

  it('drains a failing exclusive transaction before closing its parent connection', async () => {
    const taskError = new Error('database is locked during tick write');
    const rollbackError = new Error('rollback failed');
    const nativeCloseError = new Error('native close failed');
    const native = fixture({ rollbackError, closeError: nativeCloseError });
    const enteredTask = deferred();
    const resumeTask = deferred();
    const transaction = native.database.withExclusiveTransactionAsync(async () => {
      enteredTask.resolve();
      await resumeTask.promise;
      throw taskError;
    });
    const observedTransaction = transaction.catch((error: unknown) => error);

    await enteredTask.promise;
    const closing = native.database.closeAsync();
    const observedClose = closing.catch((error: unknown) => error);
    await flushMicrotasks();
    const closeCallsWhileTaskActive = native.close.mock.calls.length;
    resumeTask.resolve();
    const outcome = await observedTransaction;
    const parentCloseOutcome = await observedClose;

    expect(closeCallsWhileTaskActive).toBe(0);
    expect(outcome).toBe(taskError);
    expect(taskError).toMatchObject({ sqliteCleanupErrors: [rollbackError, nativeCloseError] });
    expect(parentCloseOutcome).toBe(nativeCloseError);
    expect(native.events).toEqual(['BEGIN', 'ROLLBACK', 'close', 'close']);
    expect(native.close).toHaveBeenCalledTimes(2);
  });

  it('refuses synchronous close while async cleanup is pending', async () => {
    const native = fixture({ pauseAt: 'finalize' });
    const observedQuery = native.database.runAsync('INSERT INTO ticks DEFAULT VALUES').catch((error: unknown) => error);
    await native.enteredPause;
    let closeError: unknown;
    try {
      native.database.closeSync();
    } catch (error) {
      closeError = error;
    }
    native.resume();
    await observedQuery;

    expect(String(closeError)).toMatch(/async|active|pending|progress/i);
    expect(native.closeSync).not.toHaveBeenCalled();
    await native.database.closeAsync();
    expect(native.finalize).toHaveBeenCalledTimes(1);
  });

  it('allows an admitted transaction to roll back when its callback loses admission', async () => {
    const native = fixture();
    const enteredTask = deferred();
    const resumeTask = deferred();
    const transaction = native.database.withTransactionAsync(async () => {
      enteredTask.resolve();
      await resumeTask.promise;
      await native.database.runAsync('INSERT INTO ticks DEFAULT VALUES');
    });
    const observedTransaction = transaction.catch((error: unknown) => error);
    await enteredTask.promise;
    const closing = native.database.closeAsync();
    await flushMicrotasks();
    const closeCallsBeforeTaskResumes = native.close.mock.calls.length;
    resumeTask.resolve();
    const failure = await observedTransaction;
    await closing;

    expect(closeCallsBeforeTaskResumes).toBe(0);
    expect(String(failure)).toMatch(/closing|closed/i);
    expect(native.events).toEqual(['BEGIN', 'ROLLBACK', 'close']);
    expect(native.finalize).not.toHaveBeenCalled();
  });
});

describe('installed expo-sqlite failure precedence', () => {
  it('releases admission after prepare fails without finalizing an unprepared statement', async () => {
    const prepareError = new Error('syntax error in tick write');
    const native = fixture({ prepareError });

    await expect(native.database.runAsync('INSERT invalid')).rejects.toBe(prepareError);
    await native.database.closeAsync();
    expect(native.events).toEqual(['prepare', 'close']);
    expect(native.finalize).not.toHaveBeenCalled();
  });

  it('preserves an execution lock error when finalization also fails', async () => {
    const cause = new Error('native write failed');
    const executeError = Object.assign(new Error('database is locked'), { cause });
    const finalizeError = new Error('finalization failed');
    const native = fixture({ executeError, finalizeError });

    await expect(native.database.runAsync('INSERT INTO ticks DEFAULT VALUES')).rejects.toBe(executeError);
    expect(executeError).toMatchObject({ cause, sqliteCleanupErrors: [finalizeError] });
    expect(native.finalize).toHaveBeenCalledTimes(1);
  });

  it.each([null, false, Object.freeze(new Error('frozen execution failure'))])(
    'preserves an execution failure that cannot accept diagnostic properties: %s',
    async (executeError) => {
      const native = fixture({ executeError, finalizeError: new Error('finalization failed') });

      await expect(native.database.runAsync('INSERT INTO ticks DEFAULT VALUES')).rejects.toBe(executeError);
      expect(native.finalize).toHaveBeenCalledTimes(1);
      await native.database.closeAsync();
    },
  );

  it('preserves a revoked proxy failure when diagnostic attachment throws', async () => {
    const { proxy, revoke } = Proxy.revocable(new Error('revoked execution failure'), {});
    revoke();
    const native = fixture({ executeError: proxy, finalizeError: new Error('finalization failed') });
    const preservedOriginal = native.database.runAsync('INSERT INTO ticks DEFAULT VALUES').then(
      () => false,
      (error: unknown) => Object.is(error, proxy),
    );

    // Do not hand the revoked proxy to assertion formatters that inspect objects.
    await expect(preservedOriginal).resolves.toBe(true);
    expect(native.finalize).toHaveBeenCalledTimes(1);
    await native.database.closeAsync();
  });

  it.each(['getFirstAsync', 'getAllAsync'] as const)(
    'preserves a %s read failure when finalization also fails',
    async (helper) => {
      const readError = new Error('database is locked while reading');
      const native = fixture({ readError, finalizeError: new Error('finalization failed') });

      await expect(runHelper(native.database, helper, 'SELECT id FROM ticks')).rejects.toBe(readError);
      expect(native.finalize).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves a cursor failure when iterator cleanup also fails', async () => {
    const readError = new Error('cursor failed');
    const native = fixture({ readError, finalizeError: new Error('finalization failed') });

    await expect(native.database.getEachAsync('SELECT id FROM ticks').next()).rejects.toBe(readError);
    expect(native.finalize).toHaveBeenCalledTimes(1);
  });

  it.each(['runAsync', 'getFirstAsync', 'getAllAsync'] as const)(
    'reports finalization failure after a successful %s, including a RETURNING row',
    async (helper) => {
      const finalizeError = new Error('database is locked at commit');
      const native = fixture({ finalizeError });

      await expect(runHelper(native.database, helper, 'UPDATE ticks SET sent = 1 RETURNING id')).rejects.toBe(
        finalizeError,
      );
      expect(native.finalize).toHaveBeenCalledTimes(1);
      await native.database.closeAsync();
      expect(native.events.at(-1)).toBe('close');
    },
  );

  it('retains a transaction task error when both rollback and close fail', async () => {
    const taskError = new Error('database is locked during tick write');
    const rollbackError = new Error('rollback failed');
    const closeError = new Error('close failed');
    const native = fixture({ rollbackError, closeError });

    await expect(
      native.database.withExclusiveTransactionAsync(async () => {
        throw taskError;
      }),
    ).rejects.toBe(taskError);
    expect(taskError).toMatchObject({ sqliteCleanupErrors: [rollbackError, closeError] });
    expect(native.events).toEqual(['BEGIN', 'ROLLBACK', 'close']);
    expect(native.close).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, null, false])('preserves a transaction task throwing %s', async (taskError) => {
    const native = fixture({ rollbackError: new Error('rollback failed'), closeError: new Error('close failed') });

    await expect(
      native.database.withExclusiveTransactionAsync(async () => {
        throw taskError;
      }),
    ).rejects.toBe(taskError);
    expect(native.events).toEqual(['BEGIN', 'ROLLBACK', 'close']);
  });

  it('keeps a failed close single-flight rather than decrementing again', async () => {
    const closeError = new Error('native close failed');
    const native = fixture({ closeError });
    await expect(native.database.closeAsync()).rejects.toBe(closeError);
    await expect(native.database.closeAsync()).rejects.toBe(closeError);
    expect(native.close).toHaveBeenCalledTimes(1);
  });
});

describe('installed expo-sqlite with the existing write retry ladder', () => {
  it('retries the original lock failure when cleanup reports a different error', async () => {
    const executeError = new Error('Error code 5: database is locked');
    const nativeOptions: FixtureOptions = { executeError, finalizeError: new Error('statement cleanup failed') };
    const native = fixture(nativeOptions);
    const onSettled = vi.fn();

    const result = await runLocalWriteWithRetry(
      () => native.database.runAsync('INSERT OR IGNORE INTO ticks VALUES (1)'),
      {
        onSettled,
        sleep: async () => {
          delete nativeOptions.executeError;
          delete nativeOptions.finalizeError;
        },
      },
    );

    expect(result.changes).toBe(1);
    expect(native.finalize).toHaveBeenCalledTimes(2);
    expect(onSettled).toHaveBeenCalledWith(
      expect.objectContaining({ error: executeError, attempts: 2, recovered: true }),
    );
    await native.database.closeAsync();
  });

  it('propagates the lock failure after the operation retry budget is exhausted', async () => {
    const executeError = new Error('Error code 5: database is locked');
    const native = fixture({ executeError, finalizeError: new Error('statement cleanup failed') });

    await expect(
      runLocalWriteWithRetry(() => native.database.runAsync('INSERT OR IGNORE INTO ticks VALUES (1)'), {
        maxAttempts: 2,
        sleep: async () => {},
      }),
    ).rejects.toBe(executeError);
    expect(native.finalize).toHaveBeenCalledTimes(2);
    await native.database.closeAsync();
  });

  it('does not retry a disk failure even when its cleanup reports a lock', async () => {
    const executeError = new Error('Error code 13: database or disk is full');
    const native = fixture({ executeError, finalizeError: new Error('Error code 5: database is locked') });
    const sleep = vi.fn(async () => {});

    await expect(
      runLocalWriteWithRetry(() => native.database.runAsync('INSERT OR IGNORE INTO ticks VALUES (1)'), { sleep }),
    ).rejects.toBe(executeError);
    expect(sleep).not.toHaveBeenCalled();
    expect(native.finalize).toHaveBeenCalledTimes(1);
    await native.database.closeAsync();
  });
});
