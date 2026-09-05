import { describe, it, expect, vi, beforeEach } from 'vitest';

// Guards the SecureStore-writer contract from issues #3602 and #4103: every write
// must carry keychainAccessible: AFTER_FIRST_UNLOCK so a locked-device background
// read stays accessible, and must land in the v2 keychain namespace — the only
// namespace where that accessibility is actually applied, since an existing legacy
// item takes expo-secure-store's update() path, which never touches
// kSecAttrAccessible. Each write is then mirrored back into the legacy namespace so
// an OTA rollback to JS that predates v2 still finds the current value.
//
// This pins the wiring for the non-auth writers so a future edit that drops a call
// site out of secure-store-io is caught (the review's stated risk).
const AFTER_FIRST_UNLOCK = 'after-first-unlock';

// babel-preset-expo replaces this at build time; set it so the v2 namespace is
// active under test.
process.env.EXPO_OS = 'ios';

vi.mock('expo-secure-store', () => {
  let storage: Record<string, string> = {};
  const setItemAsync = vi.fn(async (key: string, value: string) => {
    storage[key] = value;
  });
  return {
    AFTER_FIRST_UNLOCK,
    getItemAsync: vi.fn(async (key: string) => storage[key] ?? null),
    setItemAsync,
    deleteItemAsync: vi.fn(async (key: string) => {
      delete storage[key];
    }),
    __reset: () => {
      storage = {};
      setItemAsync.mockClear();
    },
  };
});

async function secureStore() {
  return (await import('expo-secure-store')) as unknown as {
    __reset: () => void;
    setItemAsync: ReturnType<typeof vi.fn>;
  };
}

const V2_OPTIONS = { keychainAccessible: AFTER_FIRST_UNLOCK, keychainService: 'boardsesh.v2' };
const LEGACY_OPTIONS = { keychainAccessible: AFTER_FIRST_UNLOCK };

function expectDualNamespaceWrite(setItemAsync: ReturnType<typeof vi.fn>, key: string, value: string): void {
  expect(setItemAsync).toHaveBeenNthCalledWith(1, key, value, V2_OPTIONS);
  expect(setItemAsync).toHaveBeenNthCalledWith(2, key, value, LEGACY_OPTIONS);
}

beforeEach(async () => {
  (await secureStore()).__reset();
});

describe('SecureStore writers write v2 first, then mirror to legacy', () => {
  it('session-store setStoredSessionId', async () => {
    const store = await secureStore();
    const { setStoredSessionId } = await import('../session-store');

    await setStoredSessionId('session-123');

    expectDualNamespaceWrite(store.setItemAsync, 'boardsesh_active_session_id', 'session-123');
  });

  it('last-grade-store setLastUsedGradeId', async () => {
    const store = await secureStore();
    const { setLastUsedGradeId } = await import('../last-grade-store');

    await setLastUsedGradeId(22);

    expectDualNamespaceWrite(store.setItemAsync, 'boardsesh_last_used_grade', '22');
  });

  it('secure-store-adapter secureStorePreferences.set', async () => {
    const store = await secureStore();
    const { secureStorePreferences } = await import('../preferences/secure-store-adapter');

    await secureStorePreferences.set('some_pref', { enabled: true });

    expectDualNamespaceWrite(store.setItemAsync, 'some_pref', JSON.stringify({ enabled: true }));
  });
});
