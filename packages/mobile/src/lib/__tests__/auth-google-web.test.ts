import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// auth.ts pulls in several native modules at import time. Mock them so the
// browser-OAuth fallback can be exercised in a plain node test. The real
// deep-link parser is kept (it's pure — no native imports).
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-apple-authentication', () => ({}));
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

const storeTokensMock = vi.fn();
vi.mock('../auth-store', () => ({
  storeTokens: (...args: unknown[]) => storeTokensMock(...args),
  clearTokens: vi.fn(),
  getRefreshToken: vi.fn(),
}));

const openAuthSessionAsyncMock = vi.fn();
vi.mock('expo-web-browser', () => ({
  openAuthSessionAsync: (...args: unknown[]) => openAuthSessionAsyncMock(...args),
}));

const { signInWithGoogleWeb, signInWithAppleWeb } = await import('../auth');

const okExchange = () =>
  new Response(JSON.stringify({ jwt: 'jwt-1', refreshToken: 'refresh-1', expiresAt: '2026-01-01T00:00:00.000Z' }), {
    status: 200,
  });

describe('signInWithGoogleWeb', () => {
  beforeEach(() => {
    openAuthSessionAsyncMock.mockReset();
    storeTokensMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drives the web native-start handoff and exchanges the transfer token into a stored session', async () => {
    openAuthSessionAsyncMock.mockResolvedValue({
      type: 'success',
      url: 'com.boardsesh.app://auth/callback?transferToken=tok-123&next=%2F',
    });
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(okExchange());

    const result = await signInWithGoogleWeb();

    expect(result).toEqual({ success: true });
    const [startUrl, redirect] = openAuthSessionAsyncMock.mock.calls[0];
    expect(startUrl).toContain('https://web.test/auth/native-start?provider=google');
    expect(startUrl).toContain(encodeURIComponent('https://web.test/api/auth/native/callback?next=%2F'));
    // Keep in sync with the web app's NATIVE_OAUTH_CALLBACK_SCHEME
    // (packages/web/app/lib/auth/native-oauth-config.ts) — the redirect the web
    // /api/auth/native/callback route deep-links back to. If web changes it, this
    // must change too, or openAuthSessionAsync never captures the token.
    expect(redirect).toBe('com.boardsesh.app://auth/callback');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://backend.test/auth/native/exchange',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ transferToken: 'tok-123' }) }),
    );
    expect(storeTokensMock).toHaveBeenCalledWith('jwt-1', 'refresh-1', '2026-01-01T00:00:00.000Z');
  });

  it('treats a dismissed browser as a cancellation and never exchanges', async () => {
    openAuthSessionAsyncMock.mockResolvedValue({ type: 'dismiss' });
    const fetchMock = vi.spyOn(global, 'fetch');

    expect(await signInWithGoogleWeb()).toEqual({ success: false, cancelled: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces an error param from the callback redirect without exchanging', async () => {
    openAuthSessionAsyncMock.mockResolvedValue({
      type: 'success',
      url: 'com.boardsesh.app://auth/callback?error=session_missing',
    });
    const fetchMock = vi.spyOn(global, 'fetch');

    expect(await signInWithGoogleWeb()).toEqual({ success: false, status: null, error: 'session_missing' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns no_transfer_token when the redirect carries neither a token nor an error', async () => {
    openAuthSessionAsyncMock.mockResolvedValue({ type: 'success', url: 'com.boardsesh.app://auth/callback' });

    expect(await signInWithGoogleWeb()).toEqual({ success: false, status: null, error: 'no_transfer_token' });
  });

  it('maps a non-ok exchange to the server status + error message', async () => {
    openAuthSessionAsyncMock.mockResolvedValue({
      type: 'success',
      url: 'com.boardsesh.app://auth/callback?transferToken=expired',
    });
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Invalid or expired transfer token' }), { status: 401 }),
    );

    expect(await signInWithGoogleWeb()).toEqual({
      success: false,
      status: 401,
      error: 'Invalid or expired transfer token',
    });
    expect(storeTokensMock).not.toHaveBeenCalled();
  });

  it('returns invalid_response when a 200 exchange body is not JSON', async () => {
    openAuthSessionAsyncMock.mockResolvedValue({
      type: 'success',
      url: 'com.boardsesh.app://auth/callback?transferToken=tok',
    });
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('not json', { status: 200 }));

    expect(await signInWithGoogleWeb()).toEqual({ success: false, status: 200, error: 'invalid_response' });
    expect(storeTokensMock).not.toHaveBeenCalled();
  });

  it('maps an exchange network rejection to a network failure', async () => {
    openAuthSessionAsyncMock.mockResolvedValue({
      type: 'success',
      url: 'com.boardsesh.app://auth/callback?transferToken=tok',
    });
    vi.spyOn(global, 'fetch').mockRejectedValue(new TypeError('Network request failed'));

    expect(await signInWithGoogleWeb()).toEqual({ success: false, status: null, error: 'network' });
  });

  it('maps an openAuthSessionAsync throw (no browser) to a network failure', async () => {
    openAuthSessionAsyncMock.mockRejectedValue(new Error('no browser'));

    expect(await signInWithGoogleWeb()).toEqual({ success: false, status: null, error: 'network' });
  });
});

// signInWithAppleWeb shares signInWithProviderWeb's body with signInWithGoogleWeb
// (the redirect, deep-link parse, and token exchange are provider-agnostic), so
// this only pins the one per-provider difference — the native-start provider
// param — plus the happy path, rather than re-running every shared branch.
describe('signInWithAppleWeb', () => {
  beforeEach(() => {
    openAuthSessionAsyncMock.mockReset();
    storeTokensMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens native-start with provider=apple and exchanges the transfer token into a stored session', async () => {
    openAuthSessionAsyncMock.mockResolvedValue({
      type: 'success',
      url: 'com.boardsesh.app://auth/callback?transferToken=apple-tok&next=%2F',
    });
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(okExchange());

    const result = await signInWithAppleWeb();

    expect(result).toEqual({ success: true });
    const [startUrl, redirect] = openAuthSessionAsyncMock.mock.calls[0];
    expect(startUrl).toContain('https://web.test/auth/native-start?provider=apple');
    expect(redirect).toBe('com.boardsesh.app://auth/callback');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://backend.test/auth/native/exchange',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ transferToken: 'apple-tok' }) }),
    );
    expect(storeTokensMock).toHaveBeenCalledWith('jwt-1', 'refresh-1', '2026-01-01T00:00:00.000Z');
  });

  it('treats a dismissed browser as a cancellation and never exchanges', async () => {
    openAuthSessionAsyncMock.mockResolvedValue({ type: 'dismiss' });
    const fetchMock = vi.spyOn(global, 'fetch');

    expect(await signInWithAppleWeb()).toEqual({ success: false, cancelled: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
