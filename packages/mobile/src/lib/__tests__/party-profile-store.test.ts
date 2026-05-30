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
    __throwNext: () => {},
  };
});

describe('partyProfileStorage', () => {
  beforeEach(async () => {
    vi.resetModules();
    const secureStore = (await import('expo-secure-store')) as unknown as { __reset: () => void };
    secureStore.__reset();
  });

  it('round-trips a profile via SecureStore', async () => {
    const { partyProfileStorage } = await import('../party-profile-store');

    await partyProfileStorage.set({ id: 'uuid-1' });
    await expect(partyProfileStorage.get()).resolves.toEqual({ id: 'uuid-1' });
  });

  it('returns null when nothing is stored', async () => {
    const { partyProfileStorage } = await import('../party-profile-store');
    await expect(partyProfileStorage.get()).resolves.toBeNull();
  });

  it('returns null on a parse error rather than throwing', async () => {
    const secureStore = (await import('expo-secure-store')) as unknown as {
      __setRaw: (key: string, value: string) => void;
    };
    secureStore.__setRaw('boardsesh_party_profile', '{not json');

    const { partyProfileStorage } = await import('../party-profile-store');
    await expect(partyProfileStorage.get()).resolves.toBeNull();
  });

  it('returns null when stored value is missing the id field', async () => {
    const secureStore = (await import('expo-secure-store')) as unknown as {
      __setRaw: (key: string, value: string) => void;
    };
    secureStore.__setRaw('boardsesh_party_profile', JSON.stringify({ name: 'no-id' }));

    const { partyProfileStorage } = await import('../party-profile-store');
    await expect(partyProfileStorage.get()).resolves.toBeNull();
  });

  it('returns null when SecureStore.getItemAsync throws', async () => {
    const secureStore = (await import('expo-secure-store')) as unknown as {
      getItemAsync: ReturnType<typeof vi.fn>;
    };
    secureStore.getItemAsync.mockImplementationOnce(async () => {
      throw new Error('keychain locked');
    });

    const { partyProfileStorage } = await import('../party-profile-store');
    await expect(partyProfileStorage.get()).resolves.toBeNull();
  });
});
