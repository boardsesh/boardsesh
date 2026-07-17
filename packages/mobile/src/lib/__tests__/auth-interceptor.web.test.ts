import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticatedFetch, recoverAuthRejection, setOnForcedSignOut } from '../auth-interceptor.web';
import { clearTokens, getAuthToken, synchronizeWebSession } from '../auth-store.web';

const reportHandledErrorMock = vi.fn();
vi.mock('../error-reporting', () => ({
  reportHandledError: (...args: unknown[]) => reportHandledErrorMock(...args),
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function authenticatedBridgeResponse(token: string, userId = 'user-1', authSessionId = 'login-1'): Response {
  return jsonResponse({ authenticated: true, token, userId, authSessionId });
}

async function primeToken(): Promise<void> {
  fetchMock
    .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
    .mockResolvedValueOnce(authenticatedBridgeResponse('old-jwe'));
  await synchronizeWebSession();
  fetchMock.mockReset();
}

beforeEach(async () => {
  fetchMock.mockReset();
  setOnForcedSignOut(null);
  reportHandledErrorMock.mockReset();
  await clearTokens();
});

describe('authenticatedFetch on web', () => {
  it('revalidates one 401 and retries with the refreshed memory token', async () => {
    await primeToken();
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('new-jwe'))
      .mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));

    const response = await authenticatedFetch('/graphql', { method: 'POST' });

    expect(response.status).toBe(200);
    const firstHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    const retryHeaders = fetchMock.mock.calls[3]?.[1]?.headers as Headers;
    expect(firstHeaders.get('Authorization')).toBe('Bearer old-jwe');
    expect(retryHeaders.get('Authorization')).toBe('Bearer new-jwe');
  });

  it('forces provider cleanup once when concurrent 401s confirm an anonymous cookie', async () => {
    await primeToken();
    const forcedSignOut = vi.fn();
    setOnForcedSignOut(forcedSignOut);
    fetchMock.mockImplementation((url: string | URL | Request) => {
      if (url === '/api/auth/session') return Promise.resolve(jsonResponse({}));
      if (url === '/api/auth/csrf') return Promise.resolve(jsonResponse({ csrfToken: 'csrf-token' }));
      if (url === '/api/auth/signout') return Promise.resolve(jsonResponse({ url: '/app' }));
      return Promise.resolve(new Response(null, { status: 401 }));
    });

    const [first, second] = await Promise.all([authenticatedFetch('/graphql/a'), authenticatedFetch('/graphql/b')]);

    expect(first.status).toBe(401);
    expect(second.status).toBe(401);
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/auth/session')).toHaveLength(2);
    expect(forcedSignOut).toHaveBeenCalledTimes(1);
    await expect(getAuthToken()).resolves.toBeNull();
  });

  it('preserves the current session when 401 revalidation is unavailable', async () => {
    await primeToken();
    const forcedSignOut = vi.fn();
    setOnForcedSignOut(forcedSignOut);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 })).mockRejectedValueOnce(new Error('offline'));

    const response = await authenticatedFetch('/graphql');

    expect(response.status).toBe(401);
    expect(forcedSignOut).not.toHaveBeenCalled();
    await expect(getAuthToken()).resolves.toBe('old-jwe');
  });

  it('stops after a second 401 and invalidates the confirmed bad browser session', async () => {
    await primeToken();
    const forcedSignOut = vi.fn();
    setOnForcedSignOut(forcedSignOut);
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('new-jwe'))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'csrf-token' }))
      .mockResolvedValueOnce(jsonResponse({ url: '/app' }));

    const response = await authenticatedFetch('/graphql');

    expect(response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(forcedSignOut).toHaveBeenCalledTimes(1);
    await expect(getAuthToken()).resolves.toBeNull();
  });

  it('still runs provider cleanup when durable forced sign-out cannot reach the CSRF endpoint', async () => {
    await primeToken();
    const forcedSignOut = vi.fn();
    setOnForcedSignOut(forcedSignOut);
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('new-jwe'))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      .mockRejectedValueOnce(new Error('offline'));

    const response = await authenticatedFetch('/graphql');

    expect(response.status).toBe(401);
    expect(forcedSignOut).toHaveBeenCalledTimes(1);
    expect(reportHandledErrorMock).toHaveBeenCalledTimes(1);
    await expect(getAuthToken()).resolves.toBeNull();
  });

  it('returns an old-account response that was already sent before a browser account switch', async () => {
    await primeToken();
    let resolveOldRequest!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveOldRequest = resolve;
      }),
    );

    const oldRequest = authenticatedFetch('/graphql');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await clearTokens();

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-2' }, authSessionId: 'login-2' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('new-user-jwe', 'user-2', 'login-2'));
    await synchronizeWebSession();
    resolveOldRequest(jsonResponse({ data: { privateForUserOne: true } }));

    await expect(oldRequest).resolves.toEqual(expect.objectContaining({ status: 200 }));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await expect(getAuthToken()).resolves.toBe('new-user-jwe');
  });

  it('does not let a superseded 401 revalidation sign out a newer login', async () => {
    await primeToken();
    const forcedSignOut = vi.fn();
    setOnForcedSignOut(forcedSignOut);
    let resolveOldSession!: (response: Response) => void;
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      // Ignore AbortSignal deliberately: generation, not transport cooperation,
      // must keep this old request from owning the newer session.
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveOldSession = resolve;
        }),
      );

    const oldRequest = authenticatedFetch('/graphql');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await clearTokens();

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-2' }, authSessionId: 'login-2' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('new-user-jwe', 'user-2', 'login-2'));
    await expect(synchronizeWebSession()).resolves.toEqual({
      status: 'authenticated',
      token: 'new-user-jwe',
      userId: 'user-2',
      authSessionId: 'login-2',
    });
    resolveOldSession(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }));

    await expect(oldRequest).resolves.toEqual(expect.objectContaining({ status: 401 }));
    expect(forcedSignOut).not.toHaveBeenCalled();
    await expect(getAuthToken()).resolves.toBe('new-user-jwe');
  });

  it('returns an in-flight A response when cookie revalidation discovers B without a broadcast', async () => {
    await primeToken();
    let resolveOldRequest!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveOldRequest = resolve;
      }),
    );

    const oldRequest = authenticatedFetch('/graphql');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-2' }, authSessionId: 'login-2' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('new-user-jwe', 'user-2', 'login-2'));

    await expect(synchronizeWebSession()).resolves.toEqual({
      status: 'authenticated',
      token: 'new-user-jwe',
      userId: 'user-2',
      authSessionId: 'login-2',
    });
    resolveOldRequest(jsonResponse({ data: { privateForUserOne: true } }));

    await expect(oldRequest).resolves.toEqual(expect.objectContaining({ status: 200 }));
    await expect(getAuthToken()).resolves.toBe('new-user-jwe');
  });
});

describe('recoverAuthRejection on web', () => {
  it('distinguishes an unavailable session bridge from a confirmed logout', async () => {
    await primeToken();
    const forcedSignOut = vi.fn();
    setOnForcedSignOut(forcedSignOut);
    fetchMock.mockRejectedValueOnce(new Error('offline'));

    await expect(recoverAuthRejection()).resolves.toBe('unavailable');

    expect(forcedSignOut).not.toHaveBeenCalled();
    await expect(getAuthToken()).resolves.toBe('old-jwe');
  });
});
