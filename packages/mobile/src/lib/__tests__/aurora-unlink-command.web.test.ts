import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserBackendLeaseOwner } from '@boardsesh/auth-protocol/browser-backend-lease';
const state = vi.hoisted(() => ({
  native: false,
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
const native = vi.hoisted(() => ({
  token: 'native-old',
  generation: 7,
  expiring: false,
  offline: false,
  signouts: [] as number[],
}));
vi.mock('../auth-store', () => ({
  captureAuthCredentialGeneration: () => native.generation,
  getAuthToken: async () => native.token,
  getRefreshToken: async () => 'native-refresh',
  isAuthCredentialGenerationCurrent: (generation: number) => generation === native.generation,
  storeTokensForGeneration: async (generation: number, token: string) => {
    if (generation !== native.generation) return false;
    native.token = token;
    return true;
  },
  isTokenExpiringSoon: async () => native.expiring,
  getTokenExpiresAt: async () => null,
}));
vi.mock('../auth', () => ({
  signOutForGeneration: async (generation: number) => {
    native.signouts.push(generation);
    return true;
  },
}));
vi.mock('../client-identity', () => ({
  getClientIdentityHeaderValue: () => 'native-owned',
  clientIdentityHeaders: () => ({ 'x-boardsesh-client': 'native-owned' }),
}));
vi.mock('../auth-interceptor', () => ({
  authenticatedFetch: (...args: Parameters<typeof import('../auth-interceptor.web').authenticatedFetch>) =>
    (state.native ? runtime.nativeInterceptor : runtime.interceptor).authenticatedFetch(...args),
}));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: vi.fn() }));
vi.mock('../error-reporting', () => ({ reportHandledError: vi.fn() }));
vi.mock('../env', () => ({
  BACKEND_URL: 'https://backend.owned.test/',
  WEB_BASE_URL: 'https://www.owned.test',
  webApiUrl: (path: string) => 'https://www.owned.test' + path,
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: 'rest-owned' } } }));
vi.mock('../client-platform', () => ({ CLIENT_PLATFORM: 'web' }));
vi.mock('../connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => ({ effectiveOffline: native.offline }),
  reportBackendOutcome: vi.fn(),
}));
let runtime: {
  nativeRest: typeof import('../rest-operation');
  nativeInterceptor: typeof import('../auth-interceptor');
  aurora: typeof import('../aurora-credentials');
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
let nativeRefresh: (() => Promise<Response>) | undefined;
let nativeRefreshes: number;
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
  state.native = context.task.name.startsWith('native ');
  Object.assign(native, { token: 'native-old', generation: 7, expiring: false, offline: false, signouts: [] });
  nativeRefresh = undefined;
  nativeRefreshes = 0;
  clock = 0;
  serial = 0;
  packets = [];
  leases = new Map();
  sessionReply = undefined;
  leaseReply = undefined;
  reply = async () => Response.json({ success: true });
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/auth/native/refresh')) {
        nativeRefreshes++;
        return nativeRefresh
          ? nativeRefresh()
          : Response.json({ jwt: 'native-new', refreshToken: 'new-refresh', expiresAt: '2099-01-01T00:00:00Z' });
      }
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
      packets.push({ url, init: init ? { ...init, headers: new Headers(init.headers) } : undefined });
      return reply();
    }),
  );
  const store = await import('../auth-store.web');
  const rest = await import('../rest-operation.web');
  runtime = {
    nativeRest: await import('../rest-operation'),
    nativeInterceptor: await vi.importActual<typeof import('../auth-interceptor')>('../auth-interceptor'),
    aurora: await import('../aurora-credentials'),
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

function command(options?: { signal?: AbortSignal }) {
  return runtime.rest.createUnlinkRestOperation(runtime.clients.browserHttpClients.captureRequestView(), options);
}
async function outcome(operation = command()) {
  return runtime.aurora.unlinkAuroraCredentialWithReceipt(operation, 'kilter');
}

describe('closed unlink physical command', () => {
  it.each([200, 207])('one exact DELETE preserves actual %s outcome and original guard', async (status) => {
    const result =
      status === 207 ? { success: false, localCleared: true, reason: 'revocation_failed' } : { success: true };
    reply = async () => Response.json(result, { status });
    const operation = command();
    const accepted = await outcome(operation);
    expect(accepted).toMatchObject({ ok: true, result });
    expect(() => accepted.assertCurrent()).not.toThrow();
    expect(packets).toHaveLength(1);
    expect(packets[0]?.url).toBe('https://backend.owned.test/api/aurora-credentials');
    expect(packets[0]?.init?.method).toBe('DELETE');
    expect(packets[0]?.init?.body).toBe('{"boardType":"kilter"}');
    const headers = new Headers(packets[0]?.init?.headers);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('x-boardsesh-client')).toContain('rest-owned');
    expect(leases.has(headers.get('Authorization')?.slice(7) ?? '')).toBe(true);
    await expect(operation.unlinkJson('tension')).rejects.toMatchObject({ status: 'unavailable' });
    expect(packets).toHaveLength(1);
    operation.dispose();
    expect(() => accepted.assertCurrent()).toThrow();
  });
  it.each([
    [403, 'not_allowed'],
    [429, 'rate_limited'],
    [500, 'request_failed'],
  ] as const)('HTTP%s keeps its exact error cause/code', async (status, code) => {
    reply = async () => Response.json({ error: 'private backend text' }, { status });
    const accepted = await outcome();
    expect(accepted).toMatchObject({ ok: false, error: { code } });
    expect(() => accepted.assertCurrent()).not.toThrow();
    await change('B');
    expect(() => accepted.assertCurrent()).toThrow();
    expect(packets).toHaveLength(1);
  });
  it('malformed success stays a guarded decode error', async () => {
    reply = async () => new Response('not json');
    const accepted = await outcome();
    expect(accepted.ok).toBe(false);
    expect(() => accepted.assertCurrent()).not.toThrow();
    await change('version');
    expect(() => accepted.assertCurrent()).toThrow();
  });
  it('selected401 is refused without refresh/retry', async () => {
    reply = async () => Response.json({ error: 'Invalid Aurora credentials' }, { status: 401 });
    await expect(outcome()).rejects.toMatchObject({ status: 'denied' });
    expect(packets).toHaveLength(1);
    expect(nativeRefreshes).toBe(0);
  });
  it.each(['B', 'ABA', 'SID', 'version', 'generation'])('held original physical body refuses %s', async (kind) => {
    const held = deferred<void>();
    reply = async () =>
      new Response(
        new ReadableStream({
          async pull(controller) {
            await held.promise;
            controller.enqueue(new TextEncoder().encode('{"success":true}'));
            controller.close();
          },
        }),
      );
    const pending = outcome();
    await vi.waitFor(() => expect(packets).toHaveLength(1));
    await change(kind);
    held.resolve();
    await expect(pending).rejects.toBeInstanceOf(Error);
    expect(packets).toHaveLength(1);
  });
  it('original E1 expires although independently acquired same-view E2 is live', async () => {
    const operation = command();
    const accepted = await outcome(operation);
    const token1 = new Headers(packets[0]?.init?.headers).get('Authorization');
    clock = 110000;
    const actualOwner = runtime.backend.expoBrowserBackendClient.getSnapshot().owner!;
    const fresh = await runtime.backend.expoBrowserBackendClient.acquire(actualOwner);
    const scope = runtime.backend.expoBrowserBackendClient.capture(fresh.token)!;
    clock = 120001;
    expect(fresh.token).not.toBe(token1?.slice(7));
    expect(() => runtime.backend.expoBrowserBackendClient.assertCurrent(scope, fresh)).not.toThrow();
    expect(() => accepted.assertCurrent()).toThrow();
    expect(packets).toHaveLength(1);
  });
  it('abort at actual headers awaits held cancellation and preserves fixed refusal', async () => {
    const aborted = new AbortController();
    const cancel = deferred<void>();
    let cancelled = 0;
    let settled = false;
    reply = async () => {
      aborted.abort('secret reason');
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled++;
            return cancel.promise;
          },
        }),
      );
    };
    const pending = outcome(command({ signal: aborted.signal })).then(
      () => {
        settled = true;
      },
      (error) => {
        settled = true;
        return error;
      },
    );
    await vi.waitFor(() => expect(cancelled).toBe(1));
    expect(settled).toBe(false);
    cancel.reject(new Error('secret cleanup'));
    const refused = await pending;
    expect(refused).toMatchObject({ name: 'AbortError', message: 'REST operation aborted' });
    expect(String(refused)).not.toContain('secret');
    expect(cancelled).toBe(1);
  });
  it('bad board consumes the operation before its first await', async () => {
    const operation = command();
    await expect(operation.unlinkJson('foreign' as 'kilter')).rejects.toMatchObject({ status: 'unavailable' });
    await expect(operation.unlinkJson('kilter')).rejects.toMatchObject({ status: 'unavailable' });
    expect(packets).toHaveLength(0);
  });
  it('unknown transport failure remains unknown and never obtains response authority', async () => {
    reply = async () => {
      throw new Error('private network diagnostic');
    };
    const operation = command();
    await expect(outcome(operation)).rejects.toThrow('private network diagnostic');
    expect(() => operation.assertAttemptCurrent()).not.toThrow();
    await change('B');
    expect(() => operation.assertAttemptCurrent()).toThrow();
    expect(packets).toHaveLength(1);
  });
  it('same-owner legacy DELETE preserves fixed method/body and retry policy', async () => {
    let calls = 0;
    reply = async () => Response.json(calls++ ? { success: true } : {}, { status: calls === 1 ? 401 : 200 });
    const accepted = await outcome();
    expect(accepted).toMatchObject({ ok: true, result: { success: true } });
    expect(packets).toHaveLength(2);
    for (const packet of packets)
      expect(packet.init).toMatchObject({ method: 'DELETE', body: '{"boardType":"kilter"}' });
  });
  it('native explicit operation runs actual installed interceptor and exact original wire', async () => {
    const operation = runtime.nativeRest.createUnlinkRestOperation(undefined);
    const accepted = await runtime.aurora.unlinkAuroraCredentialWithReceipt(operation, 'tension');
    expect(accepted).toMatchObject({ ok: true, result: { success: true } });
    expect(packets).toHaveLength(1);
    const packet = packets[0]!;
    expect(packet.init).toMatchObject({ method: 'DELETE', body: '{"boardType":"tension"}' });
    const headers = new Headers(packet.init?.headers);
    expect(headers.get('Authorization')).toBe('Bearer native-old');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('x-boardsesh-client')).toBe('native-owned');
    expect(packet.init?.signal).toBeUndefined();
  });
  it('native own401 retries exactly once with existing refresh and same body', async () => {
    let calls = 0;
    reply = async () => (calls++ ? Response.json({ success: true }) : Response.json({}, { status: 401 }));
    const accepted = await runtime.aurora.unlinkAuroraCredentialWithReceipt(
      runtime.nativeRest.createUnlinkRestOperation(undefined),
      'kilter',
    );
    expect(accepted.ok).toBe(true);
    expect(packets).toHaveLength(2);
    expect(nativeRefreshes).toBe(1);
    expect(new Headers(packets[0]?.init?.headers).get('Authorization')).toBe('Bearer native-old');
    expect(new Headers(packets[1]?.init?.headers).get('Authorization')).toBe('Bearer native-new');
    expect(packets.map((packet) => packet.init?.body)).toEqual(['{"boardType":"kilter"}', '{"boardType":"kilter"}']);
    expect(native.signouts).toEqual([]);
  });
  it('native offline proactive bypass preserves no-refresh ordinary dispatch', async () => {
    native.expiring = true;
    native.offline = true;
    const accepted = await runtime.aurora.unlinkAuroraCredentialWithReceipt(
      runtime.nativeRest.createUnlinkRestOperation(undefined),
      'kilter',
    );
    expect(accepted.ok).toBe(true);
    expect(nativeRefreshes).toBe(0);
    expect(packets).toHaveLength(1);
    expect(native.signouts).toEqual([]);
  });
  it('native rejected refresh performs existing generation-bound signout', async () => {
    reply = async () => Response.json({}, { status: 401 });
    nativeRefresh = async () => Response.json({}, { status: 401 });
    const accepted = await runtime.aurora.unlinkAuroraCredentialWithReceipt(
      runtime.nativeRest.createUnlinkRestOperation(undefined),
      'kilter',
    );
    expect(accepted).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    expect(nativeRefreshes).toBe(1);
    expect(packets).toHaveLength(1);
    expect(native.signouts).toEqual([7]);
  });
  it('native unavailable refresh retains existing unauthorized result without signout', async () => {
    reply = async () => Response.json({}, { status: 401 });
    nativeRefresh = async () => Response.json({}, { status: 503 });
    const accepted = await runtime.aurora.unlinkAuroraCredentialWithReceipt(
      runtime.nativeRest.createUnlinkRestOperation(undefined),
      'kilter',
    );
    expect(accepted).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    expect(nativeRefreshes).toBe(1);
    expect(packets).toHaveLength(1);
    expect(native.signouts).toEqual([]);
  });
  it('native superseded generation returns the original401 without retrying newer account', async () => {
    reply = async () => Response.json({}, { status: 401 });
    nativeRefresh = async () => {
      native.generation++;
      return Response.json({ jwt: 'foreign-new', refreshToken: 'foreign-refresh', expiresAt: '2099-01-01T00:00:00Z' });
    };
    const accepted = await runtime.aurora.unlinkAuroraCredentialWithReceipt(
      runtime.nativeRest.createUnlinkRestOperation(undefined),
      'kilter',
    );
    expect(accepted).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    expect(packets).toHaveLength(1);
    expect(nativeRefreshes).toBe(1);
    expect(native.signouts).toEqual([]);
  });
  it('own401 legacy anonymous confirmation completes provider cleanup before old operation refuses', async () => {
    let forced = 0;
    runtime.interceptor.setOnForcedSignOut(() => {
      forced++;
    });
    reply = async () => Response.json({}, { status: 401 });
    sessionReply = async () => Response.json({});
    await expect(outcome()).rejects.toBeInstanceOf(Error);
    expect(packets).toHaveLength(1);
    expect(forced).toBe(1);
  });
  it('restrictive original legacy intent cannot adopt a selected account after token awaits', async () => {
    const operation = command();
    await change('version');
    state.legacy = false;
    state.required = true;
    await admit();
    await expect(outcome(operation)).rejects.toBeInstanceOf(Error);
    expect(packets).toHaveLength(0);
  });
  it('abort during an actual reader awaits cancellation rejection before normalized failure', async () => {
    const cancelled = deferred<void>();
    let pulls = 0;
    let cancels = 0;
    let settled = false;
    const abort = new AbortController();
    reply = async () =>
      new Response(
        new ReadableStream({
          pull() {
            pulls++;
          },
          cancel() {
            cancels++;
            return cancelled.promise;
          },
        }),
      );
    const pending = outcome(command({ signal: abort.signal })).then(
      () => {
        settled = true;
      },
      (error) => {
        settled = true;
        return error;
      },
    );
    await vi.waitFor(() => expect(pulls).toBeGreaterThan(0));
    abort.abort({ secret: 'private-abort' });
    await vi.waitFor(() => expect(cancels).toBe(1));
    expect(settled).toBe(false);
    cancelled.reject(new Error('private-cancel'));
    const refused = await pending;
    expect(refused).toMatchObject({ name: 'AbortError', message: 'REST operation aborted' });
    expect(String(refused)).not.toContain('private');
    expect(cancels).toBe(1);
  });
  it('repeated mode and view observation performs no credential or lease I/O', () => {
    const before = { serial, leases: leases.size, packets: packets.length };
    for (let index = 0; index < 100; index++) {
      const view = runtime.rest.captureRestReadView();
      expect(view.ready).toBe(true);
      expect(view.isCurrent()).toBe(true);
      view.key(['auroraCredentials']);
    }
    expect({ serial, leases: leases.size, packets: packets.length }).toEqual(before);
  });
});
