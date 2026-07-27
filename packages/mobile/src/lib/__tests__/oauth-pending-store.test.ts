import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => {
  let storage: Record<string, string> = {};
  let failNextRemove = false;
  return {
    default: {
      getItem: vi.fn(async (key: string) => storage[key] ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        storage[key] = value;
      }),
      removeItem: vi.fn(async (key: string) => {
        if (failNextRemove) {
          failNextRemove = false;
          throw new Error('storage unavailable');
        }
        delete storage[key];
      }),
      getAllKeys: vi.fn(async () => Object.keys(storage)),
      removeMany: vi.fn(async (keys: string[]) => {
        keys.forEach((key) => delete storage[key]);
      }),
      __reset: () => {
        storage = {};
        failNextRemove = false;
      },
      __failNextRemove: () => {
        failNextRemove = true;
      },
    },
  };
});

describe('oauth-pending-store', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.useRealTimers();
    const asyncStorage = (await import('@react-native-async-storage/async-storage')).default as unknown as {
      __reset: () => void;
    };
    asyncStorage.__reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('consumes a fresh marker once', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const { consumeFreshOAuthPending, setOAuthPending } = await import('../oauth-pending-store');
    const marker = {
      attemptId: 'attempt-google-1',
      provider: 'google' as const,
      attemptedAt: 999_000,
      isRegistration: false,
    };

    await setOAuthPending(marker);

    await expect(consumeFreshOAuthPending(marker.attemptId)).resolves.toEqual(marker);
    await expect(consumeFreshOAuthPending(marker.attemptId)).resolves.toBeNull();
  });

  it('discards an expired marker', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const { consumeFreshOAuthPending, setOAuthPending } = await import('../oauth-pending-store');
    await setOAuthPending({
      attemptId: 'attempt-apple-1',
      provider: 'apple',
      attemptedAt: 1_000_000 - 5 * 60 * 1000 - 1,
      isRegistration: true,
    });

    await expect(consumeFreshOAuthPending('attempt-apple-1')).resolves.toBeNull();
  });

  it('returns a fresh marker when one-time cleanup fails', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const asyncStorage = (await import('@react-native-async-storage/async-storage')).default as unknown as {
      __failNextRemove: () => void;
    };
    asyncStorage.__failNextRemove();
    const { consumeFreshOAuthPending, setOAuthPending } = await import('../oauth-pending-store');
    const marker = {
      attemptId: 'attempt-apple-2',
      provider: 'apple' as const,
      attemptedAt: 999_000,
      isRegistration: false,
    };

    await setOAuthPending(marker);

    await expect(consumeFreshOAuthPending(marker.attemptId)).resolves.toEqual(marker);
  });

  it('keeps concurrent attempts isolated', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const { consumeFreshOAuthPending, setOAuthPending } = await import('../oauth-pending-store');
    const google = {
      attemptId: 'attempt-google-2',
      provider: 'google' as const,
      attemptedAt: 999_000,
      isRegistration: false,
    };
    const apple = {
      attemptId: 'attempt-apple-3',
      provider: 'apple' as const,
      attemptedAt: 999_500,
      isRegistration: true,
    };
    await setOAuthPending(google);
    await setOAuthPending(apple);

    await expect(consumeFreshOAuthPending(apple.attemptId)).resolves.toEqual(apple);
    await expect(consumeFreshOAuthPending(google.attemptId)).resolves.toEqual(google);
  });
});
