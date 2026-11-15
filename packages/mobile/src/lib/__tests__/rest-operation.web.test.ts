import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserBackendLeaseOwner } from '@boardsesh/auth-protocol/browser-backend-lease';
const state = vi.hoisted(() => ({
  required: true,
  legacy: false,
  anonymous: false,
  unavailable: false,
  user: 'A',
  sid: 'login-A',
  version: 2,
  generation: 1,
}));
vi.mock('../browser-consumer-readiness.web', () => ({ publicExpoBrowserConsumersReady: () => state.required }));
vi.mock('../browser-coordinator-client.web', () => ({ coordinateExpoBrowserSession: vi.fn(async () => {}) }));
vi.mock('../auth-interceptor', () => ({
  authenticatedFetch: (...args: Parameters<typeof import('../auth-interceptor.web').authenticatedFetch>) =>
    runtime.interceptor.authenticatedFetch(...args),
}));
vi.mock('../error-reporting', () => ({ reportHandledError: vi.fn() }));
vi.mock('../env', () => ({
  BACKEND_URL: 'https://backend.owned.test/',
  WEB_BASE_URL: 'https://www.owned.test',
  webApiUrl: (path: string) => 'https://www.owned.test' + path,
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: 'rest-owned' } } }));
vi.mock('../client-platform', () => ({ CLIENT_PLATFORM: 'web' }));
vi.mock('../connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => ({ effectiveOffline: false }),
  reportBackendOutcome: vi.fn(),
}));
let runtime: {
  store: typeof import('../auth-store.web');
  rest: typeof import('../rest-operation.web');
  backend: typeof import('../browser-backend-client.web');
  clients: typeof import('../graphql/client.web');
  interceptor: typeof import('../auth-interceptor.web');
  admission: typeof import('../browser-response-admission.web');
};
let clock: number;
let serial: number;
let packets: { url: string; init?: RequestInit }[];
let leases: Map<string, BrowserBackendLeaseOwner>;
let reply: () => Promise<Response>;
let sessionReply: (() => Promise<Response>) | undefined;
let leaseReply: ((response: Response) => Promise<Response>) | undefined;
function owner(): BrowserBackendLeaseOwner {
  return {
    userId: state.user,
    authSessionId: state.sid,
    generation: state.generation,
    cursor: { bindingId: 'a'.repeat(64), version: state.version },
  };
}
function deferred<T>() {
  let resolve!: (result: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
async function admit() {
  await runtime.store.synchronizeWebSession();
}
async function change(kind: string) {
  if (kind === 'B') {
    state.user = 'B';
    state.sid = 'login-B';
  }
  if (kind === 'ABA') {
    state.user = 'B';
    state.sid = 'login-B';
    await admit();
    state.user = 'A';
    state.sid = 'login-A';
  }
  if (kind === 'SID') state.sid = 'login-A-next';
  if (kind === 'generation') state.generation++;
  if (kind === 'version') state.version++;
  await admit();
}
beforeEach(async (context) => {
  vi.resetModules();
  Object.assign(state, {
    required: true,
    legacy: false,
    anonymous: false,
    unavailable: false,
    user: 'A',
    sid: 'login-A',
    version: 2,
    generation: 1,
  });
  if (
    /^(same-owner(?:401| )|own401|unavailable401|restrictive original|veto before retry|a same-generation)/.test(
      context.task.name,
    )
  ) {
    state.required = false;
    state.legacy = true;
  }
  clock = 0;
  serial = 0;
  packets = [];
  leases = new Map();
  sessionReply = undefined;
  leaseReply = undefined;
  reply = async () => Response.json({ credentials: [{ auroraUsername: 'private-A' }] });
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/api/auth/session')) {
        if (sessionReply) return sessionReply();
        if (state.unavailable) return Response.json({}, { status: 503 });
        if (state.anonymous) return Response.json({});
        return Response.json({
          user: { id: state.user },
          authSessionId: state.sid,
          ...(!state.legacy
            ? { authGeneration: state.generation, browserSelection: owner(), expires: '2099-01-01T00:00:00.000Z' }
            : {}),
        });
      }
      if (url.endsWith('/api/internal/ws-auth')) {
        if (state.legacy)
          return Response.json({
            authenticated: true,
            token: `legacy-${++serial}`,
            userId: state.user,
            authSessionId: state.sid,
          });
        const token = `bsbd1_REST_${++serial}`;
        leases.set(token, owner());
        const response = Response.json({ status: 'admitted', token, usableForMs: 120000, owner: owner() });
        return leaseReply ? leaseReply(response) : response;
      }
      if (url.endsWith('/api/auth/csrf')) return Response.json({ csrfToken: 'owned-csrf' });
      if (url.endsWith('/api/auth/signout')) return Response.json({ url: '/app' });
      if (!url.startsWith('https://backend.owned.test/api/aurora-credentials'))
        throw new Error('Unexpected owned destination');
      packets.push({ url, init });
      return reply();
    }),
  );
  const store = await import('../auth-store.web');
  const rest = await import('../rest-operation.web');
  runtime = {
    store,
    rest,
    backend: await import('../browser-backend-client.web'),
    clients: await import('../graphql/client.web'),
    interceptor: await import('../auth-interceptor.web'),
    admission: await import('../browser-response-admission.web'),
  };
  await admit();
});
afterEach(() => {
  runtime?.clients.browserHttpClients.dispose();
  runtime?.backend.expoBrowserBackendClient.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('original physical REST operation', () => {
  it.each(['/api/aurora-credentials', '/api/aurora-credentials/unsynced'] as const)(
    'sends one trusted GET and retains actual response provenance: %s',
    async (path) => {
      const operation = runtime.rest.captureRestOperation();
      const delivery = await operation.getJson(path);
      expect(delivery.body).toEqual({ kind: 'json', value: { credentials: [{ auroraUsername: 'private-A' }] } });
      expect(packets).toHaveLength(1);
      expect(packets[0]?.url).toBe('https://backend.owned.test' + path);
      expect(packets[0]?.init?.method).toBeUndefined();
      expect(packets[0]?.init?.body).toBeUndefined();
      const headers = new Headers(packets[0]?.init?.headers);
      expect(leases.has(headers.get('Authorization')?.slice(7) ?? '')).toBe(true);
      expect(headers.get('x-boardsesh-client')).toContain('rest-owned');
      expect(headers.get('Content-Type')).toBeNull();
      expect(runtime.admission.captureBrowserResponseCurrent(delivery.response)).toBe(delivery.assertCurrent);
      expect(runtime.admission.captureBrowserResponseCurrent(Response.json({}))).toBeNull();
      delivery.assertCurrent();
      await expect(operation.getJson(path)).rejects.toThrow();
      expect(packets).toHaveLength(1);
    },
  );
  it('consumes even an invalid invocation before any network await', async () => {
    const operation = runtime.rest.captureRestOperation();
    await expect(operation.getJson('/api/foreign' as '/api/aurora-credentials')).rejects.toThrow();
    await expect(operation.getJson('/api/aurora-credentials')).rejects.toThrow();
    expect(packets).toHaveLength(0);
  });
  it('missing/unknown intent cannot adopt a current owner', async () => {
    const operation = runtime.rest.createRestOperation(undefined);
    await expect(operation.getJson('/api/aurora-credentials')).rejects.toThrow();
    expect(packets).toHaveLength(0);
  });
  it.each(['B', 'ABA', 'SID', 'generation', 'version'])(
    'refuses retired original response at headers: %s',
    async (kind) => {
      const held = deferred<Response>();
      reply = () => held.promise;
      const operation = runtime.rest.captureRestOperation();
      const request = operation.getJson('/api/aurora-credentials');
      const rejected = expect(request).rejects.toThrow();
      await vi.waitFor(() => expect(packets).toHaveLength(1));
      await change(kind);
      held.resolve(Response.json({ privateA: true }));
      await rejected;
      expect(packets).toHaveLength(1);
    },
  );
  it.each(['B', 'ABA', 'SID', 'generation', 'version'])('refuses retired original body: %s', async (kind) => {
    const held = deferred<void>();
    reply = async () =>
      new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode('{"privateA":true}'));
            await held.promise;
            controller.close();
          },
        }),
      );
    const request = runtime.rest.captureRestOperation().getJson('/api/aurora-credentials');
    const rejected = expect(request).rejects.toThrow();
    await vi.waitFor(() => expect(packets).toHaveLength(1));
    await change(kind);
    held.resolve();
    await rejected;
  });
  it.each(['B', 'abort'])(
    'original authority held acquisition never dispatches for a replacement intent: %s',
    async (kind) => {
      clock = 120001;
      const entered = deferred<void>();
      const held = deferred<Response>();
      let originalResponse: Response | undefined;
      leaseReply = async (response) => {
        originalResponse = response;
        entered.resolve();
        return held.promise;
      };
      const abort = new AbortController();
      const operation = runtime.rest.captureRestOperation({ signal: abort.signal });
      const request = operation.getJson('/api/aurora-credentials');
      const rejected = expect(request).rejects.toThrow();
      await entered.promise;
      leaseReply = undefined;
      if (kind === 'B') await change('B');
      else abort.abort(new Error('PRIVATE old intent'));
      if (!originalResponse) throw new Error('Missing actual owned lease response');
      held.resolve(originalResponse);
      await rejected;
      expect(packets).toHaveLength(0);
    },
  );
  it('an independently fresh same-owner lease cannot extend original pending bytes', async () => {
    const held = deferred<void>();
    reply = async () =>
      new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode('{"privateA":true}'));
            await held.promise;
            controller.close();
          },
        }),
      );
    const request = runtime.rest.captureRestOperation().getJson('/api/aurora-credentials');
    const rejected = expect(request).rejects.toThrow();
    await vi.waitFor(() => expect(packets).toHaveLength(1));
    clock = 120001;
    const fresh = await runtime.backend.expoBrowserBackendClient.acquire(owner());
    expect(fresh.token).toBeTruthy();
    held.resolve();
    await rejected;
    const scope = runtime.backend.expoBrowserBackendClient.capture(fresh.token);
    expect(scope).not.toBeNull();
    if (scope) runtime.backend.expoBrowserBackendClient.assertCurrent(scope, fresh);
  });
  it('expired old401 cannot invalidate the independently fresh same-owner lease', async () => {
    const held = deferred<Response>();
    reply = () => held.promise;
    const request = runtime.rest.captureRestOperation().getJson('/api/aurora-credentials');
    const rejected = expect(request).rejects.toThrow();
    await vi.waitFor(() => expect(packets).toHaveLength(1));
    clock = 120001;
    const fresh = await runtime.backend.expoBrowserBackendClient.acquire(owner());
    held.resolve(Response.json({}, { status: 401 }));
    await rejected;
    const scope = runtime.backend.expoBrowserBackendClient.capture(fresh.token);
    expect(scope).not.toBeNull();
    if (scope) runtime.backend.expoBrowserBackendClient.assertCurrent(scope, fresh);
  });
  it('live selected401 invalidates only its original scope without retry', async () => {
    reply = async () => Response.json({ error: 'private refusal' }, { status: 401 });
    const operation = runtime.rest.captureRestOperation();
    await expect(operation.getJson('/api/aurora-credentials')).rejects.toMatchObject({
      name: 'BrowserBackendConsumerError',
      status: 'denied',
    });
    operation.assertAttemptCurrent();
    expect(packets).toHaveLength(1);
  });
  it('confirmed anonymous gets the real authenticated endpoint401 without a bearer', async () => {
    state.anonymous = true;
    await admit();
    reply = async () => Response.json({ error: 'unauthorized' }, { status: 401 });
    const delivery = await runtime.rest.captureRestOperation().getJson('/api/aurora-credentials');
    expect(delivery.response.status).toBe(401);
    expect(new Headers(packets[0]?.init?.headers).has('Authorization')).toBe(false);
    expect(delivery.body.kind).toBe('json');
  });
  it.each(['', '{', '\ufeff\ufeff{"ok":true}', '{"ok":true}'])(
    'uses platform JSON semantics while retaining original physical authority: %j',
    async (contents) => {
      reply = async () => new Response(contents);
      const expected = await new Response(contents).json().then(
        (value) => ({ kind: 'json', value }),
        () => ({ kind: 'decode-error' }),
      );
      const delivery = await runtime.rest.captureRestOperation().getJson('/api/aurora-credentials');
      expect(delivery.body.kind).toBe(expected.kind);
      if (expected.kind === 'json') expect(delivery.body).toEqual(expected);
      delivery.assertCurrent();
    },
  );
  it.each([false, true])(
    'abort at headers awaits held cancellation and suppresses secondary failure=%s',
    async (rejectCancel) => {
      const cancellation = deferred<void>();
      const cancelled = vi.fn(() => cancellation.promise);
      const abort = new AbortController();
      reply = async () => {
        abort.abort(new Error('PRIVATE abort reason'));
        return new Response(new ReadableStream({ cancel: cancelled }));
      };
      let settled = false;
      const request = runtime.rest
        .captureRestOperation({ signal: abort.signal })
        .getJson('/api/aurora-credentials')
        .finally(() => {
          settled = true;
        });
      const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError', message: 'REST operation aborted' });
      await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(1));
      expect(settled).toBe(false);
      if (rejectCancel) cancellation.reject(new Error('PRIVATE cancel error'));
      else cancellation.resolve();
      await rejected;
      expect(settled).toBe(true);
    },
  );
  it('abort during an owned reader awaits held cancellation', async () => {
    const cancellation = deferred<void>();
    const cancelled = vi.fn(() => cancellation.promise);
    const abort = new AbortController();
    reply = async () => new Response(new ReadableStream({ cancel: cancelled }));
    let settled = false;
    const request = runtime.rest
      .captureRestOperation({ signal: abort.signal })
      .getJson('/api/aurora-credentials')
      .finally(() => {
        settled = true;
      });
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(packets).toHaveLength(1));
    abort.abort('PRIVATE');
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);
    cancellation.resolve();
    await rejected;
  });
  it('post-await use checks the original receipt, never a replacement lease', async () => {
    const delivery = await runtime.rest.captureRestOperation().getJson('/api/aurora-credentials');
    await change('B');
    expect(() => delivery.assertCurrent()).toThrow();
  });
  it.each([false, true])(
    'decoder-only delay retains original physical guard even on decode rejection=%s',
    async (rejectDecode) => {
      const entered = deferred<void>();
      const held = deferred<void>();
      const actualJson = Reflect.get(Response.prototype, 'json') as (this: Response) => Promise<unknown>;
      vi.spyOn(Response.prototype, 'json').mockImplementation(async function (this: Response) {
        if (packets.length && this.status === 200 && !this.headers.has('Content-Type')) {
          entered.resolve();
          await held.promise;
          if (rejectDecode) throw new SyntaxError('PRIVATE old decode failure');
        }
        return actualJson.call(this);
      });
      reply = async () => new Response('{"privateA":true}');
      const request = runtime.rest.captureRestOperation().getJson('/api/aurora-credentials');
      const rejected = expect(request).rejects.toMatchObject({ name: 'BrowserBackendConsumerError' });
      await entered.promise;
      clock = 120001;
      const fresh = await runtime.backend.expoBrowserBackendClient.acquire(owner());
      held.resolve();
      await rejected;
      const scope = runtime.backend.expoBrowserBackendClient.capture(fresh.token);
      expect(scope).not.toBeNull();
      if (scope) runtime.backend.expoBrowserBackendClient.assertCurrent(scope, fresh);
    },
  );
});

