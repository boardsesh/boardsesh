// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real auth store, ws-client facade, shared WebSocket core and installed
// graphql-ws run here. Only the network is faked: www's session endpoints and
// the browser WebSocket.
vi.mock('../../error-reporting', () => ({ reportHandledError: vi.fn() }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: 'owned' } } }));
// Metro picks the .web fork on its own; Vitest needs to be told.
vi.mock('../../client-platform', () => import('../../client-platform.web'));

/** An in-memory browser WebSocket. The shared core assigns the on* handlers. */
class BrowserSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: BrowserSocket[] = [];
  readyState = BrowserSocket.CONNECTING;
  readonly protocol = 'graphql-transport-ws';
  readonly sent: Record<string, unknown>[] = [];
  readonly url: string;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  constructor(url: string | URL) {
    super();
    this.url = String(url);
    BrowserSocket.instances.push(this);
  }
  open() {
    this.readyState = BrowserSocket.OPEN;
    this.onopen?.(new Event('open'));
  }
  send(contents: string) {
    const message = JSON.parse(contents) as Record<string, unknown>;
    this.sent.push(message);
    if (message.type === 'connection_init') queueMicrotask(() => this.receive({ type: 'connection_ack' }));
  }
  receive(message: Record<string, unknown>) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) }));
  }
  close(code = 1000, reason = '') {
    if (this.readyState === BrowserSocket.CLOSED) return;
    this.readyState = BrowserSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code, reason, wasClean: true }));
  }
}

type Login = { userId: string; authSessionId: string };
const loginA: Login = { userId: 'owned-A', authSessionId: 'owned-login-A' };
const loginB: Login = { userId: 'owned-B', authSessionId: 'owned-login-B' };

let store: typeof import('../../auth-store.web');
let facade: typeof import('../ws-client.web');
let lifecycle: typeof import('../ws-client-lifecycle');
let currentSession: Record<string, unknown>;
let currentLogin: Login;
let webFetch: ReturnType<typeof vi.fn<(...parameters: unknown[]) => Promise<Response>>>;
const sink = () => ({ next: vi.fn(), error: vi.fn(), complete: vi.fn() });
const superseded = () => expect.objectContaining({ name: 'AbortError', code: 'superseded' });

function tokenFor(login: Login): string {
  return `${login.authSessionId}-JWE`;
}

beforeEach(async () => {
  vi.resetModules();
  currentLogin = loginA;
  currentSession = { user: { id: loginA.userId }, authSessionId: loginA.authSessionId };
  webFetch = vi.fn<(...parameters: unknown[]) => Promise<Response>>(async (input) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url.endsWith('/api/internal/ws-auth'))
      return Response.json({ authenticated: true, token: tokenFor(currentLogin), ...currentLogin });
    return Response.json(currentSession);
  });
  vi.stubGlobal('fetch', webFetch);
  vi.stubGlobal('WebSocket', BrowserSocket);
  // Cross-tab behavior has its own tests. Module resets here must not retain
  // BroadcastChannels that carry an earlier test's logout into a later one.
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.stubEnv('EXPO_PUBLIC_WS_URL', 'wss://api.owned.test/graphql');
  store = await import('../../auth-store.web');
  facade = await import('../ws-client.web');
  lifecycle = await import('../ws-client-lifecycle');
});

