import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// auth.ts pulls in several native modules at import time. Mock them so the
// browser-OAuth fallback can be exercised in a plain node test. The real
// deep-link parser and the real raceBrowserSignIn are kept (both pure — no
// native imports).
//
// The fallback now drives an openBrowserAsync + OS deep-link race (raceBrowserSignIn)
// instead of the broken WebBrowser.openAuthSessionAsync (see auth.ts). So the
// harness captures the Linking 'url' listener the race registers and controls
// the browser promise, letting each test fire the deep link, close the browser,
// or fail it to open — in any order.
let urlListener: ((event: { url: string }) => void) | null = null;
let appStateListener: ((state: 'active' | 'background' | 'inactive' | 'unknown' | 'extension') => void) | null = null;
let currentAppState: 'active' | 'background' | 'inactive' | 'unknown' | 'extension' | null = 'active';
let resolveBrowser: ((result: unknown) => void) | null = null;
let rejectBrowser: ((reason: unknown) => void) | null = null;
const platformState = { OS: 'ios' };

const removeListenerMock = vi.fn(() => {
  urlListener = null;
});
const addEventListenerMock = vi.fn((_event: string, listener: (event: { url: string }) => void) => {
  urlListener = listener;
  return { remove: removeListenerMock };
});
const removeAppStateListenerMock = vi.fn(() => {
  appStateListener = null;
});
const addAppStateEventListenerMock = vi.fn(
  (_event: string, listener: (state: 'active' | 'background' | 'inactive' | 'unknown' | 'extension') => void) => {
    appStateListener = listener;
    return { remove: removeAppStateListenerMock };
  },
);

vi.mock('react-native', () => ({
  Platform: platformState,
  AppState: {
    get currentState() {
      return currentAppState;
    },
    addEventListener: (
      event: string,
      listener: (state: 'active' | 'background' | 'inactive' | 'unknown' | 'extension') => void,
    ) => addAppStateEventListenerMock(event, listener),
  },
  Linking: {
    addEventListener: (event: string, listener: (event: { url: string }) => void) =>
      addEventListenerMock(event, listener),
  },
}));
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
const clearTokensForGenerationMock = vi.fn();
const getRefreshTokenMock = vi.fn();
const isAuthCredentialGenerationCurrentMock = vi.fn();
vi.mock('../auth-store', () => ({
  captureAuthCredentialGeneration: vi.fn(() => 1),
  storeTokens: (...args: unknown[]) => storeTokensMock(...args),
  clearTokensForGeneration: (...args: unknown[]) => clearTokensForGenerationMock(...args),
  getRefreshToken: (...args: unknown[]) => getRefreshTokenMock(...args),
  isAuthCredentialGenerationCurrent: (...args: unknown[]) => isAuthCredentialGenerationCurrentMock(...args),
}));

// Plain vi.fn() (no inline implementation) so the wrapper's spread call stays
// permissively typed — an implemented vi.fn narrows the param list and CI's
// test-inclusive typecheck rejects the spread (TS2556). resetMocks() gives
// dismissBrowser its resolved-promise behaviour.
const openBrowserAsyncMock = vi.fn();
const dismissBrowserMock = vi.fn();
vi.mock('expo-web-browser', () => ({
  openBrowserAsync: (...args: unknown[]) => openBrowserAsyncMock(...args),
  dismissBrowser: (...args: unknown[]) => dismissBrowserMock(...args),
}));

const { setNetworkPolicy } = await import('../network-policy');
const { signInWithGoogleWeb, signInWithAppleWeb, signOut, signOutForGeneration } = await import('../auth');

// Keep in sync with the web app's NATIVE_OAUTH_CALLBACK_SCHEME
// (packages/web/app/lib/auth/native-oauth-config.ts) and auth.ts's
// NATIVE_OAUTH_REDIRECT — the scheme the race listens for and the server's
// /api/auth/native/callback deep-links back to. If web changes it, this must
// change too, or the race never captures the token and the browser hangs open.
const CALLBACK_SCHEME = 'com.boardsesh.app://auth/callback';

