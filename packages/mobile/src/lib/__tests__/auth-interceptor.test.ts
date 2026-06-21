import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ── Mock expo-secure-store ──────────────────────────────────────────────
// auth-store imports expo-secure-store, which doesn't exist in Node.
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn().mockResolvedValue(null),
  setItemAsync: vi.fn().mockResolvedValue(undefined),
  deleteItemAsync: vi.fn().mockResolvedValue(undefined),
}));

// ── Mock auth-store for interceptor-level tests ─────────────────────────
vi.mock('../auth-store', () => ({
  getAuthToken: vi.fn().mockResolvedValue('test-jwt'),
  getRefreshToken: vi.fn().mockResolvedValue('test-refresh-token'),
  storeTokens: vi.fn().mockResolvedValue(undefined),
  isTokenExpiringSoon: vi.fn().mockResolvedValue(false),
  getTokenExpiresAt: vi.fn().mockResolvedValue(null),
}));

// ── Mock auth module (signOut used by interceptor on 401) ───────────────
const mockSignOut = vi.fn().mockResolvedValue(undefined);
vi.mock('../auth', () => ({
  signOut: (...args: unknown[]) => mockSignOut(...args),
}));

import { ensureFreshToken, authenticatedFetch, setOnForcedSignOut } from '../auth-interceptor';
import { getAuthToken, getRefreshToken, storeTokens, isTokenExpiringSoon } from '../auth-store';

const mockIsTokenExpiringSoon = isTokenExpiringSoon as Mock;
const mockGetAuthToken = getAuthToken as Mock;
const mockGetRefreshToken = getRefreshToken as Mock;
const mockStoreTokens = storeTokens as Mock;

// ── Global fetch mock ────────────────────────────────────────────────────
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAuthToken.mockResolvedValue('test-jwt');
  mockGetRefreshToken.mockResolvedValue('test-refresh-token');
  mockIsTokenExpiringSoon.mockResolvedValue(false);
  // The forced-sign-out hook is module-level state — clear it so a callback
  // registered by one test doesn't leak into the next.
  setOnForcedSignOut(null);
});

// ── ensureFreshToken ─────────────────────────────────────────────────────

