import { describe, expect, it } from 'vitest';
import { createIndexedDbAsyncStorage } from '../indexeddb-async-storage';

// A small in-memory IndexedDB, just wide enough for the adapter: open requests
// with upgradeneeded/success/error, transactions over one object store with
// get/put/delete/getAllKeys/clear, and switches that inject the failures iOS
// Safari produces after a page suspension.

const DATABASE_NAME = 'boardsesh-mobile-web';

type InjectedFailure = { at: 'transaction' | 'request'; error: DOMException };

function connectionClosing(): DOMException {
  return new DOMException('The database connection is closing.', 'InvalidStateError');
}

function noInProgressTransaction(): DOMException {
  return new DOMException('Attempt to get a record from database without an in-progress transaction', 'UnknownError');
}

class FakeRequest {
  result: unknown = undefined;
  error: DOMException | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onupgradeneeded: (() => void) | null = null;
}

type StoredDatabase = { version: number; stores: Map<string, Map<string, unknown>> };

class FakeTransaction {
  error: DOMException | null = null;
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private readonly operations: Array<{ request: FakeRequest; apply: (rows: Map<string, unknown>) => unknown }> = [];

  constructor(
    private readonly stored: StoredDatabase,
    private readonly storeName: string,
    private readonly mode: IDBTransactionMode,
    private readonly requestFailure: DOMException | null,
  ) {
    queueMicrotask(() => this.run());
  }

  objectStore(name: string) {
    if (name !== this.storeName) throw new DOMException(`No store ${name}`, 'NotFoundError');
    const queue = (apply: (rows: Map<string, unknown>) => unknown) => {
      const request = new FakeRequest();
      this.operations.push({ request, apply });
      return request;
    };
    return {
      get: (key: string) => queue((rows) => rows.get(key)),
      put: (value: unknown, key: string) =>
        queue((rows) => {
          rows.set(key, value);
          return key;
        }),
      delete: (key: string) => queue((rows) => void rows.delete(key)),
      getAllKeys: () => queue((rows) => [...rows.keys()]),
      clear: () => queue((rows) => rows.clear()),
    };
  }

  private run(): void {
    const committed = this.stored.stores.get(this.storeName) ?? new Map<string, unknown>();
    const working = new Map(committed);
    for (const [index, { request, apply }] of this.operations.entries()) {
      if (index === 0 && this.requestFailure) {
        request.error = this.requestFailure;
        request.onerror?.();
        this.onerror?.();
        this.error = this.requestFailure;
        this.onabort?.();
        return;
      }
      request.result = apply(working);
      request.onsuccess?.();
    }
    if (this.mode === 'readwrite') this.stored.stores.set(this.storeName, working);
    this.oncomplete?.();
  }
}

class FakeDatabase {
  closed = false;
  onclose: (() => void) | null = null;
  onversionchange: (() => void) | null = null;

  constructor(
    private readonly stored: StoredDatabase,
    private readonly factory: FakeIndexedDb,
  ) {}

  get objectStoreNames() {
    return { contains: (name: string) => this.stored.stores.has(name) };
  }

  createObjectStore(name: string): void {
    this.factory.createdStores.push(name);
    this.stored.stores.set(name, new Map());
  }

  transaction(storeName: string, mode: IDBTransactionMode): FakeTransaction {
    this.factory.transactionAttempts += 1;
    if (this.closed) throw connectionClosing();
    const failure = this.factory.injectedFailures.shift() ?? null;
    if (failure?.at === 'transaction') throw failure.error;
    return new FakeTransaction(this.stored, storeName, mode, failure?.error ?? null);
  }

  close(): void {
    this.closed = true;
  }

  /** The browser closing the connection under the page, as iOS Safari does. */
  closeAbnormally(): void {
    this.closed = true;
    this.onclose?.();
  }
}

