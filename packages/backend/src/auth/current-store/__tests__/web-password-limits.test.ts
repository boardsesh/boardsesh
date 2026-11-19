/**
 * Staged web sign-in limits (#7589) over real authenticated HTTP, PostgreSQL and
 * Redis. Each "instance" is its own handler with its own limiter, compare gate,
 * Redis connection and in-process fallback counts, as two backend replicas
 * would have.
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
import { handleCurrentStoreWebAuth, type StagedSignInGuards } from '../../../handlers/current-store-web-auth';
import { reportedClientLimitKey } from '../../../utils/client-ip';
import { prepareProjectionUnderUsersTableLock } from '../email-reservations';
import { createPasswordCompareGate, PASSWORD_COMPARES_RETRY_AFTER_SECONDS } from '../password-compare-gate';
import {
  createPasswordLoginLimiter,
  PASSWORD_LOGIN_CLIENT_LIMIT,
  passwordLoginMetrics,
  UNATTRIBUTED_PASSWORD_LOGIN_BUDGET,
  type PasswordLoginRedis,
} from '../password-login-limits';
import { DEVICE_TOKEN_SECRET_ENV, mintDeviceToken } from '@boardsesh/auth-protocol/device-token';
import { __setPasswordGuessLimiterForTests, createPasswordGuessLimiter } from '../../password-guess-limit';
import { PASSWORD_GUESS_EMAIL_KEY_ENV } from '../../password-guess-windows';

const comparison = vi.hoisted(() => ({
  /** Submitted passwords, in the order their compares started. */
  started: [] as string[],
  inFlight: 0,
  maxInFlight: 0,
  beforeCompare: undefined as ((password: string) => Promise<void>) | undefined,
}));
vi.mock('bcryptjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('bcryptjs')>();
  return {
    ...actual,
    compare: async (password: string, passwordHash: string) => {
      comparison.started.push(password);
      comparison.inFlight += 1;
      comparison.maxInFlight = Math.max(comparison.maxInFlight, comparison.inFlight);
      try {
        await comparison.beforeCompare?.(password);
        return await actual.compare(password, passwordHash);
      } finally {
        comparison.inFlight -= 1;
      }
    },
  };
});

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6380';
const LIMIT_KEYS = 'ratelimit:password-login:*';
const RIGHT_PASSWORD = 'right-password';
const WRONG_PASSWORD = 'wrong-password';
const rpcSecret = randomBytes(32).toString('base64url');
const WINDOW_MS = PASSWORD_LOGIN_CLIENT_LIMIT.windowMs;
/** Halfway through a minute, so every attempt of a test lands in one window. */
const midWindow = () => Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS + WINDOW_MS / 2;
const CLIENT_RETRY_AFTER = String(WINDOW_MS / 2 / 1000);
const SHED_RETRY_AFTER = String(PASSWORD_COMPARES_RETRY_AFTER_SECONDS);

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
const guards: { a?: StagedSignInGuards; b?: StagedSignInGuards } = {};

let clientSequence = 0;
/** A fresh public client each call: TEST-NET-3 IPv4 or a documentation IPv6 /64, alternately. */
function nextClient(): string {
  clientSequence += 1;
  return clientSequence % 2 === 1
    ? `203.0.113.${(clientSequence + 1) / 2}`
    : `2001:db8:${clientSequence.toString(16)}::${clientSequence.toString(16)}`;
}

function windowKey(clientAddress: string): string {
  return `ratelimit:password-login:client:${reportedClientLimitKey(clientAddress)}:${Math.floor(now / WINDOW_MS)}`;
}

function tracked(client: Redis): Redis {
  client.on('error', () => {});
  redisClients.push(client);
  return client;
}

function limitRedis(client: Redis, lateMs = 0): PasswordLoginRedis {
  return {
    // A late reply still runs the script at once; only the answer is held back.
    eval: (script, numberOfKeys, ...args) =>
      client.eval(script, numberOfKeys, ...args).then(async (reply) => {
        if (lateMs) await new Promise((resolve) => setTimeout(resolve, lateMs));
        return reply;
      }),
    hdel: (key, field) => client.hdel(key, field),
  };
}

