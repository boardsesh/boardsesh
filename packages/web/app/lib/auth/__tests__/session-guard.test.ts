// @vitest-environment node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  createSessionGuard,
  isSessionSuperseded,
  sessionViewerKey,
  sessionViewerOf,
  SessionSupersededError,
  shouldRetryQuery,
  type SessionGuard,
} from '../session-guard';

type Handler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
let handle: Handler;
let origin: string;
const received: { url?: string; authorization?: string }[] = [];
const server = createServer((request, response) => {
  received.push({ url: request.url, authorization: request.headers.authorization });
  void handle(request, response);
});

const accountA = { userId: 'user-a', authSessionId: 'login-a' };
const accountA2 = { userId: 'user-a', authSessionId: 'login-a2' };
const accountB = { userId: 'user-b', authSessionId: 'login-b' };

function deferred<Value = void>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'X-Fixture': 'kept' });
  response.end(JSON.stringify(body));
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

let reloadPage: ReturnType<typeof vi.fn<() => void>>;
let requestSessionCheck: ReturnType<typeof vi.fn<() => void>>;
let clock: number;

function guardWith(options: { cleanupTimeoutMs?: number; send?: typeof fetch } = {}): SessionGuard {
  return createSessionGuard({
    reloadPage,
    requestSessionCheck,
    now: () => clock,
    cleanupTimeoutMs: options.cleanupTimeoutMs ?? 1000,
    localChangeWindowMs: 20_000,
    unauthorizedDelayMs: 20,
    send: options.send,
  });
}

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

beforeEach(() => {
  received.length = 0;
  clock = 1_000_000;
  reloadPage = vi.fn<() => void>();
  requestSessionCheck = vi.fn<() => void>();
  handle = (_request, response) => json(response, 200, { ok: true });
});

describe('guarded fetch', () => {
  it('returns the full body, status and headers to a request for the current account', async () => {
    const guard = guardWith();
    guard.accept(accountA);
    handle = (_request, response) => json(response, 201, { owner: 'user-a' });

    const response = await guard.fetch(`${origin}/profile`, { headers: { Authorization: 'Bearer token-a' } });

    expect(response.status).toBe(201);
    expect(response.headers.get('x-fixture')).toBe('kept');
    expect(await response.json()).toEqual({ owner: 'user-a' });
    expect(received).toEqual([{ url: '/profile', authorization: 'Bearer token-a' }]);
  });

  it('decides after the whole body arrives, so a switch between headers and body is superseded', async () => {
    const headersReceived = deferred();
    const finishBody = deferred();
    const guard = guardWith({
      send: async (input, init) => {
        const response = await fetch(input, init);
        headersReceived.resolve();
        return response;
      },
    });
    guard.accept(accountA);
    handle = async (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('{"owner":');
      await finishBody.promise;
      response.end('"user-a"}');
    };

    const pending = guard.fetch(`${origin}/profile`);
    await headersReceived.promise;
    guard.expectLocalChange();
    guard.accept(accountB);
    finishBody.resolve();

    await expect(pending).rejects.toBeInstanceOf(SessionSupersededError);
  });

  it('refuses a token remembered for an earlier account without sending a request', async () => {
    const guard = guardWith();
    guard.accept(accountA);
    guard.rememberToken('token-a', accountA);
    guard.expectLocalChange();
    guard.accept(accountB);

    const plainHeaders = guard.fetch(`${origin}/graphql`, { headers: { authorization: 'Bearer token-a' } });
    const headersInstance = guard.fetch(`${origin}/graphql`, {
      method: 'POST',
      headers: new Headers({ Authorization: 'Bearer token-a' }),
      body: '{}',
    });

    await expect(plainHeaders).rejects.toSatisfy(isSessionSuperseded);
    await expect(headersInstance).rejects.toSatisfy(isSessionSuperseded);
    expect(received).toHaveLength(0);
  });

  it('also refuses a token from an earlier login of the same account', async () => {
    const guard = guardWith();
    guard.accept(accountA);
    guard.rememberToken('token-a', accountA);
    guard.accept(accountA2);

    await expect(guard.fetch(`${origin}/graphql`, { headers: { Authorization: 'Bearer token-a' } })).rejects.toSatisfy(
      isSessionSuperseded,
    );
    expect(received).toHaveLength(0);
  });

  it('asks for one session check for a burst of 401 responses', async () => {
    const guard = guardWith();
    guard.accept(accountA);
    handle = (_request, response) => json(response, 401, { errors: [{ message: 'unauthenticated' }] });

    const responses = await Promise.all([guard.fetch(`${origin}/one`), guard.fetch(`${origin}/two`)]);
    expect(responses.map((response) => response.status)).toEqual([401, 401]);
    expect(requestSessionCheck).not.toHaveBeenCalled();
    await sleep(60);
    expect(requestSessionCheck).toHaveBeenCalledOnce();

    await guard.fetch(`${origin}/three`);
    await sleep(60);
    expect(requestSessionCheck).toHaveBeenCalledTimes(2);
  });

  it('keeps an empty 204 response intact', async () => {
    const guard = guardWith();
    guard.accept(null);
    handle = (_request, response) => {
      response.writeHead(204);
      response.end();
    };

    const response = await guard.fetch(`${origin}/controllers`, { method: 'DELETE' });

    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
  });

  it('reports a transport failure across a switch as superseded, and as itself otherwise', async () => {
    const failure = new TypeError('fetch failed');
    let switchFirst = false;
    const guard = guardWith({
      send: async () => {
        if (switchFirst) guard.accept(accountA2);
        throw failure;
      },
    });
    guard.accept(accountA);

    await expect(guard.fetch(`${origin}/profile`)).rejects.toBe(failure);
    switchFirst = true;
    await expect(guard.fetch(`${origin}/profile`)).rejects.toBeInstanceOf(SessionSupersededError);
  });
});

