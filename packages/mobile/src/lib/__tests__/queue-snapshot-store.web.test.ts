import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserStorageOwner } from '../user-storage-owner';
import type { ClimbQueueItem } from '@boardsesh/queue';

const storage = vi.hoisted(() => ({
  rows: new Map<string, unknown>(),
  owner: { userId: 'a', authSessionId: 'a-login' } as UserStorageOwner | null,
  writeBarrier: undefined as Promise<void> | undefined,
  removeBarrier: undefined as Promise<void> | undefined,
  removeStarted: vi.fn(),
  failWrite: false,
  started: vi.fn(),
}));

vi.mock('../user-storage-owner.web', () => ({
  userScopedStorageKey: (key: string, explicitOwner?: UserStorageOwner | null) => {
    const owner = explicitOwner === undefined ? storage.owner : explicitOwner;
    return owner ? `${key}:${owner.userId}:${owner.authSessionId}` : null;
  },
}));
vi.mock('../preference-store', () => ({
  getPreference: async (key: string) => storage.rows.get(key) ?? null,
  setPreference: async (key: string, snapshot: unknown) => {
    storage.started();
    await storage.writeBarrier;
    if (storage.failWrite) throw new Error('write failed');
    storage.rows.set(key, snapshot);
  },
  removePreference: async (key: string) => {
    storage.removeStarted();
    await storage.removeBarrier;
    storage.rows.delete(key);
  },
}));

const snapshot = { queue: [], currentClimbQueueItem: null, playlistSuggestionSource: null };
function deferred() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

beforeEach(() => {
  vi.resetModules();
  storage.rows.clear();
  storage.owner = { userId: 'a', authSessionId: 'a-login' };
  storage.writeBarrier = undefined;
  storage.failWrite = false;
  storage.removeBarrier = undefined;
  storage.removeStarted.mockClear();
  storage.started.mockClear();
});