class FakeIndexedDb {
  readonly databases = new Map<string, StoredDatabase>();
  readonly openCalls: Array<[string, number]> = [];
  readonly connections: FakeDatabase[] = [];
  readonly createdStores: string[] = [];
  injectedFailures: InjectedFailure[] = [];
  failNextOpen: DOMException | null = null;
  /** Opens that never fire success or error until `releaseHungOpens()`. */
  hangNextOpens = 0;
  /** Connections handed out already closing, with no `close` event. */
  closingNextConnections = 0;
  transactionAttempts = 0;
  private readonly hungOpens: Array<() => void> = [];

  open(name: string, version: number): FakeRequest {
    this.openCalls.push([name, version]);
    const request = new FakeRequest();
    if (this.hangNextOpens > 0) {
      this.hangNextOpens -= 1;
      this.hungOpens.push(() => this.settleOpen(request, name, version));
      return request;
    }
    queueMicrotask(() => this.settleOpen(request, name, version));
    return request;
  }

  releaseHungOpens(): void {
    for (const settle of this.hungOpens.splice(0)) settle();
  }

  private settleOpen(request: FakeRequest, name: string, version: number): void {
    if (this.failNextOpen) {
      request.error = this.failNextOpen;
      this.failNextOpen = null;
      request.onerror?.();
      return;
    }
    let stored = this.databases.get(name);
    const needsUpgrade = !stored || stored.version < version;
    if (!stored) {
      stored = { version, stores: new Map() };
      this.databases.set(name, stored);
    }
    const database = new FakeDatabase(stored, this);
    if (this.closingNextConnections > 0) {
      this.closingNextConnections -= 1;
      database.closed = true;
    }
    this.connections.push(database);
    request.result = database;
    if (needsUpgrade) {
      stored.version = version;
      request.onupgradeneeded?.();
    }
    request.onsuccess?.();
  }

  /** Rows exactly as the package's v3 adapter left them on disk. */
  seed(name: string, rows: Record<string, string | null>): void {
    this.databases.set(name, { version: 1, stores: new Map([['entries', new Map(Object.entries(rows))]]) });
  }
}

function setup(maxAttempts?: number, openTimeoutMs?: number) {
  const fakeIndexedDb = new FakeIndexedDb();
  const storage = createIndexedDbAsyncStorage(DATABASE_NAME, {
    getFactory: () => fakeIndexedDb as unknown as IDBFactory,
    maxAttempts,
    openTimeoutMs,
  });
  return { fakeIndexedDb, storage };
}

