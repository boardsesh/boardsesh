// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_BACKEND_UNAVAILABLE,
  AUTH_COMMAND_REQUEST_BYTES,
  AUTH_COMMAND_RESPONSE_BYTES,
  WEB_OAUTH_COMMAND_PATHS,
  webOAuthCommandSchema,
  type WebOAuthCommand,
  type WebOAuthIntentReply,
  type WebOAuthResolveCommand,
  type WebOAuthResolveReply,
} from '@boardsesh/auth-protocol';

vi.mock('server-only', () => ({}));
import { createAuthCommandTransport } from '../auth-command-transport.server';
import { createWebOAuthCommandClient, webOAuthMode } from '../web-oauth-command-client.server';

type Handler = (request: IncomingMessage, response: ServerResponse, command: WebOAuthCommand) => void | Promise<void>;
type RecordedRequest = {
  method: string | undefined;
  path: string | undefined;
  headers: IncomingMessage['headers'];
  command: WebOAuthCommand;
};

const rpcSecret = 'owned-web-oauth-only-rpc-secret-at-least-32-bytes';
const privateActor = 'owned-synthetic-legacy-actor-cookie';
const privateCause = 'owned-synthetic-nested-provider-secret';
const flow = 'a'.repeat(64);
const originalSubject = ' Provider-SUBJECT-with-exact-case ';
const captured: RecordedRequest[] = [];
const sockets = new Set<Socket>();
const activeHandlers = new Set<Promise<void>>();
const timers = new Set<ReturnType<typeof setTimeout>>();
let origin: string;
let handle: Handler;
let accepting = true;
let fixtureFailures = 0;

function deferred<Result>() {
  let resolve = (_result: Result): void => {
    throw new Error('Owned deferred was not initialized');
  };
  const promise = new Promise<Result>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function bounded<Result>(pending: Promise<Result>, milliseconds = 2000): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Owned HTTP fixture deadline')), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function later(callback: () => void, milliseconds: number) {
  const timer = setTimeout(() => {
    timers.delete(timer);
    callback();
  }, milliseconds);
  timers.add(timer);
}

function environment(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: 'test',
    CURRENT_STORE_WEB_AUTH_MODE: 'legacy',
    CURRENT_STORE_WEB_OAUTH_MODE: 'backend-staging',
    CURRENT_STORE_AUTH_BACKEND_ORIGIN: origin,
    CURRENT_STORE_AUTH_RPC_SECRET: rpcSecret,
    NEXTAUTH_SECRET: 'owned-unrelated-nextauth-secret-at-least-32-bytes',
    CRON_SECRET: 'owned-unrelated-cron-secret-at-least-32-bytes',
    HTTP_COOKIE: 'owned-incoming-cookie-must-not-be-forwarded',
    ...overrides,
  };
}

const nativeFetch = globalThis.fetch;
let blockedDestinations = 0;
const ownedFetch: typeof fetch = async (input, settings) => {
  const address = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (address.origin !== origin || address.username || address.password || settings?.redirect !== 'error') {
    blockedDestinations += 1;
    throw new Error('Unowned HTTP destination refused');
  }
  return nativeFetch(input, settings);
};
function ownedClient(options: Parameters<typeof createWebOAuthCommandClient>[0] = {}) {
  return createWebOAuthCommandClient({ fetch: ownedFetch, environment: environment(), ...options });
}

function intentPayload() {
  return { provider: 'google' as const, flow, actorCookie: privateActor };
}

function resolvePayload(): WebOAuthResolveCommand['payload'] {
  return {
    ...intentPayload(),
    subject: originalSubject,
    email: ' Legacy.Mixed+tag@Example.test ',
    name: 'Owned climber',
    image: null,
  };
}

