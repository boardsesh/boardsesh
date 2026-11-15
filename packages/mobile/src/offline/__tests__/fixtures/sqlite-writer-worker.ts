import { Worker } from 'node:worker_threads';
import type { OfflineDatabase, SqlExecutor, SqlRunResult, SqlValue } from '@boardsesh/offline-sync';
import { createTestDatabase } from '@boardsesh/offline-sync/testing';

function deferred<Result>() {
  let resolve!: (result: Result) => void;
  return {
    promise: new Promise<Result>((complete) => {
      resolve = complete;
    }),
    resolve: (result: Result) => resolve(result),
  };
}
const workerSource = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const database = new DatabaseSync(workerData.location);
parentPort.on('message', ({ id, method, source, params }) => {
  const lockStarted = source === 'BEGIN IMMEDIATE' ? Date.now() : undefined;
  try {
    let result;
    if (method === 'close') { database.close(); parentPort.postMessage({ id, result: null }); return; }
    if (method === 'exec') {
      const lock = source === 'BEGIN IMMEDIATE';
      if (lock) parentPort.postMessage({ kind: 'waiting' });
      const started = Date.now();
      database.exec(workerData.busyTimeoutMs !== undefined && source.startsWith('PRAGMA busy_timeout') ? 'PRAGMA busy_timeout=' + workerData.busyTimeoutMs : source);
      if (lock) parentPort.postMessage({ kind: 'acquired', elapsed: Date.now() - started });
      result = null;
    } else {
      const statement = database.prepare(source);
      if (method === 'run') {
        const execution = statement.run(...params);
        result = { changes: Number(execution.changes), lastInsertRowId: Number(execution.lastInsertRowid) };
      } else if (method === 'first') result = statement.get(...params) ?? null;
      else result = statement.all(...params);
    }
    parentPort.postMessage({ id, result, source });
  } catch (error) { if (lockStarted !== undefined) parentPort.postMessage({ kind: 'lock-failed', elapsed: Date.now() - lockStarted }); parentPort.postMessage({ id, error: { message: error.message, code: error.code } }); }
});
`;

/** Real SQLite runs on the transaction worker so the host's actual auth manager
 * remains responsive while BEGIN IMMEDIATE waits on a separate held writer. */
export function createWriterWorkerDatabase(location: string, busyTimeoutMs?: number) {
  const reads = createTestDatabase(location);
  const worker = new Worker(workerSource, { eval: true, workerData: { location, busyTimeoutMs } });
  const waiting = deferred<void>();
  const acquired = deferred<number>();
  const lockFailed = deferred<number>();
  let sequence = 0;
  let pause:
    | { pattern: RegExp; reached: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>> }
    | undefined;
  const requests = new Map<number, { resolve: (result: unknown) => void; reject: (error: unknown) => void }>();
  worker.on(
    'message',
    async (message: {
      kind?: string;
      elapsed?: number;
      id: number;
      result?: unknown;
      source?: string;
      error?: { message: string; code?: string };
    }) => {
      if (message.kind === 'waiting') {
        waiting.resolve();
        return;
      }
      if (message.kind === 'lock-failed') {
        lockFailed.resolve(message.elapsed!);
        return;
      }
      if (message.kind === 'acquired') {
        acquired.resolve(message.elapsed!);
        return;
      }
      const request = requests.get(message.id);
      if (!request) return;
      requests.delete(message.id);
      if (message.error) {
        request.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
        return;
      }
      if (pause && message.source && pause.pattern.test(message.source)) {
        const current = pause;
        pause = undefined;
        current.reached.resolve();
        await current.release.promise;
      }
      request.resolve(message.result);
    },
  );
  worker.on('error', (error) => {
    for (const request of requests.values()) request.reject(error);
    requests.clear();
  });
  const call = (method: string, source = '', params: SqlValue[] = []): Promise<unknown> => {
    const id = ++sequence;
    const promise = new Promise<unknown>((resolve, reject) => {
      requests.set(id, { resolve, reject });
    });
    worker.postMessage({ id, method, source, params });
    return promise;
  };
  const transaction: SqlExecutor = {
    execAsync: async (source) => {
      await call('exec', source);
    },
    runAsync: async (source: string, ...parameters: (SqlValue | SqlValue[])[]): Promise<SqlRunResult> =>
      call('run', source, normalize(parameters)) as Promise<SqlRunResult>,
    getFirstAsync: async <Result>(source: string, ...parameters: (SqlValue | SqlValue[])[]) =>
      call('first', source, normalize(parameters)) as Promise<Result | null>,
    getAllAsync: async <Result>(source: string, ...parameters: (SqlValue | SqlValue[])[]) =>
      call('all', source, normalize(parameters)) as Promise<Result[]>,
  };
  const db: OfflineDatabase = {
    execAsync: (source) => reads.execAsync(source),
    runAsync: (source: string, ...parameters: (SqlValue | SqlValue[])[]) =>
      reads.runAsync(source, normalize(parameters)),
    getFirstAsync: <Result>(source: string, ...parameters: (SqlValue | SqlValue[])[]) =>
      reads.getFirstAsync<Result>(source, normalize(parameters)),
    getAllAsync: <Result>(source: string, ...parameters: (SqlValue | SqlValue[])[]) =>
      reads.getAllAsync<Result>(source, normalize(parameters)),
    async withExclusiveTransactionAsync(task) {
      await transaction.execAsync('BEGIN');
      try {
        await task(transaction);
        await transaction.execAsync('COMMIT');
      } catch (error) {
        await transaction.execAsync('ROLLBACK');
        throw error;
      }
    },
  };
  return {
    db,
    waiting: waiting.promise,
    acquired: acquired.promise,
    lockFailed: lockFailed.promise,
    pauseAfter(pattern: RegExp) {
      const current = { pattern, reached: deferred<void>(), release: deferred<void>() };
      pause = current;
      return { reached: current.reached.promise, release: () => current.release.resolve() };
    },
    async close() {
      await call('close');
      await worker.terminate();
      reads.close();
    },
  };
}
function normalize(parameters: (SqlValue | SqlValue[])[]): SqlValue[] {
  return parameters.length === 1 && Array.isArray(parameters[0]) ? parameters[0] : (parameters as SqlValue[]);
}