afterEach(async () => {
  facade.disposeWsClient();
  await store.clearTokens();
  for (const socket of BrowserSocket.instances) if (socket.readyState === BrowserSocket.CONNECTING) socket.open();
  for (let turn = 0; turn < 40; turn++) await Promise.resolve();
  lifecycle.__resetWsClientLifecycleForTests();
  BrowserSocket.instances = [];
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function open(index = 0) {
  await vi.waitFor(() => expect(BrowserSocket.instances.length).toBeGreaterThan(index));
  const socket = BrowserSocket.instances[index];
  socket.open();
  await vi.waitFor(() => expect(socket.sent.some((message) => message.type === 'subscribe')).toBe(true));
  return socket;
}

async function signIn(login: Login) {
  currentLogin = login;
  currentSession = { user: { id: login.userId }, authSessionId: login.authSessionId };
  expect(await store.synchronizeWebSession()).toMatchObject({ status: 'authenticated', token: tokenFor(login) });
}

describe('Expo web WebSocket on a real browser session', () => {
  it('opens no socket handshake while the page cannot read its session', async () => {
    webFetch.mockImplementation(async () => Response.json({ error: 'unavailable' }, { status: 503 }));
    const observer = sink();
    const unsubscribe = facade.getWsClient().subscribe({ query: 'subscription NeedsSession { viewer }' }, observer);
    await vi.waitFor(() => expect(BrowserSocket.instances).toHaveLength(1));
    BrowserSocket.instances[0].open();
    // An unknown session is not a signed-out one: the attempt closes before
    // either an anonymous or an authenticated connection_init.
    await vi.waitFor(() => expect(BrowserSocket.instances[0].readyState).toBe(BrowserSocket.CLOSED));
    expect(BrowserSocket.instances.flatMap((socket) => socket.sent)).not.toContainEqual(
      expect.objectContaining({ type: 'connection_init' }),
    );
    expect(store.hasConfirmedAnonymousWebSession()).toBe(false);
    unsubscribe();
  });

  it("hands the signed-in login's token to the handshake and keeps one client", async () => {
    await signIn(loginA);
    const client = facade.getWsClient();
    expect(facade.getWsClient()).toBe(client);
    const observer = sink();
    client.subscribe({ query: 'subscription Feed { private }' }, observer);
    const socket = await open();
    expect(socket.sent.find((message) => message.type === 'connection_init')?.payload).toMatchObject({
      authToken: tokenFor(loginA),
      clientPlatform: 'web',
    });
    const operation = socket.sent.find((message) => message.type === 'subscribe')!;
    socket.receive({ id: operation.id, type: 'next', payload: { data: { private: 'owned A' } } });
    expect(observer.next).toHaveBeenCalledExactlyOnceWith({ data: { private: 'owned A' } });
  });

  it("publishes nothing from the old login's socket once another login is confirmed", async () => {
    await signIn(loginA);
    const client = facade.getWsClient();
    const oldSink = sink();
    const message = vi.fn();
    client.on('message', message);
    client.subscribe({ query: 'subscription Feed { private }' }, oldSink);
    const socket = await open();
    message.mockClear();
    await signIn(loginB);
    const operation = socket.sent.find((sent) => sent.type === 'subscribe')!;
    socket.receive({ id: operation.id, type: 'next', payload: { data: { private: 'old A' } } });
    expect(oldSink.next).not.toHaveBeenCalled();
    expect(message).not.toHaveBeenCalled();
    expect(oldSink.error).toHaveBeenCalledWith(superseded());
    expect(facade.getWsClient()).not.toBe(client);
  });

  it('delivers a pulled operation on a signed-in page', async () => {
    await signIn(loginA);
    const iterator = facade.getWsClient().iterate({ query: 'subscription Feed { public }' });
    const pending = iterator.next();
    const socket = await open();
    const operation = socket.sent.find((message) => message.type === 'subscribe')!;
    socket.receive({ id: operation.id, type: 'next', payload: { data: { public: 'result' } } });
    expect(await pending).toEqual({ done: false, value: { data: { public: 'result' } } });
    await iterator.return?.();
  });

  it('lets lifecycle listeners take the replacement, which a late old disposal cannot remove', async () => {
    await signIn(loginA);
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

describe('a rate-limited operation held across a session change', () => {
  // A page that had an account is retired when its login changes (#7596), so
  // the retry finds no socket to send on. A page that had none is not retired
  // by a sign-in; the confirmed-anonymous case below pins what its retry does.
  it.each([
    ['another account', loginB],
    ['a new login of the same account', { userId: loginA.userId, authSessionId: 'new-owned-login-A' }],
  ] as const)('is not retried as %s', async (_replacement, next) => {
    await signIn(loginA);
    const pending = await heldRateLimitedIntent();
    await signIn(next);
    pending.release();
    await expect(pending.result).rejects.toEqual(superseded());
    expect(BrowserSocket.instances).toHaveLength(1);
    expect(
      BrowserSocket.instances.flatMap((socket) => socket.sent).filter((message) => message.type === 'subscribe'),
    ).toHaveLength(1);
  });

  // Accepted gap (#7596 D4): signing in on a page that had no account keeps the
  // page, and the page carries on as the new login. A retry held across that
  // sign-in goes out as the new login too.
  it('is retried as the login that follows on a page that was signed out', async () => {
    currentSession = {};
    expect(await store.synchronizeWebSession()).toMatchObject({ status: 'anonymous' });
    const pending = await heldRateLimitedIntent();
    expect(
      BrowserSocket.instances[0].sent.find((message) => message.type === 'connection_init')?.payload,
    ).not.toHaveProperty('authToken');
    await signIn(loginA);
    pending.release();
    const second = await open(1);
    expect(second.sent.find((message) => message.type === 'connection_init')?.payload).toMatchObject({
      authToken: tokenFor(loginA),
    });
    const retry = second.sent.find((message) => message.type === 'subscribe')!;
    second.receive({ id: retry.id, type: 'next', payload: { data: { private: 'answered as A' } } });
    second.receive({ id: retry.id, type: 'complete' });
    await expect(pending.result).resolves.toEqual({ private: 'answered as A' });
  });

  it('may use a replacement socket for the same login', async () => {
    await signIn(loginA);
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
  });
});
