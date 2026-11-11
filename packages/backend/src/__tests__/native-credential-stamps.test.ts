import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { hash } from 'bcryptjs';
import { SignJWT, decodeJwt, jwtVerify, type JWTPayload } from 'jose';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { authSubjectCutoffs, mobileRefreshTokens, userCredentials, users } from '@boardsesh/db/schema/auth';
import { db } from '../db/client';
import { getWorkerDatabaseUrl } from './worker-db';
import { validateMobileJwt } from '../middleware/auth';
import { redisClientManager } from '../redis/client';
import {
  handleNativeAuthCredentials,
  handleNativeAuthExchange,
  handleNativeAuthRefresh,
  handleNativeAuthRegister,
  handleWatchPair,
  handleWatchPairCode,
  __resetNativeAuthStateForTests,
} from '../handlers/native-auth';
// The wire contract released Expo builds and the Garmin PairingView/TokenStore
// parse, and the app's own unverified `sub` reader, loaded unchanged. The app
// module sits outside this package's rootDir, so it is loaded by path.
import { assertLegacyNativeTokenPair } from '../auth/prototype/__tests__/identity-native-contract';
const { userIdFromJwt } = (await import(
  fileURLToPath(new URL('../../../mobile/src/lib/jwt-user-id.ts', import.meta.url))
)) as { userIdFromJwt: (token: string | null | undefined) => string | undefined };

// BA-04 PR 1: every newly issued native credential carries the generations
// read under the issuer's user lock and, for a password or provider proof, the
// sign-in second. A refresh copies its parent's stamps. Nothing reads them yet.
// Real handlers, real Postgres and Redis; no admission or database mock.

type Handler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;
type TokenPair = { jwt: string; refreshToken: string; userId: string; expiresAt: string };
type StampedClaims = JWTPayload & { gen?: unknown; ngen?: unknown; auth_time?: unknown };

const secret = 'native-credential-stamps-secret-with-at-least-thirty-two-bytes';
const signingKey = new TextEncoder().encode(secret);
const password = 'stamp-fixture-password';
const routes: Record<string, Handler> = {
  '/credentials': handleNativeAuthCredentials,
  '/exchange': handleNativeAuthExchange,
  '/register': handleNativeAuthRegister,
  '/refresh': handleNativeAuthRefresh,
  '/watch-code': handleWatchPairCode,
  '/watch': handleWatchPair,
};
const ownerId = randomUUID();
const ownerEmail = `stamps-${ownerId}@example.test`;
const registeredEmail = `stamps-registered-${randomUUID()}@example.test`;
const createdUserIds = new Set<string>([ownerId]);
const redisKeys = new Set<string>();
const pending = new Set<Promise<unknown>>();
let httpServer: Server;
let origin: string;
let blocker: ReturnType<typeof postgres>;
let observer: ReturnType<typeof postgres>;

function track<Result>(operation: Promise<Result>): Promise<Result> {
  pending.add(operation);
  void operation.then(
    () => pending.delete(operation),
    () => pending.delete(operation),
  );
  return operation;
}

async function bounded<Result>(operation: Promise<Result>, milliseconds = 7000): Promise<Result> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Stamp fixture deadline')), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function barrier() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function native(path: string, body: unknown = {}, bearer?: string): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(7000),
  });
}

async function issued(path: string, body: unknown = {}, bearer?: string): Promise<TokenPair> {
  const response = await native(path, body, bearer);
  expect(response.status).toBeLessThan(300);
  const pair = (await response.json()) as TokenPair;
  createdUserIds.add(pair.userId);
  return pair;
}

function transferToken(userId = ownerId) {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({ userId, nextPath: `/${randomUUID()}`, iat: now, exp: now + 120 }),
  ).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  redisKeys.add(`boardsesh:native-auth:consumed:${signature}`);
  return `${payload}.${signature}`;
}

/**
 * A phone's existing bearer credential: minted the way builds before the stamps
 * were, or stamped with the climber's current generations once a cutoff exists.
 */
async function phoneBearer(userId = ownerId, stamps: { gen: number; ngen: number } | null = null) {
  return new SignJWT({ sub: userId, ...stamps })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setIssuer('boardsesh')
    .setAudience('boardsesh-mobile')
    .setExpirationTime('1h')
    .sign(signingKey);
}

async function watchPair(userId = ownerId, stamps: { gen: number; ngen: number } | null = null): Promise<TokenPair> {
  const codeResponse = await native('/watch-code', {}, await phoneBearer(userId, stamps));
  expect(codeResponse.status).toBe(200);
  const { code } = (await codeResponse.json()) as { code: string };
  redisKeys.add(`boardsesh:watch:pair:${code}`);
  return issued('/watch', { code });
}

