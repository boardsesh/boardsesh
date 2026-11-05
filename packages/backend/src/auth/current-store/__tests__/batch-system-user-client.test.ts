import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  AUTH_BACKEND_UNAVAILABLE,
  AUTH_COMMAND_RESPONSE_BYTES,
  BATCH_SYSTEM_USER_COMMAND_PATH,
  batchSystemUserCommandSchema,
  currentStoreBatchSystemUsersMode,
  type BatchSystemUserCommand,
  type BatchSystemUserRejectionCode,
} from '@boardsesh/auth-protocol';
import { AuthBackendUnavailableError } from '@boardsesh/auth-protocol/transport';
import { createBatchSystemUserClient } from '../batch-system-user-client';

const machineSecret = 'owned-batch-system-user-machine-secret-at-least-32-bytes';
const privateFailure = 'owned-private-provider-error-must-not-escape';
const usedOrigins = new Set<string>();
const cleanups: Array<() => Promise<void>> = [];

type RecordedRequest = {
  method: string | undefined;
  path: string | undefined;
  headers: IncomingMessage['headers'];
  command: BatchSystemUserCommand;
};
type Handler = (request: IncomingMessage, response: ServerResponse, command: BatchSystemUserCommand) => void;

function command(): BatchSystemUserCommand {
  return {
    protocolVersion: 1,
    operation: 'ensure',
    requestId: randomUUID(),
    issuedAt: Date.now(),
    payload: { runId: randomUUID(), attemptToken: randomUUID() },
  };
}

function environment(origin: string, overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: 'test',
    CURRENT_STORE_BATCH_SYSTEM_USERS_MODE: 'backend-staging',
    CURRENT_STORE_BATCH_SYSTEM_USERS_ORIGIN: origin,
    CURRENT_STORE_BATCH_SYSTEM_USERS_RPC_SECRET: machineSecret,
    CURRENT_STORE_AUTH_RPC_SECRET: 'owned-unrelated-human-auth-rpc-secret-at-least-32-bytes',
    NEXTAUTH_SECRET: 'owned-unrelated-nextauth-secret-at-least-32-bytes',
    CRON_SECRET: 'owned-unrelated-cron-secret-at-least-32-bytes',
    HTTP_COOKIE: 'owned-browser-cookie-must-not-be-forwarded',
    ...overrides,
  };
}

function ensured(request: BatchSystemUserCommand) {
  return { protocolVersion: 1, operation: 'ensure', requestId: request.requestId, outcome: 'ensured' };
}

function jsonReply(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function deferred<Result>() {
  let resolve = (_result: Result): void => {
    throw new Error('Owned HTTP fixture was not initialized');
  };
  const promise = new Promise<Result>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function bounded<Result>(pending: Promise<Result>, milliseconds = 2_000): Promise<Result> {
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

/** Fresh real listeners, never an origin whose pooled connections a previous case destroyed. */
async function listener(handler: Handler) {
  for (let allocation = 0; allocation < 8; allocation += 1) {
    const captured: RecordedRequest[] = [];
    const sockets = new Set<Socket>();
    const handlerFailures: unknown[] = [];
    const active = new Set<Promise<void>>();
    const server = createServer((request, response) => {
      response.setHeader('Connection', 'close');
      const pending = (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const submitted = batchSystemUserCommandSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        captured.push({ method: request.method, path: request.url, headers: request.headers, command: submitted });
        handler(request, response, submitted);
      })().catch((failure: unknown) => {
        handlerFailures.push(failure);
        response.destroy();
      });
      active.add(pending);
      void pending.finally(() => active.delete(pending));
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.once('close', () => sockets.delete(socket));
    });
    await bounded(
      new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      }),
    );
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Owned HTTP listener has no port');
    const origin = `http://127.0.0.1:${address.port}`;
    const close = async () => {
      const stopped = new Promise<void>((resolve, reject) =>
        server.close((failure) => (failure ? reject(failure) : resolve())),
      );
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await bounded(stopped);
      await bounded(Promise.all(active));
      expect(handlerFailures).toEqual([]);
    };
    if (usedOrigins.has(origin)) {
      await close();
      continue;
    }
    usedOrigins.add(origin);
    cleanups.push(close);
    return { origin, captured, environment: environment(origin) };
  }
  throw new Error('Could not allocate a fresh owned HTTP origin');
}