describe('ensureFreshToken', () => {
  it('skips refresh when token is not expiring', async () => {
    mockIsTokenExpiringSoon.mockResolvedValue(false);

    const result = await ensureFreshToken();

    expect(result).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockStoreTokens).not.toHaveBeenCalled();
  });

  it('triggers refresh when token is expiring', async () => {
    mockIsTokenExpiringSoon.mockResolvedValue(true);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          jwt: 'new-jwt',
          refreshToken: 'new-refresh',
          expiresAt: '2099-01-01T00:00:00Z',
        }),
    });

    const result = await ensureFreshToken();

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/auth/native/refresh'),
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: 'test-refresh-token' }),
      }),
    );
    expect(mockStoreTokens).toHaveBeenCalledWith('new-jwt', 'new-refresh', '2099-01-01T00:00:00Z');
  });

  it('deduplicates concurrent refresh calls', async () => {
    mockIsTokenExpiringSoon.mockResolvedValue(true);
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          jwt: 'new-jwt',
          refreshToken: 'new-refresh',
          expiresAt: '2099-01-01T00:00:00Z',
        }),
    });

    const [resultA, resultB, resultC] = await Promise.all([ensureFreshToken(), ensureFreshToken(), ensureFreshToken()]);

    expect(resultA).toBe(true);
    expect(resultB).toBe(true);
    expect(resultC).toBe(true);
    // Only one actual fetch despite three concurrent calls
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns false without calling fetch when refresh token is null', async () => {
    mockIsTokenExpiringSoon.mockResolvedValue(true);
    mockGetRefreshToken.mockResolvedValue(null);

    const result = await ensureFreshToken();

    expect(result).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockStoreTokens).not.toHaveBeenCalled();
  });

  it('returns false and logs warning when fetch throws', async () => {
    mockIsTokenExpiringSoon.mockResolvedValue(true);
    mockGetRefreshToken.mockResolvedValue('some-refresh-token');
    mockFetch.mockRejectedValueOnce(new Error('Network error'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const result = await ensureFreshToken();
      expect(result).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith('[Auth] Token refresh error:', 'Network error');
      expect(mockStoreTokens).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ── authenticatedFetch ───────────────────────────────────────────────────

describe('authenticatedFetch', () => {
  it('retries with new token on 401 even when token is not expiring', async () => {
    // Token is NOT expiring — the 401 path should bypass the expiry check
    mockIsTokenExpiringSoon.mockResolvedValue(false);
    mockGetAuthToken
      .mockResolvedValueOnce('old-jwt') // first call before initial request
      .mockResolvedValueOnce('new-jwt') // after refresh, for the retry
      .mockResolvedValue('new-jwt');

    // First request returns 401
    mockFetch.mockResolvedValueOnce({
      status: 401,
      ok: false,
    });
    // Refresh endpoint succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          jwt: 'new-jwt',
          refreshToken: 'new-refresh',
          expiresAt: '2099-01-01T00:00:00Z',
        }),
    });
    // Retried request succeeds
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
    });

    const response = await authenticatedFetch('https://api.example.com/data');

    expect(response.status).toBe(200);
    // 3 fetches: original request, refresh, retry
    expect(mockFetch).toHaveBeenCalledTimes(3);

    // Verify the retry used the new token
    const retryCall = mockFetch.mock.calls[2];
    const retryHeaders = retryCall[1].headers as Headers;
    expect(retryHeaders.get('Authorization')).toBe('Bearer new-jwt');
  });

  it('clears tokens and fires the forced-sign-out hook when 401 retry refresh fails', async () => {
    mockIsTokenExpiringSoon.mockResolvedValue(false);
    mockGetAuthToken.mockResolvedValue('old-jwt');
    const onForcedSignOut = vi.fn();
    setOnForcedSignOut(onForcedSignOut);

    // Initial request returns 401
    mockFetch.mockResolvedValueOnce({
      status: 401,
      ok: false,
    });
    // Refresh endpoint fails
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
    });

    const response = await authenticatedFetch('https://api.example.com/data');

    expect(response.status).toBe(401);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    // The provider's cleanup hook fires so the UI leaves the authenticated
    // screens immediately, and only after the token revoke/clear.
    expect(onForcedSignOut).toHaveBeenCalledTimes(1);
    expect(mockSignOut.mock.invocationCallOrder[0]).toBeLessThan(onForcedSignOut.mock.invocationCallOrder[0]);
  });

  it('fires the forced-sign-out hook once when concurrent requests both 401 and refresh fails', async () => {
    // deduplicatedRefresh collapses the refresh, but each waiting caller still
    // sees refreshed=false. The forced sign-out must run once — not once per
    // request — so PostHog gets a single `forced` Logout, not N duplicates.
    mockIsTokenExpiringSoon.mockResolvedValue(false);
    mockGetAuthToken.mockResolvedValue('old-jwt');
    const onForcedSignOut = vi.fn();
    setOnForcedSignOut(onForcedSignOut);

    // Key on the URL rather than call order: any data request 401s, the refresh
    // 403s — so the assertion can't hinge on how the two requests interleave.
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(url.includes('/auth/native/refresh') ? { ok: false, status: 403 } : { status: 401, ok: false }),
    );

    const [responseA, responseB] = await Promise.all([
      authenticatedFetch('https://api.example.com/a'),
      authenticatedFetch('https://api.example.com/b'),
    ]);

    expect(responseA.status).toBe(401);
    expect(responseB.status).toBe(401);
    // One refresh fetch (deduped), one revoke, one cleanup callback.
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(onForcedSignOut).toHaveBeenCalledTimes(1);
  });

  it('still runs the captured cleanup when the hook is cleared mid sign-out (provider unmount race)', async () => {
    // signOut() awaits a network revoke. If AuthProvider unmounts during that
    // window it nulls the hook — but the cleanup it registered must still fire,
    // or the forced sign-out silently drops in exactly the case this guards.
    mockIsTokenExpiringSoon.mockResolvedValue(false);
    mockGetAuthToken.mockResolvedValue('old-jwt');
    const onForcedSignOut = vi.fn();
    setOnForcedSignOut(onForcedSignOut);

    // Hold signOut open so we can clear the hook (simulating unmount) before it
    // resolves and the callback is invoked.
    let releaseSignOut!: () => void;
    mockSignOut.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        releaseSignOut = resolve;
      }),
    );

    mockFetch
      .mockResolvedValueOnce({ status: 401, ok: false }) // initial 401
      .mockResolvedValueOnce({ ok: false, status: 403 }); // refresh fails

    const fetchPromise = authenticatedFetch('https://api.example.com/data');
    await vi.waitFor(() => expect(mockSignOut).toHaveBeenCalledTimes(1));

    // Provider unmounts mid sign-out, then the revoke resolves.
    setOnForcedSignOut(null);
    releaseSignOut();
    await fetchPromise;

    expect(onForcedSignOut).toHaveBeenCalledTimes(1);
  });

  it('handles a failed-refresh 401 without throwing when no forced-sign-out hook is registered', async () => {
    // The interceptor can fire before the provider mounts (or after it unmounts),
    // leaving onForcedSignOut null. The optional-chain call must be a no-op.
    mockIsTokenExpiringSoon.mockResolvedValue(false);
    mockGetAuthToken.mockResolvedValue('old-jwt');
    setOnForcedSignOut(null);

    mockFetch.mockResolvedValueOnce({ status: 401, ok: false }); // initial 401
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403 }); // refresh fails

    const response = await authenticatedFetch('https://api.example.com/data');

    expect(response.status).toBe(401);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it('does not fire the forced-sign-out hook when the 401 retry succeeds', async () => {
    mockIsTokenExpiringSoon.mockResolvedValue(false);
    mockGetAuthToken
      .mockResolvedValueOnce('old-jwt') // initial request
      .mockResolvedValueOnce('new-jwt') // retry after refresh
      .mockResolvedValue('new-jwt');
    const onForcedSignOut = vi.fn();
    setOnForcedSignOut(onForcedSignOut);

    mockFetch.mockResolvedValueOnce({ status: 401, ok: false }); // initial 401
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ jwt: 'new-jwt', refreshToken: 'new-refresh', expiresAt: '2099-01-01T00:00:00Z' }),
    });
    mockFetch.mockResolvedValueOnce({ status: 200, ok: true }); // retry succeeds

    const response = await authenticatedFetch('https://api.example.com/data');

    expect(response.status).toBe(200);
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(onForcedSignOut).not.toHaveBeenCalled();
  });

  it('attaches Authorization header from stored token', async () => {
    mockIsTokenExpiringSoon.mockResolvedValue(false);
    mockGetAuthToken.mockResolvedValue('my-jwt-token');
    mockFetch.mockResolvedValueOnce({ status: 200, ok: true });

    await authenticatedFetch('https://api.example.com/data', {
      headers: { 'X-Custom': 'value' },
    });

    const fetchCall = mockFetch.mock.calls[0];
    const headers = fetchCall[1].headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer my-jwt-token');
    expect(headers.get('X-Custom')).toBe('value');
  });

  it('makes request without Authorization header when no token exists', async () => {
    mockIsTokenExpiringSoon.mockResolvedValue(false);
    mockGetAuthToken.mockResolvedValue(null);
    mockFetch.mockResolvedValueOnce({ status: 200, ok: true });

    await authenticatedFetch('https://api.example.com/data');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const fetchCallHeaders = mockFetch.mock.calls[0][1].headers as Headers;
    expect(fetchCallHeaders.has('Authorization')).toBe(false);
  });

  it('returns 401 directly without refresh attempt when no token exists', async () => {
    mockIsTokenExpiringSoon.mockResolvedValue(false);
    mockGetAuthToken.mockResolvedValue(null);
    const onForcedSignOut = vi.fn();
    setOnForcedSignOut(onForcedSignOut);
    mockFetch.mockResolvedValueOnce({ status: 401, ok: false });

    const response = await authenticatedFetch('https://api.example.com/data');

    expect(response.status).toBe(401);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(onForcedSignOut).not.toHaveBeenCalled();
  });
});

