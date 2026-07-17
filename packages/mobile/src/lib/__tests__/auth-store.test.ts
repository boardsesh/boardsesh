import { describe, it, expect, vi, beforeEach } from 'vitest';

// A sentinel for the AFTER_FIRST_UNLOCK constant so the test can assert the
// exact keychainAccessible value the writers pass without depending on the
// native module's real numeric constant.
const AFTER_FIRST_UNLOCK = Symbol('AFTER_FIRST_UNLOCK');

vi.mock('expo-secure-store', () => {
  let storage: Record<string, string> = {};
  const writeItem = async (key: string, value: string) => {
    storage[key] = value;
  };
  const deleteItem = async (key: string) => {
    delete storage[key];
  };
  const setItemAsync = vi.fn(writeItem);
  const deleteItemAsync = vi.fn(deleteItem);
  return {
    AFTER_FIRST_UNLOCK,
    getItemAsync: vi.fn(async (key: string) => storage[key] ?? null),
    setItemAsync,
    deleteItemAsync,
    __reset: () => {
      storage = {};
      setItemAsync.mockReset();
      setItemAsync.mockImplementation(writeItem);
      deleteItemAsync.mockReset();
      deleteItemAsync.mockImplementation(deleteItem);
    },
  };
});

async function secureStore() {
  return (await import('expo-secure-store')) as unknown as {
    __reset: () => void;
    setItemAsync: ReturnType<typeof vi.fn>;
    deleteItemAsync: ReturnType<typeof vi.fn>;
  };
}

const JWT_KEY = 'boardsesh_jwt';
const REFRESH_TOKEN_KEY = 'boardsesh_refresh_token';
const EXPIRES_AT_KEY = 'boardsesh_token_expires_at';

beforeEach(async () => {
  (await secureStore()).__reset();
});

describe('auth-store', () => {
  it('writes every token with keychainAccessible: AFTER_FIRST_UNLOCK', async () => {
    const store = await secureStore();
    const { storeTokens } = await import('../auth-store');

    await storeTokens('jwt-value', 'refresh-value', '2026-08-01T00:00:00.000Z');

    // Every write is what keeps a locked-device background read from rejecting
    // with "User interaction is not allowed" (issue #3602). Reads inherit the
    // accessibility the item was written with, so each key must carry it.
    const options = { keychainAccessible: AFTER_FIRST_UNLOCK };
    expect(store.setItemAsync).toHaveBeenCalledWith(JWT_KEY, 'jwt-value', options);
    expect(store.setItemAsync).toHaveBeenCalledWith(REFRESH_TOKEN_KEY, 'refresh-value', options);
    expect(store.setItemAsync).toHaveBeenCalledWith(EXPIRES_AT_KEY, '2026-08-01T00:00:00.000Z', options);
    expect(store.setItemAsync).toHaveBeenCalledTimes(3);
  });

  it('round-trips stored tokens through the getters', async () => {
    const { storeTokens, getAuthToken, getRefreshToken, getTokenExpiresAt } = await import('../auth-store');

    await storeTokens('jwt-value', 'refresh-value', '2026-08-01T00:00:00.000Z');

    expect(await getAuthToken()).toBe('jwt-value');
    expect(await getRefreshToken()).toBe('refresh-value');
    expect((await getTokenExpiresAt())?.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('retries a failed credential deletion before falling back', async () => {
    const store = await secureStore();
    const { clearTokens, getAuthToken, storeTokens } = await import('../auth-store');
    await storeTokens('jwt-value', 'refresh-value', '2026-08-01T00:00:00.000Z');
    store.setItemAsync.mockClear();
    store.deleteItemAsync.mockRejectedValueOnce(new Error('keychain temporarily unavailable'));

    await expect(clearTokens()).resolves.toBeUndefined();

    expect(store.deleteItemAsync).toHaveBeenCalledTimes(4);
    expect(store.setItemAsync).not.toHaveBeenCalled();
    await expect(getAuthToken()).resolves.toBeNull();
  });

  it('persists cleared tombstones when SecureStore cannot delete credentials', async () => {
    const store = await secureStore();
    const { clearTokens, getAuthToken, getRefreshToken, getTokenExpiresAt, storeTokens } =
      await import('../auth-store');
    await storeTokens('jwt-value', 'refresh-value', '2026-08-01T00:00:00.000Z');
    store.setItemAsync.mockClear();
    store.deleteItemAsync.mockRejectedValue(new Error('delete unavailable'));

    await expect(clearTokens()).resolves.toBeUndefined();

    expect(store.deleteItemAsync).toHaveBeenCalledTimes(6);
    expect(store.setItemAsync).toHaveBeenCalledTimes(3);
    await expect(getAuthToken()).resolves.toBeNull();
    await expect(getRefreshToken()).resolves.toBeNull();
    await expect(getTokenExpiresAt()).resolves.toBeNull();
  });

  it('surfaces cleanup failure when neither deletion nor tombstoning succeeds', async () => {
    const store = await secureStore();
    const { clearTokens, storeTokens } = await import('../auth-store');
    await storeTokens('jwt-value', 'refresh-value', '2026-08-01T00:00:00.000Z');
    store.deleteItemAsync.mockRejectedValue(new Error('delete unavailable'));
    store.setItemAsync.mockRejectedValue(new Error('write unavailable'));

    await expect(clearTokens()).rejects.toMatchObject({ name: 'AuthCredentialCleanupError' });
    expect(store.deleteItemAsync).toHaveBeenCalledTimes(6);
  });

  it('cannot restore refreshed credentials when clear starts during a token write', async () => {
    const store = await secureStore();
    const {
      captureAuthCredentialGeneration,
      clearTokens,
      getAuthToken,
      getRefreshToken,
      getTokenExpiresAt,
      storeTokensForGeneration,
    } = await import('../auth-store');
    const refreshGeneration = captureAuthCredentialGeneration();
    let releaseFirstWrite!: () => void;
    store.setItemAsync.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirstWrite = resolve;
        }),
    );

    const staleRefreshWrite = storeTokensForGeneration(
      refreshGeneration,
      'refreshed-jwt',
      'refreshed-token',
      '2026-09-01T00:00:00.000Z',
    );
    await vi.waitFor(() => expect(store.setItemAsync).toHaveBeenCalledTimes(1));
    const clearing = clearTokens();
    releaseFirstWrite();

    await expect(staleRefreshWrite).resolves.toBe(false);
    await expect(clearing).resolves.toBeUndefined();
    expect(store.setItemAsync).toHaveBeenCalledTimes(1);
    await expect(getAuthToken()).resolves.toBeNull();
    await expect(getRefreshToken()).resolves.toBeNull();
    await expect(getTokenExpiresAt()).resolves.toBeNull();
  });

  it('rejects a stale refresh write queued after credentials were cleared', async () => {
    const store = await secureStore();
    const { captureAuthCredentialGeneration, clearTokens, storeTokensForGeneration } = await import('../auth-store');
    const staleGeneration = captureAuthCredentialGeneration();
    await clearTokens();
    store.setItemAsync.mockClear();

    await expect(
      storeTokensForGeneration(staleGeneration, 'stale-jwt', 'stale-refresh', '2026-09-01T00:00:00.000Z'),
    ).resolves.toBe(false);
    expect(store.setItemAsync).not.toHaveBeenCalled();
  });
});