// raceBrowserSignIn's executor runs synchronously: it registers the url listener
// and calls openBrowserAsync (left pending here) before signInWithProviderWeb's
// await suspends. So after calling the sign-in fn — before awaiting it — the
// listener is captured and the browser is open; each helper then drives one edge.
function armBrowser() {
  openBrowserAsyncMock.mockImplementation(
    () =>
      new Promise<unknown>((resolve, reject) => {
        resolveBrowser = resolve;
        rejectBrowser = reject;
      }),
  );
}
const fireDeepLink = (url: string) => urlListener?.({ url });
const resolveBrowserResult = (result: unknown) => resolveBrowser?.(result);
const closeBrowser = () => resolveBrowserResult({ type: 'dismiss' });
const failBrowser = (reason: unknown) => rejectBrowser?.(reason);
const fireAppState = (state: 'active' | 'background' | 'inactive' | 'unknown' | 'extension') => {
  currentAppState = state;
  appStateListener?.(state);
};

const okExchange = () =>
  new Response(JSON.stringify({ jwt: 'jwt-1', refreshToken: 'refresh-1', expiresAt: '2026-01-01T00:00:00.000Z' }), {
    status: 200,
  });

function resetMocks() {
  setNetworkPolicy('online');
  urlListener = null;
  appStateListener = null;
  currentAppState = 'active';
  platformState.OS = 'ios';
  resolveBrowser = null;
  rejectBrowser = null;
  openBrowserAsyncMock.mockReset();
  dismissBrowserMock.mockReset();
  dismissBrowserMock.mockResolvedValue(undefined);
  removeListenerMock.mockClear();
  addEventListenerMock.mockClear();
  removeAppStateListenerMock.mockClear();
  addAppStateEventListenerMock.mockClear();
  storeTokensMock.mockReset();
  clearTokensForGenerationMock.mockReset();
  clearTokensForGenerationMock.mockResolvedValue(true);
  getRefreshTokenMock.mockReset();
  getRefreshTokenMock.mockResolvedValue(null);
  isAuthCredentialGenerationCurrentMock.mockReset();
  isAuthCredentialGenerationCurrentMock.mockReturnValue(true);
  armBrowser();
}

