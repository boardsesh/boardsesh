import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  generation: 7,
  token: 'native-original-token' as string | null,
  refreshToken: 'native-refresh-token' as string | null,
  expiring: false,
  getAuthToken: vi.fn<() => Promise<string | null>>(),
  getRefreshToken: vi.fn<() => Promise<string | null>>(),
  isTokenExpiringSoon: vi.fn<() => Promise<boolean>>(),
  storeTokensForGeneration:
    vi.fn<(generation: number, jwt: string, refresh: string, expiry: string) => Promise<boolean>>(),
  signOutForGeneration: vi.fn<(generation: number) => Promise<boolean>>(),
}));
const connectivity = vi.hoisted(() => ({ offline: false, reportBackendOutcome: vi.fn() }));
const reporting = vi.hoisted(() => ({ reportError: vi.fn(), reportHandledError: vi.fn() }));
vi.mock('../env', () => ({ BACKEND_URL: 'https://native-rest-owned.test/' }));
vi.mock('../auth-store', () => ({
  captureAuthCredentialGeneration: () => auth.generation,
  isAuthCredentialGenerationCurrent: (generation: number) => generation === auth.generation,
  getAuthToken: () => auth.getAuthToken(),
  getRefreshToken: () => auth.getRefreshToken(),
  isTokenExpiringSoon: () => auth.isTokenExpiringSoon(),
  storeTokensForGeneration: (generation: number, jwt: string, refresh: string, expiry: string) =>
    auth.storeTokensForGeneration(generation, jwt, refresh, expiry),
}));
vi.mock('../auth', () => ({ signOutForGeneration: (generation: number) => auth.signOutForGeneration(generation) }));
vi.mock('../connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => ({ effectiveOffline: connectivity.offline }),
  reportBackendOutcome: (outcome: unknown) => connectivity.reportBackendOutcome(outcome),
}));
vi.mock('../client-identity', () => ({
  getClientIdentityHeaderValue: () => 'boardsesh-mobile/owned-native-test',
  clientIdentityHeaders: () => ({ 'x-boardsesh-client': 'boardsesh-mobile/owned-native-test' }),
}));
vi.mock('../error-reporting', () => ({
  reportError: (error: unknown, context?: unknown) => reporting.reportError(error, context),
  reportHandledError: (error: unknown, context?: unknown) => reporting.reportHandledError(error, context),
}));

// Keep both the native interceptor and response-scope implementation real.
import { setOnForcedSignOut } from '../auth-interceptor';
import { captureRestOperation, createRestOperation, useRestView, type RestGetPath } from '../rest-operation';

const credentialsPath = '/api/aurora-credentials';
const unsyncedPath = '/api/aurora-credentials/unsynced';
const credentialsUrl = 'https://native-rest-owned.test/api/aurora-credentials';
const refreshUrl = 'https://native-rest-owned.test//auth/native/refresh';
const payload = { credentials: [{ boardType: 'kilter', username: 'owned-climber' }] };
const refreshedTokens = {
  jwt: 'native-new-token',
  refreshToken: 'native-new-refresh',
  expiresAt: '2099-01-01T00:00:00Z',
};
type RequestRecord = { url: string; options: RequestInit; headers: Headers };
let requests: RequestRecord[];
const reply = vi.fn<(url: string, options?: RequestInit) => Promise<Response>>();
const fetchMock = vi.fn(async (input: string | URL | Request, options: RequestInit = {}): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  requests.push({ url, options: { ...options }, headers: new Headers(options.headers) });
  return reply(url, options);
});