// ── isTokenExpiringSoon (boundary conditions) ────────────────────────────
// The auth-store module is mocked for the interceptor tests above.
// For boundary tests we need the real implementation, so we use
// vi.importActual to bypass the mock and drive it through the
// SecureStore mock layer.

describe('isTokenExpiringSoon boundary conditions', () => {
  it('returns false when token expires in 25 hours', async () => {
    const realAuthStore = await vi.importActual<typeof import('../auth-store')>('../auth-store');
    const SecureStore = await import('expo-secure-store');
    const futureDate = new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString();
    (SecureStore.getItemAsync as Mock).mockResolvedValueOnce(futureDate);

    const result = await realAuthStore.isTokenExpiringSoon();

    expect(result).toBe(false);
  });

  it('returns true when token expires in 23 hours', async () => {
    const realAuthStore = await vi.importActual<typeof import('../auth-store')>('../auth-store');
    const SecureStore = await import('expo-secure-store');
    const futureDate = new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString();
    (SecureStore.getItemAsync as Mock).mockResolvedValueOnce(futureDate);

    const result = await realAuthStore.isTokenExpiringSoon();

    expect(result).toBe(true);
  });

  it('returns true when no expiry is stored', async () => {
    const realAuthStore = await vi.importActual<typeof import('../auth-store')>('../auth-store');
    const SecureStore = await import('expo-secure-store');
    (SecureStore.getItemAsync as Mock).mockResolvedValueOnce(null);

    const result = await realAuthStore.isTokenExpiringSoon();

    expect(result).toBe(true);
  });
});