async function claims(pair: TokenPair): Promise<StampedClaims> {
  const verified = await jwtVerify(pair.jwt, signingKey, { issuer: 'boardsesh', audience: 'boardsesh-mobile' });
  return verified.payload as StampedClaims;
}

async function rowFor(refreshToken: string) {
  const [row] = await db
    .select()
    .from(mobileRefreshTokens)
    .where(eq(mobileRefreshTokens.tokenHash, createHash('sha256').update(refreshToken).digest('hex')));
  if (!row) throw new Error('Expected a refresh row for the issued token');
  return row;
}

async function setCutoff(generation: number, nativeGeneration: number) {
  await db
    .insert(authSubjectCutoffs)
    .values({
      userId: ownerId,
      generation,
      nativeGeneration,
      revokedThrough: new Date(),
      lastOperationId: randomUUID(),
    })
    .onConflictDoUpdate({ target: authSubjectCutoffs.userId, set: { generation, nativeGeneration } });
}

/** A refresh row written by a build from before the stamps: every stamp NULL. */
async function seedUnstampedRefresh() {
  const refreshToken = randomUUID();
  await db.insert(mobileRefreshTokens).values({
    userId: ownerId,
    tokenHash: createHash('sha256').update(refreshToken).digest('hex'),
    expiresAt: new Date(Date.now() + 60_000),
  });
  return refreshToken;
}

