import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => {
  let storage: Record<string, string> = {};
  return {
    default: {
      getItem: vi.fn(async (key: string) => storage[key] ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        storage[key] = value;
      }),
      removeItem: vi.fn(async (key: string) => {
        delete storage[key];
      }),
      __reset: () => {
        storage = {};
      },
      __setRaw: (key: string, value: string) => {
        storage[key] = value;
      },
    },
  };
});

const STORAGE_KEY = 'dimensionFilterLocks';

type StorageMock = {
  __reset: () => void;
  __setRaw: (key: string, value: string) => void;
  getItem: ((key: string) => Promise<string | null>) & { mockRejectedValueOnce: (error: Error) => void };
};

async function asyncStorageMock(): Promise<StorageMock> {
  return (await import('@react-native-async-storage/async-storage')).default as unknown as StorageMock;
}

describe('dimension-lock-store', () => {
  beforeEach(async () => {
    vi.resetModules();
    (await asyncStorageMock()).__reset();
  });

  it('loads no locks when nothing is stored', async () => {
    const { loadDimensionLocks } = await import('../dimension-lock-store');
    await expect(loadDimensionLocks()).resolves.toEqual({ tall: false, wide: false });
  });

  it('loads persisted locks', async () => {
    (await asyncStorageMock()).__setRaw(STORAGE_KEY, JSON.stringify({ tall: true }));
    const { loadDimensionLocks } = await import('../dimension-lock-store');
    await expect(loadDimensionLocks()).resolves.toEqual({ tall: true, wide: false });
  });

  it('ignores a malformed (non-boolean) persisted payload', async () => {
    (await asyncStorageMock()).__setRaw(STORAGE_KEY, JSON.stringify({ tall: 'yes', wide: 1 }));
    const { loadDimensionLocks } = await import('../dimension-lock-store');
    await expect(loadDimensionLocks()).resolves.toEqual({ tall: false, wide: false });
  });

  it('sets and persists a lock', async () => {
    const { setDimensionLock, loadDimensionLocks } = await import('../dimension-lock-store');
    setDimensionLock('wide', true);
    await expect(loadDimensionLocks()).resolves.toEqual({ tall: false, wide: true });
    await expect((await asyncStorageMock()).getItem(STORAGE_KEY)).resolves.toBe(JSON.stringify({ wide: true }));
  });

  it('sets one lock without disturbing the other', async () => {
    const { setDimensionLock, loadDimensionLocks } = await import('../dimension-lock-store');
    setDimensionLock('tall', true);
    setDimensionLock('wide', false);
    await expect(loadDimensionLocks()).resolves.toEqual({ tall: true, wide: false });
  });

  it('keeps a racing lock AND the persisted other-key on a load that loses the race', async () => {
    (await asyncStorageMock()).__setRaw(STORAGE_KEY, JSON.stringify({ wide: true }));
    const { setDimensionLock, loadDimensionLocks } = await import('../dimension-lock-store');
    // Start the load, then lock Tall before the storage read resolves.
    const pendingLoad = loadDimensionLocks();
    setDimensionLock('tall', true);
    await pendingLoad;
    // The racing Tall survives alongside the persisted Wide (a plain replace would
    // have dropped one of them).
    await expect(loadDimensionLocks()).resolves.toEqual({ tall: true, wide: true });
  });

  it('keeps a racing UNLOCK over the persisted lock (no re-lock)', async () => {
    (await asyncStorageMock()).__setRaw(STORAGE_KEY, JSON.stringify({ tall: true }));
    const { setDimensionLock, loadDimensionLocks } = await import('../dimension-lock-store');
    const pendingLoad = loadDimensionLocks();
    setDimensionLock('tall', false); // explicit unlock during the load
    await pendingLoad;
    // The explicit unlock wins over the persisted lock — the override bag tracks
    // "set false", not merely "set true", so the merge can't re-lock it.
    await expect(loadDimensionLocks()).resolves.toEqual({ tall: false, wide: false });
  });

  it('reads persisted locks when a setter ran before the first load, without clobbering storage', async () => {
    (await asyncStorageMock()).__setRaw(STORAGE_KEY, JSON.stringify({ wide: true }));
    const { setDimensionLock, loadDimensionLocks } = await import('../dimension-lock-store');
    // A direct caller (the export is public) locks Tall before anything triggers
    // the one-time storage read. The setter must NOT short-circuit the read nor
    // persist its partial {tall:true} bag over the persisted {wide:true}.
    setDimensionLock('tall', true);
    // The read still happens and merges: the persisted Wide survives next to Tall.
    await expect(loadDimensionLocks()).resolves.toEqual({ tall: true, wide: true });
    // ...and storage holds the merged set, not the partial bag the setter knew.
    await expect((await asyncStorageMock()).getItem(STORAGE_KEY)).resolves.toBe(
      JSON.stringify({ wide: true, tall: true }),
    );
  });

  it('retries the read after a failed load (does not cache the failure)', async () => {
    const storageMock = await asyncStorageMock();
    storageMock.getItem.mockRejectedValueOnce(new Error('storage unavailable'));
    const { loadDimensionLocks } = await import('../dimension-lock-store');
    await expect(loadDimensionLocks()).rejects.toThrow('storage unavailable');
    storageMock.__setRaw(STORAGE_KEY, JSON.stringify({ wide: true }));
    await expect(loadDimensionLocks()).resolves.toEqual({ tall: false, wide: true });
  });
});

describe('shouldPinDimension', () => {
  it('pins only when the chip is visible, locked, and not already active', async () => {
    const { shouldPinDimension } = await import('../dimension-lock-store');
    expect(shouldPinDimension(true, true, false)).toBe(true);
  });

  it('does not pin when unlocked, chip-hidden, or already active', async () => {
    const { shouldPinDimension } = await import('../dimension-lock-store');
    expect(shouldPinDimension(true, false, false)).toBe(false); // unlocked
    expect(shouldPinDimension(false, true, false)).toBe(false); // board doesn't support the chip
    expect(shouldPinDimension(true, true, true)).toBe(false); // already active → no redundant re-pin
  });
});