function guardsOn(redis: PasswordLoginRedis | null, gate = createPasswordCompareGate()): StagedSignInGuards {
  return { limits: createPasswordLoginLimiter({ redis: () => redis, now: () => now }), gate };
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

async function startInstance(current: () => StagedSignInGuards | undefined): Promise<string> {
  const server = createServer((request, response) => {
    void handleCurrentStoreWebAuth(request, response, db, current()).catch(() => {
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

async function signIn(
  origin: string,
  email: string,
  password: string,
  clientAddress?: string,
  signal: AbortSignal = AbortSignal.timeout(8000),
): Promise<SignIn> {
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
    signal,
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

async function seed(email = `${randomUUID()}@example.test`, passwordHash = rightHash) {
  const id = randomUUID();
  await db.insert(users).values({ id, email, name: 'Owned limit fixture', emailVerified: new Date() });
  await db.insert(userCredentials).values({ userId: id, passwordHash });
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

async function waitFor(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Holds the compare for one submitted password until released. */
function holdCompare(password: string) {
  let enter = () => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  comparison.beforeCompare = async (submitted) => {
    if (submitted !== password) return;
    enter();
    await released;
  };
  return { entered, release };
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
    instanceA = await startInstance(() => guards.a);
    instanceB = await startInstance(() => guards.b);
  });

  beforeEach(async () => {
    comparison.beforeCompare = undefined;
    comparison.started = [];
    comparison.maxInFlight = 0;
    vi.unstubAllEnvs();
    now = midWindow();
    guards.a = guardsOn(limitRedis(redisA));
    guards.b = guardsOn(limitRedis(redisB));
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

  describe('per-client limit', () => {
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
      // One window per noisy client; the climber's emptied on the right password.
      expect(await limitKeys()).toHaveLength(21);
    }, 60_000);

    it('compares exactly the limit when one client sends a parallel burst', async () => {
      const climber = await seed();
      const client = nextClient();
      const burst = await Promise.all(
        Array.from({ length: 15 }, (_, index) => signIn(instanceA, climber.email, `burst-wrong-${index}`, client)),
      );
      expect(burst.filter((attempt) => attempt.result === 'invalid_credentials')).toHaveLength(
        PASSWORD_LOGIN_CLIENT_LIMIT.attempts,
      );
      expect(burst.filter((attempt) => attempt.result === 'rate_limited')).toHaveLength(5);
      expect(comparison.started.filter((password) => password.startsWith('burst-wrong-'))).toHaveLength(
        PASSWORD_LOGIN_CLIENT_LIMIT.attempts,
      );
    });

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

    it('counts an address with no account exactly like one with an account', async () => {
      const known = await seed();
      const unknownEmail = `${randomUUID()}@example.test`;
      const client = nextClient();
      for (let attempt = 0; attempt < PASSWORD_LOGIN_CLIENT_LIMIT.attempts; attempt += 1) {
        const email = attempt % 2 === 0 ? known.email : unknownEmail;
        expect((await signIn(instanceA, email, WRONG_PASSWORD, client)).result).toBe('invalid_credentials');
      }
      const knownLimited = await signIn(instanceA, known.email, RIGHT_PASSWORD, client);
      const unknownLimited = await signIn(instanceA, unknownEmail, RIGHT_PASSWORD, client);
      for (const limited of [knownLimited, unknownLimited]) {
        expect(limited).toMatchObject({ status: 429, retryAfter: CLIENT_RETRY_AFTER });
      }
      expect({ ...knownLimited.reply, requestId: '' }).toEqual({ ...unknownLimited.reply, requestId: '' });
    }, 30_000);

    it('shares the limit between two backend instances through Redis', async () => {
      const climber = await seed();
      const client = nextClient();
      for (let attempt = 0; attempt < PASSWORD_LOGIN_CLIENT_LIMIT.attempts; attempt += 1) {
        const instance = attempt % 2 === 0 ? instanceA : instanceB;
        expect((await signIn(instance, climber.email, WRONG_PASSWORD, client)).result).toBe('invalid_credentials');
      }
      expect((await signIn(instanceA, climber.email, WRONG_PASSWORD, client)).result).toBe('rate_limited');
      expect((await signIn(instanceB, climber.email, RIGHT_PASSWORD, client)).result).toBe('rate_limited');
      expect(await redisA.hlen(windowKey(client))).toBe(PASSWORD_LOGIN_CLIENT_LIMIT.attempts);
      expect(await redisA.pttl(windowKey(client))).toBeLessThanOrEqual(WINDOW_MS / 2);
    });
  });

  describe('a sign-in the per-client limit cannot key', () => {
    it('falls back to the per-process budget of 180 a minute, counted and logged', async () => {
      const climber = await seed();
      const before = passwordLoginMetrics().unattributed.no_public_client_address;
      const unattributed = [undefined, '10.0.0.5', 'fd12:3456::1'];
      for (let attempt = 0; attempt < UNATTRIBUTED_PASSWORD_LOGIN_BUDGET.attempts; attempt += 1) {
        const clientAddress = unattributed[attempt % unattributed.length];
        expect((await signIn(instanceA, climber.email, WRONG_PASSWORD, clientAddress)).result).toBe(
          'invalid_credentials',
        );
      }
      expect(await signIn(instanceB, climber.email, RIGHT_PASSWORD)).toMatchObject({
        status: 429,
        result: 'rate_limited',
      });
      expect(passwordLoginMetrics().unattributed.no_public_client_address).toBe(
        before + UNATTRIBUTED_PASSWORD_LOGIN_BUDGET.attempts + 1,
      );
      // A sign-in with a public client address is not held by that budget.
      expect((await signIn(instanceA, climber.email, RIGHT_PASSWORD, nextClient())).result).toBe('authenticated');
      expect(await limitKeys()).toEqual([]);
    }, 30_000);

    it('refuses a malformed client address', async () => {
      const climber = await seed();
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
    });
  });

  describe('Redis unavailable', () => {
    it('with Redis not connected, counts each instance on its own and keeps signing climbers in', async () => {
      guards.a = guardsOn(null);
      guards.b = guardsOn(null);
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
      guards.a = guardsOn(limitRedis(hungRedis));
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

    it('takes back from Redis an admission whose reply came too late, so a right password is never counted there', async () => {
      guards.a = guardsOn(limitRedis(redisA, 250));
      const climber = await seed();
      const client = nextClient();
      expect((await signIn(instanceA, climber.email, RIGHT_PASSWORD, client)).result).toBe('authenticated');
      // The script ran in Redis although its reply missed the deadline; the give-back removed it.
      expect(await redisA.hlen(windowKey(client))).toBe(0);
      expect((await signIn(instanceA, climber.email, WRONG_PASSWORD, client)).result).toBe('invalid_credentials');
      expect(await redisA.hlen(windowKey(client))).toBe(1);
    });
  });

  describe('compare queue', () => {
    it('sheds a sign-in that finds the queue full before it creates any Redis key', async () => {
      const gate = createPasswordCompareGate({ maxWaiting: 1 });
      guards.a = guardsOn(limitRedis(redisA), gate);
      const climber = await seed();
      const hold = holdCompare('held-wrong');
      const holding = signIn(instanceA, climber.email, 'held-wrong');
      await hold.entered;
      const queued = signIn(instanceA, climber.email, 'queued-wrong', nextClient());
      await waitFor(() => gate.waiting() === 1, 'one queued sign-in');
      const shedClient = nextClient();
      const shed = await signIn(instanceA, climber.email, 'shed-wrong', shedClient);
      expect(shed).toMatchObject({ status: 503, result: 'unavailable', retryAfter: SHED_RETRY_AFTER });
      expect(await redisA.exists(windowKey(shedClient))).toBe(0);
      hold.release();
      expect((await holding).result).toBe('invalid_credentials');
      expect((await queued).result).toBe('invalid_credentials');
      expect(comparison.started).not.toContain('shed-wrong');
    });

    it('answers 503 with Retry-After when the wait passes its deadline, and gives the attempt back', async () => {
      const gate = createPasswordCompareGate({ waitMs: 300 });
      guards.a = guardsOn(limitRedis(redisA), gate);
      const climber = await seed();
      const hold = holdCompare('held-wrong');
      const holding = signIn(instanceA, climber.email, 'held-wrong');
      await hold.entered;
      const client = nextClient();
      const started = performance.now();
      const late = await signIn(instanceA, climber.email, 'late-wrong', client);
      expect(performance.now() - started).toBeGreaterThanOrEqual(290);
      expect(late).toMatchObject({ status: 503, result: 'unavailable', retryAfter: SHED_RETRY_AFTER });
      expect(await redisA.hlen(windowKey(client))).toBe(0);
      hold.release();
      expect((await holding).result).toBe('invalid_credentials');
      expect(comparison.started).not.toContain('late-wrong');
    });

    it('drops a waiting sign-in whose caller went away without running its compare', async () => {
      const gate = createPasswordCompareGate();
      guards.a = guardsOn(limitRedis(redisA), gate);
      const climber = await seed();
      const hold = holdCompare('held-wrong');
      const holding = signIn(instanceA, climber.email, 'held-wrong');
      await hold.entered;
      const client = nextClient();
      const callerGone = new AbortController();
      const abandoned = signIn(instanceA, climber.email, 'abandoned-wrong', client, callerGone.signal).catch(
        (error: unknown) => error,
      );
      await waitFor(() => gate.waiting() === 1, 'the sign-in to queue');
      expect(await redisA.hlen(windowKey(client))).toBe(1);
      callerGone.abort();
      await abandoned;
      await waitFor(() => gate.waiting() === 0, 'the abandoned sign-in to leave the queue');
      await waitFor(async () => (await redisA.hlen(windowKey(client))) === 0, 'the attempt to be given back');
      hold.release();
      expect((await holding).result).toBe('invalid_credentials');
      expect(comparison.started).not.toContain('abandoned-wrong');
    });

    it('runs an address shared by several accounts in one slot, one compare at a time, never partly shed', async () => {
      const gate = createPasswordCompareGate({ maxWaiting: 1 });
      guards.a = guardsOn(limitRedis(redisA), gate);
      const shared = `${randomUUID()}@example.test`;
      await seed(shared, await hash('shared-right', 4));
      await seed(shared, await hash('shared-other-one', 4));
      await seed(shared, await hash('shared-other-two', 4));
      const other = await seed();
      const hold = holdCompare('held-wrong');
      const holding = signIn(instanceA, other.email, 'held-wrong');
      await hold.entered;
      const group = signIn(instanceA, shared, 'shared-right', nextClient());
      // Three accounts, one waiter: the next sign-in finds the queue full.
      await waitFor(() => gate.waiting() === 1, 'the shared address to queue');
      const shed = await signIn(instanceA, other.email, 'shed-wrong', nextClient());
      expect(shed).toMatchObject({ status: 503, result: 'unavailable' });
      hold.release();
      expect((await holding).result).toBe('invalid_credentials');
      expect((await group).result).toBe('authenticated');
      expect(comparison.started.filter((password) => password === 'shared-right')).toHaveLength(3);
      expect(comparison.maxInFlight).toBe(1);
    });
  });

  describe('per-account guess limit (#7656)', () => {
    const deviceSecret = randomBytes(32).toString('hex');
    const guessEnvironment = {
      [PASSWORD_GUESS_EMAIL_KEY_ENV]: randomBytes(32).toString('hex'),
      [DEVICE_TOKEN_SECRET_ENV]: deviceSecret,
    };
    /** Mid-hour, so a run never straddles an hour edge. */
    const midHour = () => new Date('2026-11-17T10:15:00.000Z');

    async function signInWithDevice(email: string, password: string, clientAddress: string, deviceToken?: string) {
      const command: PasswordCommand = {
        protocolVersion: AUTH_PROTOCOL_VERSION,
        operation: 'password',
        requestId: randomUUID(),
        issuedAt: Date.now(),
        clientAddress,
        ...(deviceToken ? { deviceToken } : {}),
        payload: { email, password },
      };
      const response = await fetch(`${instanceA}${AUTH_COMMAND_PATHS.password}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${rpcSecret}`, 'content-type': 'application/json' },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(8000),
      });
      const reply = passwordReplySchema.parse(await response.json());
      return {
        status: response.status,
        retryAfter: response.headers.get('retry-after'),
        result: reply.outcome === 'error' ? reply.code : reply.outcome,
      };
    }

    afterAll(() => __setPasswordGuessLimiterForTests(undefined));

    it('enforce: refuses the 11th guess at one account from new clients, and lets the owner device through', async () => {
      __setPasswordGuessLimiterForTests(
        createPasswordGuessLimiter({
          mode: 'enforce',
          store: () => db,
          environment: guessEnvironment,
          now: midHour,
          deadlineMs: 5_000,
        }),
      );
      const owner = await seed();
      const unknown = `${randomUUID()}@example.test`;
      for (const email of [owner.email, unknown]) {
        const results = [];
        for (let attempt = 0; attempt < 12; attempt += 1)
          results.push(await signInWithDevice(email, WRONG_PASSWORD, nextClient()));
        expect(results.slice(0, 10).map(({ result }) => result)).toEqual(Array(10).fill('invalid_credentials'));
        expect(results.slice(10)).toEqual([
          { status: 429, retryAfter: expect.any(String), result: 'rate_limited' },
          { status: 429, retryAfter: expect.any(String), result: 'rate_limited' },
        ]);
      }
      const { token } = await mintDeviceToken({ userId: owner.id, secret: deviceSecret });
      expect(await signInWithDevice(owner.email, RIGHT_PASSWORD, nextClient(), token)).toMatchObject({
        status: 200,
        result: 'authenticated',
      });
      expect((await signInWithDevice(owner.email, RIGHT_PASSWORD, nextClient())).result).toBe('rate_limited');
    });

    it('observe: refuses nobody', async () => {
      __setPasswordGuessLimiterForTests(
        createPasswordGuessLimiter({
          mode: 'observe',
          store: () => db,
          environment: guessEnvironment,
          now: midHour,
          deadlineMs: 5_000,
        }),
      );
      const owner = await seed();
      for (let attempt = 0; attempt < 12; attempt += 1)
        expect((await signInWithDevice(owner.email, WRONG_PASSWORD, nextClient())).result).toBe('invalid_credentials');
      expect((await signInWithDevice(owner.email, RIGHT_PASSWORD, nextClient())).result).toBe('authenticated');
    });
  });
});