describe('browser queue snapshot write boundaries', () => {
  it('sanitizes both legacy reads and new persisted payloads', async () => {
    const store = await import('../queue-snapshot-store.web');
    const item = {
      uuid: 'slot',
      climb: { uuid: 'private', name: 'Private name', frames: 'private holds', angle: 40 },
      addedByUser: { id: 'author', username: 'Private author' },
      tickedBy: ['author'],
    } as unknown as ClimbQueueItem;
    const legacy = { ...snapshot, queue: [item], currentClimbQueueItem: item, savedAt: 'legacy' };
    storage.rows.set('boardsesh_local_queue_snapshot_v1:a:a-login', legacy);
    const restored = await store.getStoredQueueSnapshot();
    expect(restored?.queue[0]).toMatchObject({ uuid: 'slot', climb: { uuid: 'private', name: '', frames: '' } });
    expect(restored?.queue[0].addedByUser).toBeUndefined();
    expect(restored?.queue[0].tickedBy).toBeUndefined();
    await store.setStoredQueueSnapshot(legacy);
    expect(JSON.stringify([...storage.rows.values()])).not.toContain('Private');
    expect(JSON.stringify([...storage.rows.values()])).not.toContain('private holds');
    expect((await store.getStoredQueueSnapshot())?.currentClimbQueueItem?.uuid).toBe('slot');
  });

  it('invalidates pending saves without deleting the logical queue', async () => {
    const store = await import('../queue-snapshot-store.web');
    await store.setStoredQueueSnapshot(snapshot);
    const oldGeneration = store.getQueueSnapshotGeneration();
    store.invalidateStoredQueueSnapshot();
    await store.setStoredQueueSnapshot(snapshot, undefined, oldGeneration);
    expect(storage.started).toHaveBeenCalledOnce();
    expect(await store.getStoredQueueSnapshot()).toMatchObject(snapshot);
  });

  it('removes an in-flight pre-clear write before resolving clear', async () => {
    const store = await import('../queue-snapshot-store.web');
    const barrier = deferred();
    storage.writeBarrier = barrier.promise;
    const save = store.setStoredQueueSnapshot(snapshot);
    await vi.waitFor(() => expect(storage.started).toHaveBeenCalledOnce());
    const removal = store.clearStoredQueueSnapshot();
    barrier.release();
    await Promise.all([save, removal]);
    expect(await store.getStoredQueueSnapshot()).toBeNull();
  });

  it('skips stale debounces and preserves a write scheduled after clear', async () => {
    const store = await import('../queue-snapshot-store.web');
    const staleGeneration = store.getQueueSnapshotGeneration();
    const removal = store.clearStoredQueueSnapshot();
    await store.setStoredQueueSnapshot(snapshot, undefined, staleGeneration);
    await removal;
    expect(await store.getStoredQueueSnapshot()).toBeNull();
    expect(storage.started).not.toHaveBeenCalled();
    await store.setStoredQueueSnapshot(snapshot);
    expect(await store.getStoredQueueSnapshot()).toMatchObject(snapshot);
  });

  it('keeps a new-generation save behind a delayed removal', async () => {
    const store = await import('../queue-snapshot-store.web');
    await store.setStoredQueueSnapshot(snapshot);
    const barrier = deferred();
    storage.removeBarrier = barrier.promise;
    const removal = store.clearStoredQueueSnapshot();
    await vi.waitFor(() => expect(storage.removeStarted).toHaveBeenCalledOnce());
    const replacement = store.setStoredQueueSnapshot(snapshot);
    barrier.release();
    await Promise.all([removal, replacement]);
    expect(await store.getStoredQueueSnapshot()).toMatchObject(snapshot);
  });

  it('captures owner keys before waiting and keeps a later owner isolated', async () => {
    const store = await import('../queue-snapshot-store.web');
    const ownerA = storage.owner;
    const barrier = deferred();
    storage.writeBarrier = barrier.promise;
    const firstSave = store.setStoredQueueSnapshot(snapshot);
    await vi.waitFor(() => expect(storage.started).toHaveBeenCalledOnce());
    const queuedSave = store.setStoredQueueSnapshot(snapshot);
    storage.owner = { userId: 'b', authSessionId: 'b-login' };
    barrier.release();
    await Promise.all([firstSave, queuedSave]);
    expect(await store.getStoredQueueSnapshot()).toBeNull();
    expect(await store.getStoredQueueSnapshot(ownerA)).toMatchObject(snapshot);
    await store.setStoredQueueSnapshot(snapshot);
    await store.clearStoredQueueSnapshot(ownerA);
    expect(await store.getStoredQueueSnapshot()).toMatchObject(snapshot);
  });

  it('fences an older pending write for another owner when clearing', async () => {
    const store = await import('../queue-snapshot-store.web');
    const ownerA = storage.owner;
    const barrier = deferred();
    storage.writeBarrier = barrier.promise;
    const firstSave = store.setStoredQueueSnapshot(snapshot);
    await vi.waitFor(() => expect(storage.started).toHaveBeenCalledOnce());
    storage.owner = { userId: 'b', authSessionId: 'b-login' };
    const staleOtherOwnerSave = store.setStoredQueueSnapshot(snapshot);
    const removal = store.clearStoredQueueSnapshot(ownerA);
    barrier.release();
    await Promise.all([firstSave, staleOtherOwnerSave, removal]);
    expect(await store.getStoredQueueSnapshot()).toBeNull();
    expect(storage.started).toHaveBeenCalledOnce();
  });

  it('recovers after a rejected write and fences clears without an owner', async () => {
    const store = await import('../queue-snapshot-store.web');
    storage.failWrite = true;
    await expect(store.setStoredQueueSnapshot(snapshot)).rejects.toThrow('write failed');
    storage.failWrite = false;
    const oldGeneration = store.getQueueSnapshotGeneration();
    storage.owner = null;
    await store.clearStoredQueueSnapshot();
    expect(store.getQueueSnapshotGeneration()).toBe(oldGeneration + 1);
    await store.setStoredQueueSnapshot(snapshot);
    expect(storage.rows.size).toBe(0);
    storage.owner = { userId: 'a', authSessionId: 'a-login' };
    await store.setStoredQueueSnapshot(snapshot);
    expect(await store.getStoredQueueSnapshot()).toMatchObject(snapshot);
  });
});