function deferred<T>() {
  let resolve!: (result: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function observe<T>(promise: Promise<T>) {
  const settlement = { done: false };
  const result = promise.then(
    (value) => {
      settlement.done = true;
      return { ok: true as const, value };
    },
    (error: unknown) => {
      settlement.done = true;
      return { ok: false as const, error };
    },
  );
  return { settlement, result };
}

beforeEach(() => {
  requests = [];
  auth.generation = 7;
  auth.token = 'native-original-token';
  auth.refreshToken = 'native-refresh-token';
  auth.expiring = false;
  connectivity.offline = false;
  auth.getAuthToken.mockReset().mockImplementation(async () => auth.token);
  auth.getRefreshToken.mockReset().mockImplementation(async () => auth.refreshToken);
  auth.isTokenExpiringSoon.mockReset().mockImplementation(async () => auth.expiring);
  auth.storeTokensForGeneration.mockReset().mockImplementation(async (generation, jwt, refresh) => {
    if (generation !== auth.generation) return false;
    auth.token = jwt;
    auth.refreshToken = refresh;
    auth.expiring = false;
    return true;
  });
  auth.signOutForGeneration.mockReset().mockImplementation(async (generation) => {
    if (generation !== auth.generation) return false;
    auth.generation += 1;
    auth.token = null;
    auth.refreshToken = null;
    return true;
  });
  connectivity.reportBackendOutcome.mockClear();
  reporting.reportError.mockClear();
  reporting.reportHandledError.mockClear();
  fetchMock.mockClear();
  reply.mockReset().mockImplementation(async () => Response.json(payload));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  setOnForcedSignOut(null);
});

afterEach(() => {
  setOnForcedSignOut(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('native REST read operation', () => {
  it('has a stable raw-key view and does no credential I/O merely to capture or inspect it', () => {
    const first = useRestView();
    const logical = ['auroraCredentials'] as const;
    expect(useRestView()).toBe(first);
    expect(first).toMatchObject({ scope: undefined, scoped: false, ready: true });
    expect(first.isCurrent()).toBe(true);
    expect(first.key(logical)).toBe(logical);
    const operation = captureRestOperation();
    operation.assertView();
    operation.assertAttemptCurrent();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(auth.getAuthToken).not.toHaveBeenCalled();
    expect(auth.isTokenExpiringSoon).not.toHaveBeenCalled();
  });

  it.each([credentialsPath, unsyncedPath] as const)(
    'performs one trusted effective GET and decodes the exact original Response (%s)',
    async (path) => {
      const original = Response.json(payload);
      const json = vi.spyOn(original, 'json');
      reply.mockResolvedValueOnce(original);
      const delivery = await createRestOperation('ignored-native-view').getJson<typeof payload>(path);
      expect(delivery.response).toBe(original);
      expect(delivery.body).toEqual({ kind: 'json', value: payload });
      expect(json).toHaveBeenCalledTimes(1);
      expect(original.bodyUsed).toBe(true);
      delivery.assertCurrent();
      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe(`https://native-rest-owned.test${path}`);
      expect(Object.keys(requests[0].options)).toEqual(['headers']);
      expect(Object.fromEntries(requests[0].headers)).toEqual({
        authorization: 'Bearer native-original-token',
        'x-boardsesh-client': 'boardsesh-mobile/owned-native-test',
      });
      expect(requests[0].headers.has('Content-Type')).toBe(false);
      expect(auth.getAuthToken).toHaveBeenCalledTimes(1);
    },
  );

  it.each([401, 403, 429, 503])('keeps HTTP %i and its decoded body for the service mapper', async (status) => {
    auth.token = null;
    const original = Response.json({ error: 'owned current failure' }, { status });
    reply.mockResolvedValueOnce(original);
    const delivery = await captureRestOperation().getJson(credentialsPath);
    expect(delivery.response).toBe(original);
    expect(delivery.response.status).toBe(status);
    expect(delivery.body).toEqual({ kind: 'json', value: { error: 'owned current failure' } });
    expect(requests).toHaveLength(1);
    expect(auth.getRefreshToken).not.toHaveBeenCalled();
    expect(requests[0].headers.has('Authorization')).toBe(false);
  });

  it.each([200, 403])('returns a genuine platform decode error with the original HTTP %i response', async (status) => {
    const original = new Response('not JSON', { status });
    reply.mockResolvedValueOnce(original);
    const delivery = await captureRestOperation().getJson(credentialsPath);
    expect(delivery.response).toBe(original);
    expect(delivery.body.kind).toBe('decode-error');
    if (delivery.body.kind !== 'decode-error') throw new Error('Expected decoding failure');
    expect(delivery.body.error).toBeInstanceOf(SyntaxError);
    delivery.assertCurrent();
    expect(requests).toHaveLength(1);
  });

  it.each([
    { label: 'plain JSON', bytes: new TextEncoder().encode('{"ok":true}') },
    { label: 'single BOM', bytes: new Uint8Array([239, 187, 191, ...new TextEncoder().encode('{"ok":true}')]) },
    {
      label: 'double BOM',
      bytes: new Uint8Array([239, 187, 191, 239, 187, 191, ...new TextEncoder().encode('{"ok":true}')]),
    },
    { label: 'empty body', bytes: new Uint8Array() },
    { label: 'invalid UTF-8 in a string', bytes: new Uint8Array([34, 255, 34]) },
  ])('retains native Response.json semantics for $label', async ({ bytes }) => {
    const expected = await observe(new Response(bytes).json()).result;
    const original = new Response(bytes);
    reply.mockResolvedValueOnce(original);
    const delivery = await captureRestOperation().getJson(credentialsPath);
    expect(delivery.response).toBe(original);
    if (expected.ok) {
      expect(delivery.body).toEqual({ kind: 'json', value: expected.value });
    } else {
      expect(delivery.body.kind).toBe('decode-error');
      if (delivery.body.kind !== 'decode-error') throw new Error('Expected decoding failure');
      expect(delivery.body.error).toBeInstanceOf(SyntaxError);
      expect(delivery.body.error).toMatchObject({ message: (expected.error as Error).message });
    }
  });

  it('consumes its one-use flag while its first fetch is still pending', async () => {
    const headers = deferred<Response>();
    reply.mockReturnValueOnce(headers.promise);
    const operation = captureRestOperation();
    const first = operation.getJson(credentialsPath);
    await expect(operation.getJson(unsyncedPath)).rejects.toThrow('REST operation already used');
    headers.resolve(Response.json(payload));
    await expect(first).resolves.toMatchObject({ body: { kind: 'json', value: payload } });
    expect(requests).toHaveLength(1);
  });

  it.each(['https://untrusted.test/api/aurora-credentials', '/api/aurora-credentials?other=1', '/api/aurora-import'])(
    'rejects an unapproved path and consumes the operation (%s)',
    async (path) => {
      const operation = captureRestOperation();
      await expect(operation.getJson(path as RestGetPath)).rejects.toThrow('Unsupported REST read path');
      await expect(operation.getJson(credentialsPath)).rejects.toThrow('REST operation already used');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(auth.getAuthToken).not.toHaveBeenCalled();
    },
  );

  it('does not wrap a transport error in a fabricated response or retry the operation', async () => {
    const failure = new TypeError('Owned transport failure');
    reply.mockRejectedValueOnce(failure);
    const operation = captureRestOperation();
    await expect(operation.getJson(credentialsPath)).rejects.toBe(failure);
    operation.assertAttemptCurrent();
    await expect(operation.getJson(credentialsPath)).rejects.toThrow('REST operation already used');
    expect(requests).toHaveLength(1);
  });

  it('normalizes an explicit pre-abort without exposing its reason or reading credentials', async () => {
    const controller = new AbortController();
    controller.abort(new Error('private caller reason'));
    const operation = captureRestOperation({ signal: controller.signal });
    await expect(operation.getJson(credentialsPath)).rejects.toMatchObject({
      name: 'AbortError',
      code: 'REST_OPERATION_ABORTED',
      message: 'REST operation aborted',
    });
    await expect(operation.getJson(credentialsPath)).rejects.toThrow('REST operation already used');
    expect(auth.getAuthToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards only an explicitly supplied signal and retires its transferred delivery on dispose', async () => {
    const controller = new AbortController();
    const operation = captureRestOperation({ signal: controller.signal });
    const delivery = await operation.getJson(credentialsPath);
    const forwarded = requests[0].options.signal;
    expect(forwarded).toBeInstanceOf(AbortSignal);
    expect(forwarded).not.toBe(controller.signal);
    expect(forwarded?.aborted).toBe(false);
    operation.dispose();
    operation.dispose();
    expect(forwarded?.aborted).toBe(true);
    expect(controller.signal.aborted).toBe(false);
    expect(() => delivery.assertCurrent()).toThrow('REST operation aborted');
    expect(() => operation.assertAttemptCurrent()).toThrow('REST operation aborted');
  });

  it('fences delivery on dispose without adding a default native fetch signal', async () => {
    const headers = deferred<Response>();
    reply.mockReturnValueOnce(headers.promise);
    const operation = captureRestOperation();
    const pending = observe(operation.getJson(credentialsPath));
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].options).not.toHaveProperty('signal');
    operation.dispose();
    headers.resolve(Response.json(payload));
    expect(await pending.result).toMatchObject({
      ok: false,
      error: { name: 'AbortError', code: 'REST_OPERATION_ABORTED' },
    });
  });

  it.each([false, true])(
    'owns an already-aborted physical response until body cancellation settles (cancel rejects: %s)',
    async (cancelRejects) => {
      const headers = deferred<Response>();
      const cancellation = deferred<void>();
      const cancel = vi.fn(() => cancellation.promise);
      const original = new Response(new ReadableStream<Uint8Array>({ cancel }));
      reply.mockReturnValueOnce(headers.promise);
      const controller = new AbortController();
      const pending = observe(captureRestOperation({ signal: controller.signal }).getJson(credentialsPath));
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      controller.abort({ privatePayload: 'must not escape' });
      headers.resolve(original);
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
      expect(pending.settlement.done).toBe(false);
      if (cancelRejects) cancellation.reject(new Error('secondary cancellation failure'));
      else cancellation.resolve();
      expect(await pending.result).toMatchObject({
        ok: false,
        error: { name: 'AbortError', code: 'REST_OPERATION_ABORTED', message: 'REST operation aborted' },
      });
    },
  );

  it('rechecks explicit cancellation after the original native JSON reader settles', async () => {
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const original = new Response(
      new ReadableStream<Uint8Array>({
        start: (controller) => {
          body = controller;
        },
      }),
    );
    const json = vi.spyOn(original, 'json');
    reply.mockResolvedValueOnce(original);
    const controller = new AbortController();
    const pending = observe(captureRestOperation({ signal: controller.signal }).getJson(credentialsPath));
    await vi.waitFor(() => expect(json).toHaveBeenCalledTimes(1));
    controller.abort('private reason');
    body.enqueue(new TextEncoder().encode('{"private":"old body"}'));
    body.close();
    expect(await pending.result).toMatchObject({
      ok: false,
      error: { name: 'AbortError', message: 'REST operation aborted' },
    });
    expect(original.bodyUsed).toBe(true);
  });

  it('does not introduce a native account policy after the interceptor has returned a response', async () => {
    const headers = deferred<Response>();
    reply.mockReturnValueOnce(headers.promise);
    const operation = createRestOperation('opaque-native-target');
    const pending = operation.getJson(credentialsPath);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    auth.generation += 1;
    headers.resolve(Response.json(payload));
    const delivery = await pending;
    expect(delivery.body).toEqual({ kind: 'json', value: payload });
    delivery.assertCurrent();
    expect(requests).toHaveLength(1);
  });
});

describe('actual native interceptor policy through the one-use REST wrapper', () => {
  it('keeps proactive refresh and its existing client identity before the effective GET', async () => {
    auth.expiring = true;
    reply.mockResolvedValueOnce(Response.json(refreshedTokens)).mockResolvedValueOnce(Response.json(payload));
    const delivery = await captureRestOperation().getJson(credentialsPath);
    expect(delivery.body).toEqual({ kind: 'json', value: payload });
    expect(requests.map((request) => request.url)).toEqual([refreshUrl, credentialsUrl]);
    expect(requests[0].options.method).toBe('POST');
    expect(requests[0].options.body).toBe(JSON.stringify({ refreshToken: 'native-refresh-token' }));
    expect(Object.fromEntries(requests[0].headers)).toEqual({
      'content-type': 'application/json',
      'x-boardsesh-client': 'boardsesh-mobile/owned-native-test',
    });
    expect(requests[1].headers.get('Authorization')).toBe('Bearer native-new-token');
    expect(auth.storeTokensForGeneration).toHaveBeenCalledExactlyOnceWith(
      7,
      refreshedTokens.jwt,
      refreshedTokens.refreshToken,
      refreshedTokens.expiresAt,
    );
    expect(auth.signOutForGeneration).not.toHaveBeenCalled();
  });

  it('preserves the native proactive-refresh bypass while offline', async () => {
    connectivity.offline = true;
    auth.expiring = true;
    await captureRestOperation().getJson(credentialsPath);
    expect(requests.map((request) => request.url)).toEqual([credentialsUrl]);
    expect(auth.isTokenExpiringSoon).not.toHaveBeenCalled();
    expect(auth.getRefreshToken).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent native 401 refresh and retries each GET exactly once', async () => {
    const refresh = deferred<Response>();
    reply
      .mockResolvedValueOnce(Response.json({ error: 'expired' }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ error: 'expired' }, { status: 401 }))
      .mockReturnValueOnce(refresh.promise);
    const first = captureRestOperation().getJson(credentialsPath);
    const second = captureRestOperation().getJson(unsyncedPath);
    await vi.waitFor(() => expect(requests.filter((request) => request.url === refreshUrl)).toHaveLength(1));
    refresh.resolve(Response.json(refreshedTokens));
    const deliveries = await Promise.all([first, second]);
    expect(deliveries.every((delivery) => delivery.body.kind === 'json')).toBe(true);
    expect(requests).toHaveLength(5);
    expect(requests.filter((request) => request.url === refreshUrl)).toHaveLength(1);
    expect(
      requests.filter((request) => request.url !== refreshUrl).map((request) => request.headers.get('Authorization')),
    ).toEqual([
      'Bearer native-original-token',
      'Bearer native-original-token',
      'Bearer native-new-token',
      'Bearer native-new-token',
    ]);
    expect(auth.signOutForGeneration).not.toHaveBeenCalled();
  });

  it('keeps the original 401 without retry or logout when native refresh is unavailable', async () => {
    const original = Response.json({ error: 'original unauthorized' }, { status: 401 });
    reply.mockResolvedValueOnce(original).mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
    const delivery = await captureRestOperation().getJson(credentialsPath);
    expect(delivery.response).toBe(original);
    expect(delivery.body).toEqual({ kind: 'json', value: { error: 'original unauthorized' } });
    expect(requests).toHaveLength(2);
    expect(auth.signOutForGeneration).not.toHaveBeenCalled();
    expect(connectivity.reportBackendOutcome).toHaveBeenCalledWith({ kind: 'failure', status: 503 });
  });

  it('preserves native rejected-refresh cleanup and still exposes its actual original 401 response', async () => {
    const notifyProvider = vi.fn();
    setOnForcedSignOut(notifyProvider);
    const original = Response.json({ error: 'native unauthorized' }, { status: 401 });
    reply.mockResolvedValueOnce(original).mockResolvedValueOnce(new Response(null, { status: 403 }));
    const delivery = await captureRestOperation().getJson(credentialsPath);
    expect(auth.signOutForGeneration).toHaveBeenCalledExactlyOnceWith(7);
    expect(notifyProvider).toHaveBeenCalledTimes(1);
    expect(auth.generation).toBe(8);
    expect(delivery.response).toBe(original);
    expect(delivery.body).toEqual({ kind: 'json', value: { error: 'native unauthorized' } });
    delivery.assertCurrent();
    expect(requests).toHaveLength(2);
  });

  it('adds no refresh or replay when the native interceptor retry also receives 401', async () => {
    const retry = Response.json({ error: 'retry unauthorized' }, { status: 401 });
    reply
      .mockResolvedValueOnce(Response.json({ error: 'expired' }, { status: 401 }))
      .mockResolvedValueOnce(Response.json(refreshedTokens))
      .mockResolvedValueOnce(retry);
    const delivery = await captureRestOperation().getJson(credentialsPath);
    expect(delivery.response).toBe(retry);
    expect(delivery.body).toEqual({ kind: 'json', value: { error: 'retry unauthorized' } });
    expect(requests.map((request) => request.url)).toEqual([credentialsUrl, refreshUrl, credentialsUrl]);
    expect(auth.signOutForGeneration).not.toHaveBeenCalled();
  });

  it('preserves the native interceptor veto when credentials change during its token await', async () => {
    const token = deferred<string | null>();
    auth.getAuthToken.mockReturnValueOnce(token.promise);
    const pending = observe(captureRestOperation().getJson(credentialsPath));
    await vi.waitFor(() => expect(auth.getAuthToken).toHaveBeenCalledTimes(1));
    auth.generation += 1;
    token.resolve('old-native-token');
    expect(await pending.result).toMatchObject({
      ok: false,
      error: { message: 'Authentication session changed before the request could be sent' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
