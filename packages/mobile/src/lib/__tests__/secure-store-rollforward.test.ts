import { describe, it, expect, vi, beforeEach } from 'vitest';

// The OTA roll-forward hazard in the two-namespace steady state (#5345), driven
// end to end through auth-store against the same keychain fake the sibling suites
// use.
//
// The sequence every test here replays is the real remediation path:
//
//   1. a migrated install, both namespaces populated by this build
//   2. an OTA ROLLBACK to JS that predates #4127 — it reads and writes the LEGACY
//      namespace only and knows nothing about v2 or about stamps, so a raw seed
//      into the legacy service IS that build's write
//   3. an OTA ROLL FORWARD — a fresh process, which is what vi.resetModules()
//      models: the once-runner, the touched-key registry and the generation cache
//      all start empty, exactly as they do on a cold launch
//
// Before the stamp, step 3 read the stale v2 pair, migrateKey reported already-v2
// and never repaired it, and the backend had already revoked that refresh token on
// the rollback build's own refresh — a 401 and a forced sign-out for roughly a
// seventh of active users per day spent on the rolled-back bundle.
const AFTER_FIRST_UNLOCK = 'after-first-unlock';
const V2_SERVICE = 'boardsesh.v2';
const LEGACY_SERVICE = 'app';
const JWT_KEY = 'boardsesh_jwt';
const SESSION_KEY = 'boardsesh_active_session_id';
const TOMBSTONE = '__boardsesh_auth_credential_cleared__';
const EXPIRES_AT = '2026-09-30T00:00:00.000Z';

process.env.EXPO_OS = 'ios';

vi.mock('expo-secure-store', () => {
  const items = new Map<string, string>();
  const lockedServices = new Set<string>();
  const undeletableServices = new Set<string>();
  const writeFailureKeys = new Set<string>();

  const serviceOf = (options?: { keychainService?: string }) => options?.keychainService ?? LEGACY_SERVICE;
  const itemKey = (key: string, options?: { keychainService?: string }) => `${serviceOf(options)}::${key}`;

  return {
    AFTER_FIRST_UNLOCK,
    getItemAsync: vi.fn(async (key: string, options?: { keychainService?: string }) => {
      if (lockedServices.has(serviceOf(options))) throw new Error('User interaction is not allowed.');
      return items.get(itemKey(key, options)) ?? null;
    }),
    setItemAsync: vi.fn(async (key: string, value: string, options?: { keychainService?: string }) => {
      if (writeFailureKeys.has(itemKey(key, options))) throw new Error('write failed');
      if (lockedServices.has(serviceOf(options))) throw new Error('User interaction is not allowed.');
      items.set(itemKey(key, options), value);
    }),
    // Never throws and never reports failure, exactly like the real module:
    // deleteValueWithKeyAsync discards all three SecItemDelete statuses
    // (SecureStoreModule.swift:43-51).
    deleteItemAsync: vi.fn(async (key: string, options?: { keychainService?: string }) => {
      if (undeletableServices.has(serviceOf(options))) return;
      items.delete(itemKey(key, options));
    }),
    __seed: (service: string, key: string, value: string) => items.set(`${service}::${key}`, value),
    __get: (service: string, key: string) => items.get(`${service}::${key}`) ?? null,
    __makeUndeletable: (service: string) => undeletableServices.add(service),
    __failWriteFor: (service: string, key: string) => writeFailureKeys.add(`${service}::${key}`),
    __reset: () => {
      items.clear();
      lockedServices.clear();
      undeletableServices.clear();
      writeFailureKeys.clear();
    },
  };
});

vi.mock('../analytics', () => ({ track: vi.fn() }));

type SecureStoreFake = {
  __seed: (service: string, key: string, value: string) => void;
  __get: (service: string, key: string) => string | null;
  __makeUndeletable: (service: string) => void;
  __failWriteFor: (service: string, key: string) => void;
  __reset: () => void;
  setItemAsync: ReturnType<typeof vi.fn>;
};

async function secureStore(): Promise<SecureStoreFake> {
  return (await import('expo-secure-store')) as unknown as SecureStoreFake;
}

/** A fresh process against the same keychain — an OTA roll-forward, or any relaunch. */
function relaunch(): void {
  vi.resetModules();
}

beforeEach(async () => {
  vi.resetModules();
  (await secureStore()).__reset();
  vi.clearAllMocks();
});

