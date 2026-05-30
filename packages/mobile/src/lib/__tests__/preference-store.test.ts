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

  it('removePreference deletes the key', async () => {
    const { getPreference, setPreference, removePreference } = await import('../preference-store');
    await setPreference('k', 1);
    await expect(getPreference<number>('k')).resolves.toBe(1);
    await removePreference('k');
    await expect(getPreference('k')).resolves.toBeNull();
  });
});
