import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticatedFetch, recoverAuthRejection, setOnForcedSignOut } from '../auth-interceptor.web';
import { clearTokens, getAuthToken, synchronizeWebSession } from '../auth-store.web';

// The revalidation/sign-out fetches triggered here hit www's auth endpoints
// cross-origin, so `webApiUrl` resolves them to the absolute web origin
// (WEB_BASE_URL default). Caller-supplied URLs like `/graphql` stay untouched.
const WEB = 'https://www.boardsesh.com';

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
      if (url === `${WEB}/api/auth/session`) return Promise.resolve(jsonResponse({}));
      if (url === `${WEB}/api/auth/csrf`) return Promise.resolve(jsonResponse({ csrfToken: 'csrf-token' }));
      if (url === `${WEB}/api/auth/signout`) return Promise.resolve(jsonResponse({ url: '/app' }));
      return Promise.resolve(new Response(null, { status: 401 }));
    });

    const [first, second] = await Promise.all([authenticatedFetch('/graphql/a'), authenticatedFetch('/graphql/b')]);

    expect(first.status).toBe(401);
    expect(second.status).toBe(401);
    expect(fetchMock.mock.calls.filter(([url]) => url === `${WEB}/api/auth/session`)).toHaveLength(2);
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

  it('signs out after a second 401 once the session is confirmed dead', async () => {
    await primeToken();
    const forcedSignOut = vi.fn();
    setOnForcedSignOut(forcedSignOut);
    let sessionCalls = 0;
    fetchMock.mockImplementation((url: string | URL | Request) => {
      if (url === '/graphql') return Promise.resolve(new Response(null, { status: 401 }));
      if (url === `${WEB}/api/auth/session`) {
        sessionCalls += 1;
        // The first refresh confirms authenticated (driving the retry); every
        // read after the retry-401 sees an anonymous cookie.
        return Promise.resolve(
          sessionCalls === 1 ? jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }) : jsonResponse({}),
        );
      }
      if (url === `${WEB}/api/internal/ws-auth`) return Promise.resolve(authenticatedBridgeResponse('new-jwe'));
      if (url === `${WEB}/api/auth/csrf`) return Promise.resolve(jsonResponse({ csrfToken: 'csrf-token' }));
      if (url === `${WEB}/api/auth/signout`) return Promise.resolve(jsonResponse({ url: '/app' }));
      return Promise.resolve(new Response(null, { status: 401 }));
    });

    const response = await authenticatedFetch('/graphql');

    expect(response.status).toBe(401);
    expect(forcedSignOut).toHaveBeenCalledTimes(1);
    await expect(getAuthToken()).resolves.toBeNull();
  });

  it('does not sign out on a second 401 that is a permission denial, not a dead session', async () => {
    await primeToken();
    const forcedSignOut = vi.fn();
    setOnForcedSignOut(forcedSignOut);
    fetchMock.mockImplementation((url: string | URL | Request) => {
      if (url === '/graphql') return Promise.resolve(new Response(null, { status: 401 }));
      if (url === `${WEB}/api/auth/session`)
        return Promise.resolve(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }));
      if (url === `${WEB}/api/internal/ws-auth`) return Promise.resolve(authenticatedBridgeResponse('new-jwe'));
      return Promise.resolve(new Response(null, { status: 401 }));
    });

    const response = await authenticatedFetch('/graphql');

    expect(response.status).toBe(401);
    // The cookie and bridge both still authenticate — a permission-401 must not
    // log the user out.
    expect(forcedSignOut).not.toHaveBeenCalled();
    await expect(getAuthToken()).resolves.toBe('new-jwe');
  });

  it('still runs provider cleanup when durable forced sign-out cannot verify the cookie', async () => {
    await primeToken();
    const forcedSignOut = vi.fn();
    setOnForcedSignOut(forcedSignOut);
    let sessionCalls = 0;
    fetchMock.mockImplementation((url: string | URL | Request) => {
      if (url === '/graphql') return Promise.resolve(new Response(null, { status: 401 }));
      if (url === `${WEB}/api/internal/ws-auth`) return Promise.resolve(authenticatedBridgeResponse('new-jwe'));
      if (url === `${WEB}/api/auth/session`) {
        sessionCalls += 1;
        // 1: refresh confirms authenticated; 2: post-retry confirmation is
        // anonymous; 3: the durable sign-out's cookie check goes offline.
        if (sessionCalls === 1) {
          return Promise.resolve(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }));
        }
        if (sessionCalls === 2) return Promise.resolve(jsonResponse({}));
        return Promise.reject(new Error('offline'));
      }
      return Promise.resolve(new Response(null, { status: 401 }));
    });

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
