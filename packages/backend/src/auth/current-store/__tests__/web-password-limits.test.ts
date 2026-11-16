/**
 * Staged web sign-in limits (#7589) over real authenticated HTTP, PostgreSQL and
 * Redis. Each "instance" is its own handler with its own limiter, Redis
 * connection and in-process fallback counts, as two backend replicas would have.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';
import Redis from 'ioredis';
import { hash } from 'bcryptjs';
import {
  AUTH_COMMAND_PATHS,
  AUTH_PROTOCOL_VERSION,
  passwordReplySchema,
  type PasswordCommand,
  type PasswordReply,
} from '@boardsesh/auth-protocol';
import {
  authEmailProjection,
  authEmailReservationMembers,
  authEmailReservations,
  authEmailVerificationState,
  authEmailVerificationTokens,
  authSecurityMutationEvents,
  authSubjectCutoffs,
  userCredentials,
  users,
  verificationTokens,
} from '@boardsesh/db/schema/auth';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { db } from '../../../db/client';
import { setupWorkerDatabase } from '../../../__tests__/worker-db';
import { handleCurrentStoreWebAuth } from '../../../handlers/current-store-web-auth';
import { prepareProjectionUnderUsersTableLock } from '../email-reservations';
import { MAX_WAITING_PASSWORD_COMPARES, passwordCompareGate } from '../password-compare-gate';
import {
  createPasswordLoginLimiter,
  PASSWORD_LOGIN_ACCOUNT_LIMIT,
  PASSWORD_LOGIN_CLIENT_LIMIT,
  type PasswordLoginLimiter,
  type PasswordLoginRedis,
} from '../password-login-limits';

const comparison = vi.hoisted(() => ({
  beforeCompare: undefined as ((password: string) => Promise<void>) | undefined,
}));
vi.mock('bcryptjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('bcryptjs')>();
  return {
    ...actual,
    compare: async (password: string, passwordHash: string) => {
      await comparison.beforeCompare?.(password);
      return actual.compare(password, passwordHash);
    },
  };
});

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6380';
const LIMIT_KEYS = 'ratelimit:password-login:*';
const RIGHT_PASSWORD = 'right-password';
const WRONG_PASSWORD = 'wrong-password';
const rpcSecret = randomBytes(32).toString('base64url');

const ACCOUNT_WINDOW_MS = PASSWORD_LOGIN_ACCOUNT_LIMIT.windowMs;
/** Halfway through a 15-minute window, which is also halfway through its minute. */
const midWindow = () => Math.floor(Date.now() / ACCOUNT_WINDOW_MS) * ACCOUNT_WINDOW_MS + ACCOUNT_WINDOW_MS / 2;
const CLIENT_RETRY_AFTER = String(PASSWORD_LOGIN_CLIENT_LIMIT.windowMs / 2 / 1000);
const ACCOUNT_RETRY_AFTER = String(ACCOUNT_WINDOW_MS / 2 / 1000);

const httpServers: Server[] = [];
const httpSockets = new Set<Socket>();
const redisClients: Redis[] = [];
let blackhole: TcpServer | undefined;
const blackholeSockets = new Set<Socket>();
let redisA: Redis;
let redisB: Redis;
let hungRedis: Redis;
let instanceA: string;
let instanceB: string;
let now = 0;
let rightHash: string;
const limiters: { a?: PasswordLoginLimiter; b?: PasswordLoginLimiter } = {};

let clientSequence = 0;
/** A fresh public client each call: TEST-NET-3 IPv4 or a documentation IPv6 /64, alternately. */
function nextClient(): string {
  clientSequence += 1;
  return clientSequence % 2 === 1
    ? `203.0.113.${(clientSequence + 1) / 2}`
    : `2001:db8:${clientSequence.toString(16)}::${clientSequence.toString(16)}`;
}

function tracked(client: Redis): Redis {
  client.on('error', () => {});
  redisClients.push(client);
  return client;
}

