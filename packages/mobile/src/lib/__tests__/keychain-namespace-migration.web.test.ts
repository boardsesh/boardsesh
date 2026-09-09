// Why `auth-store.web.ts`'s `retryDeferredCredentialReconcile` is allowed to do
// nothing (#5345, #5350).
//
// KeychainNamespaceMigration is mounted from the single root layout, so its
// AppState `active` listener runs in the browser too and calls the deferred
// reconcile retry for both scopes. On iOS that retry repairs a credential a locked
// keychain stopped the previous pass from checking. On web it has nothing to do —
// and "nothing to do" has to be a property of the platform rather than an accident
// nobody watches, because a no-op that quietly stops being true is a dropped
// repair, and the symptom #5345 describes is a forced sign-out.
//
// The property: the v1 -> v2 keychain namespace exists on iOS only
// (`USES_V2_NAMESPACE`), so on web `migrateSecureKeysToV2` returns before it
// reaches SecureStore. No deferral is recorded, none is reported, and the retry's
// key list is empty by construction rather than by luck.
//
// Export parity — the half that broke `main` when #5350 added the native function
// without the web one — is guarded separately by
// `src/__tests__/web-fork-export-parity.test.ts`. This file guards the behaviour
// that makes the missing half honest to fill with a no-op.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const AFTER_FIRST_UNLOCK = 'after-first-unlock';
const V2_SERVICE = 'boardsesh.v2';
const LEGACY_SERVICE = 'app';
const JWT_KEY = 'boardsesh_jwt';
const STAMP_KEY = `${JWT_KEY}.nsgen`;

// The whole point of the file. Every module under test reads the platform from
// `process.env.EXPO_OS` (babel-preset-expo substitutes it at build time), so this
// is what makes the imports below the browser build.
process.env.EXPO_OS = 'web';

vi.mock('../analytics', () => ({ track: vi.fn() }));

vi.mock('expo-secure-store', () => {
  const items = new Map<string, string>();
  const lockedServices = new Set<string>();

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
      items.delete(itemKey(key, options));
    }),
    __seed: (service: string, key: string, value: string) => items.set(`${service}::${key}`, value),
    __lockService: (service: string) => lockedServices.add(service),
    __reset: () => {
      items.clear();
      lockedServices.clear();
    },
  };
});

type SecureStoreFake = {
  __seed: (service: string, key: string, value: string) => void;
  __lockService: (service: string) => void;
  __reset: () => void;
  getItemAsync: ReturnType<typeof vi.fn>;
  setItemAsync: ReturnType<typeof vi.fn>;
  deleteItemAsync: ReturnType<typeof vi.fn>;
};

async function secureStore(): Promise<SecureStoreFake> {
  return (await import('expo-secure-store')) as unknown as SecureStoreFake;
}

/**
 * The exact keychain state that yields `reconcile-deferred` on iOS: a key that
 * already has a v2 item, a stamp to compare it against, and a legacy namespace
 * that will not open. On web this must produce nothing at all — if any of it is
 * ever read here, the browser has grown a namespace the browser retry cannot fix.
 */
async function seedTheStateThatDefersOnIos(store: SecureStoreFake): Promise<void> {
  const migratedJwt = 'jwt-written-before-the-rollback';
  // Built with the real serializer so the seed cannot drift out of the wire
  // format and quietly become an unreadable stamp, which reads as no stamp and
  // would never defer on any platform.
  const { contentOf, serializeNamespaceStamp } = await import('../secure-store-stamp');
  store.__seed(V2_SERVICE, JWT_KEY, migratedJwt);
  store.__seed(
    V2_SERVICE,
    STAMP_KEY,
    serializeNamespaceStamp({ v2: contentOf(migratedJwt), legacy: contentOf(migratedJwt) }),
  );
  store.__seed(LEGACY_SERVICE, JWT_KEY, 'jwt-written-by-the-rolled-back-build');
  store.__lockService(LEGACY_SERVICE);
}

beforeEach(async () => {
  vi.resetModules();
  (await secureStore()).__reset();
  vi.clearAllMocks();
});

describe('the deferred-reconcile retry on web', () => {
  it('resolves without reaching the keychain or reporting anything', async () => {
    const store = await secureStore();
    await seedTheStateThatDefersOnIos(store);
    const { retryDeferredCredentialReconcile } = await import('../auth-store.web');
    const { track } = await import('../analytics');

    // Resolving, not throwing like `storeTokens` does for a genuinely impossible
    // web call: the component fires this on every foreground transition, and
    // asking "is anything deferred?" is an ordinary question with an honest
    // answer of "no".
    await expect(retryDeferredCredentialReconcile()).resolves.toBeUndefined();

    expect(store.getItemAsync).not.toHaveBeenCalled();
    expect(store.setItemAsync).not.toHaveBeenCalled();
    expect(store.deleteItemAsync).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });

  it('has an empty key list because the browser never records a deferral', async () => {
    const store = await secureStore();
    await seedTheStateThatDefersOnIos(store);
    const { deferredReconcileKeys, migrateSecureKeysToV2 } = await import('../keychain-namespace-migration');
    const { track } = await import('../analytics');

    // A full pass over the credential keys, against the keychain state that makes
    // iOS defer. Web has no second namespace, so the pass returns before it opens
    // the keychain at all.
    await expect(migrateSecureKeysToV2([JWT_KEY], 'auth')).resolves.toEqual([]);
    expect(store.getItemAsync).not.toHaveBeenCalled();

    // Both halves of what KeychainNamespaceMigration asks on AppState `active`.
    // Empty lists are what make the retry inert: nothing is scheduled, so nothing
    // can be silently skipped.
    expect(deferredReconcileKeys('auth')).toEqual([]);
    expect(deferredReconcileKeys('preferences')).toEqual([]);

    // And nothing tells analytics a browser is sitting on an unreconciled key.
    // #4128's go/no-go gate reads this event; a web deferral it can never clear
    // would be a permanent false negative in it.
    expect(track).not.toHaveBeenCalled();
  });
});
