import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { DbInstance, PoolInstance } from '@boardsesh/db/client';
import type { CredentialWriterReceipt } from '@boardsesh/db/credential-writer-acl';

const dependencies = vi.hoisted(() => ({
  createPool: vi.fn(),
  createDatabase: vi.fn(),
  qualify: vi.fn(),
  probe: vi.fn(),
}));
vi.mock('@boardsesh/db/client', () => ({
  createDedicatedPoolFromUrl: dependencies.createPool,
  createDbOnPool: dependencies.createDatabase,
}));
vi.mock('@boardsesh/db/credential-writer-acl', () => ({ qualifyCredentialWriter: dependencies.qualify }));
vi.mock('../../credential-database-identity', () => ({ assertSameCredentialDatabaseTarget: dependencies.probe }));

const contentUrl = 'postgresql://boardsesh_runtime:owned-content-secret@127.0.0.1:55480/owned_lifecycle';
const writerUrl = 'postgresql://boardsesh_identity_writer:owned-writer-secret@127.0.0.1:55480/owned_lifecycle';
// The qualifier's opaque result is irrelevant to this lifecycle contract.
const receipt = Object.freeze({ ownedLifecycleReceipt: true }) as unknown as CredentialWriterReceipt;
interface PoolRecord {
  readonly pool: PoolInstance;
  readonly database: DbInstance;
  readonly end: ReturnType<typeof vi.fn<(options?: { timeout?: number }) => Promise<void>>>;
}
let pools: PoolRecord[];
let module: typeof import('../../credential-database') | undefined;
let releasePending: (() => void)[];
let requests: Promise<unknown>[];

function deferred<T>(cleanupResult: T) {
  let resolve: (result: T) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const pending = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  releasePending.push(() => resolve(cleanupResult));
  return { pending, resolve, reject };
}
function track<T>(pending: Promise<T>): Promise<T> {
  requests.push(pending);
  void pending.catch(() => {});
  return pending;
}
function ownedPool(end: () => Promise<void> = async () => {}): PoolRecord {
  const close = vi.fn(end);
  const pool = { end: close } as unknown as PoolInstance;
  const database = Object.freeze({ ownedPoolNumber: pools.length }) as unknown as DbInstance;
  const record = { pool, database, end: close };
  pools.push(record);
  return record;
}
async function load() {
  module = await import('../../credential-database');
  return module;
}