async function resetAuthTables() {
  await db.delete(authEmailVerificationTokens);
  await db.delete(authEmailVerificationState);
  await db.delete(verificationTokens);
  await db.delete(authEmailReservationMembers);
  await db.delete(authEmailReservations);
  await db.delete(authSecurityMutationEvents);
  await db.delete(authSubjectCutoffs);
  await db.delete(authEmailProjection);
  await db.delete(users);
}

function limiterOn(redis: PasswordLoginRedis | null): PasswordLoginLimiter {
  return createPasswordLoginLimiter({ redis: () => redis, now: () => now });
}

async function startInstance(limiter: () => PasswordLoginLimiter | undefined): Promise<string> {
  const server = createServer((request, response) => {
    void handleCurrentStoreWebAuth(request, response, db, limiter()).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  server.on('connection', (socket) => {
    httpSockets.add(socket);
    socket.once('close', () => httpSockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  httpServers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Owned auth server failed to bind');
  return `http://127.0.0.1:${address.port}`;
}

interface SignIn {
  readonly status: number;
  readonly retryAfter: string | null;
  readonly reply: PasswordReply;
  /** `authenticated`, `invalid_credentials`, or the error code. */
  readonly result: string;
}

async function signIn(origin: string, email: string, password: string, clientAddress?: string): Promise<SignIn> {
  const command: PasswordCommand = {
    protocolVersion: AUTH_PROTOCOL_VERSION,
    operation: 'password',
    requestId: randomUUID(),
    issuedAt: Date.now(),
    ...(clientAddress === undefined ? {} : { clientAddress }),
    payload: { email, password },
  };
  const response = await fetch(`${origin}${AUTH_COMMAND_PATHS.password}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${rpcSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(8000),
  });
  const reply = passwordReplySchema.parse(await response.json());
  expect(reply.requestId).toBe(command.requestId);
  return {
    status: response.status,
    retryAfter: response.headers.get('retry-after'),
    reply,
    result: reply.outcome === 'error' ? reply.code : reply.outcome,
  };
}

async function seed(email = `${randomUUID()}@example.test`) {
  const id = randomUUID();
  await db.insert(users).values({ id, email, name: 'Owned limit fixture', emailVerified: new Date() });
  await db.insert(userCredentials).values({ userId: id, passwordHash: rightHash });
  return { id, email };
}

async function limitKeys(): Promise<string[]> {
  const found: string[] = [];
  let cursor = '0';
  do {
    const [next, keys] = await redisA.scan(cursor, 'MATCH', LIMIT_KEYS, 'COUNT', 1000);
    cursor = next;
    found.push(...keys);
  } while (cursor !== '0');
  return found;
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('staged web sign-in limits', () => {
  beforeAll(async () => {
    await setupWorkerDatabase();
    const ownedUrl = new URL(process.env.DATABASE_URL!);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(ownedUrl.hostname) ||
      !ownedUrl.pathname.startsWith('/boardsesh_backend_test_w')
    )
      throw new Error('Limit fixture requires its owned local worker database');
    rightHash = await hash(RIGHT_PASSWORD, 4);
    redisA = tracked(new Redis(REDIS_URL));
    redisB = tracked(new Redis(REDIS_URL));
    expect(await redisA.ping()).toBe('PONG');
    expect(await redisB.ping()).toBe('PONG');
    // A Redis that accepts the connection and never answers, like a paused one.
    blackhole = createTcpServer((socket) => {
      blackholeSockets.add(socket);
      socket.on('error', () => {});
      socket.once('close', () => blackholeSockets.delete(socket));
    });
    await new Promise<void>((resolve) => blackhole!.listen(0, '127.0.0.1', resolve));
    const blackholeAddress = blackhole.address();
    if (!blackholeAddress || typeof blackholeAddress === 'string') throw new Error('Black hole failed to bind');
    hungRedis = tracked(new Redis({ host: '127.0.0.1', port: blackholeAddress.port, maxRetriesPerRequest: null }));
    instanceA = await startInstance(() => limiters.a);
    instanceB = await startInstance(() => limiters.b);
  });

  beforeEach(async () => {
    comparison.beforeCompare = undefined;
    vi.unstubAllEnvs();
    now = midWindow();
    limiters.a = limiterOn(redisA);
    limiters.b = limiterOn(redisB);
    const stale = await limitKeys();
    if (stale.length) await redisA.del(...stale);
    await resetAuthTables();
    const projectionId = randomUUID();
    await db.transaction(async (transaction) => {
      await transaction.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
      await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
      await transaction
        .update(authEmailProjection)
        .set({ phase: 'enforced' })
        .where(eq(authEmailProjection.projectionId, projectionId));
    });
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'backend-staging');
    vi.stubEnv('CURRENT_STORE_AUTH_RPC_SECRET', rpcSecret);
    vi.stubEnv('CURRENT_STORE_AUTH_PROJECTION_ID', projectionId);
    vi.stubEnv('CURRENT_STORE_AUTH_WRITER_EPOCH', '1');
    vi.stubEnv('EMAIL_VERIFICATION_ENABLED', 'false');
    vi.stubEnv('DEBUG_SQL', 'false');
  });

  afterAll(async () => {
    comparison.beforeCompare = undefined;
    vi.unstubAllEnvs();
    const stale = redisA ? await limitKeys().catch(() => []) : [];
    if (stale.length) await redisA.del(...stale).catch(() => 0);
    for (const client of redisClients) client.disconnect();
    for (const socket of blackholeSockets) socket.destroy();
    await new Promise<void>((resolve) => (blackhole ? blackhole.close(() => resolve()) : resolve()));
    for (const socket of httpSockets) socket.destroy();
    await Promise.all(httpServers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    await resetAuthTables();
  });

  it('lets a climber sign in after 21 noisy clients have each used up their own limit', async () => {
    // 21 x 10 = 210 rejected passwords: more than the 180 a minute the old
    // process-wide budget allowed before it refused every sign-in on the replica.
    for (let noisy = 0; noisy < 21; noisy += 1) {
      const client = nextClient();
      const { email } = await seed();
      for (let attempt = 0; attempt < PASSWORD_LOGIN_CLIENT_LIMIT.attempts; attempt += 1) {
        expect((await signIn(instanceA, email, WRONG_PASSWORD, client)).result).toBe('invalid_credentials');
      }
      const limited = await signIn(instanceA, email, WRONG_PASSWORD, client);
      expect(limited).toMatchObject({ status: 429, result: 'rate_limited', retryAfter: CLIENT_RETRY_AFTER });
    }
    const climber = await seed();
    const signedIn = await signIn(instanceA, climber.email, RIGHT_PASSWORD, nextClient());
    expect(signedIn).toMatchObject({ status: 200, result: 'authenticated' });
    // Each noisy client still holds its own full minute, and only that.
    expect(await limitKeys()).toHaveLength(21 * 2 + 2);
  }, 60_000);

  it('never counts a right password against the client', async () => {
    const climber = await seed();
    const client = nextClient();
    for (let attempt = 0; attempt < PASSWORD_LOGIN_CLIENT_LIMIT.attempts - 1; attempt += 1) {
      expect((await signIn(instanceA, climber.email, WRONG_PASSWORD, client)).result).toBe('invalid_credentials');
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await signIn(instanceA, climber.email, RIGHT_PASSWORD, client)).result).toBe('authenticated');
    }
    expect((await signIn(instanceA, climber.email, WRONG_PASSWORD, client)).result).toBe('invalid_credentials');
    expect((await signIn(instanceA, climber.email, RIGHT_PASSWORD, client)).result).toBe('rate_limited');
  });

  it('limits one address across many clients, any capitalisation, and treats an unknown address exactly like a known one', async () => {
    const known = await seed();
    const unknownEmail = `${randomUUID()}@example.test`;
    const outcomes = { known: [] as SignIn[], unknown: [] as SignIn[] };
    for (const [name, email] of [
      ['known', known.email],
      ['unknown', unknownEmail],
    ] as const) {
      for (let attempt = 0; attempt < PASSWORD_LOGIN_ACCOUNT_LIMIT.attempts; attempt += 1) {
        outcomes[name].push(await signIn(instanceA, email, WRONG_PASSWORD, nextClient()));
      }
    }
    for (const rejected of [...outcomes.known, ...outcomes.unknown]) {
      expect(rejected).toMatchObject({ status: 200, result: 'invalid_credentials', retryAfter: null });
    }
    // Fresh clients each, and the right password: the address is out of attempts.
    const knownLimited = await signIn(instanceA, known.email.toUpperCase(), RIGHT_PASSWORD, nextClient());
    const unknownLimited = await signIn(instanceA, unknownEmail, RIGHT_PASSWORD, nextClient());
    for (const limited of [knownLimited, unknownLimited]) {
      expect(limited).toMatchObject({ status: 429, result: 'rate_limited', retryAfter: ACCOUNT_RETRY_AFTER });
    }
    expect({ ...knownLimited.reply, requestId: '' }).toEqual({ ...unknownLimited.reply, requestId: '' });
    // Another climber is untouched.
    expect((await signIn(instanceA, (await seed()).email, RIGHT_PASSWORD, nextClient())).result).toBe('authenticated');
  }, 30_000);

  it('shares both limits between two backend instances through Redis', async () => {
    const climber = await seed();
    const client = nextClient();
    for (let attempt = 0; attempt < PASSWORD_LOGIN_CLIENT_LIMIT.attempts; attempt += 1) {
      const instance = attempt % 2 === 0 ? instanceA : instanceB;
      expect((await signIn(instance, climber.email, WRONG_PASSWORD, client)).result).toBe('invalid_credentials');
    }
    expect((await signIn(instanceA, climber.email, WRONG_PASSWORD, client)).result).toBe('rate_limited');
    expect((await signIn(instanceB, climber.email, WRONG_PASSWORD, client)).result).toBe('rate_limited');

    const target = await seed();
    for (let attempt = 0; attempt < PASSWORD_LOGIN_ACCOUNT_LIMIT.attempts; attempt += 1) {
      const instance = attempt % 2 === 0 ? instanceA : instanceB;
      expect((await signIn(instance, target.email, WRONG_PASSWORD, nextClient())).result).toBe('invalid_credentials');
    }
    expect((await signIn(instanceB, target.email, RIGHT_PASSWORD, nextClient())).result).toBe('rate_limited');
    expect((await signIn(instanceA, target.email, RIGHT_PASSWORD, nextClient())).result).toBe('rate_limited');
  });

  it('with Redis not connected, counts each instance on its own and keeps signing climbers in', async () => {
    limiters.a = limiterOn(null);
    limiters.b = limiterOn(null);
    const climber = await seed();
    const client = nextClient();
    for (let attempt = 0; attempt < PASSWORD_LOGIN_CLIENT_LIMIT.attempts; attempt += 1) {
      expect((await signIn(instanceA, climber.email, WRONG_PASSWORD, client)).result).toBe('invalid_credentials');
    }
    expect(await signIn(instanceA, climber.email, WRONG_PASSWORD, client)).toMatchObject({
      status: 429,
      retryAfter: CLIENT_RETRY_AFTER,
    });
    // The documented cost of the fallback: another replica has not seen these.
    expect((await signIn(instanceB, climber.email, WRONG_PASSWORD, client)).result).toBe('invalid_credentials');
    expect((await signIn(instanceA, climber.email, RIGHT_PASSWORD, nextClient())).result).toBe('authenticated');
    expect(await limitKeys()).toEqual([]);
  });

  it('with Redis not answering, gives up after its deadline and limits from local counts', async () => {
    limiters.a = limiterOn(hungRedis);
    const climber = await seed();
    const client = nextClient();
    const durations: number[] = [];
    const timed = async (password: string, clientAddress: string) => {
      const started = performance.now();
      const result = await signIn(instanceA, climber.email, password, clientAddress);
      durations.push(performance.now() - started);
      return result;
    };
    for (let attempt = 0; attempt < PASSWORD_LOGIN_CLIENT_LIMIT.attempts; attempt += 1) {
      expect((await timed(WRONG_PASSWORD, client)).result).toBe('invalid_credentials');
    }
    expect((await timed(WRONG_PASSWORD, client)).result).toBe('rate_limited');
    expect((await timed(RIGHT_PASSWORD, nextClient())).result).toBe('authenticated');
    // Admission and give-back each wait at most 100 ms for Redis.
    expect(Math.max(...durations)).toBeLessThan(1500);
  }, 30_000);

  it('applies no client limit to a missing or private client address, and refuses a malformed one', async () => {
    const climber = await seed();
    for (const clientAddress of [undefined, '10.0.0.5', 'fd12:3456::1']) {
      for (let attempt = 0; attempt <= PASSWORD_LOGIN_CLIENT_LIMIT.attempts; attempt += 1) {
        // Spread over two addresses so neither reaches its own limit of 20.
        const email = attempt % 2 === 0 ? climber.email : `${randomUUID()}@example.test`;
        expect((await signIn(instanceA, email, WRONG_PASSWORD, clientAddress)).result).toBe('invalid_credentials');
      }
    }
    expect((await limitKeys()).filter((key) => key.includes(':client:'))).toEqual([]);
    const response = await fetch(`${instanceA}${AUTH_COMMAND_PATHS.password}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${rpcSecret}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: AUTH_PROTOCOL_VERSION,
        operation: 'password',
        requestId: randomUUID(),
        issuedAt: Date.now(),
        clientAddress: 'unknown',
        payload: { email: climber.email, password: RIGHT_PASSWORD },
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
  }, 30_000);

  it('sheds a full repeat lane with 503 and Retry-After while a first try still gets its turn', async () => {
    const climber = await seed();
    const started: string[] = [];
    let enterHeld = () => {};
    const held = new Promise<void>((resolve) => {
      enterHeld = resolve;
    });
    let releaseHeld = () => {};
    const released = new Promise<void>((resolve) => {
      releaseHeld = resolve;
    });
    comparison.beforeCompare = async (password) => {
      started.push(password);
      if (password === 'held-wrong') {
        enterHeld();
        await released;
      }
    };
    try {
      // No client address: these wait in the repeat lane.
      const holding = signIn(instanceA, climber.email, 'held-wrong');
      await held;
      const repeats = Array.from({ length: MAX_WAITING_PASSWORD_COMPARES }, (_, index) =>
        signIn(instanceA, climber.email, `repeat-wrong-${index}`),
      );
      await waitFor(() => passwordCompareGate.isFull('repeat'), 'a full repeat lane');
      const shed = await signIn(instanceA, climber.email, 'shed-wrong');
      expect(shed).toMatchObject({ status: 503, result: 'unavailable', retryAfter: '2' });
      // A client with no rejected password this minute waits in the first lane.
      const firstTry = signIn(instanceA, climber.email, RIGHT_PASSWORD, nextClient());
      await waitFor(() => passwordCompareGate.waiting('first') === 1, 'the first try to queue');
      releaseHeld();
      expect((await holding).result).toBe('invalid_credentials');
      expect((await firstTry).result).toBe('authenticated');
      for (const repeat of await Promise.all(repeats)) expect(repeat.result).toBe('invalid_credentials');
    } finally {
      releaseHeld();
      comparison.beforeCompare = undefined;
    }
    // The first try ran straight after the held compare, ahead of every repeat that waited longer.
    expect(started.slice(0, 2)).toEqual(['held-wrong', RIGHT_PASSWORD]);
    expect(started.slice(2).sort((left, right) => left.localeCompare(right))).toEqual(
      Array.from({ length: MAX_WAITING_PASSWORD_COMPARES }, (_, index) => `repeat-wrong-${index}`),
    );
    // Nine rejected passwords stay counted; the shed attempt and the right one were given back.
    const accountKeys = (await limitKeys()).filter((key) => key.includes(':account:'));
    expect(accountKeys).toHaveLength(1);
    expect(await redisA.get(accountKeys[0])).toBe(String(1 + MAX_WAITING_PASSWORD_COMPARES));
  }, 30_000);
});
