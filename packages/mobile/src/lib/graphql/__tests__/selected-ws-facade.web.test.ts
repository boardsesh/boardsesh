// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { createBrowserBackendClient } from '@boardsesh/auth-protocol/browser-backend-client';
import { OwnedSocket } from '../../../../../shared/auth-protocol/src/__tests__/fixtures/owned-browser-socket';

const fixture = vi.hoisted(() => ({ client: null as ReturnType<typeof createBrowserBackendClient> | null }));
vi.mock('../../browser-backend-client.web', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../browser-backend-client.web')>();
  return {
    ...actual,
    expoBrowserBackendClient: new Proxy(actual.expoBrowserBackendClient, {
      get(_target, property) {
        return Reflect.get(fixture.client ?? actual.expoBrowserBackendClient, property);
      },
    }),
  };
});

vi.mock('../../error-reporting', () => ({ reportHandledError: vi.fn() }));
vi.mock('../../browser-coordinator-client.web', () => ({ coordinateExpoBrowserSession: vi.fn(async () => {}) }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: 'owned' } } }));

/** Native browser properties dispatch too; the selected shared wrapper owns
 * accessor handlers itself, so those are deliberately delivered only once. */
class BrowserSocket extends OwnedSocket {
  override open() {
    super.open();
    if ('value' in (Object.getOwnPropertyDescriptor(this, 'onopen') ?? {})) this.onopen?.(new Event('open'));
  }
  override receive(message: Record<string, unknown>) {
    super.receive(message);
    if ('value' in (Object.getOwnPropertyDescriptor(this, 'onmessage') ?? {}))
      this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) }));
  }
}
function owner() {
  return {
    userId: 'owned-A',
    authSessionId: 'owned-login-A',
    generation: 0,
    cursor: { bindingId: 'a'.repeat(64), version: 1 },
  };
}
function session(selected = owner()) {
  return {
    user: { id: selected.userId },
    authSessionId: selected.authSessionId,
    authGeneration: selected.generation,
    expires: '2099-01-01T00:00:00.000Z',
    browserSelection: selected,
  };
}
let store: typeof import('../../auth-store.web');
let facade: typeof import('../ws-client.web');
let lifecycle: typeof import('../ws-client-lifecycle');
let currentSession: unknown;
let webFetch: ReturnType<typeof vi.fn<(...parameters: unknown[]) => Promise<Response>>>;
let leaseFetch: ReturnType<typeof vi.fn<(...parameters: unknown[]) => Promise<Response>>>;
const sink = () => ({ next: vi.fn(), error: vi.fn(), complete: vi.fn() });

