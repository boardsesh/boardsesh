// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserBackendClient } from '@boardsesh/auth-protocol/browser-backend-client';
import { publicExpoBrowserConsumersReady } from '../browser-consumer-readiness.web';

const fixture = vi.hoisted(() => ({
  client: null as ReturnType<typeof createBrowserBackendClient> | null,
  coordinator: vi.fn<(signal: AbortSignal) => Promise<void>>(),
  legacyHeld: false,
}));
vi.mock('../browser-coordinator-client.web', () => ({ coordinateExpoBrowserSession: fixture.coordinator }));
vi.mock('../auth-cookie-lock.web', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth-cookie-lock.web')>();
  return {
    withAuthCookieLock: <Result>(operation: () => Promise<Result>, signal?: AbortSignal) =>
      actual.withAuthCookieLock(async () => {
        fixture.legacyHeld = true;
        try {
          return await operation();
        } finally {
          fixture.legacyHeld = false;
        }
      }, signal),
  };
});
vi.mock('../error-reporting', () => ({ reportHandledError: vi.fn() }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: 'owned-fixture' } } }));
vi.mock('../browser-backend-client.web', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../browser-backend-client.web')>();
  return {
    ...actual,
    expoBrowserBackendClient: new Proxy(actual.expoBrowserBackendClient, {
      get(_target, property) {
        return Reflect.get(fixture.client ?? actual.expoBrowserBackendClient, property);
      },
    }),
  };
});
function owner() {
  return {
    userId: 'owned-user-A',
    authSessionId: 'owned-login-A',
    generation: 0,
    cursor: { bindingId: 'a'.repeat(64), version: 1 },
  };
}
function session(scope = owner()) {
  return {
    user: { id: scope.userId },
    authSessionId: scope.authSessionId,
    authGeneration: scope.generation,
    expires: '2099-01-01T00:00:00.000Z',
    browserSelection: scope,
  };
}
let store: typeof import('../auth-store.web');
let interceptor: typeof import('../auth-interceptor.web');
let currentSession: unknown;
let clock: number;
let ready: boolean;
let issued: number;
let leaseFetch: ReturnType<typeof vi.fn<(...parameters: unknown[]) => Promise<Response>>>;
let fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
let posted: unknown[];

