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
  return createSessionGuard({ reloadPage: vi.fn(), requestSessionCheck: vi.fn(), cleanupTimeoutMs: 10 });
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
    const persister = createIdbPersister({ sessionGuard: () => guard });
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
    await createIdbPersister({ sessionGuard: () => writer }).persistClient(client);

    // A switch made on another origin: this page's first read names B.
    const otherAccount = newGuard();
    otherAccount.accept(accountB);
    await expect(createIdbPersister({ sessionGuard: () => otherAccount }).restoreClient()).resolves.toBeUndefined();

    const sameAccount = newGuard();
    sameAccount.accept(accountA);
    await expect(createIdbPersister({ sessionGuard: () => sameAccount }).restoreClient()).resolves.toEqual(client);
  });

  it('never holds restore for the session read: the blob is hydrated once its owner is named', async () => {
    const writer = newGuard();
    writer.accept(accountA);
    const client = ownProfileCache();
    await createIdbPersister({ sessionGuard: () => writer }).persistClient(client);

    const pending = newGuard();
    const restoreLate = vi.fn<(restored: PersistedClient) => void>();
    // Restore settles while the session read is still out, so queries are not held.
    await expect(
      createIdbPersister({ sessionGuard: () => pending, restoreLate }).restoreClient(),
    ).resolves.toBeUndefined();
    expect(restoreLate).not.toHaveBeenCalled();

    pending.accept(accountA);
    await vi.waitFor(() => expect(restoreLate).toHaveBeenCalledWith(client));
  });

  it('never hydrates a late blob into another account or after the cache was cleared', async () => {
    const writer = newGuard();
    writer.accept(accountA);
    await createIdbPersister({ sessionGuard: () => writer }).persistClient(ownProfileCache());

    const otherAccount = newGuard();
    const restoredForOther = vi.fn<(restored: PersistedClient) => void>();
    await createIdbPersister({ sessionGuard: () => otherAccount, restoreLate: restoredForOther }).restoreClient();
    otherAccount.accept(accountB);

    const cleared = newGuard();
    const restoredAfterClear = vi.fn<(restored: PersistedClient) => void>();
    const clearedPersister = createIdbPersister({ sessionGuard: () => cleared, restoreLate: restoredAfterClear });
    await clearedPersister.restoreClient();
    await clearedPersister.removeClient();
    cleared.accept(accountA);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(restoredForOther).not.toHaveBeenCalled();
    expect(restoredAfterClear).not.toHaveBeenCalled();
  });

  it('refuses writes while the page retires', async () => {
    const guard = newGuard();
    guard.accept(accountA);
    const persister = createIdbPersister({ sessionGuard: () => guard });

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

    await expect(createIdbPersister({ sessionGuard: () => guard }).restoreClient()).resolves.toBeUndefined();
  });
});
