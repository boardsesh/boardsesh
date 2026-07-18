// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureAuthCredentialGeneration,
  clearTokens,
  getAuthToken,
  subscribeAuthTokenChanges,
  synchronizeWebSession,
} from '../auth-store.web';

// app.boardsesh.com calls www's auth/ws-auth endpoints cross-origin, so
// `webApiUrl` targets the absolute web origin (WEB_BASE_URL default) with
// credentials: 'include'. The jsdom window origin here isn't www, so the
// resolved URL is always the absolute form.
const WEB = 'https://www.boardsesh.com';

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

beforeEach(async () => {
  fetchMock.mockReset();
  await clearTokens();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('synchronizeWebSession', () => {
  it('validates the HttpOnly session before caching the backend token in memory', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('backend-jwe'));

    await expect(synchronizeWebSession()).resolves.toEqual({
      status: 'authenticated',
      token: 'backend-jwe',
      userId: 'user-1',
      authSessionId: 'login-1',
    });
    await expect(getAuthToken()).resolves.toBe('backend-jwe');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${WEB}/api/auth/session`,
      `${WEB}/api/internal/ws-auth`,
    ]);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ credentials: 'include', cache: 'no-store' }),
    );
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ credentials: 'include', cache: 'no-store' }),
    );
  });

  it('clears the memory token only after a confirmed anonymous session', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('backend-jwe'))
      .mockResolvedValueOnce(jsonResponse({}));

    await synchronizeWebSession();
    await expect(synchronizeWebSession()).resolves.toEqual({ status: 'anonymous' });
    await expect(getAuthToken()).resolves.toBeNull();
  });

  it('treats an anonymous token bridge snapshot as authoritative after an authenticated session read', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-a' }, authSessionId: 'login-a' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('user-a-jwe', 'user-a', 'login-a'));
    await synchronizeWebSession();
    const generationBeforeBridgeLogout = captureAuthCredentialGeneration();
    const listener = vi.fn();
    const unsubscribe = subscribeAuthTokenChanges(listener);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-a' }, authSessionId: 'login-a' }))
      .mockResolvedValueOnce(jsonResponse({ authenticated: false, token: null }));

    await expect(synchronizeWebSession()).resolves.toEqual({ status: 'anonymous' });

    await expect(getAuthToken()).resolves.toBeNull();
    expect(captureAuthCredentialGeneration()).toBe(generationBeforeBridgeLogout + 1);
    expect(listener).toHaveBeenCalledWith(null, 'session');
    unsubscribe();
  });

  it('preserves the memory token when session revalidation is unavailable', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('backend-jwe'))
      .mockRejectedValueOnce(new Error('offline'));

    await synchronizeWebSession();
    const result = await synchronizeWebSession();

    expect(result.status).toBe('unavailable');
    await expect(getAuthToken()).resolves.toBe('backend-jwe');
  });

  it('deduplicates concurrent session synchronizations', async () => {
    let resolveSession!: (response: Response) => void;
    fetchMock
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveSession = resolve;
        }),
      )
      .mockResolvedValueOnce(authenticatedBridgeResponse('backend-jwe'));

    const first = synchronizeWebSession();
    const second = synchronizeWebSession();
    resolveSession(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }));

    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: 'authenticated', token: 'backend-jwe', userId: 'user-1', authSessionId: 'login-1' },
      { status: 'authenticated', token: 'backend-jwe', userId: 'user-1', authSessionId: 'login-1' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never adopts a bridge token whose login changed after the session read', async () => {
    let resolveCurrentSession!: (response: Response) => void;
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-a' }, authSessionId: 'login-a' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('unpaired-user-b-jwe', 'user-b', 'login-b'))
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveCurrentSession = resolve;
        }),
      )
      .mockResolvedValueOnce(authenticatedBridgeResponse('paired-user-b-jwe', 'user-b', 'login-b'));

    const synchronization = synchronizeWebSession();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await expect(getAuthToken()).resolves.toBeNull();

    resolveCurrentSession(jsonResponse({ user: { id: 'user-b' }, authSessionId: 'login-b' }));

    await expect(synchronization).resolves.toEqual({
      status: 'authenticated',
      token: 'paired-user-b-jwe',
      userId: 'user-b',
      authSessionId: 'login-b',
    });
    await expect(getAuthToken()).resolves.toBe('paired-user-b-jwe');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${WEB}/api/auth/session`,
      `${WEB}/api/internal/ws-auth`,
      `${WEB}/api/auth/session`,
      `${WEB}/api/internal/ws-auth`,
    ]);
  });

  it('bounds repeated login changes without adopting any unpaired token', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-a' }, authSessionId: 'login-a' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('unpaired-b-jwe', 'user-b', 'login-b'))
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-b' }, authSessionId: 'login-b' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('unpaired-c-jwe', 'user-c', 'login-c'))
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-c' }, authSessionId: 'login-c' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('unpaired-a-jwe', 'user-a', 'login-a'));

    await expect(synchronizeWebSession()).resolves.toEqual({
      status: 'unavailable',
      error: expect.objectContaining({ message: 'Authentication identity kept changing during synchronization' }),
      confirmedIdentity: { userId: 'user-a', authSessionId: 'login-a' },
      identityInvalidated: true,
    });
    await expect(getAuthToken()).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('cannot restore a token from a synchronization cleared during the token bridge request', async () => {
    let resolveTokenBridge!: (response: Response) => void;
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      // Deliberately ignore the AbortSignal: the generation guard must still
      // reject the stale result even when the transport cannot be cancelled.
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveTokenBridge = resolve;
        }),
      );

    const synchronization = synchronizeWebSession();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await clearTokens();
    resolveTokenBridge(authenticatedBridgeResponse('stale-jwe'));

    await expect(synchronization).resolves.toEqual({ status: 'superseded' });
    await expect(getAuthToken()).resolves.toBeNull();
  });

  it('bounds concurrent hung synchronizations at 15 seconds and allows a later retry', async () => {
    vi.useFakeTimers();
    fetchMock.mockReturnValueOnce(new Promise<Response>(() => {}));

    const first = synchronizeWebSession();
    const second = synchronizeWebSession();
    await vi.advanceTimersByTimeAsync(15_000);

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.status).toBe('unavailable');
    expect(secondResult.status).toBe('unavailable');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('recovered-jwe'));
    await expect(synchronizeWebSession()).resolves.toEqual({
      status: 'authenticated',
      token: 'recovered-jwe',
      userId: 'user-1',
      authSessionId: 'login-1',
    });
  });

  it('also bounds a response body that never finishes parsing', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => new Promise<unknown>(() => {}),
    } as Response);

    const synchronization = synchronizeWebSession();
    await vi.advanceTimersByTimeAsync(15_000);

    const result = await synchronization;
    expect(result.status).toBe('unavailable');
    await expect(getAuthToken()).resolves.toBeNull();
  });

  it('treats only valid NextAuth storage events as remote invalidation hints', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('backend-jwe'));
    await synchronizeWebSession();
    const listener = vi.fn();
    const unsubscribe = subscribeAuthTokenChanges(listener);

    window.dispatchEvent(new StorageEvent('storage', { key: 'nextauth.message', newValue: '{bad json' }));
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'nextauth.message',
        newValue: JSON.stringify({ event: 'other', data: { trigger: 'signout' } }),
      }),
    );
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'other-key',
        newValue: JSON.stringify({ event: 'session', data: { trigger: 'signout' } }),
      }),
    );
    expect(listener).not.toHaveBeenCalled();
    await expect(getAuthToken()).resolves.toBe('backend-jwe');

    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'nextauth.message',
        newValue: JSON.stringify({ event: 'session', data: { trigger: 'getSession', userId: 'attacker' } }),
      }),
    );
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith('backend-jwe', 'hint');
    await expect(getAuthToken()).resolves.toBe('backend-jwe');

    listener.mockReset();
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'nextauth.message',
        newValue: JSON.stringify({ event: 'session', data: { trigger: 'signout', userId: 'attacker' } }),
      }),
    );
    expect(listener).toHaveBeenCalledWith('backend-jwe', 'hint');
    await expect(getAuthToken()).resolves.toBe('backend-jwe');
    unsubscribe();
  });

  it('invalidates A immediately when B is confirmed but the token bridge is unavailable', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-a' }, authSessionId: 'login-a' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('user-a-jwe', 'user-a', 'login-a'));
    await synchronizeWebSession();
    const listener = vi.fn();
    const unsubscribe = subscribeAuthTokenChanges(listener);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-b' }, authSessionId: 'login-b' }))
      .mockResolvedValueOnce(jsonResponse({ error: 'unavailable' }, 503));

    await expect(synchronizeWebSession()).resolves.toEqual({
      status: 'unavailable',
      error: expect.objectContaining({ message: 'WebSocket auth endpoint failed: HTTP 503' }),
      confirmedIdentity: { userId: 'user-b', authSessionId: 'login-b' },
      identityInvalidated: true,
    });
    expect(listener).toHaveBeenCalledWith(null, 'session');
    await expect(getAuthToken()).resolves.toBeNull();
    unsubscribe();
  });
});
