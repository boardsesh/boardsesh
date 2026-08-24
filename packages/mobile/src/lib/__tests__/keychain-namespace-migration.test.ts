import { describe, it, expect, vi, beforeEach } from 'vitest';

// The v2 keychain-namespace migration (#4103). The fake below models the one
// property the real iOS keychain has that makes this design necessary: an item
// is identified by (key, keychainService), so writing under the v2 service is a
// fresh insert that carries its own accessibility, while writing under the
// legacy service only overwrites the value of an item that already exists.
const AFTER_FIRST_UNLOCK = 'after-first-unlock';
const V2_SERVICE = 'boardsesh.v2';

type StoredItem = { value: string; accessible: string | undefined };

// babel-preset-expo replaces this at build time; set it so USES_V2_NAMESPACE
// resolves to the iOS path under test.
process.env.EXPO_OS = 'ios';

vi.mock('expo-secure-store', () => {
  const items = new Map<string, StoredItem>();
  const lockedServices = new Set<string>();
  const writeFailureKeys = new Set<string>();
  const droppedWriteKeys = new Set<string>();

  const serviceOf = (options?: { keychainService?: string }) => options?.keychainService ?? 'app';
  const itemKey = (key: string, options?: { keychainService?: string }) => `${serviceOf(options)}::${key}`;

  return {
    AFTER_FIRST_UNLOCK,
    getItemAsync: vi.fn(async (key: string, options?: { keychainService?: string }) => {
      if (lockedServices.has(serviceOf(options))) throw new Error('User interaction is not allowed.');
      return items.get(itemKey(key, options))?.value ?? null;
    }),
    setItemAsync: vi.fn(
      async (key: string, value: string, options?: { keychainService?: string; keychainAccessible?: string }) => {
        if (writeFailureKeys.has(itemKey(key, options))) throw new Error('write failed');
        if (lockedServices.has(serviceOf(options))) throw new Error('User interaction is not allowed.');
        const existing = items.get(itemKey(key, options));
        // The bug being fixed: an existing item keeps its original accessibility
        // because expo-secure-store's update() sends kSecValueData only.
        // A write that reports success but leaves nothing behind — the case the
        // read-back exists to catch, and the only shape it can physically take
        // (SecItemAdd either stores the bytes it was handed or returns an error).
        if (droppedWriteKeys.has(itemKey(key, options))) return;
        items.set(itemKey(key, options), {
          value,
          accessible: existing ? existing.accessible : options?.keychainAccessible,
        });
      },
    ),
    deleteItemAsync: vi.fn(async (key: string, options?: { keychainService?: string }) => {
      items.delete(itemKey(key, options));
    }),
    __seedLegacy: (key: string, value: string, accessible = 'when-unlocked') => {
      items.set(`app::${key}`, { value, accessible });
    },
    __get: (key: string, service = V2_SERVICE) => items.get(`${service}::${key}`) ?? null,
    __lockService: (service: string) => lockedServices.add(service),
    __unlockService: (service: string) => lockedServices.delete(service),
    __failWriteFor: (key: string, service = V2_SERVICE) => writeFailureKeys.add(`${service}::${key}`),
    __dropWriteFor: (key: string, service = V2_SERVICE) => droppedWriteKeys.add(`${service}::${key}`),
    __clearWriteHooks: () => {
      writeFailureKeys.clear();
      droppedWriteKeys.clear();
    },
    __reset: () => {
      items.clear();
      lockedServices.clear();
      writeFailureKeys.clear();
      droppedWriteKeys.clear();
    },
  };
});

vi.mock('../analytics', () => ({ track: vi.fn() }));