function intentReply(command: WebOAuthCommand): WebOAuthIntentReply {
  if (command.operation !== 'intent') throw new Error('Owned fixture expected an intent');
  return {
    webOAuthProtocolVersion: 1,
    operation: 'intent',
    requestId: command.requestId,
    outcome: 'recorded',
    flow: command.payload.flow,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function resolveReply(command: WebOAuthCommand): Extract<WebOAuthResolveReply, { outcome: 'resolved' }> {
  if (command.operation !== 'resolve') throw new Error('Owned fixture expected a resolve');
  return {
    webOAuthProtocolVersion: 1,
    operation: 'resolve',
    requestId: command.requestId,
    outcome: 'resolved',
    user: {
      id: 'owned-stable-user',
      email: ' Existing.Mixed+tag@Example.test ',
      name: null,
      image: null,
      emailVerified: '2020-01-02T03:04:05.000Z',
      createdAt: '2019-01-02T03:04:05.000Z',
    },
    createdUser: false,
    account: { provider: command.payload.provider, providerAccountId: command.payload.subject },
  };
}

function jsonReply(response: ServerResponse, body: unknown, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function expectUnavailable(failure: unknown) {
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) throw new Error('Expected a fixed unavailable error');
  expect(failure.message).toBe(AUTH_BACKEND_UNAVAILABLE);
  expect(failure.name).toBe('AuthBackendUnavailableError');
  expect(Object.hasOwn(failure, 'cause')).toBe(false);
  const exposed = `${String(failure)} ${failure.stack ?? ''} ${JSON.stringify(failure)}`;
  expect([privateActor, privateCause, rpcSecret, origin].some((secret) => exposed.includes(secret))).toBe(false);
}

let server: ReturnType<typeof createServer> | undefined;
let closing: Promise<void> | undefined;
let cleanupFailed = false;
const usedOrigins = new Set<string>();
function createOwnedServer(isAdmitted: () => boolean) {
  const listener = createServer((request, response) => {
    if (!isAdmitted() || !accepting) {
      response.destroy();
      return;
    }
    // Each case deliberately destroys its sockets. Tell the real HTTP client
    // not to pool a completed connection across that fixture boundary.
    response.setHeader('Connection', 'close');
    const handler = handle;
    const pending = (async () => {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk);
        length += buffer.length;
        if (length > AUTH_COMMAND_REQUEST_BYTES) throw new Error('Owned request body cap');
        chunks.push(buffer);
      }
      const command = webOAuthCommandSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      captured.push({ method: request.method, path: request.url, headers: request.headers, command });
      await handler(request, response, command);
    })().catch(() => {
      fixtureFailures += 1;
      if (!response.headersSent) response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end('{"error":"owned_fixture_failed"}');
    });
    activeHandlers.add(pending);
    void pending.finally(() => activeHandlers.delete(pending));
  });
  listener.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  return listener;
}
async function allocateOwnedServer(firstPort = 0) {
  const reservations: ReturnType<typeof createServer>[] = [];
  let selected: ReturnType<typeof createServer> | undefined;
  try {
    // Keep retired ports bound until a fresh origin is selected: listen(0) can
    // otherwise return the same just-closed port on every attempt.
    for (let attempt = 0; attempt <= usedOrigins.size; attempt += 1) {
      let admitted = false;
      const candidate = createOwnedServer(() => admitted);
      reservations.push(candidate);
      await bounded(
        new Promise<void>((resolve, reject) => {
          candidate.once('error', reject);
          candidate.listen(attempt === 0 ? firstPort : 0, '127.0.0.1', resolve);
        }),
      );
      const address = candidate.address();
      if (!address || typeof address === 'string') throw new Error('Missing owned HTTP address');
      const candidateOrigin = `http://127.0.0.1:${address.port}`;
      if (usedOrigins.has(candidateOrigin)) continue;
      admitted = true;
      selected = candidate;
      return { server: candidate, origin: candidateOrigin };
    }
    throw new Error('Owned HTTP fixture exhausted fresh origins');
  } finally {
    await bounded(
      Promise.all(
        reservations
          .filter((candidate) => candidate !== selected)
          .map(
            (candidate) =>
              new Promise<void>((resolve, reject) => {
                candidate.closeAllConnections();
                candidate.close((error) => {
                  if (error && candidate.listening) reject(error);
                  else resolve();
                });
              }),
          ),
      ),
      3000,
    );
  }
}

async function closeOwnedServer() {
  accepting = false;
  const owned = server;
  if (owned && !closing) {
    closing = new Promise<void>((resolve, reject) => {
      owned.close((error) => (error ? reject(new Error('Owned HTTP listener cleanup failed')) : resolve()));
    });
  }
  owned?.closeAllConnections();
  for (const socket of sockets) socket.destroy();
  try {
    await bounded(Promise.all([closing ?? Promise.resolve(), Promise.allSettled(activeHandlers)]), 3000);
  } catch (error) {
    cleanupFailed = true;
    throw error;
  }
}

