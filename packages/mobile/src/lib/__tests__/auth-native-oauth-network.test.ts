import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// auth.ts pulls in several native modules at import time; mock them so
// signInWithApple can be driven in a plain node test. Only the Apple module
// carries behaviour here — everything else is a stub to satisfy the import
// graph. Mirrors the harness in auth-google-web.test.ts.
vi.mock('expo-apple-authentication', () => ({
  signInAsync: vi.fn(),
  AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  Linking: { addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock('expo-web-browser', () => ({ openBrowserAsync: vi.fn(), dismissBrowser: vi.fn() }));
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
// auth.ts stamps every request with client-identity headers, which import
// expo-application — a native module that can't load in node (#6224).
vi.mock('../client-identity', () => ({
  clientIdentityHeaders: () => ({ 'x-boardsesh-client': 'boardsesh-mobile/2.6.0 (ios; build 45)' }),
}));
vi.mock('../auth-store', () => ({
  captureAuthCredentialGeneration: vi.fn(() => 1),
  storeTokens: vi.fn(),
  clearTokensForGeneration: vi.fn(),
  getRefreshToken: vi.fn(),
  isAuthCredentialGenerationCurrent: vi.fn(),
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { oauthNativeSignIn } = await import('../auth');

describe('oauthNativeSignIn network failures (#5852)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports networkCause "timeout" when the 15 s abort fires', async () => {
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('Aborted')));
        }),
    );

    const pending = oauthNativeSignIn('google', 'id-token');
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(pending).resolves.toEqual({
      success: false,
      status: null,
      error: 'network',
      networkCause: 'timeout',
    });
  });

  it('reports networkCause "unreachable" when fetch fails before the timeout', async () => {
    fetchMock.mockRejectedValue(new TypeError('Network request failed'));

    await expect(oauthNativeSignIn('google', 'id-token')).resolves.toEqual({
      success: false,
      status: null,
      error: 'network',
      networkCause: 'unreachable',
    });
  });
});
