import { describe, it, expect, vi, beforeEach } from 'vitest';

// secure-store-io + auth-store against a keychain fake that models the two
// properties which drive the #4103 design:
//   * an item is identified by (key, keychainService), so v2 and legacy are
//     genuinely separate items
//   * deletion never reports failure — expo-secure-store's iOS
//     deleteValueWithKeyAsync discards every SecItemDelete status and never
//     throws, so a delete that silently did nothing is indistinguishable from
//     one that worked
const AFTER_FIRST_UNLOCK = 'after-first-unlock';
const V2_SERVICE = 'boardsesh.v2';
const LEGACY_SERVICE = 'app';

process.env.EXPO_OS = 'ios';

vi.mock('expo-secure-store', () => {
  const items = new Map<string, string>();
  const lockedServices = new Set<string>();
  const undeletableServices = new Set<string>();

  const serviceOf = (options?: { keychainService?: string }) => options?.keychainService ?? LEGACY_SERVICE;
  const itemKey = (key: string, options?: { keychainService?: string }) => `${serviceOf(options)}::${key}`;

  return {
    AFTER_FIRST_UNLOCK,
    getItemAsync: vi.fn(async (key: string, options?: { keychainService?: string }) => {
      if (lockedServices.has(serviceOf(options))) throw new Error('User interaction is not allowed.');
      return items.get(itemKey(key, options)) ?? null;
    }),
    setItemAsync: vi.fn(async (key: string, value: string, options?: { keychainService?: string }) => {
      if (lockedServices.has(serviceOf(options))) throw new Error('User interaction is not allowed.');
      items.set(itemKey(key, options), value);
    }),
    deleteItemAsync: vi.fn(async (key: string, options?: { keychainService?: string }) => {
      // Never throws, exactly like the real module.
      if (undeletableServices.has(serviceOf(options))) return;
      items.delete(itemKey(key, options));
    }),
    __seed: (service: string, key: string, value: string) => items.set(`${service}::${key}`, value),
    __get: (service: string, key: string) => items.get(`${service}::${key}`) ?? null,
    __lockService: (service: string) => lockedServices.add(service),
    __makeUndeletable: (service: string) => undeletableServices.add(service),
    __reset: () => {
      items.clear();
      lockedServices.clear();
      undeletableServices.clear();
    },
  };
});

vi.mock('../analytics', () => ({ track: vi.fn() }));

type SecureStoreFake = {
  __seed: (service: string, key: string, value: string) => void;
  __get: (service: string, key: string) => string | null;
  __lockService: (service: string) => void;
  __makeUndeletable: (service: string) => void;
  __reset: () => void;
  getItemAsync: ReturnType<typeof vi.fn>;
};

async function secureStore(): Promise<SecureStoreFake> {
  return (await import('expo-secure-store')) as unknown as SecureStoreFake;
}

beforeEach(async () => {
  vi.resetModules();
  (await secureStore()).__reset();
  vi.clearAllMocks();
});

describe('readSecureValue', () => {
  it('prefers v2 and never touches the legacy namespace once a key has migrated', async () => {
    const store = await secureStore();
    store.__seed(V2_SERVICE, 'k', 'v2-value');
    store.__seed(LEGACY_SERVICE, 'k', 'legacy-value');
    // The legacy namespace is what rejects on a locked device. If the read still
    // consulted it after a v2 hit, the whole fix would be inert.
    store.__lockService(LEGACY_SERVICE);
    const { readSecureValue } = await import('../secure-store-io');

    await expect(readSecureValue('k')).resolves.toBe('v2-value');
  });

  it('falls back to legacy for a key that has not migrated yet', async () => {
    const store = await secureStore();
    store.__seed(LEGACY_SERVICE, 'k', 'legacy-value');
    const { readSecureValue } = await import('../secure-store-io');

    await expect(readSecureValue('k')).resolves.toBe('legacy-value');
  });
});

describe('writeSecureValue', () => {
  it('mirrors into legacy so an OTA rollback still finds the value', async () => {
    const store = await secureStore();
    const { writeSecureValue } = await import('../secure-store-io');

    await writeSecureValue('k', 'fresh');

    expect(store.__get(V2_SERVICE, 'k')).toBe('fresh');
    expect(store.__get(LEGACY_SERVICE, 'k')).toBe('fresh');
  });

  it('still succeeds when the legacy mirror rejects on a locked device', async () => {
    const store = await secureStore();
    store.__lockService(LEGACY_SERVICE);
    const { writeSecureValue } = await import('../secure-store-io');

    await expect(writeSecureValue('k', 'fresh')).resolves.toBeUndefined();
    expect(store.__get(V2_SERVICE, 'k')).toBe('fresh');
  });
});

