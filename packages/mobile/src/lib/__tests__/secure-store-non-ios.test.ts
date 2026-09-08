import { describe, it, expect, vi, beforeEach } from 'vitest';

// The other half of #4103: what the namespace helpers do when there is no v2
// namespace. The whole design rests on the claim that Android and expo-web keep
// byte-for-byte their pre-PR behaviour — one SecureStore call per operation,
// against the default service, with no keychainService attribute anywhere. Every
// other suite in this directory sets EXPO_OS to 'ios', so nothing was pinning
// that claim; a future edit could drop the USES_V2_NAMESPACE gates and only iOS
// tests would notice.
//
// The gates matter more on Android than the "harmless extra call" framing
// suggests. keychainService there selects the KeyStore alias AND the
// SharedPreferences storage key (SecureStoreOptions.kt:12, SecureStoreModule.kt:92,
// 102, 179), so a v2 service reaching Android would strand every existing value
// behind a name nothing reads.
const AFTER_FIRST_UNLOCK = 'after-first-unlock';

// babel-preset-expo replaces this at build time. 'android' here selects the
// non-iOS branch of USES_V2_NAMESPACE; expo-web takes the same branch.
process.env.EXPO_OS = 'android';

// No keychainService — the default service, exactly as before this PR.
const LEGACY_OPTIONS = { keychainAccessible: AFTER_FIRST_UNLOCK };

vi.mock('expo-secure-store', () => {
  let storage: Record<string, string> = {};
  const rejectingKeys = new Set<string>();

  return {
    AFTER_FIRST_UNLOCK,
    getItemAsync: vi.fn(async (key: string) => storage[key] ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => {
      if (rejectingKeys.has(key)) throw new Error('write failed');
      storage[key] = value;
    }),
    deleteItemAsync: vi.fn(async (key: string) => {
      delete storage[key];
    }),
    __seed: (key: string, value: string) => {
      storage[key] = value;
    },
    __get: (key: string) => storage[key] ?? null,
    __failWriteFor: (key: string) => rejectingKeys.add(key),
    __reset: () => {
      storage = {};
      rejectingKeys.clear();
    },
  };
});

vi.mock('../analytics', () => ({ track: vi.fn() }));

type SecureStoreFake = {
  __seed: (key: string, value: string) => void;
  __get: (key: string) => string | null;
  __failWriteFor: (key: string) => void;
  __reset: () => void;
  getItemAsync: ReturnType<typeof vi.fn>;
  setItemAsync: ReturnType<typeof vi.fn>;
  deleteItemAsync: ReturnType<typeof vi.fn>;
};

async function secureStore(): Promise<SecureStoreFake> {
  return (await import('expo-secure-store')) as unknown as SecureStoreFake;
}

beforeEach(async () => {
  vi.resetModules();
  (await secureStore()).__reset();
  vi.clearAllMocks();
});

describe('secure-store-io off iOS', () => {
  it('exposes no v2 keychain service at all', async () => {
    const { SECURE_STORE_V2_OPTIONS, USES_V2_NAMESPACE } = await import('../secure-store-options');

    expect(USES_V2_NAMESPACE).toBe(false);
    expect(SECURE_STORE_V2_OPTIONS).toEqual(LEGACY_OPTIONS);
    expect('keychainService' in SECURE_STORE_V2_OPTIONS).toBe(false);
  });

  it('reads once, against the default service', async () => {
    const store = await secureStore();
    store.__seed('boardsesh_jwt', 'token-1');
    const { readSecureValue } = await import('../secure-store-io');

    await expect(readSecureValue('boardsesh_jwt')).resolves.toBe('token-1');

    expect(store.getItemAsync).toHaveBeenCalledTimes(1);
    expect(store.getItemAsync).toHaveBeenCalledWith('boardsesh_jwt', LEGACY_OPTIONS);
  });

  it('reads once even on a miss, instead of falling through to a second lookup', async () => {
    const store = await secureStore();
    const { readSecureValue } = await import('../secure-store-io');

    await expect(readSecureValue('boardsesh_jwt')).resolves.toBeNull();

    // The iOS path would try legacy here. Off iOS both namespaces are the same
    // item, so a second call could only ever return the same null.
    expect(store.getItemAsync).toHaveBeenCalledTimes(1);
  });

  it('writes once, with no mirror', async () => {
    const store = await secureStore();
    const { writeSecureValue } = await import('../secure-store-io');

    await writeSecureValue('boardsesh_jwt', 'token-1');

    expect(store.setItemAsync).toHaveBeenCalledTimes(1);
    expect(store.setItemAsync).toHaveBeenCalledWith('boardsesh_jwt', 'token-1', LEGACY_OPTIONS);
    expect(store.__get('boardsesh_jwt')).toBe('token-1');
  });

  it('deletes once, with no second namespace to clear', async () => {
    const store = await secureStore();
    store.__seed('boardsesh_jwt', 'token-1');
    const { deleteSecureValue } = await import('../secure-store-io');

    await deleteSecureValue('boardsesh_jwt');

    expect(store.deleteItemAsync).toHaveBeenCalledTimes(1);
    expect(store.deleteItemAsync).toHaveBeenCalledWith('boardsesh_jwt', LEGACY_OPTIONS);
    expect(store.__get('boardsesh_jwt')).toBeNull();
  });

  it('writes the tombstone once and still surfaces a rejection', async () => {
    const store = await secureStore();
    const { writeSecureValueToEitherNamespace, SecureStoreWriteError } = await import('../secure-store-io');

    await writeSecureValueToEitherNamespace('boardsesh_jwt', 'cleared');
    expect(store.setItemAsync).toHaveBeenCalledTimes(1);
    expect(store.__get('boardsesh_jwt')).toBe('cleared');

    // With one namespace there is no "either": the single write failing is the
    // whole operation failing, and clearStoredCredential must still hear about
    // it rather than reporting a sign-out that did not happen.
    store.__failWriteFor('boardsesh_refresh_token');
    await expect(writeSecureValueToEitherNamespace('boardsesh_refresh_token', 'cleared')).rejects.toBeInstanceOf(
      SecureStoreWriteError,
    );
  });
});

describe('migrateSecureKeysToV2 off iOS', () => {
  it('does nothing at all — no outcomes and no keychain calls', async () => {
    const store = await secureStore();
    store.__seed('boardsesh_jwt', 'token-1');
    const { migrateSecureKeysToV2 } = await import('../keychain-namespace-migration');

    await expect(migrateSecureKeysToV2(['boardsesh_jwt'], 'auth')).resolves.toEqual([]);

    expect(store.getItemAsync).not.toHaveBeenCalled();
    expect(store.setItemAsync).not.toHaveBeenCalled();
    expect(store.deleteItemAsync).not.toHaveBeenCalled();
  });

  it('reports nothing to analytics, so no Android device emits a migration event', async () => {
    const { migrateSecureKeysToV2 } = await import('../keychain-namespace-migration');
    const { track } = await import('../analytics');

    await migrateSecureKeysToV2(['boardsesh_jwt'], 'auth');

    expect(track).not.toHaveBeenCalled();
  });
});
