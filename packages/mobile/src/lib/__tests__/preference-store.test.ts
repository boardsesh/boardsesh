import { describe, it, expect, vi, beforeEach } from 'vitest';

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
      getAllKeys: vi.fn(async () => Object.keys(storage)),
      removeMany: vi.fn(async (keys: string[]) => {
        keys.forEach((key) => delete storage[key]);
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

describe('preference-store', () => {
  beforeEach(async () => {
    vi.resetModules();
    const asyncStorage = (await import('@react-native-async-storage/async-storage')).default as unknown as {
      __reset: () => void;
    };
    asyncStorage.__reset();
  });

  it('round-trips a string value', async () => {
    const { getPreference, setPreference } = await import('../preference-store');
    await setPreference('k', 'hello');
    await expect(getPreference<string>('k')).resolves.toBe('hello');
  });

  it('round-trips an object value', async () => {
    const { getPreference, setPreference } = await import('../preference-store');
    const value = { backend: 'wss://example' as string, retries: 3 };
    await setPreference('cfg', value);
    await expect(getPreference<typeof value>('cfg')).resolves.toEqual(value);
  });

  it('returns null for a missing key', async () => {
    const { getPreference } = await import('../preference-store');
    await expect(getPreference('absent')).resolves.toBeNull();
  });

  it('returns null on a parse error rather than throwing', async () => {
    const asyncStorage = (await import('@react-native-async-storage/async-storage')).default as unknown as {
      __setRaw: (key: string, value: string) => void;
    };
    asyncStorage.__setRaw('corrupt', '{not json');

    const { getPreference } = await import('../preference-store');
    await expect(getPreference('corrupt')).resolves.toBeNull();
  });

  it('propagates a storage read rejection so a one-time-load store can retry after unlock (#3610)', async () => {
    // iOS denies the backing-file read on a background launch before first unlock
    // ("Failed to get values for keys"). getPreference deliberately does NOT swallow
    // it: the rejection propagates so stores can distinguish "read failed" from "no
    // value" and retry. Consumers own the catch (their load singleton clears the
    // rejected promise + call sites `.catch`) so nothing floats into error tracking.
    const asyncStorage = (await import('@react-native-async-storage/async-storage')).default as unknown as {
      getItem: { mockRejectedValueOnce: (error: Error) => void };
    };
    asyncStorage.getItem.mockRejectedValueOnce(new Error('Failed to get values for keys'));

    const { getPreference } = await import('../preference-store');
    await expect(getPreference('locked')).rejects.toThrow('Failed to get values for keys');
  });

  it('removePreference deletes the key', async () => {
    const { getPreference, setPreference, removePreference } = await import('../preference-store');
    await setPreference('k', 1);
    await expect(getPreference<number>('k')).resolves.toBe(1);
    await removePreference('k');
    await expect(getPreference('k')).resolves.toBeNull();
  });

  it('removePreferencesMatching deletes only matching keys', async () => {
    const { getPreference, removePreferencesMatching, setPreference } = await import('../preference-store');
    await setPreference('draft:first', 1);
    await setPreference('draft:second', 2);
    await setPreference('unrelated', 3);

    await removePreferencesMatching((key) => key.startsWith('draft:'));

    await expect(getPreference('draft:first')).resolves.toBeNull();
    await expect(getPreference('draft:second')).resolves.toBeNull();
    await expect(getPreference('unrelated')).resolves.toBe(3);
  });
});
