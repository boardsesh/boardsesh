import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createQueryWrapper } from '@/app/test-utils/test-providers';
import { useWsAuthToken } from '../use-ws-auth-token';

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

  it('clears a failed token request after an explicit successful retry', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    const { result } = renderHook(() => useWsAuthToken(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.error).toBe('Failed to fetch auth token: 500'));
    expect(result.current.token).toBeNull();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        token: 'recovered-token',
        authenticated: true,
        userId: 'user-1',
        authSessionId: 'session-1',
      }),
    });
    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(result.current.token).toBe('recovered-token'));
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
