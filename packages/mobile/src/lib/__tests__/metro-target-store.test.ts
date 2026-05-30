import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('expo-secure-store', () => {
  let storage: Record<string, string> = {};
  return {
    getItemAsync: vi.fn(async (key: string) => storage[key] ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => {
      storage[key] = value;
    }),
    deleteItemAsync: vi.fn(async (key: string) => {
      delete storage[key];
    }),
    __reset: () => {
      storage = {};
    },
    __setRaw: (key: string, value: string) => {
      storage[key] = value;
    },
    __getRaw: (key: string) => storage[key],
  };
});

describe('metro-target-store', () => {
  beforeEach(async () => {
    vi.resetModules();
    const store = await import('expo-secure-store');
    (store as unknown as { __reset: () => void }).__reset();
  });

  it('normalizes and deduplicates saved targets', async () => {
    const { addSavedMetroTarget, getSavedMetroTargets } = await import('../metro-target-store');

    await addSavedMetroTarget('HOST-A.example');
    await addSavedMetroTarget('http://host-a.example:8084/foo');
    await addSavedMetroTarget('host-a.example');

    await expect(getSavedMetroTargets()).resolves.toEqual(['host-a.example', 'http://host-a.example:8084']);
  });

  it('removes saved targets', async () => {
    const { addSavedMetroTarget, getSavedMetroTargets, removeSavedMetroTarget } = await import('../metro-target-store');

    await addSavedMetroTarget('host-a.example');
    await addSavedMetroTarget('host-b.example');
    await removeSavedMetroTarget('host-a.example');

    await expect(getSavedMetroTargets()).resolves.toEqual(['host-b.example']);
  });

  it('normalizes the input on remove so non-normalized callers still match', async () => {
    const { addSavedMetroTarget, getSavedMetroTargets, removeSavedMetroTarget } = await import('../metro-target-store');

    // Add via the canonical form
    await addSavedMetroTarget('host-a.example');
    // Remove via a non-normalized form (uppercase, trailing slash, URL path).
    // Without normalization the predicate would compare raw against stored
    // and silently no-op.
    await removeSavedMetroTarget('HOST-A.example');

    await expect(getSavedMetroTargets()).resolves.toEqual([]);
  });

  it('also accepts URL-form remove values that normalize to a stored URL', async () => {
    const { addSavedMetroTarget, getSavedMetroTargets, removeSavedMetroTarget } = await import('../metro-target-store');

    await addSavedMetroTarget('http://host-a.example:8084');
    await removeSavedMetroTarget('http://host-a.example:8084/foo');

    await expect(getSavedMetroTargets()).resolves.toEqual([]);
  });

  it('throws for invalid targets', async () => {
    const { addSavedMetroTarget } = await import('../metro-target-store');

    await expect(addSavedMetroTarget('https://host-a.example:8081')).rejects.toThrow('Enter a host');
  });

  it('moves a re-added target to the front of the list', async () => {
    const { addSavedMetroTarget, getSavedMetroTargets } = await import('../metro-target-store');

    await addSavedMetroTarget('host-a.example');
    await addSavedMetroTarget('host-b.example');
    await addSavedMetroTarget('host-c.example');
    await addSavedMetroTarget('host-a.example');

    await expect(getSavedMetroTargets()).resolves.toEqual(['host-a.example', 'host-c.example', 'host-b.example']);
  });

  it('caps the saved list at 20 entries', async () => {
    const { addSavedMetroTarget, getSavedMetroTargets } = await import('../metro-target-store');

    for (let i = 0; i < 25; i++) {
      await addSavedMetroTarget(`host-${i}.example`);
    }
    const targets = await getSavedMetroTargets();
    expect(targets).toHaveLength(20);
    expect(targets[0]).toBe('host-24.example');
    expect(targets.at(-1)).toBe('host-5.example');
  });

  it('preserves all concurrent writes (no lost-update race)', async () => {
    const { addSavedMetroTarget, getSavedMetroTargets } = await import('../metro-target-store');

    await Promise.all([
      addSavedMetroTarget('host-a.example'),
      addSavedMetroTarget('host-b.example'),
      addSavedMetroTarget('host-c.example'),
    ]);

    const targets = await getSavedMetroTargets();
    expect(targets.sort()).toEqual(['host-a.example', 'host-b.example', 'host-c.example'].sort());
  });

  it('refuses to overwrite a corrupted stored value', async () => {
    const store = (await import('expo-secure-store')) as unknown as {
      __setRaw: (key: string, value: string) => void;
      __getRaw: (key: string) => string;
    };
    store.__setRaw('boardsesh_dev_metro_hosts', '{not json');

    const { addSavedMetroTarget } = await import('../metro-target-store');
    await expect(addSavedMetroTarget('host-a.example')).rejects.toThrow(/corrupted/i);
    expect(store.__getRaw('boardsesh_dev_metro_hosts')).toBe('{not json');
  });

  it('returns an empty list (without wiping storage) when stored value is non-array', async () => {
    const store = (await import('expo-secure-store')) as unknown as {
      __setRaw: (key: string, value: string) => void;
      __getRaw: (key: string) => string;
    };
    store.__setRaw('boardsesh_dev_metro_hosts', '"a string"');

    const { getSavedMetroTargets } = await import('../metro-target-store');
    await expect(getSavedMetroTargets()).resolves.toEqual([]);
    expect(store.__getRaw('boardsesh_dev_metro_hosts')).toBe('"a string"');
  });
});
