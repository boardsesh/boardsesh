import { describe, expect, it, vi } from 'vitest';
import { createGpuFailureStore, type GpuFailureRecord } from '../gpu-failure-store-core';

const binaryIdentity = 'android:com.boardsesh.app:2.6:123:api5';
const configHash = (index: number) => index.toString(16).padStart(64, '0');
const persisted = (hashes: string[], binary = binaryIdentity): GpuFailureRecord => ({
  version: 1,
  binaryIdentity: binary,
  configHashes: hashes,
});
const sparseHashes = (length: number): string[] => {
  const hashes: string[] = [];
  hashes.length = length;
  return hashes;
};

function deferred<T>() {
  let resolve!: (result: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('GPU failure store', () => {
  it('keeps snapshots stable until hydration or a new failure changes them', async () => {
    const store = createGpuFailureStore({ binaryIdentity, read: async () => null, write: async () => {} });
    const initial = store.getSnapshot();
    expect(store.getSnapshot()).toBe(initial);
    expect(initial).toEqual({ hydrated: false, unavailable: false, keys: new Set() });
    await store.hydrate();
    const hydrated = store.getSnapshot();
    expect(hydrated).not.toBe(initial);
    expect(store.getSnapshot()).toBe(hydrated);
    store.record(configHash(1));
    const failed = store.getSnapshot();
    store.record(configHash(1));
    expect(store.getSnapshot()).toBe(failed);
    expect(hydrated.keys.size).toBe(0);
    await store.flush();
    expect(store.getSnapshot()).toBe(failed);
  });

  it('notifies immediately and unsubscribes independently', async () => {
    const read = deferred<unknown>();
    const store = createGpuFailureStore({ binaryIdentity, read: () => read.promise, write: async () => {} });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.record(configHash(1));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().keys.has(configHash(1))).toBe(true);
    expect(store.getSnapshot().hydrated).toBe(false);
    unsubscribe();
    read.resolve(null);
    await store.flush();
    store.record(configHash(2));
    await store.flush();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('persists hashes and restores them for the same binary after restart', async () => {
    let disk: unknown = null;
    const write = vi.fn(async (record: GpuFailureRecord) => {
      disk = record;
    });
    const first = createGpuFailureStore({ binaryIdentity, read: async () => disk, write });
    first.record(configHash(1));
    await first.flush();
    expect(write).toHaveBeenLastCalledWith(persisted([configHash(1)]));
    const restarted = createGpuFailureStore({ binaryIdentity, read: async () => disk, write });
    await restarted.hydrate();
    expect([...restarted.getSnapshot().keys]).toEqual([configHash(1)]);
    expect(restarted.getSnapshot().unavailable).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('starts a new binary with no inherited failures', async () => {
    const write = vi.fn(async (_record: GpuFailureRecord) => {});
    const store = createGpuFailureStore({
      binaryIdentity: 'android:com.boardsesh.app:2.6:124:api5',
      read: async () => persisted([configHash(1)]),
      write,
    });
    await store.hydrate();
    expect(store.getSnapshot().keys.size).toBe(0);
    expect(store.getSnapshot().unavailable).toBe(false);
    expect(write).not.toHaveBeenCalled();
    store.record(configHash(2));
    await store.flush();
    expect(write).toHaveBeenLastCalledWith(persisted([configHash(2)], 'android:com.boardsesh.app:2.6:124:api5'));
  });

  it('merges failures recorded during a delayed read without a stale overwrite', async () => {
    const read = deferred<unknown>();
    const write = vi.fn(async (_record: GpuFailureRecord) => {});
    const store = createGpuFailureStore({ binaryIdentity, read: () => read.promise, write, maxEntries: 3 });
    const hydration = store.hydrate();
    store.record(configHash(3));
    store.record(configHash(4));
    expect(write).not.toHaveBeenCalled();
    read.resolve(persisted([configHash(1), configHash(2)]));
    await hydration;
    await store.flush();
    expect([...store.getSnapshot().keys]).toEqual([configHash(2), configHash(3), configHash(4)]);
    expect(write).toHaveBeenLastCalledWith(persisted([configHash(2), configHash(3), configHash(4)]));
  });

  it('treats a raced failure as newer than the same hash in storage', async () => {
    const read = deferred<unknown>();
    const store = createGpuFailureStore({
      binaryIdentity,
      read: () => read.promise,
      write: async () => {},
      maxEntries: 2,
    });
    store.record(configHash(1));
    read.resolve(persisted([configHash(1), configHash(2), configHash(3)]));
    await store.flush();
    expect([...store.getSnapshot().keys]).toEqual([configHash(3), configHash(1)]);
  });

  it('hydrates exactly once and returns the same in-flight promise', async () => {
    const result = deferred<unknown>();
    const read = vi.fn(() => result.promise);
    const store = createGpuFailureStore({ binaryIdentity, read, write: async () => {} });
    const first = store.hydrate();
    expect(store.hydrate()).toBe(first);
    result.resolve(null);
    await first;
    expect(store.hydrate()).toBe(first);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('serializes writes and coalesces changes while an older write is pending', async () => {
    const firstWrite = deferred<void>();
    const writes: GpuFailureRecord[] = [];
    const write = vi.fn(async (record: GpuFailureRecord) => {
      writes.push(record);
      if (writes.length === 1) await firstWrite.promise;
    });
    const store = createGpuFailureStore({ binaryIdentity, read: async () => null, write });
    await store.hydrate();
    store.record(configHash(1));
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    store.record(configHash(2));
    store.record(configHash(3));
    expect(write).toHaveBeenCalledTimes(1);
    firstWrite.resolve();
    await store.flush();
    expect(writes).toEqual([persisted([configHash(1)]), persisted([configHash(1), configHash(2), configHash(3)])]);
    expect(writes[0].configHashes).toEqual([configHash(1)]);
  });

  it('waits for a failure added reentrantly by an I/O adapter when flushing', async () => {
    let writes = 0;
    const store = createGpuFailureStore({
      binaryIdentity,
      read: async () => null,
      write: async () => {
        if (++writes === 1) store.record(configHash(2));
      },
    });
    store.record(configHash(1));
    await store.flush();
    expect(writes).toBe(2);
    expect([...store.getSnapshot().keys]).toEqual([configHash(1), configHash(2)]);
  });

  it('keeps at most 64 entries and evicts the oldest failure first', async () => {
    const write = vi.fn(async (_record: GpuFailureRecord) => {});
    const store = createGpuFailureStore({ binaryIdentity, read: async () => null, write });
    for (let index = 0; index < 70; index++) store.record(configHash(index));
    await store.flush();
    expect([...store.getSnapshot().keys]).toEqual(Array.from({ length: 64 }, (_, index) => configHash(index + 6)));
    expect(write).toHaveBeenLastCalledWith(persisted(Array.from({ length: 64 }, (_, index) => configHash(index + 6))));
  });

  it.each([0, -1, 65, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects an invalid entry bound %s', (maxEntries) => {
    expect(() =>
      createGpuFailureStore({ binaryIdentity, read: async () => null, write: async () => {}, maxEntries }),
    ).toThrow(RangeError);
  });

  it.each([
    null,
    [],
    {},
    { ...persisted([]), version: 2 },
    { ...persisted([]), configHashes: 'not-an-array' },
    persisted(['A'.repeat(64)]),
    persisted(['0'.repeat(63)]),
    persisted([configHash(1), 'p123r42']),
    persisted(sparseHashes(2)),
    persisted(Array.from({ length: 65 }, (_, index) => configHash(index))),
  ])('ignores the entire malformed record %#', async (record) => {
    const write = vi.fn(async (_record: GpuFailureRecord) => {});
    const store = createGpuFailureStore({ binaryIdentity, read: async () => record, write });
    await store.hydrate();
    expect(store.getSnapshot()).toEqual({ hydrated: true, unavailable: false, keys: new Set() });
    expect(write).not.toHaveBeenCalled();
  });

  it('checks oversized persisted arrays before inspecting their entries', async () => {
    const hashes = sparseHashes(65);
    const entry = vi.fn(() => {
      throw new Error('Oversized array entries must not be inspected');
    });
    Object.defineProperty(hashes, 0, { get: entry });
    const store = createGpuFailureStore({ binaryIdentity, read: async () => persisted(hashes), write: async () => {} });
    await store.hydrate();
    expect(entry).not.toHaveBeenCalled();
    expect(store.getSnapshot().unavailable).toBe(false);
  });

  it('keeps RAM failures and marks storage unavailable when the read fails', async () => {
    const read = deferred<unknown>();
    const write = vi.fn(async (_record: GpuFailureRecord) => {});
    const store = createGpuFailureStore({ binaryIdentity, read: () => read.promise, write });
    store.record(configHash(1));
    read.reject(new Error('Storage unavailable'));
    await expect(store.flush()).resolves.toBeUndefined();
    expect(store.getSnapshot()).toEqual({ hydrated: true, unavailable: true, keys: new Set([configHash(1)]) });
    store.record(configHash(2));
    await store.flush();
    expect([...store.getSnapshot().keys]).toEqual([configHash(1), configHash(2)]);
    expect(write).not.toHaveBeenCalled();
  });

  it('contains synchronous I/O throws without floating rejections', async () => {
    const store = createGpuFailureStore({
      binaryIdentity,
      read: () => {
        throw new Error('Read adapter threw');
      },
      write: async () => {},
    });
    store.record(configHash(1));
    await expect(store.flush()).resolves.toBeUndefined();
    expect(store.getSnapshot().unavailable).toBe(true);
  });

  it('retains RAM after failed writes and writes the complete set after another failure', async () => {
    const write = vi
      .fn<(record: GpuFailureRecord) => Promise<void>>()
      .mockRejectedValueOnce(new Error('Disk full'))
      .mockResolvedValue(undefined);
    const store = createGpuFailureStore({ binaryIdentity, read: async () => null, write });
    store.record(configHash(1));
    await expect(store.flush()).resolves.toBeUndefined();
    expect(store.getSnapshot().keys.has(configHash(1))).toBe(true);
    expect(store.getSnapshot().unavailable).toBe(false);
    store.record(configHash(2));
    await store.flush();
    expect(write).toHaveBeenLastCalledWith(persisted([configHash(1), configHash(2)]));
  });

  it('contains a synchronously throwing write adapter and retains the RAM latch', async () => {
    const store = createGpuFailureStore({
      binaryIdentity,
      read: async () => null,
      write: () => {
        throw new Error('Write adapter threw');
      },
    });
    store.record(configHash(1));
    await expect(store.flush()).resolves.toBeUndefined();
    expect([...store.getSnapshot().keys]).toEqual([configHash(1)]);
  });

  it('never retains or persists raw configuration or malformed hash strings', async () => {
    const write = vi.fn(async (_record: GpuFailureRecord) => {});
    const read = vi.fn(async () => null);
    const store = createGpuFailureStore({ binaryIdentity, read, write });
    for (const raw of [
      '{"frames":"p123r42"}',
      'file:///private/board.json',
      'F'.repeat(64),
      'f'.repeat(65),
      'x'.repeat(1_000_000),
    ])
      store.record(raw);
    expect(store.getSnapshot().keys.size).toBe(0);
    expect(read).not.toHaveBeenCalled();
    store.record(configHash(1));
    await store.flush();
    expect(write).toHaveBeenLastCalledWith(persisted([configHash(1)]));
    expect(Object.keys(write.mock.calls[0][0]).sort()).toEqual(['binaryIdentity', 'configHashes', 'version']);
  });
});
