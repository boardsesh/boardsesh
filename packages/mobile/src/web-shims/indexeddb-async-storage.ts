import type { AsyncStorage } from '@react-native-async-storage/async-storage';

// Browser-only AsyncStorage over raw IndexedDB, reached through the Expo web
// shim (`./async-storage`). It replaces the package's v3 web adapter, which
// caches one IDBDatabase per name forever and never retries. iOS Safari closes
// that connection or aborts its transactions around page suspension, and every
// later read then rejects with "Attempt to get a record from database without
// an in-progress transaction" or "The database connection is closing" until the
// page reloads (Sentry BOARDSESH-KA / KB / MZ, issue #5612).
//
// The on-disk layout matches the package byte for byte so rows it wrote are
// read as-is: database version 1, one object store `entries`, out-of-line
// string keys, `string | null` values written with `put(value, key)`.

const ENTRIES_STORE = 'entries';
const DATABASE_VERSION = 1;
// One first try plus one retry on a fresh connection. Every operation here is
// idempotent (get, put, delete, getAllKeys, clear), so repeating one is safe,
// as long as a retried write cannot land after a newer one (see `runInOrder`).
const DEFAULT_MAX_ATTEMPTS = 2;
// An open normally settles in milliseconds. WebKit can leave one pending with
// neither success nor error after the page resumes; without a bound, every
// caller would await that one request forever.
const DEFAULT_OPEN_TIMEOUT_MS = 5_000;

// What WebKit and Chromium raise when the connection or transaction died under
// us, rather than when the request itself is wrong. QuotaExceededError,
// DataError, ConstraintError and VersionError are deliberately absent: a fresh
// connection would fail the same way.
const RECOVERABLE_ERROR_NAMES = new Set([
  'InvalidStateError',
  'UnknownError',
  'TransactionInactiveError',
  'AbortError',
  // Our own open timeout; a fresh open request may still succeed.
  'TimeoutError',
]);

export type IndexedDbAsyncStorageOptions = {
  /** Injected for tests; defaults to the global `indexedDB`. */
  getFactory?: () => IDBFactory | undefined;
  /** Total attempts per operation, including the first. Defaults to 2. */
  maxAttempts?: number;
  /** How long one open may stay pending before it counts as failed. Defaults to 5 s. */
  openTimeoutMs?: number;
};

function defaultFactory(): IDBFactory | undefined {
  return typeof indexedDB === 'undefined' ? undefined : indexedDB;
}

function errorName(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('name' in error)) return undefined;
  return typeof error.name === 'string' ? error.name : undefined;
}

function isRecoverable(error: unknown): boolean {
  const name = errorName(error);
  return name !== undefined && RECOVERABLE_ERROR_NAMES.has(name);
}

function toStorageError(error: unknown): Error {
  const browserMessage =
    typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
      ? error.message
      : String(error);
  return new Error(`IndexedDB storage error: ${browserMessage}`, { cause: error });
}

