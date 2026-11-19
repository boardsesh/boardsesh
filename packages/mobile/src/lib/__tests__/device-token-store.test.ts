import { beforeEach, describe, expect, it, vi } from 'vitest';

// The SecureStore side of #7656's device tokens. The injected-storage cases pin
// the store's own behaviour; the last block runs the real secure-store-io
// helpers over an in-memory expo-secure-store to pin the keychain contract from
// docs/keychain-namespaces.md (v2 first, legacy mirror, delete from both).

process.env.EXPO_OS = 'ios';

const AFTER_FIRST_UNLOCK = 'after-first-unlock';
const keychain = vi.hoisted(() => ({ items: new Map<string, string>() }));
vi.mock('expo-secure-store', () => {
  const itemKey = (key: string, options?: { keychainService?: string }) =>
    `${options?.keychainService ?? 'app'}:${key}`;
  return {
    AFTER_FIRST_UNLOCK: 'after-first-unlock',
    getItemAsync: vi.fn(async (key: string, options?: { keychainService?: string }) => {
      return keychain.items.get(itemKey(key, options)) ?? null;
    }),
    setItemAsync: vi.fn(async (key: string, value: string, options?: { keychainService?: string }) => {
      keychain.items.set(itemKey(key, options), value);
    }),
    deleteItemAsync: vi.fn(async (key: string, options?: { keychainService?: string }) => {
      keychain.items.delete(itemKey(key, options));
    }),
  };
});

const SecureStore = await import('expo-secure-store');
const {
  DEVICE_TOKEN_LEDGER_KEY,
  NATIVE_DEVICE_TOKEN_HEADER,
  createDeviceTokenStore,
  deviceTokenHeadersForCredentialsSignIn,
  forgetDeviceTokenForAccount,
  rememberDeviceTokenFromReply,
} = await import('../device-token-store');
const { MAX_DEVICE_TOKEN_ACCOUNTS } = await import('../device-token-ledger');

const tokenFor = (label: string) => `v1.${label.padEnd(22, 'x')}.1763424000.${'s'.repeat(43)}`;
const jwtFor = (userId: string) => `header.${btoa(JSON.stringify({ sub: userId })).replace(/=/g, '')}.signature`;

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    read: vi.fn(async (key: string) => values.get(key) ?? null),
    write: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    remove: vi.fn(async (key: string) => {
      values.delete(key);
    }),
  };
}

beforeEach(() => {
  keychain.items.clear();
  vi.clearAllMocks();
});

