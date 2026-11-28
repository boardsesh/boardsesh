import { beforeEach, describe, expect, it, vi } from 'vitest';

// auth.ts wiring for #7656's device tokens, end to end over an in-memory
// keychain: what a password sign-in sends, what each reply stores, and that a
// backend which never returns `deviceToken` (production until the secret is
// set) sees exactly the requests it saw before.

process.env.EXPO_OS = 'ios';

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
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: { currentState: 'active', addEventListener: vi.fn() },
  Linking: { addEventListener: vi.fn() },
}));
vi.mock('expo-apple-authentication', () => ({}));
vi.mock('expo-web-browser', () => ({}));
vi.mock('expo-crypto', () => ({
  getRandomBytes: () => new Uint8Array(16),
  digestStringAsync: vi.fn(),
  CryptoDigestAlgorithm: { SHA256: 'SHA256' },
  CryptoEncoding: { HEX: 'HEX' },
}));
vi.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: { configure: vi.fn(), hasPlayServices: vi.fn(), signIn: vi.fn() },
  statusCodes: {},
}));
vi.mock('../env', () => ({ BACKEND_URL: 'https://backend.test', WEB_BASE_URL: 'https://web.test' }));
vi.mock('../client-identity', () => ({
  clientIdentityHeaders: () => ({ 'x-boardsesh-client': 'boardsesh-mobile/2.7.1 (ios; build 50)' }),
}));
const authStore = vi.hoisted(() => ({
  storeTokens: vi.fn(async (_jwt: string, _refreshToken: string, _expiresAt: string): Promise<void> => {}),
  clearTokensForGeneration: vi.fn(async (_generation: number): Promise<boolean> => true),
  getRefreshToken: vi.fn(async (): Promise<string | null> => 'refresh-token'),
}));
vi.mock('../auth-store', () => ({
  captureAuthCredentialGeneration: () => 1,
  isAuthCredentialGenerationCurrent: () => true,
  storeTokens: authStore.storeTokens,
  clearTokensForGeneration: authStore.clearTokensForGeneration,
  getRefreshToken: authStore.getRefreshToken,
}));

const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
vi.stubGlobal('fetch', fetchMock);

const SecureStore = await import('expo-secure-store');
const { oauthNativeSignIn, registerWithCredentials, signInWithCredentials, signOutForGeneration } =
  await import('../auth');
const { DEVICE_TOKEN_LEDGER_KEY, NATIVE_DEVICE_TOKEN_HEADER, deviceTokenHeadersForCredentialsSignIn } =
  await import('../device-token-store');
const { rememberDeviceTokenFromReply } = await import('../device-token-store');
const { watchProfileEmailForDeviceTokens } = await import('../device-token-profile-email');
const { QueryClient } = await import('@tanstack/react-query');

const USER_ID = '602c83bf-e090-4c90-9f7e-000000000101';
const OTHER_USER_ID = '602c83bf-e090-4c90-9f7e-000000000102';
const tokenFor = (label: string) => `v1.${label.padEnd(22, 'x')}.1763424000.${'s'.repeat(43)}`;
const jwtFor = (userId: string) => `header.${btoa(JSON.stringify({ sub: userId })).replace(/=/g, '')}.signature`;
const BASE_HEADERS = {
  'Content-Type': 'application/json',
  'x-boardsesh-client': 'boardsesh-mobile/2.7.1 (ios; build 50)',
};

