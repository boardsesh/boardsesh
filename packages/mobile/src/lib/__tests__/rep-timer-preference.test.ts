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

type MockAsyncStorage = {
  getItem: (key: string) => Promise<string | null>;
  __reset: () => void;
  __setRaw: (key: string, value: string) => void;
};

async function getAsyncStorage(): Promise<MockAsyncStorage> {
  return (await import('@react-native-async-storage/async-storage')).default as unknown as MockAsyncStorage;
}

describe('rep-timer-preference', () => {
  beforeEach(async () => {
    vi.resetModules();
    (await getAsyncStorage()).__reset();
  });

  it('defaults to 3 minutes when no preference is stored', async () => {
    const { loadRepTimerPreference } = await import('../rep-timer-preference');
    await expect(loadRepTimerPreference()).resolves.toBe(180);
  });

  it('loads a stored timer target', async () => {
    (await getAsyncStorage()).__setRaw('repTimerPreference', JSON.stringify(300));

    const { loadRepTimerPreference } = await import('../rep-timer-preference');
    await expect(loadRepTimerPreference()).resolves.toBe(300);
  });

  it('loads the stored timer off sentinel', async () => {
    (await getAsyncStorage()).__setRaw('repTimerPreference', JSON.stringify('off'));

    const { loadRepTimerPreference } = await import('../rep-timer-preference');
    await expect(loadRepTimerPreference()).resolves.toBeNull();
  });

  it('falls back to 3 minutes for invalid stored values', async () => {
    (await getAsyncStorage()).__setRaw('repTimerPreference', JSON.stringify('invalid'));

    const { loadRepTimerPreference } = await import('../rep-timer-preference');
    await expect(loadRepTimerPreference()).resolves.toBe(180);
  });

  it('persists the timer off sentinel', async () => {
    const asyncStorage = await getAsyncStorage();
    const { loadRepTimerPreference, setRepTimerTargetPreference } = await import('../rep-timer-preference');

    await setRepTimerTargetPreference(null);

    await expect(loadRepTimerPreference()).resolves.toBeNull();
    await expect(asyncStorage.getItem('repTimerPreference')).resolves.toBe(JSON.stringify('off'));
  });
});
