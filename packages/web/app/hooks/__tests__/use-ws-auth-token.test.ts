import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createQueryWrapper } from '@/app/test-utils/test-providers';
import { useWsAuthToken } from '../use-ws-auth-token';
import {
  accessTokenRefreshFailures,
  isBrowserAccessToken,
  noteSocketClosed,
  refreshAccessTokenAfterCredentialChange,
  resetBrowserAccessTokensForTests,
  socketConnectToken,
  socketCredentialHandle,
} from '@/app/lib/auth/browser-access-token';
import { focusManager } from '@tanstack/react-query';
import { browserSessionGuard } from '@/app/lib/auth/session-guard';
import { WEB_SESSION_REFRESH_EVENT } from '@/app/lib/auth/web-session-events';

const mockUseSession = vi.fn();
vi.mock('next-auth/react', () => ({
  useSession: () => mockUseSession(),
}));

const mockFetch = vi.fn();

describe('useWsAuthToken', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    mockUseSession.mockReturnValue({
      status: 'authenticated',
      data: { user: { id: 'user-1' }, authSessionId: 'session-1' },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns loading initially', () => {
    mockFetch.mockReturnValue(new Promise(() => {})); // never resolves

    const { result } = renderHook(() => useWsAuthToken(), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current.isLoading).toBe(true);
    expect(result.current.token).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);
  });

  it('returns token and isAuthenticated when fetch succeeds', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ token: 'test-token-123', authenticated: true, userId: 'user-1', authSessionId: 'session-1' }),
    });

    const { result } = renderHook(() => useWsAuthToken(), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.token).toBe('test-token-123');
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('never reuses account A’s fresh token after sign-out and account B sign-in', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ token: 'token-A', authenticated: true, userId: 'user-1', authSessionId: 'session-1' }),
    });
    const { result, rerender } = renderHook(() => useWsAuthToken(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.token).toBe('token-A'));
    mockUseSession.mockReturnValue({ status: 'unauthenticated', data: null });
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ token: null, authenticated: false }) });
    rerender();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.token).toBeNull();
    let finishB: ((response: unknown) => void) | undefined;
    mockFetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishB = resolve;
        }),
    );
    mockUseSession.mockReturnValue({
      status: 'authenticated',
      data: { user: { id: 'user-B' }, authSessionId: 'session-B' },
    });
    rerender();
    expect(result.current.token).toBeNull();
    expect(result.current.isLoading).toBe(true);
    const checkoutRequest = vi.fn();
    if (result.current.token) checkoutRequest(result.current.token);
    expect(checkoutRequest).not.toHaveBeenCalled();
    await act(async () => {
      finishB?.({
        ok: true,
        json: async () => ({ token: 'token-B', authenticated: true, userId: 'user-B', authSessionId: 'session-B' }),
      });
    });
    await waitFor(() => expect(result.current.token).toBe('token-B'));
    checkoutRequest(result.current.token);
    expect(checkoutRequest).toHaveBeenCalledExactlyOnceWith('token-B');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    { userId: 'other-user', authSessionId: 'session-1' },
    { userId: 'user-1', authSessionId: 'other-login' },
    { userId: 'user-1' },
  ])('rejects authenticated responses from a different principal: %j', async (principal) => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ token: 'wrong-token', authenticated: true, ...principal }),
    });
    const { result } = renderHook(() => useWsAuthToken(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.error).toBe('ws-auth returned a token for a different session identity'));
    expect(result.current.token).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);
  });

  it('returns a settled null token for an anonymous (unauthenticated) session', async () => {
    // A logged-out user legitimately has no WS token — that's the settled
    // result, not a failure to retry.
    mockUseSession.mockReturnValue({ status: 'unauthenticated' });
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ token: null, authenticated: false }),
    });

    const { result } = renderHook(() => useWsAuthToken(), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.token).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('surfaces an error instead of caching a null token for a logged-in session', async () => {
    // Regression guard: a logged-in user must never silently settle on a null
    // token, or the session WebSocket connects anonymously and inflates the
    // crew/peer count. The null is treated as a transient failure (retried,
    // then surfaced) rather than an "anonymous" result.
    mockUseSession.mockReturnValue({
      status: 'authenticated',
      data: { user: { id: 'user-1' }, authSessionId: 'session-1' },
    });
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ token: null, authenticated: false }),
    });

    const { result } = renderHook(() => useWsAuthToken(), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });

    expect(result.current.token).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);
  });

  it('returns error message when fetch fails', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
    });

    const { result } = renderHook(() => useWsAuthToken(), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBe('Failed to fetch auth token: 500');
    expect(result.current.token).toBeNull();
  });

  it('returns API error from response data', async () => {
    // An unauthenticated session surfaces the endpoint's own error field
    // verbatim (no throw/retry — anonymous null tokens are legitimate).
    mockUseSession.mockReturnValue({ status: 'unauthenticated' });
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          token: null,
          authenticated: false,
          error: 'Session expired',
        }),
    });

    const { result } = renderHook(() => useWsAuthToken(), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBe('Session expired');
  });

  it('isAuthenticated defaults to false before data loads', () => {
    mockFetch.mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useWsAuthToken(), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current.isAuthenticated).toBe(false);
  });

  it('token defaults to null before data loads', () => {
    mockFetch.mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useWsAuthToken(), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current.token).toBeNull();
  });

  it('returns loading when session status is loading', () => {
    mockUseSession.mockReturnValue({ status: 'loading' });
    mockFetch.mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useWsAuthToken(), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current.isLoading).toBe(true);
  });

  it('does not fetch when session status is loading', () => {
    mockUseSession.mockReturnValue({ status: 'loading' });

    renderHook(() => useWsAuthToken(), {
      wrapper: createQueryWrapper(),
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns idle unauthenticated state and does not fetch when disabled', () => {
    const { result } = renderHook(() => useWsAuthToken(false), {
      wrapper: createQueryWrapper(),
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.token).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.error).toBeNull();
  });
});