function expectUnavailable(failure: unknown, origin?: string): void {
  expect(failure).toBeInstanceOf(AuthBackendUnavailableError);
  if (!(failure instanceof Error)) throw new Error('Expected fixed unavailable error');
  expect(failure.message).toBe(AUTH_BACKEND_UNAVAILABLE);
  expect(Object.hasOwn(failure, 'cause')).toBe(false);
  const exposed = `${String(failure)} ${failure.stack ?? ''} ${JSON.stringify(failure)}`;
  for (const secret of [machineSecret, privateFailure, origin].filter((entry): entry is string => Boolean(entry))) {
    expect(exposed.includes(secret)).toBe(false);
  }
}

async function unavailable(pending: Promise<unknown>, origin?: string): Promise<void> {
  const failure = await bounded(
    pending.then(
      () => undefined,
      (rejected: unknown) => rejected,
    ),
  );
  expectUnavailable(failure, origin);
}

afterEach(async () => {
  const pending = cleanups.splice(0).map((cleanup) => cleanup());
  await Promise.all(pending);
});

describe('dedicated batch system-user client over real owned HTTP', () => {
  it('sends one authenticated fixed command with no identity or browser fields', async () => {
    const fixture = await listener((_request, response, submitted) => jsonReply(response, ensured(submitted)));
    const submitted = command();
    await createBatchSystemUserClient({ environment: fixture.environment }).ensure(submitted);
    expect(fixture.captured).toHaveLength(1);
    expect(fixture.captured[0]).toMatchObject({
      method: 'POST',
      path: BATCH_SYSTEM_USER_COMMAND_PATH,
      headers: { authorization: `Bearer ${machineSecret}`, 'content-type': 'application/json' },
      command: submitted,
    });
    expect(fixture.captured[0].headers.cookie).toBeUndefined();
    expect(Object.keys(fixture.captured[0].command.payload).sort()).toEqual(['attemptToken', 'runId']);
  });

  it('captures environment and DTO before later caller mutations', async () => {
    const arrived = deferred<{ response: ServerResponse; submitted: BatchSystemUserCommand }>();
    const fixture = await listener((_request, response, submitted) => arrived.resolve({ response, submitted }));
    const selectedEnvironment = { ...fixture.environment };
    const client = createBatchSystemUserClient({ environment: selectedEnvironment });
    selectedEnvironment.CURRENT_STORE_BATCH_SYSTEM_USERS_ORIGIN = 'http://127.0.0.1:1';
    selectedEnvironment.CURRENT_STORE_BATCH_SYSTEM_USERS_RPC_SECRET = 'changed-machine-secret';
    selectedEnvironment.CURRENT_STORE_BATCH_SYSTEM_USERS_MODE = 'legacy';
    const submitted = command(),
      original = structuredClone(submitted);
    const pending = client.ensure(submitted).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    const received = await bounded(arrived.promise);
    submitted.requestId = randomUUID();
    submitted.payload.runId = randomUUID();
    submitted.payload.attemptToken = randomUUID();
    jsonReply(received.response, ensured(received.submitted));
    expect(await pending).toBeUndefined();
    expect(fixture.captured).toHaveLength(1);
    expect(fixture.captured[0].command).toEqual(original);
    expect(fixture.captured[0].headers.authorization).toBe(`Bearer ${machineSecret}`);
  });

  it.each([undefined, '', 'legacy'])('requires no private client configuration in legacy mode %s', (mode) => {
    const selectedEnvironment = { CURRENT_STORE_BATCH_SYSTEM_USERS_MODE: mode };
    expect(currentStoreBatchSystemUsersMode(selectedEnvironment)).toBe('legacy');
    expect(() => createBatchSystemUserClient({ environment: selectedEnvironment })).toThrow(
      AuthBackendUnavailableError,
    );
  });

  it.each(['CURRENT_STORE_AUTH_RPC_SECRET', 'NEXTAUTH_SECRET', 'CRON_SECRET'])(
    'rejects a machine secret reused from %s before HTTP',
    (secretName) => {
      const selectedEnvironment = environment('http://127.0.0.1:1', { [secretName]: machineSecret });
      expect(() => createBatchSystemUserClient({ environment: selectedEnvironment })).toThrow(
        AuthBackendUnavailableError,
      );
    },
  );

  it.each([undefined, 'short', ` ${machineSecret}`])('rejects absent, short or padded machine secrets', (secret) => {
    expect(() =>
      createBatchSystemUserClient({
        environment: environment('http://127.0.0.1:1', { CURRENT_STORE_BATCH_SYSTEM_USERS_RPC_SECRET: secret }),
      }),
    ).toThrow(AuthBackendUnavailableError);
  });

  it.each([
    { NODE_ENV: 'production', CURRENT_STORE_BATCH_SYSTEM_USERS_ORIGIN: 'http://127.0.0.1:1' },
    { CURRENT_STORE_BATCH_SYSTEM_USERS_ORIGIN: 'https://auth.example.test/?private=1' },
  ])('rejects unsafe configured origins before HTTP', (overrides) => {
    expect(() => createBatchSystemUserClient({ environment: environment('http://127.0.0.1:1', overrides) })).toThrow(
      AuthBackendUnavailableError,
    );
  });

  it('accepts production HTTPS configuration without contacting it (injected no-I/O sentinel)', () => {
    const noIoFetch = vi.fn<typeof fetch>(() => Promise.reject(new Error('Unexpected non-owned request')));
    expect(() =>
      createBatchSystemUserClient({
        environment: environment('https://auth.example.test', { NODE_ENV: 'production' }),
        fetch: noIoFetch,
      }),
    ).not.toThrow();
    expect(noIoFetch).not.toHaveBeenCalled();
  });

  it.each(['userId', 'identityKind'])(
    'rejects an invented %s command field without sending a request',
    async (field) => {
      const fixture = await listener((_request, response, submitted) => jsonReply(response, ensured(submitted)));
      const submitted = { ...command(), payload: { ...command().payload, [field]: 'invented-owner' } };
      await unavailable(
        createBatchSystemUserClient({ environment: fixture.environment }).ensure(
          submitted as unknown as BatchSystemUserCommand,
        ),
        fixture.origin,
      );
      expect(fixture.captured).toHaveLength(0);
    },
  );

  it.each(['version', 'operation', 'correlation', 'unknown-field', 'status'] as const)(
    'rejects %s mismatch without exposing the private reply or retrying',
    async (variant) => {
      const fixture = await listener((_request, response, submitted) => {
        const body = ensured(submitted);
        if (variant === 'version') jsonReply(response, { ...body, protocolVersion: 2 });
        else if (variant === 'operation') jsonReply(response, { ...body, operation: 'register' });
        else if (variant === 'correlation') jsonReply(response, { ...body, requestId: randomUUID() });
        else if (variant === 'unknown-field') jsonReply(response, { ...body, privateFailure });
        else jsonReply(response, body, 201);
      });
      await unavailable(
        createBatchSystemUserClient({ environment: fixture.environment }).ensure(command()),
        fixture.origin,
      );
      expect(fixture.captured).toHaveLength(1);
    },
  );

  it.each<{ code: BatchSystemUserRejectionCode; status: number }>([
    { code: 'invalid_request', status: 400 },
    { code: 'unauthorized', status: 401 },
    { code: 'request_expired', status: 400 },
    { code: 'attempt_lost', status: 409 },
    { code: 'replayed_request', status: 409 },
    { code: 'unavailable', status: 503 },
  ])('treats authoritative $code/$status as unavailable without a retry', async ({ code, status }) => {
    const fixture = await listener((_request, response, submitted) =>
      jsonReply(
        response,
        {
          protocolVersion: 1,
          operation: 'ensure',
          requestId: submitted.requestId,
          outcome: 'rejected',
          code,
        },
        status,
      ),
    );
    await unavailable(
      createBatchSystemUserClient({ environment: fixture.environment }).ensure(command()),
      fixture.origin,
    );
    expect(fixture.captured).toHaveLength(1);
  });

  it('refuses a redirect without following its second path', async () => {
    const fixture = await listener((_request, response) => {
      response.writeHead(307, { Location: '/unowned-second-command' });
      response.end();
    });
    await unavailable(
      createBatchSystemUserClient({ environment: fixture.environment }).ensure(command()),
      fixture.origin,
    );
    expect(fixture.captured).toHaveLength(1);
    expect(fixture.captured[0].path).toBe(BATCH_SYSTEM_USER_COMMAND_PATH);
  });

  it.each(['oversized-length', 'non-json-type'] as const)('rejects %s response headers', async (variant) => {
    const fixture = await listener((_request, response, submitted) => {
      if (variant === 'oversized-length') {
        response.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': AUTH_COMMAND_RESPONSE_BYTES + 1,
        });
        response.flushHeaders();
      } else {
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end(JSON.stringify(ensured(submitted)));
      }
    });
    await unavailable(
      createBatchSystemUserClient({ environment: fixture.environment }).ensure(command()),
      fixture.origin,
    );
    expect(fixture.captured).toHaveLength(1);
  });

  it('bounds an actually streamed chunked response without Content-Length', async () => {
    const fixture = await listener((_request, response, submitted) => {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' });
      response.write(JSON.stringify(ensured(submitted)));
      response.write(' '.repeat(AUTH_COMMAND_RESPONSE_BYTES));
      response.end(' '.repeat(1_024));
    });
    await unavailable(
      createBatchSystemUserClient({ environment: fixture.environment }).ensure(command()),
      fixture.origin,
    );
    expect(fixture.captured).toHaveLength(1);
  });

  it('rejects malformed physical UTF-8 without leaking adjacent private response text', async () => {
    const fixture = await listener((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(Buffer.concat([Buffer.from(`{"private":"${privateFailure}"`), Buffer.from([0xc3, 0x28])]));
    });
    await unavailable(
      createBatchSystemUserClient({ environment: fixture.environment }).ensure(command()),
      fixture.origin,
    );
    expect(fixture.captured).toHaveLength(1);
  });

  it('enforces the real pre-header deadline without resending an observed command', async () => {
    const arrived = deferred<void>();
    const fixture = await listener(() => arrived.resolve());
    const client = createBatchSystemUserClient({ environment: fixture.environment, timeoutMs: 250 });
    const pending = unavailable(client.ensure(command()), fixture.origin);
    await bounded(arrived.promise);
    await pending;
    expect(fixture.captured).toHaveLength(1);
  });

  it('keeps the deadline through a real stalled body after successful headers', async () => {
    const arrived = deferred<void>();
    const fixture = await listener((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.flushHeaders();
      response.write('{');
      arrived.resolve();
    });
    const pending = unavailable(
      createBatchSystemUserClient({ environment: fixture.environment, timeoutMs: 250 }).ensure(command()),
      fixture.origin,
    );
    await bounded(arrived.promise);
    await pending;
    expect(fixture.captured).toHaveLength(1);
  });

  it('returns one safe error after received-request socket loss, with no cause or retry', async () => {
    const fixture = await listener((request) => request.socket.destroy(new Error(privateFailure)));
    await unavailable(
      createBatchSystemUserClient({ environment: fixture.environment }).ensure(command()),
      fixture.origin,
    );
    expect(fixture.captured).toHaveLength(1);
  });
});