async function waitForLock(blockingPid: number, operation: Promise<unknown>) {
  let stopped = false;
  const polling = (async () => {
    while (!stopped) {
      const [state] = await observer<
        { waiting: boolean }[]
      >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${blockingPid}=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock') AS waiting`;
      if (state.waiting) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  })();
  try {
    await bounded(
      Promise.race([
        polling,
        operation.then(() => {
          throw new Error('Issuance passed the user lock');
        }),
      ]),
      3000,
    );
  } finally {
    stopped = true;
    await polling;
  }
}

function seconds(instant: Date) {
  return Math.floor(instant.getTime() / 1000);
}

describe('native credential stamps against the owned primary database', () => {
  beforeAll(async () => {
    const options = { max: 1, connect_timeout: 3, onnotice: () => {}, connection: { statement_timeout: 6000 } };
    blocker = postgres(getWorkerDatabaseUrl(), options);
    observer = postgres(getWorkerDatabaseUrl(), options);
    httpServer = createServer((request, response) => {
      const handler = routes[new URL(request.url ?? '/', 'http://localhost').pathname];
      if (!handler) {
        response.writeHead(404).end();
        return;
      }
      void track(handler(request, response)).catch(() => response.writeHead(500).end());
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', resolve);
    });
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Stamp fixture has no TCP port');
    origin = `http://127.0.0.1:${address.port}`;
    expect(await redisClientManager.connect()).toBe(true);
  });

  beforeEach(async () => {
    if (pending.size) throw new Error('Previous stamp fixture did not settle');
    vi.stubEnv('NEXTAUTH_SECRET', secret);
    vi.stubEnv('CURRENT_STORE_NATIVE_REGISTRATION_MODE', '');
    __resetNativeAuthStateForTests();
    await db.delete(authSubjectCutoffs).where(inArray(authSubjectCutoffs.userId, [...createdUserIds]));
    await db.delete(users).where(inArray(users.id, [...createdUserIds]));
    await db.insert(users).values({ id: ownerId, email: ownerEmail, name: 'Stamp owner' });
    await db.insert(userCredentials).values({ userId: ownerId, passwordHash: await hash(password, 4) });
  });

  afterEach(async () => {
    await bounded(Promise.allSettled(pending));
    if (redisKeys.size) await redisClientManager.getClients().publisher.del(...redisKeys);
    redisKeys.clear();
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await db.delete(authSubjectCutoffs).where(inArray(authSubjectCutoffs.userId, [...createdUserIds]));
    await db.delete(users).where(inArray(users.id, [...createdUserIds]));
    await blocker?.end({ timeout: 3 });
    await observer?.end({ timeout: 3 });
    if (httpServer)
      await new Promise<void>((resolve, reject) => httpServer.close((error) => (error ? reject(error) : resolve())));
    await redisClientManager.disconnect();
  });

  it('answers every issuer in the shape released apps and the Garmin watch parse, and the app still reads sub', async () => {
    const credentials = await issued('/credentials', { email: ownerEmail, password });
    const pairs: [string, TokenPair, string][] = [
      ['password sign-in', credentials, ownerId],
      ['web transfer', await issued('/exchange', { transferToken: transferToken() }), ownerId],
      ['watch pairing', await watchPair(), ownerId],
      ['refresh', await issued('/refresh', { refreshToken: credentials.refreshToken }), ownerId],
    ];
    const registered = await issued('/register', { email: registeredEmail, password, name: 'Registered climber' });
    pairs.push(['registration', registered, registered.userId]);

    for (const [, pair, userId] of pairs) {
      const payload = (await assertLegacyNativeTokenPair(pair, signingKey, userId)) as StampedClaims;
      expect(userIdFromJwt(pair.jwt)).toBe(userId);
      expect((await validateMobileJwt(pair.jwt))?.userId).toBe(userId);
      expect(Number.isSafeInteger(payload.gen)).toBe(true);
      expect(Number.isSafeInteger(payload.ngen)).toBe(true);
      if (payload.auth_time !== undefined) expect(Number.isSafeInteger(payload.auth_time)).toBe(true);
      // The stamps never displace or shadow a claim a client or validator reads.
      expect(Object.keys(payload).sort()).toEqual(
        [
          'aud',
          'exp',
          'gen',
          'iat',
          'iss',
          'ngen',
          'sub',
          ...(payload.auth_time === undefined ? [] : ['auth_time']),
        ].sort(),
      );
    }
  });

  it('adds at most 60 characters to a native JWT', async () => {
    const pair = await issued('/credentials', { email: ownerEmail, password });
    const { sub, iat, exp, iss, aud, gen, ngen, auth_time: authTime } = await claims(pair);
    expect([gen, ngen, typeof authTime]).toEqual([0, 0, 'number']);
    // The same token as builds before the stamps signed it: these five claims only.
    const before = await new SignJWT({ sub, iat, exp, iss, aud })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .sign(signingKey);
    expect(pair.jwt.length - before.length).toBeGreaterThan(0);
    expect(pair.jwt.length - before.length).toBeLessThanOrEqual(60);
  });

  it('stamps a password sign-in with the generations read under the user lock and the sign-in second', async () => {
    await setCutoff(2, 5);
    const startedAt = Date.now();
    const pair = await issued('/credentials', { email: ownerEmail, password });
    const finishedAt = Date.now();
    const row = await rowFor(pair.refreshToken);
    const payload = await claims(pair);

    expect(payload).toMatchObject({ sub: ownerId, gen: 2, ngen: 5 });
    expect(row).toMatchObject({ subjectGeneration: 2, nativeGeneration: 5 });
    expect(row.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.authenticatedAt?.getTime()).toBeGreaterThanOrEqual(startedAt);
    expect(row.authenticatedAt?.getTime()).toBeLessThanOrEqual(finishedAt);
    expect(payload.auth_time).toBe(seconds(row.authenticatedAt!));
  });

  it.each(['/exchange', '/watch'])(
    'stamps %s with the current generations but never a sign-in time it did not see',
    async (path) => {
      await setCutoff(1, 3);
      const pair =
        path === '/exchange'
          ? await issued(path, { transferToken: transferToken() })
          : await watchPair(ownerId, { gen: 1, ngen: 3 });
      const row = await rowFor(pair.refreshToken);

      expect(await claims(pair)).toMatchObject({ gen: 1, ngen: 3 });
      expect(await claims(pair)).not.toHaveProperty('auth_time');
      expect(row).toMatchObject({ subjectGeneration: 1, nativeGeneration: 3, authenticatedAt: null });
      expect(row.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    },
  );

  it('reads the generations a mutation committed while the issuer waited for the user lock', async () => {
    const locked = barrier(),
      release = barrier();
    let blockingPid = 0;
    // A reset in the planned order: users FOR UPDATE, then the cutoff row.
    const mutation = track(
      blocker.begin(async (transaction) => {
        const [pid] = await transaction<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        blockingPid = pid.pid;
        await transaction`SELECT id FROM users WHERE id=${ownerId} FOR UPDATE`;
        await transaction`INSERT INTO auth_subject_cutoffs (user_id, generation, native_generation, revoked_through, last_operation_id)
          VALUES (${ownerId}, 6, 3, clock_timestamp(), ${randomUUID()})`;
        locked.release();
        await release.promise;
      }),
    );
    let exchange: Promise<Response> | undefined;
    try {
      await bounded(locked.promise);
      exchange = track(native('/exchange', { transferToken: transferToken() }));
      await waitForLock(blockingPid, exchange);
    } finally {
      release.release();
      await bounded(mutation);
    }
    const response = await bounded(exchange!);
    expect(response.status).toBe(200);
    const pair = (await response.json()) as TokenPair;

    expect(await claims(pair)).toMatchObject({ gen: 6, ngen: 3 });
    expect(await rowFor(pair.refreshToken)).toMatchObject({ subjectGeneration: 6, nativeGeneration: 3 });
  });

  it('keeps auth_time, both generations and the session through three rotations', async () => {
    await setCutoff(4, 1);
    const signIn = await issued('/credentials', { email: ownerEmail, password });
    // Move the sign-in three days back, so a rotation that stamped its own time
    // instead of copying the parent's could not land on the same second.
    const signedInAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await db
      .update(mobileRefreshTokens)
      .set({ authenticatedAt: signedInAt })
      .where(eq(mobileRefreshTokens.id, (await rowFor(signIn.refreshToken)).id));
    const { sessionId } = await rowFor(signIn.refreshToken);

    let current = signIn;
    for (let rotation = 1; rotation <= 3; rotation += 1) {
      current = await issued('/refresh', { refreshToken: current.refreshToken });
      const row = await rowFor(current.refreshToken);
      expect(row).toMatchObject({ subjectGeneration: 4, nativeGeneration: 1, sessionId });
      expect(row.authenticatedAt?.getTime()).toBe(signedInAt.getTime());
      expect(await claims(current)).toMatchObject({ gen: 4, ngen: 1, auth_time: seconds(signedInAt) });
    }
  });

  it('copies stamps, never re-reads them: a later mutation reaches no child through its parent', async () => {
    await setCutoff(4, 1);
    const signIn = await issued('/credentials', { email: ownerEmail, password });
    const { sessionId } = await rowFor(signIn.refreshToken);
    // Enforcing readers refuse such a parent (BA-04 PR 2). Under observe the
    // issuer still mints, which is where copy versus re-read shows.
    vi.stubEnv('AUTH_CUTOFF_ENFORCEMENT', 'observe');
    let current = signIn;
    for (let rotation = 1; rotation <= 3; rotation += 1) {
      await setCutoff(4 + rotation, 1 + rotation);
      current = await issued('/refresh', { refreshToken: current.refreshToken });
      expect(await rowFor(current.refreshToken)).toMatchObject({
        subjectGeneration: 4,
        nativeGeneration: 1,
        sessionId,
      });
      expect(await claims(current)).toMatchObject({ gen: 4, ngen: 1 });
    }
    vi.stubEnv('AUTH_CUTOFF_ENFORCEMENT', 'enforce');
    expect((await native('/refresh', { refreshToken: current.refreshToken })).status).toBe(401);
  });

  it('never gives a child of an unstamped refresh row a sign-in time or a newer generation', async () => {
    await setCutoff(3, 2);
    const unstamped = await seedUnstampedRefresh();
    // An unstamped row stands for generation 0, so enforcing readers refuse it here.
    expect((await native('/refresh', { refreshToken: unstamped })).status).toBe(401);
    vi.stubEnv('AUTH_CUTOFF_ENFORCEMENT', 'observe');
    const first = await issued('/refresh', { refreshToken: unstamped });
    const firstRow = await rowFor(first.refreshToken);
    expect(firstRow).toMatchObject({ subjectGeneration: 0, nativeGeneration: 0, authenticatedAt: null });
    expect(firstRow.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(decodeJwt(first.jwt)).toMatchObject({ gen: 0, ngen: 0 });
    expect(decodeJwt(first.jwt)).not.toHaveProperty('auth_time');

    // The family is bound to one session from that rotation on.
    const second = await issued('/refresh', { refreshToken: first.refreshToken });
    expect(await rowFor(second.refreshToken)).toMatchObject({
      subjectGeneration: 0,
      nativeGeneration: 0,
      authenticatedAt: null,
      sessionId: firstRow.sessionId,
    });
    expect(decodeJwt(second.jwt)).not.toHaveProperty('auth_time');
  });

  it('gives a new sign-in its own session while an older family keeps its own', async () => {
    const older = await issued('/credentials', { email: ownerEmail, password });
    const newer = await issued('/exchange', { transferToken: transferToken() });
    const rotated = await issued('/refresh', { refreshToken: older.refreshToken });
    const [olderRow, newerRow, rotatedRow] = await Promise.all(
      [older, newer, rotated].map((pair) => rowFor(pair.refreshToken)),
    );
    expect(newerRow.sessionId).not.toBe(olderRow.sessionId);
    expect(rotatedRow.sessionId).toBe(olderRow.sessionId);
  });
});
