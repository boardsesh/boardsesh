import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    const marker = { provider: 'google' as const, attemptedAt: 999_000, isRegistration: false };

    await setOAuthPending(marker);

    await expect(consumeFreshOAuthPending()).resolves.toEqual(marker);
    await expect(consumeFreshOAuthPending()).resolves.toBeNull();
  });

  it('discards an expired marker', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const { consumeFreshOAuthPending, setOAuthPending } = await import('../oauth-pending-store');
    await setOAuthPending({
      provider: 'apple',
      attemptedAt: 1_000_000 - 5 * 60 * 1000 - 1,
      isRegistration: true,
    });

    await expect(consumeFreshOAuthPending()).resolves.toBeNull();
  });
});