describe('createDeviceTokenStore', () => {
  it('touches no storage at all for a reply without a device token', async () => {
    const storage = memoryStorage();
    const store = createDeviceTokenStore(storage);

    await store.rememberFromReply(
      { jwt: jwtFor('user-1'), refreshToken: 'r', expiresAt: 'e', userId: 'user-1' },
      { email: 'a@example.com', jwt: jwtFor('user-1') },
    );

    expect(storage.read).not.toHaveBeenCalled();
    expect(storage.write).not.toHaveBeenCalled();
    expect(await store.headersForCredentialsSignIn('a@example.com')).toEqual({});
  });

  it('sends back only the token stored for the email being signed in to', async () => {
    const storage = memoryStorage();
    const store = createDeviceTokenStore(storage);
    await store.rememberFromReply({ userId: 'user-1', deviceToken: tokenFor('a') }, { email: 'A@example.com' });
    await store.rememberFromReply({ userId: 'user-2', deviceToken: tokenFor('b') }, { email: 'b@example.com' });

    expect(await store.headersForCredentialsSignIn(' a@EXAMPLE.com')).toEqual({
      [NATIVE_DEVICE_TOKEN_HEADER]: tokenFor('a'),
    });
    expect(await store.headersForCredentialsSignIn('b@example.com')).toEqual({
      [NATIVE_DEVICE_TOKEN_HEADER]: tokenFor('b'),
    });
    expect(await store.headersForCredentialsSignIn('stranger@example.com')).toEqual({});
  });

  it('lets an OAuth or exchange reply store a token under the JWT subject, and a refresh replace it', async () => {
    const storage = memoryStorage();
    const store = createDeviceTokenStore(storage);
    await store.rememberFromReply({ userId: 'user-1', deviceToken: tokenFor('pw') }, { email: 'a@example.com' });
    // Exchange reply without a userId: the JWT names the account.
    await store.rememberFromReply({ deviceToken: tokenFor('oauth') }, { jwt: jwtFor('user-1') });
    expect(await store.headersForCredentialsSignIn('a@example.com')).toEqual({
      [NATIVE_DEVICE_TOKEN_HEADER]: tokenFor('oauth'),
    });

    await store.rememberFromReply({ userId: 'user-1', deviceToken: tokenFor('refresh') }, { jwt: jwtFor('user-1') });
    expect(await store.headersForCredentialsSignIn('a@example.com')).toEqual({
      [NATIVE_DEVICE_TOKEN_HEADER]: tokenFor('refresh'),
    });
  });

  it(`keeps the keychain bounded at ${MAX_DEVICE_TOKEN_ACCOUNTS} accounts in one key`, async () => {
    const storage = memoryStorage();
    const store = createDeviceTokenStore(storage);
    for (let index = 0; index < MAX_DEVICE_TOKEN_ACCOUNTS + 3; index += 1) {
      await store.rememberFromReply(
        { userId: `user-${index}`, deviceToken: tokenFor(`t${index}`) },
        { email: `c${index}@example.com` },
      );
    }
    expect([...storage.values.keys()]).toEqual([DEVICE_TOKEN_LEDGER_KEY]);
    const stored = JSON.parse(storage.values.get(DEVICE_TOKEN_LEDGER_KEY) ?? '{}') as { accounts: unknown[] };
    expect(stored.accounts).toHaveLength(MAX_DEVICE_TOKEN_ACCOUNTS);
  });

  it('serialises concurrent replies so neither account is lost', async () => {
    const storage = memoryStorage();
    const store = createDeviceTokenStore(storage);
    await Promise.all([
      store.rememberFromReply({ userId: 'user-1', deviceToken: tokenFor('a') }, { email: 'a@example.com' }),
      store.rememberFromReply({ userId: 'user-2', deviceToken: tokenFor('b') }, { email: 'b@example.com' }),
    ]);
    expect(await store.headersForCredentialsSignIn('a@example.com')).not.toEqual({});
    expect(await store.headersForCredentialsSignIn('b@example.com')).not.toEqual({});
  });

  it("fills a refresh-created entry's email from the profile, so the password sign-in finds it", async () => {
    const storage = memoryStorage();
    const store = createDeviceTokenStore(storage);
    await store.rememberFromReply({ userId: 'user-1', deviceToken: tokenFor('refresh') }, { jwt: jwtFor('user-1') });
    expect(await store.headersForCredentialsSignIn('a@example.com')).toEqual({});

    await store.rememberAccountEmail('user-1', 'A@Example.com');
    expect(await store.headersForCredentialsSignIn('a@example.com')).toEqual({
      [NATIVE_DEVICE_TOKEN_HEADER]: tokenFor('refresh'),
    });

    // The profile refetches often; a confirmed email costs no keychain access.
    storage.read.mockClear();
    storage.write.mockClear();
    await store.rememberAccountEmail('user-1', 'a@example.com');
    expect(storage.read).not.toHaveBeenCalled();
    expect(storage.write).not.toHaveBeenCalled();
  });

  it('names the first refresh token from an earlier profile of the same account', async () => {
    const store = createDeviceTokenStore(memoryStorage());
    await store.rememberAccountEmail('user-1', 'A@example.com');
    await store.rememberFromReply({ userId: 'user-2', deviceToken: tokenFor('other') });
    expect(await store.headersForCredentialsSignIn('a@example.com')).toEqual({});
    await store.rememberFromReply({ userId: 'user-1', deviceToken: tokenFor('refresh') });
    expect(await store.headersForCredentialsSignIn('a@example.com')).toEqual({
      [NATIVE_DEVICE_TOKEN_HEADER]: tokenFor('refresh'),
    });
  });

  it('forgets the pending profile when a newer sign-in takes its email', async () => {
    const store = createDeviceTokenStore(memoryStorage());
    await store.rememberAccountEmail('old-user', 'a@example.com');
    await store.rememberFromReply({ userId: 'new-user', deviceToken: tokenFor('new') }, { email: 'a@example.com' });
    await store.rememberFromReply({ userId: 'old-user', deviceToken: tokenFor('old') });
    expect(await store.headersForCredentialsSignIn('a@example.com')).toEqual({
      [NATIVE_DEVICE_TOKEN_HEADER]: tokenFor('new'),
    });
  });

  it('adds no entry from a profile alone', async () => {
    const storage = memoryStorage();
    const store = createDeviceTokenStore(storage);
    await store.rememberAccountEmail('user-1', 'a@example.com');
    expect(storage.write).not.toHaveBeenCalled();
    expect(await store.headersForCredentialsSignIn('a@example.com')).toEqual({});
  });

  it('does not let a refresh reply that lands after deletion re-add the account', async () => {
    const storage = memoryStorage();
    const store = createDeviceTokenStore(storage);
    await store.rememberFromReply({ userId: 'user-1', deviceToken: tokenFor('a') }, { email: 'a@example.com' });

    await store.forgetAccount('user-1');
    await store.rememberFromReply({ userId: 'user-1', deviceToken: tokenFor('late') }, { jwt: jwtFor('user-1') });
    await store.rememberAccountEmail('user-1', 'a@example.com');

    expect(storage.values.size).toBe(0);
    expect(await store.headersForCredentialsSignIn('a@example.com')).toEqual({});
  });

  it('never throws, even for a reply whose fields throw when read', async () => {
    const storage = memoryStorage();
    const store = createDeviceTokenStore(storage);
    const hostileReply = {
      get deviceToken(): string {
        throw new Error('getter');
      },
    };
    let settled: Promise<void> | undefined;
    expect(() => {
      settled = store.rememberFromReply(hostileReply, { jwt: 'not.a.jwt' });
    }).not.toThrow();
    await expect(settled).resolves.toBeUndefined();
    expect(storage.read).not.toHaveBeenCalled();
  });

  it('forgets a deleted account and removes the key when it was the last one', async () => {
    const storage = memoryStorage();
    const store = createDeviceTokenStore(storage);
    await store.rememberFromReply({ userId: 'user-1', deviceToken: tokenFor('a') }, { email: 'a@example.com' });
    await store.rememberFromReply({ userId: 'user-2', deviceToken: tokenFor('b') }, { email: 'b@example.com' });

    await store.forgetAccount('user-1');
    expect(await store.headersForCredentialsSignIn('a@example.com')).toEqual({});
    expect(await store.headersForCredentialsSignIn('b@example.com')).not.toEqual({});

    await store.forgetAccount('user-2');
    expect(storage.remove).toHaveBeenCalledExactlyOnceWith(DEVICE_TOKEN_LEDGER_KEY);
    expect(storage.values.size).toBe(0);

    storage.write.mockClear();
    await store.forgetAccount('never-stored');
    expect(storage.write).not.toHaveBeenCalled();
  });

  it('treats a malformed stored value as empty and replaces it on the next reply', async () => {
    const storage = memoryStorage();
    storage.values.set(DEVICE_TOKEN_LEDGER_KEY, '{not json');
    const store = createDeviceTokenStore(storage);

    expect(await store.headersForCredentialsSignIn('a@example.com')).toEqual({});
    await store.rememberFromReply({ userId: 'user-1', deviceToken: tokenFor('a') }, { email: 'a@example.com' });
    expect(await store.headersForCredentialsSignIn('a@example.com')).toEqual({
      [NATIVE_DEVICE_TOKEN_HEADER]: tokenFor('a'),
    });
  });

  it('never throws when the keychain fails', async () => {
    const storage = memoryStorage();
    storage.read.mockRejectedValue(new Error('User interaction is not allowed'));
    storage.write.mockRejectedValue(new Error('write failed'));
    storage.remove.mockRejectedValue(new Error('delete failed'));
    const store = createDeviceTokenStore(storage);

    await expect(
      store.rememberFromReply({ userId: 'user-1', deviceToken: tokenFor('a') }, { email: 'a@example.com' }),
    ).resolves.toBeUndefined();
    await expect(store.headersForCredentialsSignIn('a@example.com')).resolves.toEqual({});
    await expect(store.forgetAccount('user-1')).resolves.toBeUndefined();
  });

  it('gives up on a keychain that does not answer and sends no header', async () => {
    const storage = memoryStorage();
    storage.read.mockReturnValue(new Promise<string | null>(() => {}));
    const timers: Array<() => void> = [];
    const store = createDeviceTokenStore(storage, {
      setTimer: (callback) => {
        timers.push(callback);
        return timers.length;
      },
      clearTimer: () => {},
    });

    const headers = store.headersForCredentialsSignIn('a@example.com');
    expect(timers).toHaveLength(1);
    timers[0]();
    await expect(headers).resolves.toEqual({});
  });
});