describe('useWsAuthToken with a 15-minute browser token (#7596 B3b)', () => {
  const MINUTE_MS = 60_000;
  let issued = 0;
  const browserToken = () => {
    issued += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        token: `browser-token-${issued}`,
        authenticated: true,
        userId: 'user-1',
        authSessionId: 'session-1',
        expiresAt: new Date(Date.now() + 15 * MINUTE_MS).toISOString(),
        expiresIn: 15 * 60,
      }),
    };
  };

  beforeEach(() => {
    issued = 0;
    delete (globalThis as typeof globalThis & { [key: symbol]: unknown })[Symbol.for('boardsesh.web-session-guard.v1')];
    resetBrowserAccessTokensForTests();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    mockUseSession.mockReturnValue({
      status: 'authenticated',
      data: { user: { id: 'user-1' }, authSessionId: 'session-1' },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([200, 401])('discards an earlier login’s held %i reply without disrupting the new socket', async (status) => {
    const guard = browserSessionGuard();
    guard.accept({ userId: 'user-1', authSessionId: 'session-1' });
    let releasePrevious!: (response: Response) => void;
    mockFetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        releasePrevious = resolve;
      }),
    );
    const { result, rerender } = renderHook(() => useWsAuthToken(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    guard.accept({ userId: 'user-1', authSessionId: 'session-2' });
    mockUseSession.mockReturnValue({
      status: 'authenticated',
      data: { user: { id: 'user-1' }, authSessionId: 'session-2' },
    });
    let nextToken = 0;
    mockFetch.mockImplementation(async () =>
      Response.json({
        authenticated: true,
        userId: 'user-1',
        authSessionId: 'session-2',
        token: `current-${++nextToken}`,
        expiresIn: 900,
      }),
    );
    rerender();
    await waitFor(() => expect(result.current.token).toBe('current-1'));
    const handle = 'current-1';
    await expect(socketConnectToken(handle)).resolves.toBe(handle);
    const refreshRequest = vi.fn();
    window.addEventListener(WEB_SESSION_REFRESH_EVENT, refreshRequest);
    try {
      await act(async () => {
        releasePrevious(
          Response.json(
            {
              authenticated: true,
              userId: 'user-1',
              authSessionId: 'session-1',
              token: 'previous-login',
              expiresIn: 900,
            },
            { status },
          ),
        );
      });
      expect(isBrowserAccessToken('previous-login')).toBe(false);
      expect(accessTokenRefreshFailures()).toBe(0);
      expect(refreshRequest).not.toHaveBeenCalled();
      noteSocketClosed(handle, 4401);
      await act(async () => {
        await expect(socketConnectToken(handle)).resolves.toBe('current-2');
      });
      expect(socketCredentialHandle('current-2')).toBe(handle);
    } finally {
      window.removeEventListener(WEB_SESSION_REFRESH_EVENT, refreshRequest);
    }
  });

  it('refreshes about three minutes before the end, one fetch shared by every caller', async () => {
    mockFetch.mockImplementation(async () => browserToken());
    const wrapper = createQueryWrapper();
    const first = renderHook(() => useWsAuthToken(), { wrapper });
    const second = renderHook(() => useWsAuthToken(), { wrapper });
    await waitFor(() => expect(first.result.current.token).toBe('browser-token-1'));
    expect(second.result.current.token).toBe('browser-token-1');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11 * MINUTE_MS);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MINUTE_MS + 1000);
    });
    await waitFor(() => expect(first.result.current.token).toBe('browser-token-2'));
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // The socket keeps its handle across the refresh.
    expect(socketCredentialHandle(first.result.current.token)).toBe('browser-token-1');
  });

  it('keeps the token through a 503 and backs off instead of signing out', async () => {
    mockFetch.mockImplementationOnce(async () => browserToken());
    const { result } = renderHook(() => useWsAuthToken(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.token).toBe('browser-token-1'));
    mockFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12 * MINUTE_MS + 10_000);
    });
    expect(result.current.token).toBe('browser-token-1');
    expect(result.current.isAuthenticated).toBe(true);
  });

  it('on a 401 asks the session read once and does not retry', async () => {
    const refreshRequests = vi.fn();
    window.addEventListener(WEB_SESSION_REFRESH_EVENT, refreshRequests);
    mockFetch.mockResolvedValue({ ok: false, status: 401, json: async () => ({ token: null, authenticated: false }) });
    const { result } = renderHook(() => useWsAuthToken(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.error).toBe('Failed to fetch auth token: 401'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(refreshRequests).toHaveBeenCalledTimes(1);
    window.removeEventListener(WEB_SESSION_REFRESH_EVENT, refreshRequests);
  });

  it('on focus refetches only inside the last three minutes, counted from receipt (focus at minute 8 does not)', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    mockFetch.mockImplementation(async () => browserToken());
    const { result } = renderHook(() => useWsAuthToken(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.token).toBe('browser-token-1'));
    const refocus = () =>
      act(async () => {
        focusManager.setFocused(false);
        focusManager.setFocused(true);
        await vi.advanceTimersByTimeAsync(10);
      });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8 * MINUTE_MS);
    });
    await refocus();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * MINUTE_MS + 1000);
    });
    await waitFor(() => expect(result.current.token).toBe('browser-token-2'));
    vi.mocked(Math.random).mockRestore();
    focusManager.setFocused(undefined);
  });

  it('keeps refreshing after the hook that registered last unmounts', async () => {
    mockFetch.mockImplementation(async () => browserToken());
    const wrapper = createQueryWrapper();
    const kept = renderHook(() => useWsAuthToken(), { wrapper });
    const dialog = renderHook(() => useWsAuthToken(), { wrapper });
    await waitFor(() => expect(kept.result.current.token).toBe('browser-token-1'));
    dialog.unmount();
    await act(async () => {
      await refreshAccessTokenAfterCredentialChange();
    });
    await waitFor(() => expect(kept.result.current.token).toBe('browser-token-2'));
  });

  it('backs off 30 s, then 60 s, per failed refresh, with no quick retries in between', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    mockFetch.mockImplementationOnce(async () => browserToken());
    const { result } = renderHook(() => useWsAuthToken(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.token).toBe('browser-token-1'));
    mockFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12 * MINUTE_MS + 1000);
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(28_000);
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(mockFetch).toHaveBeenCalledTimes(3);
    // The failure at 12:30 waits 60 s: nothing until 13:30.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(55_000);
    });
    expect(mockFetch).toHaveBeenCalledTimes(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(result.current.token).toBe('browser-token-1');
    vi.mocked(Math.random).mockRestore();
  });

  it('asks the session read once when 401s repeat while the session keeps the login, then only backs off', async () => {
    const refreshRequests = vi.fn();
    window.addEventListener(WEB_SESSION_REFRESH_EVENT, refreshRequests);
    mockFetch.mockImplementationOnce(async () => browserToken());
    const { result } = renderHook(() => useWsAuthToken(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.token).toBe('browser-token-1'));
    mockFetch.mockResolvedValue({ ok: false, status: 401, json: async () => ({ token: null, authenticated: false }) });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15 * MINUTE_MS);
    });
    // 12 min, then 30 s, 60 s, 120 s: four 401s, one session read asked for.
    expect(mockFetch.mock.calls.length).toBeLessThanOrEqual(5);
    expect(refreshRequests).toHaveBeenCalledTimes(1);
    window.removeEventListener(WEB_SESSION_REFRESH_EVENT, refreshRequests);
  });
});