beforeEach(async () => {
  vi.resetModules();
  currentSession = session();
  clock = 0;
  ready = true;
  issued = 0;
  posted = [];
  fixture.legacyHeld = false;
  fixture.coordinator.mockReset().mockImplementation(async () => {
    expect(fixture.legacyHeld).toBe(false);
  });
  vi.stubGlobal(
    'BroadcastChannel',
    class {
      addEventListener() {}
      postMessage(message: unknown) {
        posted.push(message);
      }
    },
  );
  leaseFetch = vi.fn<(...parameters: unknown[]) => Promise<Response>>(async () =>
    Response.json({
      status: 'admitted',
      token: `bsbd1_OWNED${++issued}`,
      usableForMs: 120_000,
      owner: (currentSession as ReturnType<typeof session>).browserSelection,
    }),
  );
  fixture.client = createBrowserBackendClient({
    ready: () => ready,
    fetch: leaseFetch,
    endpoint: 'https://www.boardsesh.com/api/internal/ws-auth',
    now: () => clock,
    schedule(callback, milliseconds) {
      const timer = setTimeout(callback, milliseconds);
      return () => clearTimeout(timer);
    },
  });
  fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(currentSession));
  vi.stubGlobal('fetch', fetch);
  store = await import('../auth-store.web');
  interceptor = await import('../auth-interceptor.web');
});
afterEach(() => {
  fixture.client?.dispose();
  fixture.client = null;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('gated Expo-web selected session and memory credentials', () => {
  it('uses the canonical host-only proof reader and keeps only its short lease in memory', async () => {
    expect(await store.synchronizeWebSession()).toMatchObject({
      status: 'authenticated',
      token: 'bsbd1_OWNED1',
      browserSelection: owner(),
    });
    expect(await store.getAuthToken()).toBe('bsbd1_OWNED1');
    expect(store.captureConfirmedWebAuthIdentity()).toEqual({
      userId: owner().userId,
      authSessionId: owner().authSessionId,
      browserSelection: owner(),
    });
    expect(fetch.mock.calls[0][0]).toBe('https://www.boardsesh.com/api/auth/session');
    expect(leaseFetch).toHaveBeenCalledWith(
      'https://www.boardsesh.com/api/internal/ws-auth',
      expect.objectContaining({ credentials: 'include', cache: 'no-store', keepalive: false }),
    );
    expect(JSON.stringify(fixture.client?.getSnapshot())).not.toContain('bsbd1_');
    store.broadcastSignOutStarted(store.captureConfirmedWebAuthIdentity()!);
    expect(JSON.stringify(posted)).not.toContain('bsbd1_');
    expect(JSON.stringify(posted)).not.toContain('browserSelection');
    expect(JSON.stringify(posted)).not.toContain(owner().cursor.bindingId);
  });
  it.each(['UID', 'SID', 'generation', 'version', 'binding'] as const)(
    'retires network generations on a confirmed %s change',
    async (change) => {
      await store.synchronizeWebSession();
      const generation = store.captureAuthCredentialGeneration();
      const previous = await store.getAuthToken();
      const next = owner();
      if (change === 'UID') next.userId = 'owned-user-B';
      if (change === 'SID') next.authSessionId = 'new-owned-login';
      if (change === 'generation') next.generation = 1;
      if (change === 'version') next.cursor.version = 2;
      if (change === 'binding') next.cursor.bindingId = 'b'.repeat(64);
      const listener = vi.fn();
      store.subscribeAuthTokenChanges(listener);
      currentSession = session(next);
      expect(await store.synchronizeWebSession()).toMatchObject({ status: 'authenticated', browserSelection: next });
      expect(store.captureAuthCredentialGeneration()).toBe(generation + 1);
      expect(listener).toHaveBeenCalledWith(null, 'session');
      expect(await store.getAuthToken()).not.toBe(previous);
    },
  );
  it('renews ordinary leases from actual source without changing the session generation', async () => {
    await store.synchronizeWebSession();
    const generation = store.captureAuthCredentialGeneration();
    clock = 90_000;
    expect(await store.getAuthToken()).toBe('bsbd1_OWNED2');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(leaseFetch).toHaveBeenCalledTimes(2);
    expect(store.captureAuthCredentialGeneration()).toBe(generation);
  });
  it('local retirement does not assert sign-out and needs another actual session admission', async () => {
    await store.synchronizeWebSession();
    await store.clearTokens();
    expect(store.captureConfirmedWebAuthIdentity()?.userId).toBe(owner().userId);
    expect(store.hasConfirmedAnonymousWebSession()).toBe(false);
    await expect(store.getAuthToken()).rejects.toMatchObject({ status: 'unavailable' });
    expect(await store.synchronizeWebSession()).toMatchObject({ status: 'authenticated', token: 'bsbd1_OWNED2' });
  });
  it('unavailable renewal keeps offline identity and never returns an expired lease or anonymity', async () => {
    await store.synchronizeWebSession();
    const generation = store.captureAuthCredentialGeneration();
    leaseFetch.mockImplementation(async () => Response.json({ status: 'unavailable' }, { status: 503 }));
    clock = 90_000;
    expect(await store.getAuthToken()).toBe('bsbd1_OWNED1');
    clock = 120_000;
    await expect(store.getAuthToken()).rejects.toMatchObject({ status: 'unavailable' });
    expect(store.captureConfirmedWebAuthIdentity()?.userId).toBe(owner().userId);
    expect(store.captureAuthCredentialGeneration()).toBe(generation);
    expect(store.hasConfirmedAnonymousWebSession()).toBe(false);
  });
  it('malformed selected metadata cannot fall back to a previously cached legacy bearer', async () => {
    currentSession = { user: { id: 'legacy-user' }, authSessionId: 'legacy-login' };
    fetch.mockResolvedValueOnce(Response.json(currentSession)).mockResolvedValueOnce(
      Response.json({
        authenticated: true,
        token: 'legacy-JWE',
        userId: 'legacy-user',
        authSessionId: 'legacy-login',
      }),
    );
    await store.synchronizeWebSession();
    expect(await store.getAuthToken()).toBe('legacy-JWE');
    currentSession = { ...session(), browserSelection: null };
    expect(await store.synchronizeWebSession()).toMatchObject({ status: 'unavailable', identityInvalidated: true });
    await expect(store.getAuthToken()).rejects.toMatchObject({ status: 'unavailable' });
    expect(store.hasConfirmedAnonymousWebSession()).toBe(false);
  });
  it('only a successful anonymous observation permits public null-token requests', async () => {
    await store.synchronizeWebSession();
    currentSession = {};
    expect(await store.synchronizeWebSession()).toEqual({ status: 'anonymous' });
    expect(await store.getAuthToken()).toBeNull();
    expect(store.hasConfirmedAnonymousWebSession()).toBe(true);
  });
  it('neither environment claims nor a selected response bypass the real hard-false entry gate', async () => {
    vi.stubEnv('EXPO_PUBLIC_SELECTED_BROWSER_READY', 'true');
    expect(publicExpoBrowserConsumersReady()).toBe(false);
    ready = false;
    expect(await store.synchronizeWebSession()).toMatchObject({ status: 'unavailable' });
    await expect(store.getAuthToken()).rejects.toMatchObject({ status: 'unavailable' });
    expect(leaseFetch).not.toHaveBeenCalled();
  });
  it('an unconfirmed initial read does not turn local retirement into an anonymous network request', async () => {
    fetch.mockResolvedValue(Response.json({ error: 'unavailable' }, { status: 503 }));
    await expect(interceptor.authenticatedFetch('https://api.owned.test/graphql')).rejects.toThrow();
    expect(
      fetch.mock.calls.every(([input]) =>
        (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).endsWith(
          '/api/auth/session',
        ),
      ),
    ).toBe(true);
    expect(store.hasConfirmedAnonymousWebSession()).toBe(false);
  });
  it('never replays a selected mutation after a confirmed backend refusal', async () => {
    await store.synchronizeWebSession();
    fetch.mockReset().mockResolvedValueOnce(new Response(null, { status: 401 }));
    const generation = store.captureAuthCredentialGeneration();
    await expect(
      interceptor.authenticatedFetch('https://api.owned.test/graphql', { method: 'POST', body: 'mutation Owned' }),
    ).rejects.toMatchObject({ status: 'denied' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(leaseFetch).toHaveBeenCalledTimes(1);
    expect(store.captureAuthCredentialGeneration()).toBe(generation);
    expect(store.captureConfirmedWebAuthIdentity()?.userId).toBe(owner().userId);
    expect(fixture.client?.capture('bsbd1_OWNED1')).toBeNull();
  });
  it('discards delayed headers after another account becomes current', async () => {
    await store.synchronizeWebSession();
    let resolve!: (response: Response) => void;
    fetch.mockImplementationOnce(async () => new Promise<Response>((complete) => (resolve = complete)));
    const pending = interceptor.authenticatedFetch('https://api.owned.test/graphql');
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    currentSession = session({ ...owner(), userId: 'owned-user-B', cursor: { ...owner().cursor, version: 2 } });
    await store.synchronizeWebSession();
    resolve(Response.json({ private: 'old A' }));
    await expect(pending).rejects.toMatchObject({ status: 'superseded' });
  });
  it('keeps a delayed actual body fenced across A to B to A', async () => {
    await store.synchronizeWebSession();
    let body!: ReadableStreamDefaultController<Uint8Array>;
    fetch.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            body = controller;
          },
        }),
      ),
    );
    const response = await interceptor.authenticatedFetch('https://api.owned.test/graphql');
    const decoded = response.clone().json();
    currentSession = session({ ...owner(), userId: 'owned-user-B', cursor: { ...owner().cursor, version: 2 } });
    await store.synchronizeWebSession();
    currentSession = session();
    await store.synchronizeWebSession();
    body.enqueue(new TextEncoder().encode('{"private":"old A"}'));
    body.close();
    await expect(decoded).rejects.toMatchObject({ status: 'superseded' });
    expect(await store.getAuthToken()).toBe('bsbd1_OWNED3');
  });
  it('an expired older 401 cannot retire a newly admitted same-owner lease', async () => {
    await store.synchronizeWebSession();
    let resolve!: (response: Response) => void;
    fetch.mockImplementationOnce(async () => new Promise<Response>((complete) => (resolve = complete)));
    const pending = interceptor.authenticatedFetch('https://api.owned.test/graphql');
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    clock = 120_000;
    expect(await store.getAuthToken()).toBe('bsbd1_OWNED2');
    resolve(new Response(null, { status: 401 }));
    await expect(pending).rejects.toMatchObject({ status: 'superseded' });
    expect(await store.getAuthToken()).toBe('bsbd1_OWNED2');
    expect(fixture.client?.capture('bsbd1_OWNED2')).not.toBeNull();
  });
  it('only confirmed anonymous requests discard an unrelated supplied authorization header', async () => {
    await store.synchronizeWebSession();
    currentSession = {};
    await store.synchronizeWebSession();
    fetch
      .mockReset()
      .mockImplementation(async (input) =>
        Response.json(input === 'https://api.owned.test/graphql' ? { public: true } : {}),
      );
    const response = await interceptor.authenticatedFetch('https://api.owned.test/graphql', {
      headers: { Authorization: 'Bearer unrelated-stale-credential' },
    });
    const sent = fetch.mock.calls.find(([input]) => input === 'https://api.owned.test/graphql');
    expect(sent).toBeDefined();
    expect(new Headers(sent?.[1]?.headers).has('Authorization')).toBe(false);
    expect(await response.json()).toEqual({ public: true });
  });
  it('keeps the primary session packet behind canonical preflight outside the legacy lock', async () => {
    await store.synchronizeWebSession();
    fetch.mockClear();
    let complete!: () => void;
    fixture.coordinator.mockImplementation(() => {
      expect(fixture.legacyHeld).toBe(false);
      return new Promise<void>((resolve) => {
        complete = resolve;
      });
    });
    const pending = store.synchronizeWebSession();
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    expect(fetch).not.toHaveBeenCalled();
    complete();
    expect(await pending).toMatchObject({ status: 'authenticated' });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('refuses a preflight that completes after the original generation retires', async () => {
    await store.synchronizeWebSession();
    fetch.mockClear();
    let complete!: () => void;
    fixture.coordinator.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const pending = store.synchronizeWebSession();
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    await store.isolateTokensForSignOut();
    complete();
    expect(await pending).toEqual({ status: 'superseded' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps coordinator unavailability distinct from confirmed anonymous without a legacy retry', async () => {
    await store.synchronizeWebSession();
    fetch.mockClear();
    fixture.coordinator.mockRejectedValue(new Error('COORDINATOR_UNAVAILABLE'));
    expect(await store.synchronizeWebSession()).toMatchObject({ status: 'unavailable' });
    expect(fetch).not.toHaveBeenCalled();
    expect(store.hasConfirmedAnonymousWebSession()).toBe(false);
  });
});