describe('signInWithGoogleWeb', () => {
  beforeEach(resetMocks);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drives the web native-start handoff and exchanges the transfer token into a stored session', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(okExchange());

    const racePromise = signInWithGoogleWeb();
    // A non-callback deep link must be ignored — pins the exact callback scheme
    // (the race would settle on the wrong URL if the prefix were too loose).
    fireDeepLink('com.boardsesh.app://join/some-session');
    fireDeepLink(`${CALLBACK_SCHEME}?transferToken=tok-123&next=%2F`);
    const result = await racePromise;

    expect(result).toEqual({ success: true });
    const [startUrl] = openBrowserAsyncMock.mock.calls[0];
    expect(startUrl).toContain('https://web.test/auth/native-start?provider=google');
    expect(startUrl).toContain(encodeURIComponent('https://web.test/api/auth/native/callback?next=%2F'));
    // The captured callback dismisses the browser left open under the deep-link
    // hand-off, and the listener is torn down after the race settles.
    expect(dismissBrowserMock).toHaveBeenCalledTimes(1);
    expect(removeListenerMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://backend.test/auth/native/exchange',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ transferToken: 'tok-123' }) }),
    );
    expect(storeTokensMock).toHaveBeenCalledWith('jwt-1', 'refresh-1', '2026-01-01T00:00:00.000Z');
  });

  it('keeps the Android listener alive after opened and exchanges the callback after foregrounding', async () => {
    vi.useFakeTimers();
    try {
      platformState.OS = 'android';
      const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(okExchange());

      const racePromise = signInWithGoogleWeb();
      resolveBrowserResult({ type: 'opened' });
      await Promise.resolve();
      expect(removeListenerMock).not.toHaveBeenCalled();

      fireAppState('background');
      fireAppState('active');
      fireDeepLink(`${CALLBACK_SCHEME}?transferToken=android-tok`);

      await expect(racePromise).resolves.toEqual({ success: true });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://backend.test/auth/native/exchange',
        expect.objectContaining({ body: JSON.stringify({ transferToken: 'android-tok' }) }),
      );
      expect(removeListenerMock).toHaveBeenCalledOnce();
      expect(removeAppStateListenerMock).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps an exhausted Android callback race to browser_timeout', async () => {
    vi.useFakeTimers();
    try {
      platformState.OS = 'android';
      const fetchMock = vi.spyOn(global, 'fetch');

      const racePromise = signInWithGoogleWeb();
      resolveBrowserResult({ type: 'opened' });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1_000);

      await expect(racePromise).resolves.toEqual({ success: false, status: null, error: 'browser_timeout' });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a closed browser (no callback deep link) as a cancellation and never exchanges', async () => {
    const fetchMock = vi.spyOn(global, 'fetch');

    const racePromise = signInWithGoogleWeb();
    closeBrowser();

    expect(await racePromise).toEqual({ success: false, cancelled: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dismissBrowserMock).not.toHaveBeenCalled();
  });

  it('reports browser_unavailable (not a cancel, not network) when the browser fails to open', async () => {
    const fetchMock = vi.spyOn(global, 'fetch');

    const racePromise = signInWithGoogleWeb();
    // The iOS 26 dead-end this fixes: the in-app browser rejects instead of
    // presenting. Must be a distinct terminal reason, not a silent cancel.
    failBrowser(new Error('Another WebBrowser is already being presented.'));

    expect(await racePromise).toEqual({ success: false, status: null, error: 'browser_unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces an error param from the callback redirect without exchanging', async () => {
    const fetchMock = vi.spyOn(global, 'fetch');

    const racePromise = signInWithGoogleWeb();
    fireDeepLink(`${CALLBACK_SCHEME}?error=session_missing`);

    expect(await racePromise).toEqual({ success: false, status: null, error: 'session_missing' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns no_transfer_token when the redirect carries neither a token nor an error', async () => {
    const racePromise = signInWithGoogleWeb();
    fireDeepLink(CALLBACK_SCHEME);

    expect(await racePromise).toEqual({ success: false, status: null, error: 'no_transfer_token' });
  });

  it('maps a non-ok exchange to the server status + error message', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Invalid or expired transfer token' }), { status: 401 }),
    );

    const racePromise = signInWithGoogleWeb();
    fireDeepLink(`${CALLBACK_SCHEME}?transferToken=expired`);

    expect(await racePromise).toEqual({
      success: false,
      status: 401,
      error: 'Invalid or expired transfer token',
    });
    expect(storeTokensMock).not.toHaveBeenCalled();
  });

  it('returns invalid_response when a 200 exchange body is not JSON', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('not json', { status: 200 }));

    const racePromise = signInWithGoogleWeb();
    fireDeepLink(`${CALLBACK_SCHEME}?transferToken=tok`);

    expect(await racePromise).toEqual({ success: false, status: 200, error: 'invalid_response' });
    expect(storeTokensMock).not.toHaveBeenCalled();
  });

  it('maps an exchange network rejection to a network failure', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new TypeError('Network request failed'));

    const racePromise = signInWithGoogleWeb();
    fireDeepLink(`${CALLBACK_SCHEME}?transferToken=tok`);

    expect(await racePromise).toEqual({ success: false, status: null, error: 'network' });
  });
});