describe('deleteSecureValue', () => {
  it('clears both namespaces', async () => {
    const store = await secureStore();
    store.__seed(V2_SERVICE, 'k', 'a');
    store.__seed(LEGACY_SERVICE, 'k', 'b');
    const { deleteSecureValue } = await import('../secure-store-io');

    await deleteSecureValue('k');

    expect(store.__get(V2_SERVICE, 'k')).toBeNull();
    expect(store.__get(LEGACY_SERVICE, 'k')).toBeNull();
  });
});

describe('auth-store over the v2 namespace', () => {
  it('migrates a pre-fix credential on the first read and returns it', async () => {
    const store = await secureStore();
    store.__seed(LEGACY_SERVICE, 'boardsesh_jwt', 'legacy-jwt');
    const { getAuthToken } = await import('../auth-store');

    await expect(getAuthToken()).resolves.toBe('legacy-jwt');
    expect(store.__get(V2_SERVICE, 'boardsesh_jwt')).toBe('legacy-jwt');
  });

  it('reads through without signing out when the legacy keychain is locked', async () => {
    const store = await secureStore();
    store.__seed(LEGACY_SERVICE, 'boardsesh_jwt', 'legacy-jwt');
    store.__lockService(LEGACY_SERVICE);
    const { getAuthToken } = await import('../auth-store');

    // Same rejection the app already surfaces today — crucially NOT a null,
    // which auth-interceptor treats as a confirmed logout.
    await expect(getAuthToken()).rejects.toThrow('User interaction is not allowed.');
  });

  it('does not resurrect a signed-out session when the legacy delete silently fails', async () => {
    const store = await secureStore();
    store.__seed(LEGACY_SERVICE, 'boardsesh_jwt', 'legacy-jwt');
    store.__seed(LEGACY_SERVICE, 'boardsesh_refresh_token', 'legacy-refresh');
    // The delete reports success while the item survives — the case JS cannot
    // detect from the return value.
    store.__makeUndeletable(LEGACY_SERVICE);
    const { clearTokens, getAuthToken, getRefreshToken } = await import('../auth-store');

    await clearTokens();

    await expect(getAuthToken()).resolves.toBeNull();
    await expect(getRefreshToken()).resolves.toBeNull();
    // The tombstone is written to v2 AND mirrored into legacy, so the credential
    // that survived deletion is overwritten rather than merely shadowed — it is
    // unreachable even through the read fallback.
    expect(store.__get(LEGACY_SERVICE, 'boardsesh_jwt')).toBe('__boardsesh_auth_credential_cleared__');
    expect(store.__get(V2_SERVICE, 'boardsesh_jwt')).toBe('__boardsesh_auth_credential_cleared__');
  });

  it('leaves nothing behind when deletion actually works', async () => {
    const store = await secureStore();
    store.__seed(LEGACY_SERVICE, 'boardsesh_jwt', 'legacy-jwt');
    const { clearTokens, getAuthToken } = await import('../auth-store');

    await clearTokens();

    await expect(getAuthToken()).resolves.toBeNull();
    expect(store.__get(V2_SERVICE, 'boardsesh_jwt')).toBeNull();
    expect(store.__get(LEGACY_SERVICE, 'boardsesh_jwt')).toBeNull();
  });

  it('writes new tokens into v2 and mirrors them to legacy', async () => {
    const store = await secureStore();
    const { storeTokens } = await import('../auth-store');

    await storeTokens('jwt', 'refresh', '2026-09-01T00:00:00.000Z');

    expect(store.__get(V2_SERVICE, 'boardsesh_jwt')).toBe('jwt');
    expect(store.__get(LEGACY_SERVICE, 'boardsesh_jwt')).toBe('jwt');
  });

  it('runs the credential migration once across concurrent cold-start reads', async () => {
    const store = await secureStore();
    store.__seed(LEGACY_SERVICE, 'boardsesh_jwt', 'legacy-jwt');
    const { getAuthToken, getRefreshToken, getTokenExpiresAt } = await import('../auth-store');

    await Promise.all([getAuthToken(), getRefreshToken(), getTokenExpiresAt(), getAuthToken()]);

    // Three auth keys, each probed once in v2 by the single migration pass.
    const v2Probes = store.getItemAsync.mock.calls.filter(
      (call) => (call[1] as { keychainService?: string } | undefined)?.keychainService === V2_SERVICE,
    );
    const migrationProbes = v2Probes.filter((call) => call[0] === 'boardsesh_jwt');
    // One migration probe + one verify + the reads themselves; without the
    // once-runner each of the four callers would start its own pass.
    expect(migrationProbes.length).toBeLessThanOrEqual(4);
  });
});