describe('private credential database connection ownership', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    pools = [];
    releasePending = [];
    requests = [];
    module = undefined;
    vi.stubEnv('DATABASE_URL', contentUrl);
    vi.stubEnv('AUTH_IDENTITY_DATABASE_URL', writerUrl);
    dependencies.createPool.mockReset().mockImplementation(() => ownedPool().pool);
    dependencies.createDatabase.mockReset().mockImplementation((pool: PoolInstance) => {
      const record = pools.find((candidate) => candidate.pool === pool);
      if (!record) throw new Error('Unowned lifecycle pool');
      return record.database;
    });
    dependencies.qualify.mockReset().mockResolvedValue(receipt);
    dependencies.probe.mockReset().mockResolvedValue(undefined);
  });
  afterEach(async () => {
    for (const release of releasePending) release();
    await Promise.allSettled(requests);
    await module?.closeCredentialDatabase();
    vi.unstubAllEnvs();
  });

  it('coalesces concurrent first requests without exposing an unqualified handle', async () => {
    const qualification = deferred(receipt);
    dependencies.qualify.mockReturnValue(qualification.pending);
    const connection = await load();
    let completed = 0;
    const first = track(
      connection.getCredentialDatabase().then((database) => {
        completed += 1;
        return database;
      }),
    );
    const second = track(
      connection.getCredentialDatabase().then((database) => {
        completed += 1;
        return database;
      }),
    );
    await vi.waitFor(() => expect(dependencies.qualify).toHaveBeenCalledOnce());
    expect(completed).toBe(0);
    expect(pools).toHaveLength(1);
    expect(dependencies.createPool).toHaveBeenCalledWith(writerUrl, 2, expect.objectContaining({ connect_timeout: 2 }));
    expect(dependencies.createDatabase).toHaveBeenCalledWith(pools[0].pool, { logger: false });
    expect(process.env.DATABASE_URL).toBe(contentUrl);
    qualification.resolve(receipt);
    expect(await first).toBe(pools[0].database);
    expect(await second).toBe(pools[0].database);
    expect(await connection.getCredentialDatabase()).toBe(pools[0].database);
    expect(dependencies.qualify).toHaveBeenCalledOnce();
    expect(dependencies.probe).toHaveBeenCalledExactlyOnceWith(pools[0].pool, contentUrl, {
      writerRole: 'boardsesh_identity_writer',
      contentRole: 'boardsesh_runtime',
      database: 'owned_lifecycle',
    });
  });

  it('keeps a qualified handle unpublished until its physical-target probe succeeds', async () => {
    const probe = deferred<void>(undefined);
    dependencies.probe.mockReturnValue(probe.pending);
    const connection = await load();
    let completed = false;
    const pending = track(
      connection.getCredentialDatabase().then((database) => {
        completed = true;
        return database;
      }),
    );
    await vi.waitFor(() => expect(dependencies.probe).toHaveBeenCalledOnce());
    expect(dependencies.qualify).toHaveBeenCalledOnce();
    expect(completed).toBe(false);
    expect(pools[0].end).not.toHaveBeenCalled();
    probe.resolve(undefined);
    expect(await pending).toBe(pools[0].database);
  });

  it('closes a qualified pool rejected by its physical-target probe and retries cleanly', async () => {
    const failure = new Error('Owned target mismatch');
    dependencies.probe.mockRejectedValueOnce(failure);
    const connection = await load();
    await expect(connection.getCredentialDatabase()).rejects.toBe(failure);
    expect(pools[0].end).toHaveBeenCalledOnce();
    expect(await connection.getCredentialDatabase()).toBe(pools[1].database);
    expect(dependencies.qualify).toHaveBeenCalledTimes(2);
    expect(dependencies.probe).toHaveBeenCalledTimes(2);
  });

  it('finishes failed-qualification cleanup before allowing a fresh retry', async () => {
    const cleanup = deferred<void>(undefined);
    const failedPool = ownedPool(() => cleanup.pending);
    dependencies.createPool.mockReturnValueOnce(failedPool.pool);
    const failure = new Error('Owned qualification failure');
    dependencies.qualify.mockRejectedValueOnce(failure);
    const connection = await load();
    const first = track(connection.getCredentialDatabase());
    await vi.waitFor(() => expect(failedPool.end).toHaveBeenCalledWith({ timeout: 5 }));
    const duringCleanup = track(connection.getCredentialDatabase());
    expect(dependencies.createPool).toHaveBeenCalledOnce();
    cleanup.resolve(undefined);
    await expect(first).rejects.toBe(failure);
    await expect(duringCleanup).rejects.toBe(failure);
    const retried = await connection.getCredentialDatabase();
    expect(dependencies.createPool).toHaveBeenCalledTimes(2);
    expect(dependencies.qualify).toHaveBeenCalledTimes(2);
    expect(retried).toBe(pools[1].database);
    expect(failedPool.end).toHaveBeenCalledOnce();
  });

  it.each(
    (['pending', 'resolved'] as const).flatMap((phase) => [
      {
        phase,
        target: 'writer',
        variable: 'AUTH_IDENTITY_DATABASE_URL',
        original: writerUrl,
        changed: writerUrl.replace('owned-writer-secret', 'owned-rotated-writer-secret'),
      },
      {
        phase,
        target: 'content',
        variable: 'DATABASE_URL',
        original: contentUrl,
        changed: contentUrl.replace('boardsesh_runtime', 'owned_next_content_login'),
      },
    ]),
  )(
    'refuses $target target drift with a $phase handle without opening another pool',
    async ({ phase, variable, original, changed }) => {
      const qualification = deferred(receipt);
      dependencies.qualify.mockReturnValue(qualification.pending);
      const connection = await load();
      const first = track(connection.getCredentialDatabase());
      await vi.waitFor(() => expect(dependencies.qualify).toHaveBeenCalledOnce());
      if (phase === 'resolved') {
        qualification.resolve(receipt);
        await first;
      }
      vi.stubEnv(variable, changed);
      await expect(connection.getCredentialDatabase()).rejects.toThrow('CREDENTIAL_DATABASE_CONFIGURATION_CHANGED');
      expect(dependencies.createPool).toHaveBeenCalledOnce();
      expect(pools[0].end).not.toHaveBeenCalled();
      qualification.resolve(receipt);
      expect(await first).toBe(pools[0].database);
      expect(dependencies.probe).toHaveBeenCalledExactlyOnceWith(pools[0].pool, contentUrl, {
        writerRole: 'boardsesh_identity_writer',
        contentRole: 'boardsesh_runtime',
        database: 'owned_lifecycle',
      });
      vi.stubEnv(variable, original);
      expect(await connection.getCredentialDatabase()).toBe(pools[0].database);
    },
  );

  it('waits for pending initialization at shutdown and closes that pool exactly once', async () => {
    const qualification = deferred(receipt);
    dependencies.qualify.mockReturnValue(qualification.pending);
    const connection = await load();
    const first = track(connection.getCredentialDatabase());
    await vi.waitFor(() => expect(dependencies.qualify).toHaveBeenCalledOnce());
    let closed = false;
    const shutdown = track(
      connection.closeCredentialDatabase().then(() => {
        closed = true;
      }),
    );
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(pools[0].end).not.toHaveBeenCalled();
    qualification.resolve(receipt);
    await first;
    await shutdown;
    expect(pools[0].end).toHaveBeenCalledWith({ timeout: 5 });
    await connection.closeCredentialDatabase();
    expect(pools[0].end).toHaveBeenCalledOnce();
    expect(await connection.getCredentialDatabase()).toBe(pools[1].database);
    expect(dependencies.createPool).toHaveBeenCalledTimes(2);
  });

  it('drains failed creation during shutdown without double-closing or retaining its rejection', async () => {
    const qualification = deferred(receipt);
    dependencies.qualify.mockReturnValueOnce(qualification.pending);
    const connection = await load();
    const first = track(connection.getCredentialDatabase());
    await vi.waitFor(() => expect(dependencies.qualify).toHaveBeenCalledOnce());
    const shutdown = track(connection.closeCredentialDatabase());
    const failure = new Error('Owned startup qualification failure');
    qualification.reject(failure);
    await expect(first).rejects.toBe(failure);
    await expect(shutdown).resolves.toBeUndefined();
    await connection.closeCredentialDatabase();
    expect(pools[0].end).toHaveBeenCalledOnce();
    expect(await connection.getCredentialDatabase()).toBe(pools[1].database);
    expect(dependencies.qualify).toHaveBeenCalledTimes(2);
  });

  it('closes a pool whose database wrapper fails, then retries with a new owned handle', async () => {
    dependencies.createDatabase.mockImplementationOnce(() => {
      throw new Error('Owned wrapper startup failure');
    });
    const connection = await load();
    await expect(connection.getCredentialDatabase()).rejects.toThrow('Owned wrapper startup failure');
    expect(pools[0].end).toHaveBeenCalledOnce();
    expect(dependencies.qualify).not.toHaveBeenCalled();
    expect(await connection.getCredentialDatabase()).toBe(pools[1].database);
    expect(dependencies.qualify).toHaveBeenCalledOnce();
  });
});
