import 'fake-indexeddb/auto';
import { dehydrate, QueryClient } from '@tanstack/react-query';
import type { PersistedClient } from '@tanstack/react-query-persist-client';
import { openDB } from 'idb';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createSessionGuard, type SessionGuard } from '../auth/session-guard';
import { createIdbPersister } from '../react-query-idb-persister';

const accountA = { userId: 'user-a', authSessionId: 'login-a' };
const accountB = { userId: 'user-b', authSessionId: 'login-b' };

function newGuard(): SessionGuard {
  return createSessionGuard({ reloadToRoot: vi.fn(), requestSessionCheck: vi.fn(), cleanupTimeoutMs: 10 });
}

function ownProfileCache(): PersistedClient {
  const queryClient = new QueryClient();
  queryClient.setQueryData(['profile', 'user-a'], { email: 'a@example.invalid' });
  return { timestamp: Date.now(), buster: '', clientState: dehydrate(queryClient) };
}

async function stored(): Promise<unknown> {
  const db = await openDB('boardsesh-react-query', 1);
  return db.get('cache', 'client');
}

beforeEach(async () => {
  const db = await openDB('boardsesh-react-query', 1, {
    upgrade(upgradeDb) {
      if (!upgradeDb.objectStoreNames.contains('cache')) upgradeDb.createObjectStore('cache');
    },
  });
  await db.clear('cache');
  db.close();
});

describe('persisted query cache owner', () => {
  it('writes nothing until the account is known, then tags the blob with it', async () => {
    const guard = newGuard();
    const persister = createIdbPersister(() => guard);
    const client = ownProfileCache();

    await persister.persistClient(client);
    expect(await stored()).toBeUndefined();

    guard.accept(accountA);
    await persister.persistClient(client);
    expect(await stored()).toEqual({ owner: 'user-a:login-a', client });
  });

  it('restores the cache only into the account that wrote it', async () => {
    const writer = newGuard();
    writer.accept(accountA);
    const client = ownProfileCache();
    await createIdbPersister(() => writer).persistClient(client);

    // A switch made on another origin: this page's first read names B.
    const otherAccount = newGuard();
    otherAccount.accept(accountB);
    await expect(createIdbPersister(() => otherAccount).restoreClient()).resolves.toBeUndefined();

    const sameAccount = newGuard();
    sameAccount.accept(accountA);
    await expect(createIdbPersister(() => sameAccount).restoreClient()).resolves.toEqual(client);
  });

  it('waits for the first session read before restoring, and restores nothing if it never comes', async () => {
    const writer = newGuard();
    writer.accept(accountA);
    const client = ownProfileCache();
    await createIdbPersister(() => writer).persistClient(client);

    const pending = newGuard();
    const restored = createIdbPersister(() => pending).restoreClient();
    setTimeout(() => pending.accept(accountA), 20);
    await expect(restored).resolves.toEqual(client);

    vi.useFakeTimers();
    try {
      const silent = createIdbPersister(() => newGuard()).restoreClient();
      await vi.advanceTimersByTimeAsync(1500);
      await expect(silent).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses writes while the page retires', async () => {
    const guard = newGuard();
    guard.accept(accountA);
    const persister = createIdbPersister(() => guard);

    guard.accept(accountB);
    await persister.persistClient(ownProfileCache());

    expect(guard.isRetiring()).toBe(true);
    expect(await stored()).toBeUndefined();
  });

  it('never restores an untagged blob written before the guard existed', async () => {
    const db = await openDB('boardsesh-react-query', 1);
    await db.put('cache', ownProfileCache(), 'client');
    db.close();
    const guard = newGuard();
    guard.accept(accountA);

    await expect(createIdbPersister(() => guard).restoreClient()).resolves.toBeUndefined();
  });
});