describe('fixed legacy dispatch reuses the installed refresh algorithm', () => {
  it('same-owner401 refresh retries once with exact headers and disposes first body', async () => {
    const cancel = vi.fn();
    let count = 0;
    reply = async () =>
      ++count === 1
        ? new Response(new ReadableStream({ cancel }), { status: 401 })
        : Response.json({ credentials: [] });
    const delivery = await runtime.rest.captureRestOperation().getJson('/api/aurora-credentials');
    expect(delivery.response.status).toBe(200);
    expect(packets).toHaveLength(2);
    expect(cancel).toHaveBeenCalledTimes(1);
    const first = new Headers(packets[0]?.init?.headers);
    const second = new Headers(packets[1]?.init?.headers);
    expect(first.get('Authorization')).not.toBe(second.get('Authorization'));
    expect(first.get('x-boardsesh-client')).toBe(second.get('x-boardsesh-client'));
    delivery.assertCurrent();
  });
  it('own401 confirmed anonymous performs provider cleanup before refusing the retired operation', async () => {
    const cleanup = vi.fn();
    runtime.interceptor.setOnForcedSignOut(cleanup);
    reply = async () => {
      state.anonymous = true;
      return new Response(null, { status: 401 });
    };
    await expect(runtime.rest.captureRestOperation().getJson('/api/aurora-credentials')).rejects.toThrow();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(packets).toHaveLength(1);
  });
  it('unavailable401 confirmation preserves current legacy identity and original failure response', async () => {
    const cleanup = vi.fn();
    runtime.interceptor.setOnForcedSignOut(cleanup);
    reply = async () => {
      state.unavailable = true;
      return new Response(null, { status: 401 });
    };
    const delivery = await runtime.rest.captureRestOperation().getJson('/api/aurora-credentials');
    expect(delivery.response.status).toBe(401);
    expect(cleanup).not.toHaveBeenCalled();
    expect(packets).toHaveLength(1);
  });
  it.each([1, 2, 3])('restrictive original veto blocks dispatch checkpoint%s with no payload leak', async (vetoAt) => {
    let calls = 0;
    await expect(
      runtime.interceptor.authenticatedFetchForOriginalLegacyRequest(
        'https://backend.owned.test/api/aurora-credentials',
        {},
        () => {
          if (++calls === vetoAt) throw new Error('PRIVATE veto');
        },
      ),
    ).rejects.toMatchObject({
      name: 'BrowserBackendConsumerError',
      message: 'Selected browser credential is unavailable',
    });
    expect(packets).toHaveLength(0);
  });
  it.each([false, true])(
    'veto before retry owns first401 until cancellation settles, rejection=%s',
    async (rejectCancel) => {
      const cancellation = deferred<void>();
      const cancelled = vi.fn(() => cancellation.promise);
      reply = async () => new Response(new ReadableStream({ cancel: cancelled }), { status: 401 });
      let checks = 0;
      let settled = false;
      const request = runtime.interceptor
        .authenticatedFetchForOriginalLegacyRequest('https://backend.owned.test/api/aurora-credentials', {}, () => {
          if (++checks === 4) throw new Error('PRIVATE');
        })
        .finally(() => {
          settled = true;
        });
      const rejected = expect(request).rejects.toThrow();
      await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(1));
      expect(settled).toBe(false);
      expect(packets).toHaveLength(1);
      if (rejectCancel) cancellation.reject(new Error('PRIVATE secondary cancel'));
      else cancellation.resolve();
      await rejected;
    },
  );
  it('same-owner second401 retains confirmation policy and one retry', async () => {
    const cleanup = vi.fn();
    runtime.interceptor.setOnForcedSignOut(cleanup);
    reply = async () => new Response(null, { status: 401 });
    const delivery = await runtime.rest.captureRestOperation().getJson('/api/aurora-credentials');
    expect(delivery.response.status).toBe(401);
    expect(packets).toHaveLength(2);
    expect(cleanup).not.toHaveBeenCalled();
    delivery.assertCurrent();
  });
  it('own401 second confirmation completes anonymous cleanup before the old operation refuses', async () => {
    const cleanup = vi.fn();
    runtime.interceptor.setOnForcedSignOut(cleanup);
    reply = async () => {
      if (packets.length === 2) state.anonymous = true;
      return new Response(null, { status: 401 });
    };
    await expect(runtime.rest.captureRestOperation().getJson('/api/aurora-credentials')).rejects.toThrow();
    expect(packets).toHaveLength(2);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
  it('same-owner pending token await cannot upgrade original legacy mode to selected', async () => {
    const operation = runtime.rest.captureRestOperation();
    const generation = runtime.store.captureAuthCredentialGeneration();
    const request = operation.getJson('/api/aurora-credentials');
    state.required = true;
    await expect(request).rejects.toThrow();
    expect(runtime.store.captureAuthCredentialGeneration()).toBe(generation);
    expect(packets).toHaveLength(0);
  });
  it('a same-generation selected-mode transition cannot make the legacy entry dispatch', async () => {
    state.required = true;
    await expect(
      runtime.interceptor.authenticatedFetchForOriginalLegacyRequest(
        'https://backend.owned.test/api/aurora-credentials',
        {},
        () => {},
      ),
    ).rejects.toThrow();
    expect(packets).toHaveLength(0);
  });
});