export function createIndexedDbAsyncStorage(
  databaseName: string,
  options: IndexedDbAsyncStorageOptions = {},
): AsyncStorage {
  const getFactory = options.getFactory ?? defaultFactory;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;

  let pendingConnection: Promise<IDBDatabase> | null = null;
  let openConnection: IDBDatabase | null = null;
  // Settles once every write issued so far has finished its whole retry cycle,
  // whether it committed or failed for good.
  let earlierWritesSettled: Promise<void> = Promise.resolve();

  // Drops the cached connection, but only if it is still the one that failed:
  // a concurrent caller may already have opened a fresh one.
  function forgetConnection(database: IDBDatabase): void {
    if (openConnection !== database) return;
    openConnection = null;
    pendingConnection = null;
  }

  function discardConnection(database: IDBDatabase): void {
    forgetConnection(database);
    try {
      database.close();
    } catch {
      // Already closed; nothing left to release.
    }
  }

  function connect(): Promise<IDBDatabase> {
    if (pendingConnection) return pendingConnection;
    const factory = getFactory();
    if (!factory) return Promise.reject(new Error('IndexedDB is not available'));

    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = factory.open(databaseName, DATABASE_VERSION);
      } catch (error) {
        reject(error);
        return;
      }
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        reject(new DOMException('Opening the IndexedDB database timed out.', 'TimeoutError'));
      }, openTimeoutMs);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(ENTRIES_STORE)) {
          database.createObjectStore(ENTRIES_STORE);
        }
      };
      request.onsuccess = () => {
        clearTimeout(timeout);
        const database = request.result;
        if (timedOut) {
          // Nobody is waiting for this one any more; release it so it cannot
          // block another tab's upgrade.
          database.close();
          return;
        }
        // `close` fires when the browser closes the connection abnormally (the
        // iOS Safari suspension case). `versionchange` means another tab wants
        // to upgrade; step aside so it is not blocked, and reopen on next use.
        database.onclose = () => forgetConnection(database);
        database.onversionchange = () => discardConnection(database);
        if (pendingConnection === opening) openConnection = database;
        resolve(database);
      };
      request.onerror = () => {
        clearTimeout(timeout);
        reject(request.error ?? new Error('IndexedDB open failed'));
      };
    });

    pendingConnection = opening;
    // A failed open must not stay cached, or every later call reuses the failure.
    opening.catch(() => {
      if (pendingConnection === opening) pendingConnection = null;
    });
    return opening;
  }

  function runTransaction<TResult>(
    database: IDBDatabase,
    mode: IDBTransactionMode,
    issueRequests: (store: IDBObjectStore) => IDBRequest<TResult>[],
  ): Promise<TResult[]> {
    return new Promise<TResult[]>((resolve, reject) => {
      let transaction: IDBTransaction;
      let requests: IDBRequest<TResult>[];
      try {
        // Throws InvalidStateError synchronously when the connection is closing.
        transaction = database.transaction(ENTRIES_STORE, mode);
        requests = issueRequests(transaction.objectStore(ENTRIES_STORE));
      } catch (error) {
        reject(error);
        return;
      }

      let firstRequestError: DOMException | null = null;
      for (const request of requests) {
        request.onerror = () => {
          firstRequestError ??= request.error;
        };
      }
      const fail = () => {
        reject(
          firstRequestError ??
            transaction.error ??
            new DOMException('The IndexedDB transaction was aborted.', 'AbortError'),
        );
      };
      transaction.onerror = fail;
      transaction.onabort = fail;
      // Results are read only after commit, so a write that resolves is durable.
      transaction.oncomplete = () => resolve(requests.map((request) => request.result));
    });
  }

  async function withRecovery<TResult>(
    mode: IDBTransactionMode,
    issueRequests: (store: IDBObjectStore) => IDBRequest<TResult>[],
  ): Promise<TResult[]> {
    for (let attempt = 1; ; attempt += 1) {
      let database: IDBDatabase | null = null;
      try {
        database = await connect();
        return await runTransaction(database, mode, issueRequests);
      } catch (error) {
        const recoverable = isRecoverable(error);
        // Drop a dead connection even on the last attempt, so the next call
        // opens a fresh one instead of failing on the same handle.
        if (database && recoverable) discardConnection(database);
        if (attempt >= maxAttempts || !recoverable) throw toStorageError(error);
      }
    }
  }

  // IndexedDB runs overlapping transactions in the order they were created, but
  // a retry creates a new transaction after any call issued in the meantime. A
  // write that fails, reopens and retries would then overwrite a newer write to
  // the same key, and a read issued after a write would miss it. So each write
  // waits for every earlier write to settle, and each read waits for the writes
  // issued before it. Reads still run alongside each other.
  function runInOrder<TResult>(
    mode: IDBTransactionMode,
    issueRequests: (store: IDBObjectStore) => IDBRequest<TResult>[],
  ): Promise<TResult[]> {
    const operation = earlierWritesSettled.then(() => withRecovery(mode, issueRequests));
    if (mode === 'readwrite') {
      const ignoreOutcome = () => undefined;
      earlierWritesSettled = operation.then(ignoreOutcome, ignoreOutcome);
    }
    return operation;
  }

  async function readValues(keys: string[]): Promise<(string | null)[]> {
    const results = await runInOrder<unknown>('readonly', (store) => keys.map((key) => store.get(key)));
    return results.map((stored) => (typeof stored === 'string' ? stored : null));
  }

  async function writeValues(entries: [string, string][]): Promise<void> {
    await runInOrder('readwrite', (store) => entries.map(([key, value]) => store.put(value, key)));
  }

  async function deleteValues(keys: string[]): Promise<void> {
    await runInOrder('readwrite', (store) => keys.map((key) => store.delete(key)));
  }

  return {
    getItem: async (key) => {
      const [stored] = await readValues([key]);
      return stored ?? null;
    },
    setItem: (key, value) => writeValues([[key, value]]),
    removeItem: (key) => deleteValues([key]),
    getMany: async (keys) => {
      const values = await readValues(keys);
      const entries: Record<string, string | null> = {};
      keys.forEach((key, index) => {
        entries[key] = values[index] ?? null;
      });
      return entries;
    },
    setMany: (entries) => writeValues(Object.entries(entries)),
    removeMany: (keys) => deleteValues(keys),
    getAllKeys: async () => {
      const [storedKeys] = await runInOrder('readonly', (store) => [store.getAllKeys()]);
      // Keys are always written as strings; skip anything another writer put there.
      return (storedKeys ?? []).filter((storedKey): storedKey is string => typeof storedKey === 'string');
    },
    clear: async () => {
      await runInOrder('readwrite', (store) => [store.clear()]);
    },
  };
}
