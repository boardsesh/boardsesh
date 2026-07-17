import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getSessionMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(async () => null),
}));

vi.mock('next-auth/react', () => ({
  getSession: getSessionMock,
}));

import { guardedNextAuthSignOut, installNextAuthCookieFetchLock } from '../nextauth-cookie-fetch-lock';

const LOCK_INSTALLATION_KEY = Symbol.for('boardsesh.nextauth-cookie-fetch-lock.state-v1');
let originalFetchMock: ReturnType<typeof vi.fn>;

function clearLockInstallation(): void {
  delete (globalThis as typeof globalThis & { [key: symbol]: unknown })[LOCK_INSTALLATION_KEY];
}

beforeEach(() => {
  clearLockInstallation();
  getSessionMock.mockClear();
  originalFetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', originalFetchMock);
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('BroadcastChannel', undefined);
});

afterEach(() => {
  clearLockInstallation();
  vi.unstubAllGlobals();
});

describe('NextAuth cookie fetch lock', () => {
  it('installs idempotently across later fetch instrumentation and uses the shared Web Lock', async () => {
    const requestLock = vi.fn(
      async (
        _name: string,
        _options: LockOptions,
        operation: (lock: Lock | null) => PromiseLike<Response> | Response,
      ) => operation(null),
    );
    vi.stubGlobal('navigator', { locks: { request: requestLock } });

    installNextAuthCookieFetchLock();
    const installedFetch = globalThis.fetch;
    installNextAuthCookieFetchLock();
    expect(globalThis.fetch).toBe(installedFetch);

    const instrumentedFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => installedFetch(input, init));
    globalThis.fetch = instrumentedFetch;
    installNextAuthCookieFetchLock();
    expect(globalThis.fetch).toBe(instrumentedFetch);

    await globalThis.fetch('/api/auth/session');
    expect(requestLock).toHaveBeenCalledOnce();
    expect(requestLock).toHaveBeenCalledWith(
      'boardsesh-nextauth-cookie-v1',
      { mode: 'exclusive', signal: expect.anything() },
      expect.any(Function),
    );
    expect(originalFetchMock).toHaveBeenCalledOnce();
  });

  it('passes the effective init or Request abort signal to Web Lock acquisition', async () => {
    const requestLock = vi.fn(
      async (
        _name: string,
        _options: LockOptions,
        operation: (lock: Lock | null) => PromiseLike<Response> | Response,
      ) => operation(null),
    );
    vi.stubGlobal('navigator', { locks: { request: requestLock } });
    installNextAuthCookieFetchLock();
    const requestController = new AbortController();
    const initController = new AbortController();
    const sessionRequest = new Request(`${window.location.origin}/api/auth/session`, {
      signal: requestController.signal,
    });
    const requestAbort = new Error('request aborted');
    const initAbort = new Error('init aborted');
    requestController.abort(requestAbort);
    initController.abort(initAbort);

    await globalThis.fetch(sessionRequest);
    await globalThis.fetch(sessionRequest, { signal: undefined });
    await globalThis.fetch(sessionRequest, { signal: initController.signal });

    const acquiredSignals = requestLock.mock.calls.map((call) => call[1].signal);
    expect(acquiredSignals[0]).not.toBe(sessionRequest.signal);
    expect(acquiredSignals[0]).toMatchObject({ aborted: true, reason: requestAbort });
    expect(acquiredSignals[1]).toMatchObject({ aborted: true, reason: requestAbort });
    expect(acquiredSignals[2]).not.toBe(initController.signal);
    expect(acquiredSignals[2]).toMatchObject({ aborted: true, reason: initAbort });
  });

  it('serializes session reads and NextAuth mutations with the same-realm FIFO fallback', async () => {
    const executionOrder: string[] = [];
    let releaseSessionRead!: () => void;
    originalFetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const requestTarget = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      executionOrder.push(`${requestTarget}:start`);
      if (requestTarget === '/api/auth/session') {
        await new Promise<void>((resolve) => {
          releaseSessionRead = resolve;
        });
      }
      executionOrder.push(`${requestTarget}:end`);
      return new Response('{}', { status: 200 });
    });
    installNextAuthCookieFetchLock();

    const sessionRead = globalThis.fetch('/api/auth/session');
    const callbackMutation = globalThis.fetch('/api/auth/callback/credentials', { method: 'POST' });
    const signOutMutation = globalThis.fetch('/api/auth/signout', { method: 'post' });

    await vi.waitFor(() => expect(executionOrder).toEqual(['/api/auth/session:start']));
    releaseSessionRead();
    await Promise.all([sessionRead, callbackMutation, signOutMutation]);

    expect(executionOrder).toEqual([
      '/api/auth/session:start',
      '/api/auth/session:end',
      '/api/auth/callback/credentials:start',
      '/api/auth/callback/credentials:end',
      '/api/auth/signout:start',
      '/api/auth/signout:end',
    ]);
  });

  it('removes an aborted auth request from the fallback queue before it can fetch', async () => {
    let releaseSessionRead!: () => void;
    originalFetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          releaseSessionRead = () => resolve(new Response('{}', { status: 200 }));
        }),
    );
    installNextAuthCookieFetchLock();
    const sessionRead = globalThis.fetch('/api/auth/session');
    await vi.waitFor(() => expect(releaseSessionRead).toBeTypeOf('function'));
    const abortController = new AbortController();
    const callbackMutation = globalThis.fetch('/api/auth/callback/credentials', {
      method: 'POST',
      signal: abortController.signal,
    });

    abortController.abort(new Error('superseded auth request'));
    await expect(callbackMutation).rejects.toThrow('superseded auth request');
    releaseSessionRead();
    await sessionRead;
    await Promise.resolve();

    expect(originalFetchMock).toHaveBeenCalledOnce();
  });

  it('times out a stalled auth request and releases the fallback queue', async () => {
    vi.useFakeTimers();
    try {
      originalFetchMock
        .mockImplementationOnce(
          (_input: RequestInfo | URL, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              const signal = init?.signal;
              if (!signal) throw new Error('Expected a bounded auth signal');
              const rejectFromAbort = () => reject(signal.reason);
              if (signal.aborted) rejectFromAbort();
              else signal.addEventListener('abort', rejectFromAbort, { once: true });
            }),
        )
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));
      installNextAuthCookieFetchLock();

      const stalledRequest = globalThis.fetch('/api/auth/session');
      const stalledAssertion = expect(stalledRequest).rejects.toThrow('NextAuth cookie operation timed out');
      await vi.advanceTimersByTimeAsync(15_000);
      await stalledAssertion;

      await expect(globalThis.fetch('/api/auth/session')).resolves.toMatchObject({ status: 200 });
      expect(originalFetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('locks CSRF reads and provider sign-in mutations', async () => {
    const requestLock = vi.fn(
      async (
        _name: string,
        _options: LockOptions,
        operation: (lock: Lock | null) => PromiseLike<Response> | Response,
      ) => operation(null),
    );
    vi.stubGlobal('navigator', { locks: { request: requestLock } });
    installNextAuthCookieFetchLock();

    await globalThis.fetch('/api/auth/csrf');
    await globalThis.fetch('/api/auth/signin/google', { method: 'POST' });

    expect(requestLock).toHaveBeenCalledTimes(2);
    expect(requestLock.mock.calls.map(([name]) => name)).toEqual([
      'boardsesh-nextauth-cookie-v1',
      'boardsesh-nextauth-cookie-v1',
    ]);
  });

  it('holds one outer lock while signing out the identity shown by the initiating tab', async () => {
    const requestLock = vi.fn(
      async (
        _name: string,
        _options: LockOptions,
        operation: (lock: Lock | null) => PromiseLike<Response> | Response,
      ) => operation(null),
    );
    vi.stubGlobal('navigator', { locks: { request: requestLock } });
    originalFetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const requestTarget = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (requestTarget === '/api/auth/session') {
        return new Response(JSON.stringify({ user: { id: 'user-1' }, authSessionId: 'login-1' }), { status: 200 });
      }
      if (requestTarget === '/api/auth/csrf') {
        return new Response(JSON.stringify({ csrfToken: 'csrf-token' }), { status: 200 });
      }
      return new Response(JSON.stringify({ url: 'https://boardsesh.test/fallback' }), { status: 200 });
    });

    const result = await guardedNextAuthSignOut(
      { userId: 'user-1', authSessionId: 'login-1' },
      { callbackUrl: 'https://boardsesh.test/fallback', redirect: false },
    );

    expect(result).toEqual({ status: 'signed-out', url: 'https://boardsesh.test/fallback' });
    expect(requestLock).toHaveBeenCalledOnce();
    expect(originalFetchMock.mock.calls.map(([input]) => input)).toEqual([
      '/api/auth/session',
      '/api/auth/csrf',
      '/api/auth/signout',
    ]);
    const signOutBody = originalFetchMock.mock.calls[2]?.[1]?.body;
    expect(signOutBody).toBeInstanceOf(URLSearchParams);
    expect(Object.fromEntries((signOutBody as URLSearchParams).entries())).toEqual({
      csrfToken: 'csrf-token',
      callbackUrl: 'https://boardsesh.test/fallback',
      json: 'true',
      expectedUserId: 'user-1',
      expectedAuthSessionId: 'login-1',
    });
    expect(getSessionMock).toHaveBeenCalledOnce();
  });

  it('does not sign out when the shared cookie no longer matches the initiating tab', async () => {
    const requestLock = vi.fn(
      async (
        _name: string,
        _options: LockOptions,
        operation: (lock: Lock | null) => PromiseLike<Response> | Response,
      ) => operation(null),
    );
    vi.stubGlobal('navigator', { locks: { request: requestLock } });
    originalFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ user: { id: 'user-2' }, authSessionId: 'login-2' }), { status: 200 }),
    );

    const result = await guardedNextAuthSignOut(
      { userId: 'user-1', authSessionId: 'login-1' },
      { callbackUrl: 'https://boardsesh.test/current', redirect: false },
    );

    expect(result).toEqual({ status: 'identity-changed', url: 'https://boardsesh.test/current' });
    expect(requestLock).toHaveBeenCalledOnce();
    expect(originalFetchMock).toHaveBeenCalledOnce();
    expect(getSessionMock).toHaveBeenCalledOnce();
  });

  it('treats a server identity conflict after CSRF as a changed login', async () => {
    const requestLock = vi.fn(
      async (
        _name: string,
        _options: LockOptions,
        operation: (lock: Lock | null) => PromiseLike<Response> | Response,
      ) => operation(null),
    );
    vi.stubGlobal('navigator', { locks: { request: requestLock } });
    originalFetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ user: { id: 'user-1' }, authSessionId: 'login-1' }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: 'csrf-token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'signout_identity_changed' }), { status: 409 }));

    const result = await guardedNextAuthSignOut(
      { userId: 'user-1', authSessionId: 'login-1' },
      { callbackUrl: 'https://boardsesh.test/current', redirect: false },
    );

    expect(result.status).toBe('identity-changed');
    expect(originalFetchMock).toHaveBeenCalledTimes(3);
    expect(getSessionMock).toHaveBeenCalledOnce();
  });

  it('rejects a 200 NextAuth CSRF-failure redirect without confirming sign-out', async () => {
    const postedMessages: unknown[] = [];
    class BroadcastChannelMock {
      postMessage(message: unknown): void {
        postedMessages.push(message);
      }

      close(): void {}
    }
    vi.stubGlobal('BroadcastChannel', BroadcastChannelMock);
    const requestLock = vi.fn(
      async (
        _name: string,
        _options: LockOptions,
        operation: (lock: Lock | null) => PromiseLike<Response> | Response,
      ) => operation(null),
    );
    vi.stubGlobal('navigator', { locks: { request: requestLock } });
    originalFetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ user: { id: 'user-1' }, authSessionId: 'login-1' }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: 'csrf-token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ url: '/api/auth/signout?csrf=true' }), { status: 200 }));

    await expect(
      guardedNextAuthSignOut(
        { userId: 'user-1', authSessionId: 'login-1' },
        { callbackUrl: 'https://boardsesh.test/current', redirect: false },
      ),
    ).rejects.toThrow('Unable to confirm sign out');

    expect(postedMessages).toEqual([
      expect.objectContaining({ reason: 'signout-started' }),
      expect.objectContaining({ reason: 'credential-rotation' }),
    ]);
    expect(postedMessages).not.toContainEqual(expect.objectContaining({ reason: 'confirmed-signout' }));
    expect(getSessionMock).toHaveBeenCalledOnce();
  });

  it.each([
    ['unavailable', new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 })],
    ['malformed', new Response(JSON.stringify({ user: 'invalid' }), { status: 200 })],
  ])('throws when the session endpoint is %s', async (_caseName, sessionResponse) => {
    const requestLock = vi.fn(
      async (
        _name: string,
        _options: LockOptions,
        operation: (lock: Lock | null) => PromiseLike<Response> | Response,
      ) => operation(null),
    );
    vi.stubGlobal('navigator', { locks: { request: requestLock } });
    originalFetchMock.mockResolvedValueOnce(sessionResponse);

    await expect(
      guardedNextAuthSignOut(
        { userId: 'user-1', authSessionId: 'login-1' },
        { callbackUrl: 'https://boardsesh.test/current', redirect: false },
      ),
    ).rejects.toThrow('Unable to verify the session before signing out');

    expect(originalFetchMock).toHaveBeenCalledOnce();
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it('treats an explicitly anonymous session as already signed out', async () => {
    const requestLock = vi.fn(
      async (
        _name: string,
        _options: LockOptions,
        operation: (lock: Lock | null) => PromiseLike<Response> | Response,
      ) => operation(null),
    );
    vi.stubGlobal('navigator', { locks: { request: requestLock } });
    originalFetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await expect(
      guardedNextAuthSignOut(
        { userId: 'user-1', authSessionId: 'login-1' },
        { callbackUrl: 'https://boardsesh.test/current', redirect: false },
      ),
    ).resolves.toEqual({ status: 'signed-out', url: 'https://boardsesh.test/current' });

    expect(originalFetchMock).toHaveBeenCalledOnce();
    expect(getSessionMock).toHaveBeenCalledOnce();
  });

  it('does not lock unrelated or cross-origin fetches', async () => {
    const requestLock = vi.fn(
      async (
        _name: string,
        _options: LockOptions,
        operation: (lock: Lock | null) => PromiseLike<Response> | Response,
      ) => operation(null),
    );
    vi.stubGlobal('navigator', { locks: { request: requestLock } });
    installNextAuthCookieFetchLock();

    await globalThis.fetch('/api/internal/profile');
    await globalThis.fetch('https://example.com/api/auth/session');
    await globalThis.fetch('/api/auth/signout');

    expect(requestLock).not.toHaveBeenCalled();
    expect(originalFetchMock).toHaveBeenCalledTimes(3);
  });
});
