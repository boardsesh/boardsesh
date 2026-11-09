import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { hash } from 'bcryptjs';
import { and, eq, like } from 'drizzle-orm';
import { decodeJwt, jwtVerify, SignJWT } from 'jose';
import { WebSocket, type RawData } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { createPrototypeEnvironment } from '../environment';
import { createPrototypeNativeFacade, type PrototypeNativeTokenPair } from '../identity-native-facade';
import { PROTOTYPE_LEGACY_KEY } from '../legacy-bridge';
import {
  startPrototypeTransportFixture,
  PROTOTYPE_TRANSPORT_KEY,
  PROTOTYPE_TRANSPORT_RECEIPT_PREFIX,
  type PrototypeTransportFixture,
  type PrototypeTransportHooks,
} from '../transport-fixture';

type Environment = Awaited<ReturnType<typeof createPrototypeEnvironment>>;
type Message = Record<string, unknown>;
type SocketClient = {
  socket: WebSocket;
  next: () => Promise<Message>;
  send: (body: unknown) => void;
  closed: Promise<number>;
};

const fixtures = new Set<PrototypeTransportFixture>();
const clients = new Set<SocketClient>();
const rejectionMeasurements: number[] = [];
const password = 'synthetic-transport-password-山';
let environment: Environment;
let first: PrototypeTransportFixture;
let second: PrototypeTransportFixture;
let passwordHash: string;

function deferred<T>() {
  let resolve: (result: T) => void = () => {};
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function bounded<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), 10000);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function parsedMessage(bytes: RawData): Message {
  const buffer = Array.isArray(bytes) ? Buffer.concat(bytes) : Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const parsed: unknown = JSON.parse(buffer.toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid fixture response.');
  return parsed as Message;
}

async function socketClient(fixture: PrototypeTransportFixture): Promise<SocketClient> {
  const socket = new WebSocket(fixture.websocketUrl);
  const messages: Message[] = [];
  const waiters: { resolve: (body: Message) => void; reject: (reason: Error) => void }[] = [];
  const closed = new Promise<number>((resolve) =>
    socket.once('close', (code) => {
      resolve(code);
      for (const waiting of waiters.splice(0)) waiting.reject(new Error('Socket closed before the expected response.'));
    }),
  );
  socket.on('message', (bytes) => {
    const body = parsedMessage(bytes);
    const waiting = waiters.shift();
    if (waiting) waiting.resolve(body);
    else messages.push(body);
  });
  socket.on('error', () => {});
  const client: SocketClient = {
    socket,
    send: (body) => socket.send(JSON.stringify(body)),
    next: () => {
      const existing = messages.shift();
      if (existing) return Promise.resolve(existing);
      return bounded(
        new Promise<Message>((resolve, reject) => waiters.push({ resolve, reject })),
        'WebSocket response exceeded 10 seconds.',
      );
    },
    closed,
  };
  clients.add(client);
  await bounded(
    new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', () => reject(new Error('The loopback WebSocket could not open.')));
    }),
    'WebSocket did not open within 10 seconds.',
  );
  return client;
}

async function authenticatedSocket(fixture: PrototypeTransportFixture, token: string) {
  const client = await socketClient(fixture);
  client.send({ type: 'authenticate', token });
  const connected = await client.next();
  expect(connected).toMatchObject({ type: 'connected' });
  return client;
}

function command(client: SocketClient, id = randomUUID(), extra: Record<string, unknown> = {}) {
  client.send({ type: 'command', id, ...extra });
  return client.next();
}