// signInWithAppleWeb shares signInWithProviderWeb's body with signInWithGoogleWeb
// (the race, deep-link parse, and token exchange are provider-agnostic), so this
// only pins the one per-provider difference — the native-start provider param —
// plus the happy path, rather than re-running every shared branch.
describe('signInWithAppleWeb', () => {
  beforeEach(resetMocks);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens native-start with provider=apple and exchanges the transfer token into a stored session', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(okExchange());

    const racePromise = signInWithAppleWeb();
    fireDeepLink(`${CALLBACK_SCHEME}?transferToken=apple-tok&next=%2F`);
    const result = await racePromise;

    expect(result).toEqual({ success: true });
    const [startUrl] = openBrowserAsyncMock.mock.calls[0];
    expect(startUrl).toContain('https://web.test/auth/native-start?provider=apple');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://backend.test/auth/native/exchange',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ transferToken: 'apple-tok' }) }),
    );
    expect(storeTokensMock).toHaveBeenCalledWith('jwt-1', 'refresh-1', '2026-01-01T00:00:00.000Z');
  });

  it('treats a closed browser as a cancellation and never exchanges', async () => {
    const fetchMock = vi.spyOn(global, 'fetch');

    const racePromise = signInWithAppleWeb();
    closeBrowser();

    expect(await racePromise).toEqual({ success: false, cancelled: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('signOut', () => {
  beforeEach(resetMocks);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('still clears credentials when reading the best-effort revocation token fails', async () => {
    const fetchMock = vi.spyOn(global, 'fetch');
    getRefreshTokenMock.mockRejectedValueOnce(new Error('keychain read unavailable'));

    await expect(signOut()).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(clearTokensForGenerationMock).toHaveBeenCalledWith(1);
  });

  it('surfaces a credential cleanup failure', async () => {
    const cleanupError = new Error('credential cleanup failed');
    clearTokensForGenerationMock.mockRejectedValueOnce(cleanupError);

    await expect(signOut()).rejects.toBe(cleanupError);
  });

  it('does not clear or revoke a newer account when an old forced sign-out is superseded', async () => {
    const fetchMock = vi.spyOn(global, 'fetch');
    let releaseRefreshTokenRead!: (token: string) => void;
    getRefreshTokenMock.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        releaseRefreshTokenRead = resolve;
      }),
    );

    const oldSignOut = signOutForGeneration(1);
    await vi.waitFor(() => expect(getRefreshTokenMock).toHaveBeenCalledTimes(1));
    isAuthCredentialGenerationCurrentMock.mockReturnValue(false);
    releaseRefreshTokenRead('new-user-refresh-token');

    await expect(oldSignOut).resolves.toBe(false);
    expect(clearTokensForGenerationMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns false when a newer login arrives while credential deletion succeeds', async () => {
    let currentGeneration = 1;
    isAuthCredentialGenerationCurrentMock.mockImplementation((generation: number) => generation === currentGeneration);
    let finishClear!: (cleared: boolean) => void;
    clearTokensForGenerationMock.mockImplementationOnce(() => {
      currentGeneration = 2;
      return new Promise<boolean>((resolve) => {
        finishClear = resolve;
      });
    });

    const oldSignOut = signOutForGeneration(1);
    await vi.waitFor(() => expect(clearTokensForGenerationMock).toHaveBeenCalledWith(1));
    currentGeneration = 3;
    finishClear(true);

    await expect(oldSignOut).resolves.toBe(false);
  });

  it('returns false when a newer login arrives while credential deletion fails', async () => {
    let currentGeneration = 1;
    isAuthCredentialGenerationCurrentMock.mockImplementation((generation: number) => generation === currentGeneration);
    let failClear!: (error: unknown) => void;
    clearTokensForGenerationMock.mockImplementationOnce(() => {
      currentGeneration = 2;
      return new Promise<boolean>((_resolve, reject) => {
        failClear = reject;
      });
    });

    const oldSignOut = signOutForGeneration(1);
    await vi.waitFor(() => expect(clearTokensForGenerationMock).toHaveBeenCalledWith(1));
    currentGeneration = 3;
    failClear(new Error('old credential cleanup failed'));

    await expect(oldSignOut).resolves.toBe(false);
  });
});