function tokenReply(userId: string, deviceToken?: string): Response {
  const body = {
    jwt: jwtFor(userId),
    refreshToken: 'refresh',
    expiresAt: '2026-11-25T00:00:00.000Z',
    userId,
    ...(deviceToken ? { deviceToken } : {}),
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function requestTo(path: string): RequestInit | undefined {
  return fetchMock.mock.calls.find(([url]) => url === `https://backend.test${path}`)?.[1];
}

function ledgerWrites(): number {
  return vi.mocked(SecureStore.setItemAsync).mock.calls.filter(([key]) => key === DEVICE_TOKEN_LEDGER_KEY).length;
}

/** Wait for the fire-and-forget ledger write: reads queue behind writes. */
async function settleDeviceTokenWrites(): Promise<void> {
  await deviceTokenHeadersForCredentialsSignIn('settle@example.com');
}

beforeEach(() => {
  keychain.items.clear();
  vi.clearAllMocks();
  fetchMock.mockReset();
});

describe('with a backend that never returns deviceToken (production today)', () => {
  it('sends the same credentials request as before and stores nothing', async () => {
    fetchMock.mockImplementation(async () => tokenReply(USER_ID));

    await expect(signInWithCredentials('climber@example.com', 'pw')).resolves.toMatchObject({
      success: true,
      userId: USER_ID,
    });
    await settleDeviceTokenWrites();
    await signInWithCredentials('climber@example.com', 'pw');

    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe('https://backend.test/auth/native/credentials');
      expect(init.headers).toEqual(BASE_HEADERS);
      expect(init.body).toBe(JSON.stringify({ email: 'climber@example.com', password: 'pw' }));
    }
    expect(ledgerWrites()).toBe(0);
  });

  it('stores nothing from registration or OAuth replies either', async () => {
    fetchMock.mockImplementation(async () => tokenReply(USER_ID));

    await registerWithCredentials('new@example.com', 'pw');
    await oauthNativeSignIn('google', 'id-token');
    await settleDeviceTokenWrites();

    expect(ledgerWrites()).toBe(0);
    expect(requestTo('/auth/native/register')?.headers).toEqual(BASE_HEADERS);
    expect(requestTo('/auth/native/oauth')?.headers).toEqual(BASE_HEADERS);
  });
});

describe('with a backend that returns deviceToken', () => {
  it('sends the stored token back on the next password sign-in for that email only', async () => {
    fetchMock.mockResolvedValueOnce(tokenReply(USER_ID, tokenFor('first')));
    await signInWithCredentials('Climber@Example.com', 'pw');

    fetchMock.mockResolvedValueOnce(tokenReply(USER_ID, tokenFor('second')));
    await signInWithCredentials(' climber@example.com', 'pw');
    expect(fetchMock.mock.calls[1][1].headers).toEqual({
      ...BASE_HEADERS,
      [NATIVE_DEVICE_TOKEN_HEADER]: tokenFor('first'),
    });

    fetchMock.mockResolvedValueOnce(tokenReply(OTHER_USER_ID));
    await signInWithCredentials('someone-else@example.com', 'pw');
    expect(fetchMock.mock.calls[2][1].headers).toEqual(BASE_HEADERS);
  });

  it('keeps the token across sign-out, and never sends it on other requests', async () => {
    fetchMock.mockImplementation(async (url) =>
      url.endsWith('/auth/native/revoke') ? new Response('{}') : tokenReply(USER_ID, tokenFor('registered')),
    );
    await registerWithCredentials('climber@example.com', 'pw');
    await oauthNativeSignIn('apple', 'id-token');
    await signOutForGeneration(1);
    await signInWithCredentials('climber@example.com', 'pw');

    expect(requestTo('/auth/native/credentials')?.headers).toEqual({
      ...BASE_HEADERS,
      [NATIVE_DEVICE_TOKEN_HEADER]: tokenFor('registered'),
    });
    for (const path of ['/auth/native/register', '/auth/native/oauth', '/auth/native/revoke']) {
      expect(JSON.stringify(requestTo(path)?.headers)).not.toContain(NATIVE_DEVICE_TOKEN_HEADER);
    }
  });

  it('fills the token from an OAuth reply in for an account already signed in to by password', async () => {
    fetchMock.mockResolvedValueOnce(tokenReply(USER_ID, tokenFor('password')));
    await signInWithCredentials('climber@example.com', 'pw');
    fetchMock.mockResolvedValueOnce(tokenReply(USER_ID, tokenFor('google')));
    await oauthNativeSignIn('google', 'id-token');

    expect(await deviceTokenHeadersForCredentialsSignIn('climber@example.com')).toEqual({
      [NATIVE_DEVICE_TOKEN_HEADER]: tokenFor('google'),
    });
  });

  it('signs in normally when the keychain cannot be read', async () => {
    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error('User interaction is not allowed'));
    fetchMock.mockResolvedValueOnce(tokenReply(USER_ID));

    await expect(signInWithCredentials('climber@example.com', 'pw')).resolves.toMatchObject({ success: true });
    expect(fetchMock.mock.calls[0][1].headers).toEqual(BASE_HEADERS);
  });

  it('sends the token a refresh stored once the profile has named the email', async () => {
    const refreshedUserId = '602c83bf-e090-4c90-9f7e-000000000103';
    // Already signed in before the OTA: the only token arrives on a refresh reply.
    await rememberDeviceTokenFromReply(
      { jwt: jwtFor(refreshedUserId), userId: refreshedUserId, deviceToken: tokenFor('refresh') },
      { jwt: jwtFor(refreshedUserId) },
    );
    const queryClient = new QueryClient();
    const stopWatching = watchProfileEmailForDeviceTokens(queryClient);
    queryClient.setQueryData(['profile'], { profile: { id: refreshedUserId, email: 'Long.Time@Example.com' } });
    // The cache notifies its listeners on a later tick.
    await vi.waitFor(async () => {
      expect(await deviceTokenHeadersForCredentialsSignIn('long.time@example.com')).not.toEqual({});
    });
    stopWatching();

    fetchMock.mockResolvedValueOnce(tokenReply(refreshedUserId));
    await signInWithCredentials('long.time@example.com', 'pw');

    expect(fetchMock.mock.calls[0][1].headers).toEqual({
      ...BASE_HEADERS,
      [NATIVE_DEVICE_TOKEN_HEADER]: tokenFor('refresh'),
    });
  });
});