type SecureStoreFake = {
  __seedLegacy: (key: string, value: string, accessible?: string) => void;
  __get: (key: string, service?: string) => StoredItem | null;
  __lockService: (service: string) => void;
  __unlockService: (service: string) => void;
  __failWriteFor: (key: string, service?: string) => void;
  __dropWriteFor: (key: string, service?: string) => void;
  __clearWriteHooks: () => void;
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

describe('migrateSecureKeysToV2', () => {
  it('copies a legacy value into v2 with AFTER_FIRST_UNLOCK applied', async () => {
    const store = await secureStore();
    store.__seedLegacy('boardsesh_jwt', 'jwt-value');
    const { migrateSecureKeysToV2 } = await import('../keychain-namespace-migration');

    const outcomes = await migrateSecureKeysToV2(['boardsesh_jwt'], 'auth');

    expect(outcomes).toEqual([{ key: 'boardsesh_jwt', status: 'migrated' }]);
    expect(store.__get('boardsesh_jwt')).toEqual({ value: 'jwt-value', accessible: AFTER_FIRST_UNLOCK });
  });

  it('leaves the legacy copy in place so an OTA rollback still finds the value', async () => {
    const store = await secureStore();
    store.__seedLegacy('boardsesh_jwt', 'jwt-value');
    const { migrateSecureKeysToV2 } = await import('../keychain-namespace-migration');

    await migrateSecureKeysToV2(['boardsesh_jwt'], 'auth');

    expect(store.__get('boardsesh_jwt', 'app')).toEqual({ value: 'jwt-value', accessible: 'when-unlocked' });
    expect(store.deleteItemAsync).not.toHaveBeenCalled();
  });

  it('reports already-v2 and rewrites nothing on a second pass', async () => {
    const store = await secureStore();
    store.__seedLegacy('boardsesh_jwt', 'jwt-value');
    const { migrateSecureKeysToV2 } = await import('../keychain-namespace-migration');

    await migrateSecureKeysToV2(['boardsesh_jwt'], 'auth');
    store.setItemAsync.mockClear();
    const outcomes = await migrateSecureKeysToV2(['boardsesh_jwt'], 'auth');

    expect(outcomes).toEqual([{ key: 'boardsesh_jwt', status: 'already-v2' }]);
    expect(store.setItemAsync).not.toHaveBeenCalled();
  });

  it('reports absent when nothing is stored under either namespace', async () => {
    const { migrateSecureKeysToV2 } = await import('../keychain-namespace-migration');

    await expect(migrateSecureKeysToV2(['boardsesh_jwt'], 'auth')).resolves.toEqual([
      { key: 'boardsesh_jwt', status: 'absent' },
    ]);
  });

  it('aborts without touching anything when the legacy namespace is locked', async () => {
    const store = await secureStore();
    store.__seedLegacy('boardsesh_jwt', 'jwt-value');
    store.__lockService('app');
    const { migrateSecureKeysToV2 } = await import('../keychain-namespace-migration');

    const outcomes = await migrateSecureKeysToV2(['boardsesh_jwt'], 'auth');

    expect(outcomes).toEqual([{ key: 'boardsesh_jwt', status: 'legacy-read-failed' }]);
    expect(store.__get('boardsesh_jwt')).toBeNull();
    expect(store.deleteItemAsync).not.toHaveBeenCalled();
  });

  it('retries a key that failed a previous pass, because v2 presence is the record', async () => {
    const store = await secureStore();
    store.__seedLegacy('boardsesh_jwt', 'jwt-value');
    store.__failWriteFor('boardsesh_jwt');
    const { migrateSecureKeysToV2 } = await import('../keychain-namespace-migration');

    const firstPass = await migrateSecureKeysToV2(['boardsesh_jwt'], 'auth');
    expect(firstPass).toEqual([{ key: 'boardsesh_jwt', status: 'v2-write-failed' }]);

    // A fresh process with the write no longer failing picks the key back up.
    vi.resetModules();
    store.__reset();
    store.__seedLegacy('boardsesh_jwt', 'jwt-value');
    const { migrateSecureKeysToV2: retry } = await import('../keychain-namespace-migration');

    await expect(retry(['boardsesh_jwt'], 'auth')).resolves.toEqual([{ key: 'boardsesh_jwt', status: 'migrated' }]);
  });

  it('never rejects, and keeps going after one key fails', async () => {
    const store = await secureStore();
    store.__seedLegacy('boardsesh_jwt', 'jwt-value');
    store.__seedLegacy('theme_override', '"dark"');
    store.__failWriteFor('boardsesh_jwt');
    const { migrateSecureKeysToV2 } = await import('../keychain-namespace-migration');

    const outcomes = await migrateSecureKeysToV2(['boardsesh_jwt', 'theme_override'], 'preferences');

    expect(outcomes).toEqual([
      { key: 'boardsesh_jwt', status: 'v2-write-failed' },
      { key: 'theme_override', status: 'migrated' },
    ]);
  });

  it('reports verify-mismatch and leaves legacy intact when the read-back disagrees', async () => {
    const store = await secureStore();
    store.__seedLegacy('boardsesh_jwt', 'jwt-value');
    // The write reports success but nothing lands. Without the read-back this
    // pass would report `migrated` while the next launch still read legacy.
    store.__dropWriteFor('boardsesh_jwt');
    const { migrateSecureKeysToV2 } = await import('../keychain-namespace-migration');

    const outcomes = await migrateSecureKeysToV2(['boardsesh_jwt'], 'auth');

    expect(outcomes).toEqual([{ key: 'boardsesh_jwt', status: 'verify-mismatch' }]);
    // Nothing was destroyed: legacy is byte-identical to the seed.
    expect(store.__get('boardsesh_jwt', 'app')).toEqual({ value: 'jwt-value', accessible: 'when-unlocked' });
    expect(store.deleteItemAsync).not.toHaveBeenCalled();

    // And a later pass with the write behaving picks the key back up.
    store.__clearWriteHooks();
    await expect(migrateSecureKeysToV2(['boardsesh_jwt'], 'auth')).resolves.toEqual([
      { key: 'boardsesh_jwt', status: 'migrated' },
    ]);
  });

  it('reports per-key outcomes to analytics, with key names but never values', async () => {
    const store = await secureStore();
    store.__seedLegacy('boardsesh_jwt', 'jwt-value');
    store.__seedLegacy('theme_override', '"dark"');
    store.__failWriteFor('theme_override');
    const { migrateSecureKeysToV2 } = await import('../keychain-namespace-migration');
    const { track } = await import('../analytics');

    await migrateSecureKeysToV2(['boardsesh_jwt', 'theme_override'], 'auth');

    expect(track).toHaveBeenCalledWith('Keychain Namespace Migration', {
      scope: 'auth',
      keys: 2,
      migrated: 1,
      already_v2: 0,
      absent: 0,
      failed: 1,
      failures: 'theme_override:v2-write-failed',
    });
    expect(JSON.stringify(vi.mocked(track).mock.calls)).not.toContain('jwt-value');
  });

  it('reports an incomplete scope once per process, and again when it completes', async () => {
    const store = await secureStore();
    store.__seedLegacy('boardsesh_jwt', 'jwt-value');
    store.__lockService('app');
    const { migrateSecureKeysToV2 } = await import('../keychain-namespace-migration');
    const { track } = await import('../analytics');

    // A locked background wake retries on every token read, and every retry
    // fails identically. One stuck device must not become a stream of events.
    await migrateSecureKeysToV2(['boardsesh_jwt'], 'auth');
    await migrateSecureKeysToV2(['boardsesh_jwt'], 'auth');

    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenLastCalledWith(
      'Keychain Namespace Migration',
      expect.objectContaining({ scope: 'auth', failed: 1, failures: 'boardsesh_jwt:legacy-read-failed' }),
    );

    store.__unlockService('app');
    await migrateSecureKeysToV2(['boardsesh_jwt'], 'auth');

    expect(track).toHaveBeenCalledTimes(2);
    expect(track).toHaveBeenLastCalledWith(
      'Keychain Namespace Migration',
      expect.objectContaining({ scope: 'auth', migrated: 1, failed: 0, failures: '' }),
    );
    expect(JSON.stringify(vi.mocked(track).mock.calls)).not.toContain('jwt-value');
  });

  it('bounds incomplete reports per scope, not across scopes', async () => {
    const store = await secureStore();
    store.__seedLegacy('boardsesh_jwt', 'jwt-value');
    store.__lockService('app');
    const { migrateSecureKeysToV2 } = await import('../keychain-namespace-migration');
    const { track } = await import('../analytics');

    await migrateSecureKeysToV2(['boardsesh_jwt'], 'auth');
    await migrateSecureKeysToV2(['boardsesh_jwt'], 'preferences');

    expect(track).toHaveBeenCalledTimes(2);
  });
});

describe('isMigrationComplete', () => {
  it('accepts the three terminal statuses and rejects every retryable one', async () => {
    const { isMigrationComplete } = await import('../keychain-namespace-migration');

    expect(isMigrationComplete([])).toBe(true);
    expect(
      isMigrationComplete([
        { key: 'a', status: 'already-v2' },
        { key: 'b', status: 'migrated' },
        { key: 'c', status: 'absent' },
      ]),
    ).toBe(true);
    for (const status of ['v2-read-failed', 'legacy-read-failed', 'v2-write-failed', 'verify-mismatch'] as const) {
      expect(
        isMigrationComplete([
          { key: 'a', status: 'migrated' },
          { key: 'b', status },
        ]),
      ).toBe(false);
    }
  });
});

describe('createOnceRunner', () => {
  it('shares one in-flight run across concurrent callers', async () => {
    const { createOnceRunner } = await import('../keychain-namespace-migration');
    const task = vi.fn(async () => true);
    const runOnce = createOnceRunner(task);

    await Promise.all([runOnce(), runOnce(), runOnce()]);

    expect(task).toHaveBeenCalledTimes(1);
  });

  it('latches on a complete pass and never runs again', async () => {
    const { createOnceRunner } = await import('../keychain-namespace-migration');
    const task = vi.fn(async () => true);
    const runOnce = createOnceRunner(task);

    await runOnce();
    await runOnce();

    expect(task).toHaveBeenCalledTimes(1);
  });

  it('does NOT latch on an incomplete pass, so the next caller retries', async () => {
    const { createOnceRunner } = await import('../keychain-namespace-migration');
    // migrateSecureKeysToV2 never rejects — a locked keychain resolves as an
    // outcome — so `false` is the only signal that the work still needs doing.
    const task = vi.fn<() => Promise<boolean>>().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const runOnce = createOnceRunner(task);

    await runOnce();
    await runOnce();
    await runOnce();

    expect(task).toHaveBeenCalledTimes(2);
  });

  it('retries after a rejection instead of latching completed', async () => {
    const { createOnceRunner } = await import('../keychain-namespace-migration');
    const task = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('keychain locked'))
      .mockResolvedValueOnce(true);
    const runOnce = createOnceRunner(task);

    await expect(runOnce()).rejects.toThrow('keychain locked');
    await expect(runOnce()).resolves.toBeUndefined();
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('retries a fully failed migration pass in the SAME process once the keychain unlocks', async () => {
    // The latch bug this guards: a process cold-launched in the background on a
    // locked phone gets nothing but legacy-read-failed, and used to burn its one
    // attempt on it and never retry for the whole process lifetime.
    const store = await secureStore();
    store.__seedLegacy('boardsesh_jwt', 'jwt-value');
    store.__seedLegacy('boardsesh_refresh_token', 'refresh-value');
    store.__seedLegacy('boardsesh_token_expires_at', '2026-09-01T00:00:00.000Z');
    store.__lockService('app');
    const { createOnceRunner, isMigrationComplete, migrateSecureKeysToV2 } =
      await import('../keychain-namespace-migration');
    const keys = ['boardsesh_jwt', 'boardsesh_refresh_token', 'boardsesh_token_expires_at'];
    const outcomesPerPass: string[][] = [];
    const runOnce = createOnceRunner(async () => {
      const outcomes = await migrateSecureKeysToV2(keys, 'auth');
      outcomesPerPass.push(outcomes.map((outcome) => outcome.status));
      return isMigrationComplete(outcomes);
    });

    await runOnce();
    expect(outcomesPerPass[0]).toEqual(['legacy-read-failed', 'legacy-read-failed', 'legacy-read-failed']);
    expect(store.__get('boardsesh_jwt')).toBeNull();

    store.__unlockService('app');
    await runOnce();

    expect(outcomesPerPass[1]).toEqual(['migrated', 'migrated', 'migrated']);
    for (const key of keys) {
      expect(store.__get(key)?.accessible).toBe(AFTER_FIRST_UNLOCK);
    }

    // And now it latches.
    await runOnce();
    expect(outcomesPerPass).toHaveLength(2);
  });
});