function post(fixture: PrototypeTransportFixture, path: string, body: unknown, token?: string) {
  return fetch(`${fixture.origin}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://www.boardsesh.test',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
}

async function transport(hooks: PrototypeTransportHooks = {}) {
  const fixture = await startPrototypeTransportFixture(environment.databaseUrl, hooks);
  fixtures.add(fixture);
  return fixture;
}

async function user() {
  const userId = randomUUID();
  const email = `${userId}@example.test`;
  await environment.database
    .insert(environment.schema.user)
    .values({ id: userId, email, name: 'Transport fixture', emailVerified: true });
  await environment.database.insert(environment.schema.account).values({
    id: randomUUID(),
    userId,
    providerId: 'credential',
    accountId: userId,
    password: passwordHash,
  });
  return { userId, email };
}

async function signedIn() {
  const identity = await user();
  const response = await post(first, '/__fixture/sign-in', { email: identity.email, password });
  expect(response.status).toBe(200);
  const pair = (await response.json()) as PrototypeNativeTokenPair;
  expect(pair.userId).toBe(identity.userId);
  return { ...identity, pair };
}

async function reset(fixture: PrototypeTransportFixture, userId: string) {
  const token = randomUUID();
  await environment.database.insert(environment.schema.verification).values({
    id: randomUUID(),
    identifier: `reset-password:${token}`,
    value: userId,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return post(fixture, '/api/auth/reset-password', { token, newPassword: 'reset-transport-password-山' });
}

async function receipt(operationIdentifier: string) {
  const rows = await environment.database
    .select()
    .from(environment.schema.verification)
    .where(like(environment.schema.verification.identifier, `${PROTOTYPE_TRANSPORT_RECEIPT_PREFIX}%`));
  return rows.filter((row) => {
    const body = JSON.parse(row.value) as { operationId: string };
    return body.operationId === operationIdentifier;
  });
}

describe('real HTTP and open WebSockets consult the canonical authority on every operation', () => {
  beforeAll(async () => {
    environment = await createPrototypeEnvironment();
    passwordHash = await hash(password, 4);
    first = await transport();
    second = await transport();
  });
  afterAll(async () => {
    for (const client of clients) client.socket.terminate();
    const outcomes = await Promise.allSettled([...fixtures].map((fixture) => fixture.close()));
    await environment?.close();
    const failed = outcomes.find((outcome) => outcome.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    if (rejectionMeasurements.length > 0) {
      console.info(
        `[transport-proof] reset/revoke acknowledgement to denied socket reply: ${Math.min(...rejectionMeasurements).toFixed(2)}–${Math.max(...rejectionMeasurements).toFixed(2)} ms (${rejectionMeasurements.length} observations)`,
      );
    }
  });

  it('performs a real HTTP operation using signed identity rather than body ownership', async () => {
    const { pair, userId } = await signedIn();
    const id = randomUUID();
    const response = await post(second, '/protected/operation', { id, userId: 'untrusted-request-owner' }, pair.jwt);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ type: 'result', id, userId });
    const written = await receipt(id);
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0].value)).toMatchObject({ userId, operationId: id });
  });

  it('authenticates a real WebSocket and rechecks identity when executing its command', async () => {
    const { pair, userId } = await signedIn();
    const socket = await authenticatedSocket(first, pair.jwt);
    const id = randomUUID();
    expect(await command(socket, id, { userId: 'another-account', token: 'ignored-message-token' })).toMatchObject({
      type: 'result',
      id,
      userId,
    });
    expect(await receipt(id)).toHaveLength(1);
  });

  it.each(['password-reset', 'account-sign-out'] as const)(
    '%s rejects the next command on an already authenticated socket',
    async (mutation) => {
      const { pair, userId } = await signedIn();
      const socket = await authenticatedSocket(first, pair.jwt);
      expect(await command(socket)).toMatchObject({ type: 'result', userId });
      const revoked =
        mutation === 'password-reset'
          ? await reset(second, userId)
          : await post(second, '/__fixture/revoke', { refreshToken: pair.refreshToken });
      const acknowledged = performance.now();
      expect(revoked.status).toBe(200);
      // Expiry/signature still pass: this rejection must come from canonical state.
      expect(
        (await jwtVerify(pair.jwt, PROTOTYPE_TRANSPORT_KEY, { issuer: 'boardsesh', audience: 'boardsesh-mobile' }))
          .payload.sub,
      ).toBe(userId);
      const id = randomUUID();
      expect(await command(socket, id)).toMatchObject({ type: 'error', id, code: 'UNAUTHORIZED' });
      const elapsed = performance.now() - acknowledged;
      rejectionMeasurements.push(elapsed);
      expect(elapsed).toBeLessThan(10000);
      expect(await bounded(socket.closed, 'A rejected socket did not close.')).toBe(4401);
      expect(await receipt(id)).toHaveLength(0);
      expect((await post(first, '/protected/operation', { id: randomUUID() }, pair.jwt)).status).toBe(401);
      expect((await post(second, '/protected/operation', { id: randomUUID() }, pair.jwt)).status).toBe(401);
    },
  );

  it('an authority read outage is retryable, writes nothing and does not invalidate the session', async () => {
    const { pair, userId } = await signedIn();
    const unavailable = await transport();
    const socket = await authenticatedSocket(unavailable, pair.jwt);
    await unavailable.closeDatabase();
    const id = randomUUID();
    expect(await command(socket, id)).toMatchObject({ type: 'error', id, code: 'UNAVAILABLE' });
    expect(await bounded(socket.closed, 'An unavailable socket did not close.')).toBe(1013);
    expect(await receipt(id)).toHaveLength(0);
    const response = await post(unavailable, '/protected/operation', { id: randomUUID() }, pair.jwt);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'UNAVAILABLE' });
    expect((await post(second, '/protected/operation', { id: randomUUID() }, pair.jwt)).status).toBe(200);
    const recovered = await transport();
    const reopened = await authenticatedSocket(recovered, pair.jwt);
    expect(await command(reopened)).toMatchObject({ type: 'result', userId });
    expect(
      await environment.database
        .select()
        .from(environment.schema.prototypeUserCutoff)
        .where(eq(environment.schema.prototypeUserCutoff.userId, userId)),
    ).toHaveLength(0);
  });

  it('an unavailable authority cannot grant a new socket authentication', async () => {
    const { pair } = await signedIn();
    const unavailable = await transport();
    await unavailable.closeDatabase();
    const socket = await socketClient(unavailable);
    socket.send({ type: 'authenticate', token: pair.jwt });
    expect(await socket.next()).toMatchObject({ type: 'error', code: 'UNAVAILABLE' });
    expect(await bounded(socket.closed, 'Unavailable authentication did not close.')).toBe(1013);
  });

  it.each(['opaque', 'forged', 'wrong-audience'] as const)(
    'rejects a %s bearer over HTTP and WebSocket before any receipt',
    async (kind) => {
      const { pair, userId } = await signedIn();
      const token =
        kind === 'opaque'
          ? randomUUID()
          : await new SignJWT({ sub: userId, sid: decodeJwt(pair.jwt).sid })
              .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
              .setIssuedAt()
              .setIssuer('boardsesh')
              .setAudience(kind === 'wrong-audience' ? 'partner-api' : 'boardsesh-mobile')
              .setExpirationTime('1h')
              .sign(
                kind === 'forged' ? new TextEncoder().encode('another-synthetic-signing-key') : PROTOTYPE_TRANSPORT_KEY,
              );
      const id = randomUUID();
      expect((await post(first, '/protected/operation', { id }, token)).status).toBe(401);
      const socket = await socketClient(second);
      socket.send({ type: 'authenticate', token });
      expect(await socket.next()).toMatchObject({ type: 'error', code: 'UNAUTHORIZED' });
      expect(await bounded(socket.closed, 'Rejected authentication did not close.')).toBe(4401);
      expect(await receipt(id)).toHaveLength(0);
    },
  );

  it('a socket command without authentication never executes a protected operation', async () => {
    const socket = await socketClient(first);
    const id = randomUUID();
    expect(await command(socket, id)).toMatchObject({ type: 'error', id, code: 'UNAUTHORIZED' });
    expect(await receipt(id)).toHaveLength(0);
    expect(await bounded(socket.closed, 'Unauthenticated command did not close.')).toBe(4401);
  });

  it('rejects a malformed raw WebSocket upgrade without crashing the listening authority', async () => {
    const target = new URL(first.origin);
    const socket = createConnection({ host: '127.0.0.1', port: Number(target.port) });
    const disconnected = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    socket.on('error', () => {});
    try {
      await bounded(
        new Promise<void>((resolve, reject) => {
          socket.once('connect', resolve);
          socket.once('error', () => reject(new Error('Raw upgrade connection failed.')));
        }),
        'Raw upgrade socket did not connect.',
      );
      socket.write(
        'GET // HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
      );
      await bounded(disconnected, 'Malformed upgrade socket was not closed.');
      const health = await fetch(`${first.origin}/__fixture/ready`, { signal: AbortSignal.timeout(10000) });
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ready: true });
    } finally {
      socket.destroy();
    }
  });

  it('serializes an authorized socket operation before a queued reset under the common fence', async () => {
    const { pair, userId } = await signedIn();
    const id = randomUUID();
    const authorized = deferred<void>();
    const release = deferred<void>();
    const resetArrived = deferred<void>();
    const operationAuthority = await transport({
      afterAuthorized: async (operation) => {
        if (operation === id) {
          authorized.resolve();
          await release.promise;
        }
      },
    });
    const mutationAuthority = await transport({
      onLifecycleRequest: (path) => {
        if (path.endsWith('/reset-password')) resetArrived.resolve();
      },
    });
    const socket = await authenticatedSocket(operationAuthority, pair.jwt);
    const result = command(socket, id);
    try {
      await bounded(authorized.promise, 'The operation did not acquire the authorization fence.');
      const mutation = reset(mutationAuthority, userId);
      await bounded(resetArrived.promise, 'The concurrent reset never reached its authority.');
      expect(
        await environment.database
          .select()
          .from(environment.schema.prototypeUserCutoff)
          .where(eq(environment.schema.prototypeUserCutoff.userId, userId)),
      ).toHaveLength(0);
      release.resolve();
      expect(await result).toMatchObject({ type: 'result', id, userId });
      expect((await mutation).status).toBe(200);
      expect(await receipt(id)).toHaveLength(1);
      expect(await command(socket)).toMatchObject({ type: 'error', code: 'UNAUTHORIZED' });
    } finally {
      release.resolve();
      await result.catch(() => {});
    }
  });

  it('a reset committed before operation validation leaves no operation receipt', async () => {
    const { pair, userId } = await signedIn();
    const socket = await authenticatedSocket(first, pair.jwt);
    expect((await reset(second, userId)).status).toBe(200);
    const id = randomUUID();
    expect(await command(socket, id)).toMatchObject({ type: 'error', id, code: 'UNAUTHORIZED' });
    expect(await receipt(id)).toHaveLength(0);
  });

  it('an authorized response can arrive after reset while the next operation is rejected', async () => {
    const { pair, userId } = await signedIn();
    const id = randomUUID();
    const committed = deferred<void>();
    const publish = deferred<void>();
    const fixture = await transport({
      afterCommitted: async (operation) => {
        if (operation === id) {
          committed.resolve();
          await publish.promise;
        }
      },
    });
    const socket = await authenticatedSocket(fixture, pair.jwt);
    const result = command(socket, id);
    try {
      await bounded(committed.promise, 'The operation did not reach its post-commit publication barrier.');
      expect(await receipt(id)).toHaveLength(1);
      expect((await reset(second, userId)).status).toBe(200);
      publish.resolve();
      expect(await result).toMatchObject({ type: 'result', id, userId });
      expect(await command(socket)).toMatchObject({ type: 'error', code: 'UNAUTHORIZED' });
    } finally {
      publish.resolve();
      await result.catch(() => {});
    }
  });

  it('an operation failure after validation rolls back its receipt and remains retryable elsewhere', async () => {
    const { pair } = await signedIn();
    const id = randomUUID();
    let writeReached = false;
    const failing = await transport({
      afterReceiptWritten: async () => {
        writeReached = true;
        throw new Error('Synthetic operation failure');
      },
    });
    const response = await post(failing, '/protected/operation', { id }, pair.jwt);
    expect(response.status).toBe(503);
    expect(writeReached).toBe(true);
    expect(await receipt(id)).toHaveLength(0);
    expect((await post(second, '/protected/operation', { id }, pair.jwt)).status).toBe(200);
    expect(await receipt(id)).toHaveLength(1);
  });

  it('ordinary transport use preserves unknown authentication age rather than granting sensitive access', async () => {
    const { userId } = await user();
    const now = Math.floor(Date.now() / 1000);
    const legacyToken = await new SignJWT({ sub: userId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('boardsesh')
      .setAudience('boardsesh-mobile')
      .setIssuedAt(now - 60)
      .setExpirationTime(now + 3600)
      .sign(PROTOTYPE_LEGACY_KEY);
    const bridged = await post(first, '/api/auth/prototype-legacy-bridge', {}, legacyToken);
    expect(bridged.status).toBe(200);
    const cookie = bridged.headers
      .getSetCookie()
      .find((header) => header.includes('better-auth.session_token='))!
      .split(';')[0];
    const binding = (await bridged.json()) as { userId: string; sessionId: string };
    const pair = await createPrototypeNativeFacade(
      environment.database,
      PROTOTYPE_TRANSPORT_KEY,
    ).issueForVerifiedSession(binding.userId, binding.sessionId);
    expect(decodeJwt(pair.jwt).auth_time).toBeUndefined();
    const socket = await authenticatedSocket(second, pair.jwt);
    expect(await command(socket)).toMatchObject({ type: 'result', userId });
    const sensitive = await fetch(`${first.origin}/api/auth/list-sessions`, {
      headers: { cookie },
      signal: AbortSignal.timeout(10000),
    });
    expect(sensitive.status).toBe(403);
    expect(await sensitive.json()).toMatchObject({ code: 'SESSION_NOT_FRESH' });
    const [stored] = await environment.database
      .select()
      .from(environment.schema.session)
      .where(and(eq(environment.schema.session.id, binding.sessionId), eq(environment.schema.session.userId, userId)));
    expect(stored.createdAt).toEqual(new Date(0));
  });
});
