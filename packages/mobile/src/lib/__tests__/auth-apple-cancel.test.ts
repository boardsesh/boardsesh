import { beforeEach, describe, expect, it, vi } from 'vitest';

// auth.ts pulls in several native modules at import time; mock them so
// signInWithApple can be driven in a plain node test. Only the Apple module
// carries behaviour here — everything else is a stub to satisfy the import
// graph. Mirrors the harness in auth-google-web.test.ts.
const signInAsyncMock = vi.fn();
vi.mock('expo-apple-authentication', () => ({
  signInAsync: (...args: unknown[]) => signInAsyncMock(...args),
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
vi.mock('../abort-timeout', () => ({ createTimeoutSignal: () => undefined }));
vi.mock('../env', () => ({ BACKEND_URL: 'https://backend.test', WEB_BASE_URL: 'https://web.test' }));
vi.mock('../auth-store', () => ({
  captureAuthCredentialGeneration: vi.fn(() => 1),
  storeTokens: vi.fn(),
  clearTokensForGeneration: vi.fn(),
  getRefreshToken: vi.fn(),
  isAuthCredentialGenerationCurrent: vi.fn(),
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { signInWithApple } = await import('../auth');

/**
 * The integration point for #3088: `useNativeOAuthSignIn` only skips the iOS
 * browser fallback when signInWithApple hands it `{ cancelled: true }` — every
 * other outcome (including a throw) reaches the hook's outer catch, where
 * `willFallBack = Platform.OS === 'ios'` is unconditionally true. So the cancel
 * has to be recognised *here*; the predicate's own unit tests can't prove it is
 * wired in. See use-native-oauth-sign-in.test.tsx for the hook half.
 */
describe('signInWithApple — backing out of the system sheet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports the coded cancel as a cancel, without hitting the backend', async () => {
    signInAsyncMock.mockRejectedValue(
      Object.assign(new Error('The operation was canceled'), {
        code: 'ERR_REQUEST_CANCELED',
      }),
    );

    await expect(signInWithApple()).resolves.toEqual({ success: false, cancelled: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a message-only cancel as a cancel, so iOS never runs the browser fallback', async () => {
    // The shape that escaped before #3088: some builds of
    // expo-apple-authentication reject with no usable `.code`. 49 events / 44
    // users in 30 days threw past this catch and opened a web sign-in.
    signInAsyncMock.mockRejectedValue(new Error('The user canceled the authorization attempt'));

    await expect(signInWithApple()).resolves.toEqual({ success: false, cancelled: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still rethrows a real Apple failure so the caller can fall back', async () => {
    const failure = new Error('The authorization attempt failed for an unknown reason');
    signInAsyncMock.mockRejectedValue(failure);

    await expect(signInWithApple()).rejects.toBe(failure);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