describe('the app-wide store on the real keychain helpers (iOS)', () => {
  it('writes the ledger to v2, mirrors it to legacy, and keeps it readable', async () => {
    await rememberDeviceTokenFromReply({ userId: 'user-1', deviceToken: tokenFor('a') }, { email: 'a@example.com' });
    await deviceTokenHeadersForCredentialsSignIn('a@example.com');

    const ledgerWrites = vi
      .mocked(SecureStore.setItemAsync)
      .mock.calls.filter(([key]) => key === DEVICE_TOKEN_LEDGER_KEY);
    expect(ledgerWrites).toHaveLength(2);
    expect(ledgerWrites[0][2]).toEqual({ keychainAccessible: AFTER_FIRST_UNLOCK, keychainService: 'boardsesh.v2' });
    expect(ledgerWrites[1][2]).toEqual({ keychainAccessible: AFTER_FIRST_UNLOCK });
    expect(await deviceTokenHeadersForCredentialsSignIn('A@example.com')).toEqual({
      [NATIVE_DEVICE_TOKEN_HEADER]: tokenFor('a'),
    });
  });

  it('removes the ledger from both namespaces once the last account is deleted', async () => {
    await rememberDeviceTokenFromReply({ userId: 'user-9', deviceToken: tokenFor('z') }, { email: 'z@example.com' });
    await forgetDeviceTokenForAccount('user-9');

    expect(keychain.items.has(`boardsesh.v2:${DEVICE_TOKEN_LEDGER_KEY}`)).toBe(false);
    expect(keychain.items.has(`app:${DEVICE_TOKEN_LEDGER_KEY}`)).toBe(false);
    expect(await deviceTokenHeadersForCredentialsSignIn('z@example.com')).toEqual({});
  });
});