describe('an OTA roll-forward after a rollback', () => {
  it('keeps the credential the rolled-back build wrote, instead of the stale v2 one', async () => {
    const store = await secureStore();
    const { storeTokens } = await import('../auth-store');
    await storeTokens('jwt-before-rollback', 'refresh-before-rollback', EXPIRES_AT);

    // The rollback: pre-#4127 JS refreshes the token into legacy alone. It has no
    // idea v2 or the stamp exist, which is exactly why a raw seed is a faithful
    // model of its write.
    store.__seed(LEGACY_SERVICE, JWT_KEY, 'jwt-after-rollback');
    store.__seed(LEGACY_SERVICE, 'boardsesh_refresh_token', 'refresh-after-rollback');

    relaunch();
    const { getAuthToken, getRefreshToken } = await import('../auth-store');

    // The refresh token is the one that matters: the backend revoked the
    // pre-rollback one when the rolled-back build rotated it, so handing it back
    // here is the 401 that signs the climber out.
    await expect(getRefreshToken()).resolves.toBe('refresh-after-rollback');
    await expect(getAuthToken()).resolves.toBe('jwt-after-rollback');
    expect(store.__get(V2_SERVICE, JWT_KEY)).toBe('jwt-after-rollback');
  });

  it('reports repaired rather than already-v2, and settles on the second pass', async () => {
    const store = await secureStore();
    const { storeTokens } = await import('../auth-store');
    await storeTokens('jwt-before-rollback', 'refresh-before-rollback', EXPIRES_AT);
    store.__seed(LEGACY_SERVICE, JWT_KEY, 'jwt-after-rollback');

    relaunch();
    const { migrateSecureKeysToV2 } = await import('../keychain-namespace-migration');

    await expect(migrateSecureKeysToV2([JWT_KEY], 'auth')).resolves.toEqual([{ key: JWT_KEY, status: 'repaired' }]);
    // The repair re-stamps, so the next pass sees two namespaces that agree and
    // does no work at all — a repair loop would rewrite the credential on every
    // launch forever.
    await expect(migrateSecureKeysToV2([JWT_KEY], 'auth')).resolves.toEqual([{ key: JWT_KEY, status: 'already-v2' }]);
  });
});

describe('the resurrection guard #4127 exists for', () => {
  it('keeps a v2 tombstone ahead of the live legacy credential it could not overwrite', async () => {
    const store = await secureStore();
    const { storeTokens } = await import('../auth-store');
    await storeTokens('live-jwt', 'live-refresh', EXPIRES_AT);

    // Sign-out on a keychain whose legacy item refuses both deletion and
    // overwrite — the WHEN_UNLOCKED item on a device not unlocked since boot. The
    // tombstone lands in v2 alone, and legacy keeps the live credential.
    store.__makeUndeletable(LEGACY_SERVICE);
    store.__failWriteFor(LEGACY_SERVICE, JWT_KEY);
    const { clearTokens } = await import('../auth-store');
    await clearTokens();

    expect(store.__get(V2_SERVICE, JWT_KEY)).toBe(TOMBSTONE);
    expect(store.__get(LEGACY_SERVICE, JWT_KEY)).toBe('live-jwt');

    relaunch();
    const { getAuthToken } = await import('../auth-store');

    // Preferring legacy on any divergence — the obvious fix for the roll-forward
    // bug — signs this climber back in on their next launch. The stamp records the
    // rejected legacy write as UNKNOWN, and an unknown never out-ranks v2.
    await expect(getAuthToken()).resolves.toBeNull();
    expect(store.__get(V2_SERVICE, JWT_KEY)).toBe(TOMBSTONE);
  });
});