describe('createIndexedDbAsyncStorage', () => {
  it('round-trips values on version 1 of the entries store', async () => {
    const { fakeIndexedDb, storage } = setup();

    await storage.setItem('theme', 'dark');
    await storage.setMany({ grade: 'V5', angle: '40' });
    await expect(storage.getItem('theme')).resolves.toBe('dark');
    await expect(storage.getItem('missing')).resolves.toBeNull();
    await expect(storage.getMany(['grade', 'angle', 'missing'])).resolves.toEqual({
      grade: 'V5',
      angle: '40',
      missing: null,
    });
    await expect(storage.getAllKeys()).resolves.toEqual(['theme', 'grade', 'angle']);

    await storage.removeMany(['grade', 'angle']);
    await storage.removeItem('theme');
    await expect(storage.getAllKeys()).resolves.toEqual([]);

    await storage.setItem('theme', 'light');
    await storage.clear();
    await expect(storage.getItem('theme')).resolves.toBeNull();

    expect(fakeIndexedDb.openCalls).toEqual([[DATABASE_NAME, 1]]);
    expect(fakeIndexedDb.createdStores).toEqual(['entries']);
  });

  it('reads rows the package adapter already wrote without upgrading the database', async () => {
    const { fakeIndexedDb, storage } = setup();
    fakeIndexedDb.seed(DATABASE_NAME, { 'secure:theme': 'dark', cleared: null });

    await expect(storage.getItem('secure:theme')).resolves.toBe('dark');
    await expect(storage.getItem('cleared')).resolves.toBeNull();
    expect(fakeIndexedDb.createdStores).toEqual([]);
  });

  it('reopens and retries once when the cached connection is closing', async () => {
    const { fakeIndexedDb, storage } = setup();
    await storage.setItem('theme', 'dark');
    fakeIndexedDb.injectedFailures.push({ at: 'transaction', error: connectionClosing() });

    await expect(storage.getItem('theme')).resolves.toBe('dark');
    expect(fakeIndexedDb.openCalls).toHaveLength(2);
    expect(fakeIndexedDb.connections[0]?.closed).toBe(true);
  });

  it('retries once when a read loses its transaction mid-flight', async () => {
    const { fakeIndexedDb, storage } = setup();
    await storage.setItem('theme', 'dark');
    fakeIndexedDb.injectedFailures.push({ at: 'request', error: noInProgressTransaction() });

    await expect(storage.getItem('theme')).resolves.toBe('dark');
    expect(fakeIndexedDb.openCalls).toHaveLength(2);
  });

  it('stops after two attempts and rejects with the browser message', async () => {
    const { fakeIndexedDb, storage } = setup();
    await storage.setItem('theme', 'dark');
    const attemptsBefore = fakeIndexedDb.transactionAttempts;
    fakeIndexedDb.injectedFailures.push(
      { at: 'request', error: noInProgressTransaction() },
      { at: 'request', error: noInProgressTransaction() },
    );

    await expect(storage.getItem('theme')).rejects.toThrow(/without an in-progress transaction/);
    expect(fakeIndexedDb.transactionAttempts - attemptsBefore).toBe(2);
    // The next call works again on a fresh connection.
    await expect(storage.getItem('theme')).resolves.toBe('dark');
  });

  it('drops a connection that is still closing after the last attempt', async () => {
    const { fakeIndexedDb, storage } = setup();
    await storage.setItem('theme', 'dark');
    // The cached connection dies silently and the retry's fresh one is closing too.
    if (fakeIndexedDb.connections[0]) fakeIndexedDb.connections[0].closed = true;
    fakeIndexedDb.closingNextConnections = 1;

    await expect(storage.getItem('theme')).rejects.toThrow(/connection is closing/);
    expect(fakeIndexedDb.openCalls).toHaveLength(2);
    // The next call opens a third connection on its first attempt instead of
    // spending that attempt on the dead retry connection.
    const attemptsBefore = fakeIndexedDb.transactionAttempts;
    await expect(storage.getItem('theme')).resolves.toBe('dark');
    expect(fakeIndexedDb.transactionAttempts - attemptsBefore).toBe(1);
    expect(fakeIndexedDb.openCalls).toHaveLength(3);
  });

  it('gives up on an open that never settles and retries on a fresh request', async () => {
    const { fakeIndexedDb, storage } = setup(undefined, 10);
    fakeIndexedDb.hangNextOpens = 1;

    await expect(storage.getItem('theme')).resolves.toBeNull();
    expect(fakeIndexedDb.openCalls).toHaveLength(2);

    // The hung request finally succeeds; its connection is closed, not cached.
    fakeIndexedDb.releaseHungOpens();
    const lateConnection = fakeIndexedDb.connections.at(-1);
    expect(lateConnection?.closed).toBe(true);
    await storage.setItem('theme', 'dark');
    await expect(storage.getItem('theme')).resolves.toBe('dark');
    expect(fakeIndexedDb.openCalls).toHaveLength(2);
  });

  it('rejects when every open hangs, instead of waiting forever', async () => {
    const { fakeIndexedDb, storage } = setup(undefined, 10);
    fakeIndexedDb.hangNextOpens = 2;

    await expect(storage.getItem('theme')).rejects.toThrow(/timed out/);
    expect(fakeIndexedDb.openCalls).toHaveLength(2);
  });

  it('reopens after the browser closes the connection, without spending a retry', async () => {
    const { fakeIndexedDb, storage } = setup(1);
    await storage.setItem('theme', 'dark');
    fakeIndexedDb.connections[0]?.closeAbnormally();

    await expect(storage.getItem('theme')).resolves.toBe('dark');
    expect(fakeIndexedDb.openCalls).toHaveLength(2);
  });

  it('steps aside on versionchange and reopens on next use', async () => {
    const { fakeIndexedDb, storage } = setup(1);
    await storage.setItem('theme', 'dark');
    fakeIndexedDb.connections[0]?.onversionchange?.();

    expect(fakeIndexedDb.connections[0]?.closed).toBe(true);
    await expect(storage.getItem('theme')).resolves.toBe('dark');
    expect(fakeIndexedDb.openCalls).toHaveLength(2);
  });

  it('keeps the newer write when an older one to the same key retries', async () => {
    const { fakeIndexedDb, storage } = setup();
    await storage.getItem('warm-up');
    // The first write loses its transaction; the second, issued right after
    // without awaiting (as setSectionExpanded does), is fine.
    fakeIndexedDb.injectedFailures.push({ at: 'request', error: noInProgressTransaction() });

    await Promise.all([storage.setItem('sections', 'older'), storage.setItem('sections', 'newer')]);

    await expect(storage.getItem('sections')).resolves.toBe('newer');
  });

  it('lets a read issued after a retrying write see that write', async () => {
    const { fakeIndexedDb, storage } = setup();
    await storage.getItem('warm-up');
    fakeIndexedDb.injectedFailures.push({ at: 'request', error: noInProgressTransaction() });

    const write = storage.setItem('theme', 'dark');
    const read = storage.getItem('theme');

    await write;
    await expect(read).resolves.toBe('dark');
  });

  it('still runs a later write after an earlier one fails for good', async () => {
    const { fakeIndexedDb, storage } = setup();
    await storage.getItem('warm-up');
    fakeIndexedDb.injectedFailures.push({
      at: 'request',
      error: new DOMException('The quota has been exceeded.', 'QuotaExceededError'),
    });

    const failed = storage.setItem('big', 'value');
    const next = storage.setItem('theme', 'dark');

    await expect(failed).rejects.toThrow(/quota has been exceeded/);
    await next;
    await expect(storage.getItem('theme')).resolves.toBe('dark');
  });

  it('does not retry a quota failure', async () => {
    const { fakeIndexedDb, storage } = setup();
    await storage.getItem('warm-up');
    const attemptsBefore = fakeIndexedDb.transactionAttempts;
    fakeIndexedDb.injectedFailures.push({
      at: 'request',
      error: new DOMException('The quota has been exceeded.', 'QuotaExceededError'),
    });

    await expect(storage.setItem('big', 'value')).rejects.toThrow(/quota has been exceeded/);
    expect(fakeIndexedDb.transactionAttempts - attemptsBefore).toBe(1);
    await expect(storage.getItem('big')).resolves.toBeNull();
  });

  it('does not cache a failed open', async () => {
    const { fakeIndexedDb, storage } = setup(1);
    fakeIndexedDb.failNextOpen = new DOMException('Version mismatch.', 'VersionError');

    await expect(storage.getItem('theme')).rejects.toThrow(/Version mismatch/);
    await storage.setItem('theme', 'dark');
    await expect(storage.getItem('theme')).resolves.toBe('dark');
    expect(fakeIndexedDb.openCalls).toHaveLength(2);
  });

  it('rejects every call when the browser has no IndexedDB', async () => {
    const storage = createIndexedDbAsyncStorage(DATABASE_NAME, { getFactory: () => undefined });
    await expect(storage.getItem('theme')).rejects.toThrow('IndexedDB storage error: IndexedDB is not available');
  });
});