beforeEach(async () => {
  if (cleanupFailed || activeHandlers.size) throw new Error('Previous owned HTTP handlers did not settle');
  accepting = true;
  captured.length = 0;
  fixtureFailures = 0;
  blockedDestinations = 0;
  handle = (_request, response, command) => {
    jsonReply(response, command.operation === 'intent' ? intentReply(command) : resolveReply(command));
  };
  closing = undefined;
  ({ server, origin } = await allocateOwnedServer());
  if (usedOrigins.has(origin)) throw new Error('Owned HTTP fixture reused a retired origin');
  usedOrigins.add(origin);
});

afterEach(async () => {
  accepting = false;
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  await closeOwnedServer();
  expect(fixtureFailures).toBe(0);
  expect(blockedDestinations).toBe(0);
});

afterAll(async () => {
  accepting = false;
  for (const timer of timers) clearTimeout(timer);
  await closeOwnedServer();
});

describe('private web OAuth commands over actual owned HTTP', () => {
  it('refuses traffic before local admission', async () => {
    const denied = createOwnedServer(() => false);
    try {
      await new Promise<void>((resolve) => denied.listen(0, '127.0.0.1', resolve));
      const address = denied.address();
      if (!address || typeof address === 'string') throw new Error('Missing denied address');
      await expect(nativeFetch(`http://127.0.0.1:${address.port}`, { method: 'POST', body: '{}' })).rejects.toThrow();
      expect(captured).toHaveLength(0);
    } finally {
      denied.closeAllConnections();
      await new Promise<void>((resolve) => denied.close(() => resolve()));
      fixtureFailures = 0;
    }
  });

  it('closes retired reservations when later allocation fails', async () => {
    const retiredPort = Number(new URL(origin).port);
    await closeOwnedServer();
    closing = undefined;
    accepting = true;
    const prototype = Object.getPrototypeOf(server) as { listen: NonNullable<typeof server>['listen'] };
    server = undefined;
    const originalListen = prototype.listen;
    let calls = 0;
    const observed: ReturnType<typeof createServer>[] = [];
    const spy = vi.spyOn(prototype, 'listen').mockImplementation(function (
      this: ReturnType<typeof createServer>,
      ...args: unknown[]
    ) {
      calls += 1;
      observed.push(this);
      if (calls === 2) throw new Error('injected-owned-allocation-failure');
      return Reflect.apply(originalListen, this, args) as ReturnType<typeof createServer>;
    });
    try {
      await expect(allocateOwnedServer(retiredPort)).rejects.toThrow('injected-owned-allocation-failure');
      expect(observed.length).toBe(2);
      expect(observed.every((listener) => !listener.listening)).toBe(true);
    } finally {
      spy.mockRestore();
      await Promise.all(
        observed.map(
          (listener) =>
            new Promise<void>((resolve) => {
              listener.closeAllConnections();
              listener.close(() => resolve());
            }),
        ),
      );
    }
  });

  it('reserves a forcibly reused retired port before serving the next fixture', async () => {
    const retiredOrigin = origin;
    const retiredPort = Number(new URL(retiredOrigin).port);
    await closeOwnedServer();
    closing = undefined;
    accepting = true;
    ({ server, origin } = await allocateOwnedServer(retiredPort));
    expect(origin).not.toBe(retiredOrigin);
    if (usedOrigins.has(origin)) throw new Error('Owned HTTP fixture reused a retired origin');
    usedOrigins.add(origin);
    await expect(ownedClient().intent(intentPayload())).resolves.toMatchObject({ outcome: 'recorded' });
    expect(captured).toHaveLength(1);
  });

  it('uses the fixed intent and resolve paths, header-only RPC credential and fresh correlated request IDs', async () => {
    const client = ownedClient({ environment: environment() });
    await expect(client.intent(intentPayload())).resolves.toMatchObject({ outcome: 'recorded', flow });
    await expect(client.resolve(resolvePayload())).resolves.toMatchObject({
      outcome: 'resolved',
      createdUser: false,
      account: { provider: 'google', providerAccountId: originalSubject },
      user: { emailVerified: '2020-01-02T03:04:05.000Z' },
    });
    expect(captured).toHaveLength(2);
    expect(captured.map((request) => request.path)).toEqual([
      WEB_OAUTH_COMMAND_PATHS.intent,
      WEB_OAUTH_COMMAND_PATHS.resolve,
    ]);
    expect(captured.every((request) => request.method === 'POST')).toBe(true);
    expect(captured.every((request) => request.headers.authorization === `Bearer ${rpcSecret}`)).toBe(true);
    expect(captured.every((request) => request.headers.cookie === undefined)).toBe(true);
    expect(captured.every((request) => !JSON.stringify(request.command).includes(rpcSecret))).toBe(true);
    expect(captured[0].command.requestId !== captured[1].command.requestId).toBe(true);
    expect(captured[1].command).toMatchObject({
      webOAuthProtocolVersion: 1,
      operation: 'resolve',
      payload: resolvePayload(),
    });
  });

  it('keeps provider subjects in the JSON body instead of using them to build a destination', async () => {
    const payload = { ...resolvePayload(), subject: '../password?redirect=https://unowned.invalid/' };
    await expect(ownedClient({ environment: environment() }).resolve(payload)).resolves.toMatchObject({
      account: { providerAccountId: payload.subject },
    });
    expect(captured[0].path).toBe(WEB_OAUTH_COMMAND_PATHS.resolve);
    expect(captured[0].command.payload).toMatchObject({ subject: payload.subject });
  });

  it('keeps OAuth mode independent from password mode, including an invalid password selector', async () => {
    expect(webOAuthMode({ CURRENT_STORE_WEB_AUTH_MODE: 'backend-staging' })).toBe('legacy');
    expect(() =>
      ownedClient({
        environment: environment({
          CURRENT_STORE_WEB_OAUTH_MODE: 'legacy',
          CURRENT_STORE_WEB_AUTH_MODE: 'backend-staging',
        }),
      }),
    ).toThrow(AUTH_BACKEND_UNAVAILABLE);
    expect(captured).toHaveLength(0);
    const client = ownedClient({ environment: environment({ CURRENT_STORE_WEB_AUTH_MODE: 'unknown' }) });
    await expect(client.intent(intentPayload())).resolves.toMatchObject({ outcome: 'recorded' });
    expect(captured).toHaveLength(1);
  });

  it.each([undefined, '', 'legacy', 'unknown'])('does not enable OAuth for selector %s', (selector) => {
    expect(() => ownedClient({ environment: environment({ CURRENT_STORE_WEB_OAUTH_MODE: selector }) })).toThrow(
      AUTH_BACKEND_UNAVAILABLE,
    );
    expect(captured).toHaveLength(0);
  });

  it('rejects missing server credential and production HTTP before network activity', () => {
    for (const unsafe of [
      { CURRENT_STORE_AUTH_RPC_SECRET: '' },
      { NEXTAUTH_SECRET: rpcSecret },
      { NODE_ENV: 'production' },
    ]) {
      expect(() => ownedClient({ environment: environment(unsafe) })).toThrow(AUTH_BACKEND_UNAVAILABLE);
    }
    expect(captured).toHaveLength(0);
  });

  it.each([
    ['wrong version', (reply: ReturnType<typeof resolveReply>) => ({ ...reply, webOAuthProtocolVersion: 2 })],
    ['wrong request', (reply: ReturnType<typeof resolveReply>) => ({ ...reply, requestId: randomUUID() })],
    [
      'wrong operation',
      (reply: ReturnType<typeof resolveReply>) => ({
        webOAuthProtocolVersion: 1,
        operation: 'intent',
        requestId: reply.requestId,
        outcome: 'recorded',
        flow,
        expiresAt: new Date().toISOString(),
      }),
    ],
    [
      'wrong provider',
      (reply: ReturnType<typeof resolveReply>) => ({ ...reply, account: { ...reply.account, provider: 'apple' } }),
    ],
    [
      'wrong subject',
      (reply: ReturnType<typeof resolveReply>) => ({
        ...reply,
        account: { ...reply.account, providerAccountId: 'other-provider-subject' },
      }),
    ],
    ['extra credential', (reply: ReturnType<typeof resolveReply>) => ({ ...reply, sourceProof: privateCause })],
    [
      'nested credential',
      (reply: ReturnType<typeof resolveReply>) => ({
        ...reply,
        account: { ...reply.account, access_token: privateCause },
      }),
    ],
  ] as const)('rejects a %s reply without exposing provider data or nested causes', async (_description, corrupt) => {
    handle = (_request, response, command) => jsonReply(response, corrupt(resolveReply(command)));
    const failure = await ownedClient({ environment: environment() })
      .resolve(resolvePayload())
      .catch((error: unknown) => error);
    expectUnavailable(failure);
    expect(captured).toHaveLength(1);
  });

  it('rejects an otherwise valid intent reply for another flow', async () => {
    handle = (_request, response, command) => jsonReply(response, { ...intentReply(command), flow: 'b'.repeat(64) });
    expectUnavailable(
      await ownedClient({ environment: environment() })
        .intent(intentPayload())
        .catch((error: unknown) => error),
    );
    expect(captured).toHaveLength(1);
  });

  it('returns authoritative generic 409 denials while treating transport 503 as unavailable', async () => {
    handle = (_request, response, command) =>
      jsonReply(
        response,
        {
          webOAuthProtocolVersion: 1,
          operation: command.operation,
          requestId: command.requestId,
          outcome: 'denied',
          code: 'identity_unavailable',
        },
        409,
      );
    await expect(ownedClient({ environment: environment() }).resolve(resolvePayload())).resolves.toMatchObject({
      outcome: 'denied',
      code: 'identity_unavailable',
    });
    handle = (_request, response) => jsonReply(response, { error: 'unavailable' }, 503);
    expectUnavailable(
      await ownedClient({ environment: environment() })
        .resolve(resolvePayload())
        .catch((error: unknown) => error),
    );
    expect(captured).toHaveLength(2);
  });

  it.each([201, 409, 503])('rejects a resolved body returned with status %s', async (status) => {
    handle = (_request, response, command) => jsonReply(response, resolveReply(command), status);
    expectUnavailable(
      await ownedClient({ environment: environment() })
        .resolve(resolvePayload())
        .catch((error: unknown) => error),
    );
    expect(captured).toHaveLength(1);
  });

  it.each(['malformed JSON', 'wrong content type', 'invalid UTF8', 'oversized Content-Length'])(
    'rejects %s on the real response stream',
    async (fault) => {
      handle = (_request, response) => {
        response.writeHead(200, {
          'Content-Type': fault === 'wrong content type' ? 'text/plain' : 'application/json',
          ...(fault === 'oversized Content-Length'
            ? { 'Content-Length': String(AUTH_COMMAND_RESPONSE_BYTES + 1) }
            : {}),
        });
        response.end(fault === 'invalid UTF8' ? Buffer.from([0xc3, 0x28]) : privateCause);
      };
      expectUnavailable(
        await ownedClient({ environment: environment() })
          .resolve(resolvePayload())
          .catch((error: unknown) => error),
      );
      expect(captured).toHaveLength(1);
    },
  );

  it('does not follow a redirect or forward its RPC credential to a second path', async () => {
    handle = (_request, response) => {
      response.writeHead(307, { Location: `${origin}/unowned-second-destination` });
      response.end();
    };
    expectUnavailable(
      await ownedClient({ environment: environment() })
        .resolve(resolvePayload())
        .catch((error: unknown) => error),
    );
    expect(captured).toHaveLength(1);
  });

  it('preserves valid UTF8 across response chunks split inside a multibyte character', async () => {
    const displayName = 'Owned 岩🧗 climber';
    handle = (_request, response, command) => {
      const body = Buffer.from(
        JSON.stringify({ ...resolveReply(command), user: { ...resolveReply(command).user, name: displayName } }),
      );
      const split = body.indexOf(Buffer.from('岩')) + 1;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write(body.subarray(0, split));
      later(() => response.end(body.subarray(split)), 20);
    };
    await expect(ownedClient({ environment: environment() }).resolve(resolvePayload())).resolves.toMatchObject({
      user: { name: displayName },
    });
  });

  it('accepts an exactly bounded response and rejects multibyte overflow without Content-Length', async () => {
    handle = (_request, response, command) => {
      const json = Buffer.from(JSON.stringify(resolveReply(command)));
      const boundedBody = Buffer.concat([json, Buffer.alloc(AUTH_COMMAND_RESPONSE_BYTES - json.length, ' ')]);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write(boundedBody.subarray(0, 32768));
      response.end(boundedBody.subarray(32768));
    };
    await expect(ownedClient({ environment: environment() }).resolve(resolvePayload())).resolves.toMatchObject({
      outcome: 'resolved',
    });
    handle = (_request, response, command) => {
      const valid = resolveReply(command);
      const body = JSON.stringify({
        ...valid,
        user: { ...valid.user, name: '界'.repeat(8192), email: '界'.repeat(8192), image: '界'.repeat(8192) },
      });
      expect(body.length < AUTH_COMMAND_RESPONSE_BYTES && Buffer.byteLength(body) > AUTH_COMMAND_RESPONSE_BYTES).toBe(
        true,
      );
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write(Buffer.from(body).subarray(0, 32768));
      response.end(Buffer.from(body).subarray(32768));
    };
    expectUnavailable(
      await ownedClient({ environment: environment() })
        .resolve(resolvePayload())
        .catch((error: unknown) => error),
    );
    expect(captured).toHaveLength(2);
  });

  it('caps UTF8 request bytes even when every logical field is within its character limit', async () => {
    const payload = { ...resolvePayload(), actorCookie: 'é'.repeat(AUTH_COMMAND_REQUEST_BYTES) };
    expectUnavailable(
      await ownedClient({ environment: environment() })
        .resolve(payload)
        .catch((error: unknown) => error),
    );
    expect(captured).toHaveLength(0);
  });

  it.each(['headers', 'body'] as const)('bounds a stalled %s response and never retries', async (phase) => {
    handle = (_request, response) => {
      if (phase === 'body') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.write('{');
      }
    };
    const startedAt = Date.now();
    expectUnavailable(
      await ownedClient({ environment: environment(), timeoutMs: 150 })
        .resolve(resolvePayload())
        .catch((error: unknown) => error),
    );
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(captured).toHaveLength(1);
  });

  it('does not replay a received request when only its response body is lost after a fixture commit', async () => {
    const headersObserved = deferred<void>();
    let committedOperations = 0;
    let pendingResponse: ServerResponse | undefined;
    handle = (_request, response, command) => {
      committedOperations += 1;
      pendingResponse = response;
      const body = JSON.stringify(resolveReply(command));
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
      });
      response.flushHeaders();
      response.write(body.slice(0, 10));
    };
    const observedFetch: typeof fetch = async (input, settings) => {
      const response = await ownedFetch(input, settings);
      headersObserved.resolve();
      return response;
    };
    const pending = ownedClient({ environment: environment(), fetch: observedFetch, timeoutMs: 1000 }).resolve(
      resolvePayload(),
    );
    void pending.catch(() => {});
    try {
      await bounded(headersObserved.promise);
      expect(committedOperations).toBe(1);
      pendingResponse?.destroy();
      expectUnavailable(await pending.catch((error: unknown) => error));
      expect(captured).toHaveLength(1);
      expect(committedOperations).toBe(1);
    } finally {
      pendingResponse?.destroy();
      await bounded(Promise.allSettled([pending]));
    }
  });

  it('captures the payload before I/O so later mutations cannot retarget response correlation', async () => {
    const arrived = deferred<void>();
    const release = deferred<void>();
    handle = async (_request, response, command) => {
      arrived.resolve();
      await release.promise;
      jsonReply(response, resolveReply(command));
    };
    const payload = resolvePayload();
    const pending = ownedClient({ environment: environment(), timeoutMs: 1000 }).resolve(payload);
    void pending.catch(() => {});
    try {
      await bounded(arrived.promise);
      payload.provider = 'apple';
      payload.subject = 'changed-after-request';
      payload.actorCookie = 'changed-after-request';
      release.resolve();
      await expect(pending).resolves.toMatchObject({
        account: { provider: 'google', providerAccountId: originalSubject },
      });
      expect(captured[0].command.payload).toMatchObject({
        provider: 'google',
        subject: originalSubject,
        actorCookie: privateActor,
      });
    } finally {
      release.resolve();
      await bounded(Promise.allSettled([pending]));
    }
  });

  it('drops nested transport error causes without retaining private input or provider material', async () => {
    const nestedFetch: typeof fetch = async () => {
      throw new Error(privateActor, { cause: new Error(privateCause) });
    };
    expectUnavailable(
      await ownedClient({ environment: environment(), fetch: nestedFetch })
        .resolve(resolvePayload())
        .catch((error: unknown) => error),
    );
    expect(captured).toHaveLength(0);
  });

  it('rejects unsupported destinations and non-JSON top-level commands before sending', async () => {
    const transport = createAuthCommandTransport({
      environment: environment(),
      fetch: ownedFetch,
      paths: Object.values(WEB_OAUTH_COMMAND_PATHS),
    });
    expectUnavailable(await transport.post('/unowned-destination', {}).catch((error: unknown) => error));
    expectUnavailable(await transport.post(WEB_OAUTH_COMMAND_PATHS.intent, undefined).catch((error: unknown) => error));
    expectUnavailable(await transport.post(WEB_OAUTH_COMMAND_PATHS.intent, BigInt(1)).catch((error: unknown) => error));
    expect(captured).toHaveLength(0);
  });
});