beforeEach(async () => {
  vi.resetModules();
  currentSession = session();
  let issuance = 0;
  const { createBrowserBackendClient } = await import('@boardsesh/auth-protocol/browser-backend-client');
  leaseFetch = vi.fn<(...parameters: unknown[]) => Promise<Response>>(async () =>
    Response.json({
      status: 'admitted',
      token: `bsbd1_OWNED${++issuance}`,
      usableForMs: 120_000,
      owner: (currentSession as ReturnType<typeof session>).browserSelection,
    }),
  );
  fixture.client = createBrowserBackendClient({
    ready: () => true,
    fetch: leaseFetch,
    endpoint: 'https://www.owned.test/api/internal/ws-auth',
    now: () => 0,
    schedule(callback, milliseconds) {
      const timer = setTimeout(callback, milliseconds);
      return () => clearTimeout(timer);
    },
  });
  webFetch = vi.fn<(...parameters: unknown[]) => Promise<Response>>(async (input) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url.endsWith('/api/internal/ws-auth'))
      return Response.json({
        authenticated: true,
        token: 'owned-legacy-JWE',
        userId: 'owned-A',
        authSessionId: 'owned-login-A',
      });
    return Response.json(currentSession);
  });
  vi.stubGlobal('fetch', webFetch);
  vi.stubGlobal('WebSocket', BrowserSocket);
  // Cross-tab behavior has its own owned tests. Module resets here must not
  // retain Node BroadcastChannels that broadcast an earlier fixture's logout
  // into a later fixture's new account.
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.stubEnv('EXPO_PUBLIC_WS_URL', 'wss://api.owned.test/graphql');
  store = await import('../../auth-store.web');
  facade = await import('../ws-client.web');
  lifecycle = await import('../ws-client-lifecycle');
});
afterEach(async () => {
  facade.disposeWsClient();
  await store.clearTokens();
  for (const socket of OwnedSocket.instances) if (socket.readyState === OwnedSocket.CONNECTING) socket.open();
  for (let turn = 0; turn < 40; turn++) await Promise.resolve();
  fixture.client?.dispose();
  fixture.client = null;
  lifecycle.__resetWsClientLifecycleForTests();
  OwnedSocket.instances = [];
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
async function open(index = 0) {
  await vi.waitFor(() => expect(OwnedSocket.instances.length).toBeGreaterThan(index));
  const socket = OwnedSocket.instances[index];
  socket.open();
  await vi.waitFor(() => expect(socket.sent.some((message) => message.type === 'subscribe')).toBe(true));
  return socket;
}
async function legacySession() {
  currentSession = { user: { id: owner().userId }, authSessionId: owner().authSessionId };
  expect(await store.synchronizeWebSession()).toMatchObject({ status: 'authenticated', token: 'owned-legacy-JWE' });
}

describe('actual Expo browser WebSocket facade', () => {
  it('unconfirmed startup cannot silently open an anonymous authenticated transport', async () => {
    webFetch.mockImplementation(async () => Response.json({ error: 'unavailable' }, { status: 503 }));
    const observer = sink();
    const unsubscribe = facade.getWsClient().subscribe({ query: 'subscription NeedsAdmission { viewer }' }, observer);
    await vi.waitFor(() => expect(OwnedSocket.instances).toHaveLength(1));
    OwnedSocket.instances[0].open();
    // Outage recovery may retry the legacy transport, but it must close this
    // attempt before either an anonymous or authenticated connection_init.
    await vi.waitFor(() => expect(OwnedSocket.instances[0].readyState).toBe(OwnedSocket.CLOSED));
    expect(OwnedSocket.instances.flatMap((socket) => socket.sent)).not.toContainEqual(
      expect.objectContaining({ type: 'connection_init' }),
    );
    expect(store.hasConfirmedAnonymousWebSession()).toBe(false);
    expect(leaseFetch).not.toHaveBeenCalled();
    unsubscribe();
  });
  it('actual selected admission uses the bounded private lease and retains one fixed client', async () => {
    await store.synchronizeWebSession();
    const client = facade.getWsClient();
    expect(facade.getWsClient()).toBe(client);
    const observer = sink();
    client.subscribe({ query: 'subscription Feed { private }' }, observer);
    const socket = await open();
    expect(socket.sent.find((message) => message.type === 'connection_init')?.payload).toMatchObject({
      authToken: 'bsbd1_OWNED1',
      clientPlatform: 'web',
    });
    const operation = socket.sent.find((message) => message.type === 'subscribe')!;
    socket.receive({ id: operation.id, type: 'next', payload: { data: { private: 'owned A' } } });
    expect(observer.next).toHaveBeenCalledExactlyOnceWith({ data: { private: 'owned A' } });
    expect(leaseFetch).toHaveBeenCalledTimes(1);
  });
  it('malformed first selection returns only a refusing facade without anonymous or legacy fallback', async () => {
    currentSession = { ...session(), browserSelection: null };
    expect(await store.synchronizeWebSession()).toMatchObject({ status: 'unavailable' });
    const observer = sink();
    const client = facade.getWsClient();
    client.subscribe({ query: 'mutation MustNotSend { private }' }, observer);
    expect(observer.error).toHaveBeenCalledWith(expect.objectContaining({ status: 'unavailable' }));
    await expect(client.iterate({ query: 'subscription MustNotEscape { private }' }).next()).rejects.toMatchObject({
      status: 'unavailable',
    });
    expect(OwnedSocket.instances).toHaveLength(0);
    expect(leaseFetch).not.toHaveBeenCalled();
  });
  it('positively confirmed anonymous transport never acquires credentials after a later sign-in', async () => {
    await store.synchronizeWebSession();
    currentSession = {};
    await store.synchronizeWebSession();
    const anonymous = facade.getWsClient();
    const publicSink = sink();
    anonymous.subscribe({ query: 'subscription PublicFeed { feed }' }, publicSink);
    const publicSocket = await open();
    expect(publicSocket.sent.find((message) => message.type === 'connection_init')?.payload).not.toHaveProperty(
      'authToken',
    );
    currentSession = session({ ...owner(), userId: 'owned-B', cursor: { ...owner().cursor, version: 2 } });
    await store.synchronizeWebSession();
    const old = sink();
    anonymous.subscribe({ query: 'mutation OldAnonymous { private }' }, old);
    expect(old.error).toHaveBeenCalledWith(expect.objectContaining({ status: 'superseded' }));
    expect(OwnedSocket.instances).toHaveLength(1);
    expect(facade.getWsClient()).not.toBe(anonymous);
  });
  it('an old selected A client cannot send or publish through a later B client', async () => {
    await store.synchronizeWebSession();
    const old = facade.getWsClient();
    const oldSink = sink();
    old.subscribe({ query: 'subscription Feed { private }' }, oldSink);
    const oldSocket = await open();
    const oldOperation = oldSocket.sent.find((message) => message.type === 'subscribe')!;
    currentSession = session({ ...owner(), userId: 'owned-B', cursor: { ...owner().cursor, version: 2 } });
    await store.synchronizeWebSession();
    const next = facade.getWsClient();
    const nextSink = sink();
    next.subscribe({ query: 'subscription Feed { private }' }, nextSink);
    const nextSocket = await open(1);
    oldSocket.receive({ id: oldOperation.id, type: 'next', payload: { data: { private: 'stale A' } } });
    const refused = sink();
    old.subscribe({ query: 'mutation Stale { private }' }, refused);
    expect(refused.error).toHaveBeenCalledWith(expect.objectContaining({ status: 'superseded' }));
    expect(oldSink.next).not.toHaveBeenCalled();
    const nextOperation = nextSocket.sent.find((message) => message.type === 'subscribe')!;
    nextSocket.receive({ id: nextOperation.id, type: 'next', payload: { data: { private: 'current B' } } });
    expect(nextSink.next).toHaveBeenCalledExactlyOnceWith({ data: { private: 'current B' } });
    expect(facade.getWsClient()).toBe(next);
  });
  it('a legacy client cannot borrow the first selected login or publish queued legacy data', async () => {
    await legacySession();
    const legacy = facade.getWsClient();
    const oldSink = sink();
    const message = vi.fn();
    legacy.on('message', message);
    legacy.subscribe({ query: 'subscription Feed { private }' }, oldSink);
    const oldSocket = await open();
    expect(oldSocket.sent.find((sent) => sent.type === 'connection_init')?.payload).toMatchObject({
      authToken: 'owned-legacy-JWE',
    });
    message.mockClear();
    currentSession = session({ ...owner(), userId: 'owned-B', cursor: { ...owner().cursor, version: 2 } });
    await store.synchronizeWebSession();
    const oldOperation = oldSocket.sent.find((sent) => sent.type === 'subscribe')!;
    oldSocket.receive({ id: oldOperation.id, type: 'next', payload: { data: { private: 'old legacy A' } } });
    expect(oldSink.next).not.toHaveBeenCalled();
    expect(message).not.toHaveBeenCalled();
    expect(oldSink.error).toHaveBeenCalledWith(expect.objectContaining({ status: 'superseded' }));
    expect(facade.getWsClient()).not.toBe(legacy);
  });
  it('legacy pull iteration still works before selected admission', async () => {
    await legacySession();
    const iterator = facade.getWsClient().iterate({ query: 'subscription LegacyFeed { public }' });
    const pending = iterator.next();
    const socket = await open();
    const operation = socket.sent.find((message) => message.type === 'subscribe')!;
    socket.receive({ id: operation.id, type: 'next', payload: { data: { public: 'legacy result' } } });
    expect(await pending).toEqual({ done: false, value: { data: { public: 'legacy result' } } });
    await iterator.return?.();
  });
  it('lifecycle listeners see a replacement after cache retirement and old disposal cannot erase it', async () => {
    await store.synchronizeWebSession();
    const old = facade.getWsClient();
    const replacements: (typeof old)[] = [];
    const unsubscribe = lifecycle.subscribeWsClientDisposed((disposed) => {
      if (disposed === old) replacements.push(facade.getWsClient());
    });
    facade.disposeWsClient();
    expect(replacements).toHaveLength(1);
    const next = facade.getWsClient();
    expect(next).toBe(replacements[0]);
    expect(next).not.toBe(old);
    await old.dispose();
    expect(facade.getWsClient()).toBe(next);
    unsubscribe();
  });
  it('the real public readiness function cannot be bypassed by environment claims', async () => {
    fixture.client = null;
    vi.stubEnv('EXPO_PUBLIC_SELECTED_BROWSER_READY', 'true');
    expect(await store.synchronizeWebSession()).toMatchObject({ status: 'unavailable' });
    const client = facade.getWsClient();
    await expect(client.iterate({ query: 'mutation MustNotEscape { private }' }).next()).rejects.toMatchObject({
      status: 'unavailable',
    });
    const observer = sink();
    client.subscribe({ query: 'subscription MustNotOpen { private }' }, observer);
    expect(observer.error).toHaveBeenCalledWith(expect.objectContaining({ status: 'unavailable' }));
    expect(OwnedSocket.instances).toHaveLength(0);
  });
});

async function heldRateLimitedIntent() {
  const { execute } = await import('@boardsesh/graphql-client');
  let release = () => {};
  let entered = () => {};
  const waiting = new Promise<void>((resolve) => (entered = resolve));
  const sleep = vi.fn(() => {
    entered();
    return new Promise<void>((resolve) => (release = resolve));
  });
  const result = execute<{ private: string }>(
    facade.getWsClient,
    { query: 'mutation OriginalA { private }' },
    { sleep, rateLimitJitterMs: 0 },
  );
  void result.catch(() => {});
  const first = await open();
  const original = first.sent.find((message) => message.type === 'subscribe')!;
  first.receive({
    id: original.id,
    type: 'error',
    payload: [{ message: 'Not executed', extensions: { code: 'RATE_LIMITED', retryAfterSeconds: 1 } }],
  });
  await Promise.race([waiting, result]);
  expect(sleep).toHaveBeenCalledTimes(1);
  return { result, release: () => release() };
}

describe('actual Expo operation intent through a held rate-limit wait', () => {
  it.each(['A -> B', 'A -> B -> A'] as const)(
    '%s cannot choose a later client for the original mutation',
    async (transition) => {
      await store.synchronizeWebSession();
      const pending = await heldRateLimitedIntent();
      currentSession = session({ ...owner(), userId: 'owned-B', cursor: { ...owner().cursor, version: 2 } });
      await store.synchronizeWebSession();
      if (transition === 'A -> B -> A') {
        currentSession = session();
        await store.synchronizeWebSession();
      }
      pending.release();
      await expect(pending.result).rejects.toMatchObject({ status: 'superseded' });
      expect(OwnedSocket.instances).toHaveLength(1);
      expect(
        OwnedSocket.instances.flatMap((socket) => socket.sent).filter((message) => message.type === 'subscribe'),
      ).toHaveLength(1);
    },
  );
  it('a confirmed retry may use a replacement transport for the exact same accepted view', async () => {
    await store.synchronizeWebSession();
    const generation = store.captureAuthCredentialGeneration();
    const pending = await heldRateLimitedIntent();
    facade.disposeWsClient();
    pending.release();
    const second = await open(1);
    const retry = second.sent.find((message) => message.type === 'subscribe')!;
    second.receive({ id: retry.id, type: 'next', payload: { data: { private: 'original A intent' } } });
    second.receive({ id: retry.id, type: 'complete' });
    await expect(pending.result).resolves.toEqual({ private: 'original A intent' });
    expect(store.captureAuthCredentialGeneration()).toBe(generation);
    expect(leaseFetch).toHaveBeenCalledTimes(1);
  });
  it('first selected observation cannot resume an earlier legacy operation even for the same UID/SID', async () => {
    await legacySession();
    const pending = await heldRateLimitedIntent();
    const issuedBeforeTransition = leaseFetch.mock.calls.length;
    currentSession = session();
    await store.synchronizeWebSession();
    pending.release();
    await expect(pending.result).rejects.toMatchObject({ status: 'superseded' });
    expect(OwnedSocket.instances).toHaveLength(1);
    // Central observation may acquire B's own lease; the old intent may not.
    expect(leaseFetch).toHaveBeenCalledTimes(issuedBeforeTransition + 1);
  });
  it('a legacy store generation change cannot silently renew an earlier intent under a new SID', async () => {
    await legacySession();
    const pending = await heldRateLimitedIntent();
    currentSession = { user: { id: owner().userId }, authSessionId: 'new-owned-login-A' };
    webFetch.mockImplementation(async (input) =>
      typeof input === 'string' && input.endsWith('/api/internal/ws-auth')
        ? Response.json({
            authenticated: true,
            token: 'new-legacy-JWE',
            userId: owner().userId,
            authSessionId: 'new-owned-login-A',
          })
        : Response.json(currentSession),
    );
    await store.synchronizeWebSession();
    pending.release();
    await expect(pending.result).rejects.toMatchObject({ status: 'superseded' });
    expect(OwnedSocket.instances).toHaveLength(1);
  });
});
