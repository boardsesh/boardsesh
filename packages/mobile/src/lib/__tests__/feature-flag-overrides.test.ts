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

const STORAGE_KEY = 'featureFlagOverrides';

describe('feature-flag-overrides', () => {
  beforeEach(async () => {
    vi.resetModules();
    const asyncStorage = (await import('@react-native-async-storage/async-storage')).default as unknown as {
      __reset: () => void;
    };
    asyncStorage.__reset();
  });

  it('loads an empty bag when nothing is stored', async () => {
    const { loadFeatureFlagOverrides } = await import('../feature-flag-overrides');
    await expect(loadFeatureFlagOverrides()).resolves.toEqual({});
  });

  it('loads persisted overrides', async () => {
    const asyncStorage = (await import('@react-native-async-storage/async-storage')).default as unknown as {
      __setRaw: (key: string, value: string) => void;
    };
    asyncStorage.__setRaw(STORAGE_KEY, JSON.stringify({ 'strava-integration': true }));

    const { loadFeatureFlagOverrides } = await import('../feature-flag-overrides');
    await expect(loadFeatureFlagOverrides()).resolves.toEqual({ 'strava-integration': true });
  });

  it('ignores a malformed (non-boolean) persisted payload', async () => {
    const asyncStorage = (await import('@react-native-async-storage/async-storage')).default as unknown as {
      __setRaw: (key: string, value: string) => void;
    };
    asyncStorage.__setRaw(STORAGE_KEY, JSON.stringify({ 'strava-integration': 'yes' }));

    const { loadFeatureFlagOverrides } = await import('../feature-flag-overrides');
    await expect(loadFeatureFlagOverrides()).resolves.toEqual({});
  });

  it('sets and persists an override', async () => {
    const { setFeatureFlagOverride, loadFeatureFlagOverrides } = await import('../feature-flag-overrides');
    setFeatureFlagOverride('strava-integration', false);
    await expect(loadFeatureFlagOverrides()).resolves.toEqual({ 'strava-integration': false });

    const asyncStorage = (await import('@react-native-async-storage/async-storage')).default as unknown as {
      getItem: (key: string) => Promise<string | null>;
    };
    await expect(asyncStorage.getItem(STORAGE_KEY)).resolves.toBe(JSON.stringify({ 'strava-integration': false }));
  });

  it('clears a single override, leaving others', async () => {
    const { setFeatureFlagOverride, clearFeatureFlagOverride, loadFeatureFlagOverrides } =
      await import('../feature-flag-overrides');
    setFeatureFlagOverride('flag-a', true);
    setFeatureFlagOverride('flag-b', false);
    clearFeatureFlagOverride('flag-a');
    await expect(loadFeatureFlagOverrides()).resolves.toEqual({ 'flag-b': false });
  });

  it('clears all overrides', async () => {
    const { setFeatureFlagOverride, clearAllFeatureFlagOverrides, loadFeatureFlagOverrides } =
      await import('../feature-flag-overrides');
    setFeatureFlagOverride('flag-a', true);
    setFeatureFlagOverride('flag-b', true);
    clearAllFeatureFlagOverrides();
    await expect(loadFeatureFlagOverrides()).resolves.toEqual({});
  });

  it('removes the storage key (not an empty bag) on clear-all', async () => {
    const asyncStorage = (await import('@react-native-async-storage/async-storage')).default as unknown as {
      getItem: (key: string) => Promise<string | null>;
    };
    const { setFeatureFlagOverride, clearAllFeatureFlagOverrides } = await import('../feature-flag-overrides');
    setFeatureFlagOverride('flag-a', true);
    clearAllFeatureFlagOverrides();
    await expect(asyncStorage.getItem(STORAGE_KEY)).resolves.toBeNull();
  });

  it('merges a mutator that races the load on top of the persisted bag', async () => {
    const asyncStorage = (await import('@react-native-async-storage/async-storage')).default as unknown as {
      __setRaw: (key: string, value: string) => void;
    };
    asyncStorage.__setRaw(STORAGE_KEY, JSON.stringify({ 'flag-a': true }));

    const { setFeatureFlagOverride, loadFeatureFlagOverrides } = await import('../feature-flag-overrides');
    // Start the load, then set an override before the storage read resolves.
    const pendingLoad = loadFeatureFlagOverrides();
    setFeatureFlagOverride('flag-b', false);
    await pendingLoad;

    // The persisted flag-a survives alongside the racing flag-b (a plain replace
    // would have dropped flag-a).
    await expect(loadFeatureFlagOverrides()).resolves.toEqual({ 'flag-a': true, 'flag-b': false });
  });

  it('retries the read after a failed load (does not cache the failure)', async () => {
    const asyncStorage = (await import('@react-native-async-storage/async-storage')).default as unknown as {
      getItem: { mockRejectedValueOnce: (error: Error) => void };
      __setRaw: (key: string, value: string) => void;
    };
    asyncStorage.getItem.mockRejectedValueOnce(new Error('storage unavailable'));

    const { loadFeatureFlagOverrides } = await import('../feature-flag-overrides');
    await expect(loadFeatureFlagOverrides()).rejects.toThrow('storage unavailable');

    // The failed read left `hasLoaded` false, so the next attempt reads fresh
    // instead of staying stuck at the default until restart.
    asyncStorage.__setRaw(STORAGE_KEY, JSON.stringify({ 'flag-a': true }));
    await expect(loadFeatureFlagOverrides()).resolves.toEqual({ 'flag-a': true });
  });
});