describe('account transitions', () => {
  it('neither bumps nor reloads on the first read or a repeat of the same account', () => {
    const guard = guardWith();
    const generation = guard.capture();

    expect(guard.accept(accountA)).toBe('publish');
    expect(guard.accept({ ...accountA })).toBe('publish');

    expect(guard.capture()).toBe(generation);
    expect(guard.viewerKey()).toBe('user-a:login-a');
    expect(reloadPage).not.toHaveBeenCalled();
  });

  it('drops anonymous responses on sign-in without reloading', async () => {
    const guard = guardWith();
    guard.accept(null);
    const generation = guard.capture();

    expect(guard.accept(accountA)).toBe('publish');

    expect(guard.isCurrent(generation)).toBe(false);
    expect(guard.isRetiring()).toBe(false);
    await sleep(5);
    expect(reloadPage).not.toHaveBeenCalled();
  });

  it('drops responses from an earlier login of the same account without reloading', async () => {
    const guard = guardWith();
    guard.accept(accountA);
    const generation = guard.capture();

    expect(guard.accept(accountA2)).toBe('publish');

    expect(guard.isCurrent(generation)).toBe(false);
    await sleep(5);
    expect(reloadPage).not.toHaveBeenCalled();
  });

  it.each([
    ['another account', accountB],
    ['signed out', null],
  ] as const)(
    'retires the page when %s arrives from elsewhere: cleanup first, then one reload',
    async (_label, next) => {
      const guard = guardWith();
      const order: string[] = [];
      guard.registerCleanup(async () => {
        await sleep(5);
        order.push('cleanup');
      });
      reloadPage.mockImplementation(() => order.push('reload'));
      guard.accept(accountA);
      const generation = guard.capture();

      expect(guard.accept(next)).toBe('retire');

      expect(guard.isRetiring()).toBe(true);
      expect(guard.isCurrent(generation)).toBe(false);
      expect(guard.isCurrent(guard.capture())).toBe(false);
      await expect(guard.fetch(`${origin}/profile`)).rejects.toBeInstanceOf(SessionSupersededError);
      expect(received).toHaveLength(0);
      await vi.waitFor(() => expect(reloadPage).toHaveBeenCalledOnce());
      expect(order).toEqual(['cleanup', 'reload']);
      expect(guard.accept(accountA)).toBe('retire');
      await sleep(5);
      expect(reloadPage).toHaveBeenCalledOnce();
    },
  );

  it('reloads at the cleanup timeout when a cleanup never settles', async () => {
    const guard = guardWith({ cleanupTimeoutMs: 20 });
    guard.registerCleanup(() => new Promise<void>(() => {}));
    guard.registerCleanup(() => {
      throw new Error('cleanup failed');
    });
    guard.accept(accountA);

    guard.accept(accountB);

    await sleep(5);
    expect(reloadPage).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(reloadPage).toHaveBeenCalledOnce());
  });

  it('does not reload for this tab’s own sign-in or sign-out, and the intent covers one change', async () => {
    const guard = guardWith();
    guard.accept(accountA);
    const generation = guard.capture();

    guard.expectLocalChange();
    expect(guard.accept(null)).toBe('publish');
    expect(guard.isCurrent(generation)).toBe(false);
    expect(guard.accept(accountB)).toBe('publish');

    expect(guard.accept(null)).toBe('retire');
    await vi.waitFor(() => expect(reloadPage).toHaveBeenCalledOnce());
  });

  it('treats a change after the local intent window as coming from elsewhere', () => {
    const guard = guardWith();
    guard.accept(accountA);
    guard.expectLocalChange();
    clock += 20_001;

    expect(guard.accept(accountB)).toBe('retire');
  });

  it('retires on a change from elsewhere once a failed local flow cancels its claim', () => {
    const guard = guardWith();
    guard.accept(accountA);
    const failedSignIn = guard.expectLocalChange();

    failedSignIn.cancel();

    expect(guard.accept(accountB)).toBe('retire');
  });

  it('extends an open claim for the refresh read, but never reopens one a change used', () => {
    const guard = guardWith();
    guard.accept(accountA);
    const signOut = guard.expectLocalChange();
    clock += 15_000;
    signOut.extend();
    clock += 15_000;

    expect(guard.accept(null)).toBe('publish');
    signOut.extend();
    expect(guard.accept(accountB)).toBe('publish');
    expect(guard.accept(null)).toBe('retire');
  });

  it('lets an earlier claim cancel nothing once a newer flow has claimed', () => {
    const guard = guardWith();
    guard.accept(accountA);
    const earlier = guard.expectLocalChange();
    guard.expectLocalChange();

    earlier.cancel();

    expect(guard.accept(null)).toBe('publish');
  });

  it('stops running an unregistered cleanup', async () => {
    const guard = guardWith();
    const cleanup = vi.fn();
    const unregister = guard.registerCleanup(cleanup);
    unregister();
    guard.accept(accountA);

    guard.accept(accountB);

    await vi.waitFor(() => expect(reloadPage).toHaveBeenCalledOnce());
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('tells subscribers about bumps and resolves the first known viewer', async () => {
    const guard = guardWith();
    const listener = vi.fn();
    guard.subscribe(listener);
    const firstViewer = guard.whenViewerKnown(1000);
    const timedOut = guardWith().whenViewerKnown(10);

    guard.accept(null);
    guard.accept(accountA);

    await expect(firstViewer).resolves.toBe('anonymous');
    await expect(timedOut).resolves.toBeUndefined();
    await expect(guard.whenViewerKnown(10)).resolves.toBe('user-a:login-a');
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('identity helpers', () => {
  it('names a login without an authSessionId with the shared placeholder', () => {
    const pending = sessionViewerOf({ user: { id: 'user-a' }, expires: '2099-01-01T00:00:00.000Z' });

    expect(sessionViewerKey(pending)).toBe('user-a:pending-login-identity');
    expect(sessionViewerKey(sessionViewerOf(null))).toBe('anonymous');
  });

  it('retries a superseded query once, and any other failure three times', () => {
    const superseded = new SessionSupersededError();
    const failure = new Error('network');

    expect([0, 1].map((failureCount) => shouldRetryQuery(failureCount, superseded))).toEqual([true, false]);
    expect([0, 2, 3].map((failureCount) => shouldRetryQuery(failureCount, failure))).toEqual([true, true, false]);
  });
});