describe('a genuinely fresher v2 copy', () => {
  it('stays put, with no repair, when the legacy mirror was the half that failed', async () => {
    const store = await secureStore();
    store.__seed(LEGACY_SERVICE, JWT_KEY, 'jwt-old');
    store.__failWriteFor(LEGACY_SERVICE, JWT_KEY);
    const { storeTokens } = await import('../auth-store');

    // v2 takes the new token; the legacy mirror is rejected, so the namespaces
    // diverge with v2 as the newer side.
    await storeTokens('jwt-new', 'refresh-new', EXPIRES_AT);
    expect(store.__get(V2_SERVICE, JWT_KEY)).toBe('jwt-new');
    expect(store.__get(LEGACY_SERVICE, JWT_KEY)).toBe('jwt-old');

    relaunch();
    const { migrateSecureKeysToV2 } = await import('../keychain-namespace-migration');
    store.setItemAsync.mockClear();

    await expect(migrateSecureKeysToV2([JWT_KEY], 'auth')).resolves.toEqual([{ key: JWT_KEY, status: 'already-v2' }]);
    // Not one write: no value copied, and no stamp rewritten either.
    expect(store.setItemAsync).not.toHaveBeenCalled();
    expect(store.__get(V2_SERVICE, JWT_KEY)).toBe('jwt-new');
  });

  it('stays put when the two namespaces simply agree', async () => {
    const store = await secureStore();
    const { storeTokens } = await import('../auth-store');
    await storeTokens('jwt-1', 'refresh-1', EXPIRES_AT);

    relaunch();
    const { migrateSecureKeysToV2 } = await import('../keychain-namespace-migration');
    store.setItemAsync.mockClear();

    await expect(migrateSecureKeysToV2([JWT_KEY], 'auth')).resolves.toEqual([{ key: JWT_KEY, status: 'already-v2' }]);
    expect(store.setItemAsync).not.toHaveBeenCalled();
  });
});

describe('deleteSecureValue when only one namespace actually deletes', () => {
  it('does not let the surviving legacy value resurface, or come back through the migration', async () => {
    const store = await secureStore();
    const { deleteSecureValue, readSecureValue, writeSecureValue } = await import('../secure-store-io');
    await writeSecureValue(SESSION_KEY, 'session-1');

    // The v2 delete lands, the legacy one silently does nothing. Without the
    // read-back the value is reachable through readSecureValue's fallback, and the
    // next launch's migrateKey copies it back into v2 and makes it durable.
    store.__makeUndeletable(LEGACY_SERVICE);
    await deleteSecureValue(SESSION_KEY);

    await expect(readSecureValue(SESSION_KEY)).resolves.toBeNull();

    relaunch();
    const { migrateSecureKeysToV2 } = await import('../keychain-namespace-migration');
    const { readSecureValue: readAfterRelaunch } = await import('../secure-store-io');

    await migrateSecureKeysToV2([SESSION_KEY], 'preferences');

    await expect(readAfterRelaunch(SESSION_KEY)).resolves.toBeNull();
    expect(store.__get(V2_SERVICE, SESSION_KEY)).not.toBe('session-1');
  });

  it('still reads as absent when the surviving legacy item also refuses the overwrite', async () => {
    const store = await secureStore();
    const { deleteSecureValue, readSecureValue, writeSecureValue } = await import('../secure-store-io');
    await writeSecureValue(SESSION_KEY, 'session-1');

    store.__makeUndeletable(LEGACY_SERVICE);
    store.__failWriteFor(LEGACY_SERVICE, SESSION_KEY);
    await deleteSecureValue(SESSION_KEY);

    // Nothing in JS can retire that legacy item, so the tombstone goes to v2 and
    // shadows it — which is enough, because readSecureValue stops at a v2 hit.
    expect(store.__get(LEGACY_SERVICE, SESSION_KEY)).toBe('session-1');
    await expect(readSecureValue(SESSION_KEY)).resolves.toBeNull();

    relaunch();
    const { migrateSecureKeysToV2 } = await import('../keychain-namespace-migration');
    const { readSecureValue: readAfterRelaunch } = await import('../secure-store-io');

    await migrateSecureKeysToV2([SESSION_KEY], 'preferences');

    await expect(readAfterRelaunch(SESSION_KEY)).resolves.toBeNull();
  });

  it('leaves no tombstone behind when both deletes actually land', async () => {
    const store = await secureStore();
    const { deleteSecureValue, writeSecureValue } = await import('../secure-store-io');
    await writeSecureValue(SESSION_KEY, 'session-1');

    await deleteSecureValue(SESSION_KEY);

    expect(store.__get(V2_SERVICE, SESSION_KEY)).toBeNull();
    expect(store.__get(LEGACY_SERVICE, SESSION_KEY)).toBeNull();
    // And the stamp goes with it, rather than accumulating a keychain item per
    // key that anything ever cleared.
    expect(store.__get(V2_SERVICE, `${SESSION_KEY}.nsgen`)).toBeNull();
  });
});
