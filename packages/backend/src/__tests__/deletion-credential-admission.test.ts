import { createHash, createHmac, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { createRequire } from 'node:module';
import { fork, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import postgres from 'postgres';
import { SignJWT, jwtVerify } from 'jose';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { WebSocket, type WebSocketServer } from 'ws';
import {
  authEmailProjection,
  authEmailReservationMembers,
  authEmailReservations,
  authPasswordRecoveryState,
  authPasswordRecoveryTokens,
  authSecurityMutationEvents,
  authSubjectCutoffs,
  mobileRefreshTokens,
  userCredentials,
  users,
} from '@boardsesh/db/schema/auth';
import { AUTH_PROTOCOL_VERSION } from '@boardsesh/auth-protocol';
import { db } from '../db/client';
import { notifications } from '@boardsesh/db/schema/app';
import { getWorkerDatabaseName, getWorkerDatabaseUrl } from './worker-db';
import { validateMobileJwt, validateNextAuthToken, validateToken } from '../middleware/auth';
import { getAdmissionPool } from '../auth/admission-pool';
import { AuthAdmissionUnavailableError, requireHumanSubjectForIssuance } from '../auth/human-admission';
import { prepareProjectionUnderUsersTableLock, reserveEnforcedEmail } from '../auth/current-store/email-reservations';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../auth/current-store/foundation-context';
import { consumePasswordRecovery, requestPasswordRecovery } from '../auth/current-store/password-recovery';
import { createYogaInstance } from '../graphql/yoga';
import {
  handleNativeAuthCredentials,
  handleNativeAuthExchange,
  handleNativeAuthRefresh,
  handleWatchPair,
  handleWatchPairCode,
  __resetNativeAuthStateForTests,
} from '../handlers/native-auth';
import { handleOcrTestDataUpload } from '../handlers/ocr-test-data';
import { handleAvatarUpload } from '../handlers/avatars';
import { handleGymPhotoUpload } from '../handlers/gym-photos';
import { handleFeedbackScreenshotUpload } from '../handlers/feedback-screenshots';
import { handleSprayWallPhotoUpload } from '../handlers/spray-wall-photos';
import { handleSprayWallTestDataUpload } from '../handlers/spray-wall-test-data';
import { handleAuroraCredentials } from '../handlers/aurora-credentials';
import { handleAuroraImport } from '../handlers/aurora-import';
import { handleMoonBoardImport } from '../handlers/moonboard-import';
import { handleKilterCredentialsHandoff } from '../handlers/kilter-credentials-oauth';
import { handleUserDataExport } from '../handlers/user-data-export';
import { handleSessionState } from '../handlers/session-state';
import { __resetSessionUserRateLimitForTests } from '../handlers/session-user-rate-limit';
import { setupWebSocketServer } from '../websocket/setup';
import { redisClientManager } from '../redis/client';
import { pubsub } from '../pubsub';
import { getConnectionCount } from '../graphql/context';
import { stopClientUsageReporter } from '../services/client-usage';

// graphql-ws checks returned errors with instanceof. Match its external Node
// constructor instead of Vite's separate graphql/index.mjs module instance.
vi.mock('graphql', async () => {
  const { createRequire } = await import('node:module');
  return createRequire(import.meta.url)('graphql') as typeof import('graphql');
});

// Real primary SQL, public token encoders, mounted Yoga/native/WS handlers.
// No validator/admission mock or admission-off switch is used in this file.
const publicJwt = createRequire(new URL('../../../web/package.json', import.meta.url))('next-auth/jwt') as {
  encode(options: { token: Record<string, unknown>; secret: string; maxAge?: number }): Promise<string>;
};
const secret = 'owned-deletion-reader-secret-with-at-least-thirty-two-bytes';
const ownerId = randomUUID(),
  otherId = randomUUID();
const hiddenCutoffTable = `owned_hidden_cutoff_${randomUUID().replaceAll('-', '')}`;
const issuerTriggerName = `owned_refresh_barrier_${randomUUID().replaceAll('-', '')}`;
const issuerAdvisoryKey = Number.parseInt(randomUUID().replaceAll('-', '').slice(0, 7), 16);
type Handler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;
type GraphqlBody = {
  data?: { authenticatedUserId?: string; deleteAccount?: boolean } | null;
  errors?: { extensions?: { code?: string }; message: string }[];
};
type TokenPair = { jwt: string; refreshToken: string; userId: string; expiresAt: string };
const routes: Record<string, Handler> = {
  '/credentials': handleNativeAuthCredentials,
  '/exchange': handleNativeAuthExchange,
  '/refresh': handleNativeAuthRefresh,
  '/watch-code': handleWatchPairCode,
  '/watch': handleWatchPair,
  '/ocr': handleOcrTestDataUpload,
  '/avatar': handleAvatarUpload,
  '/gym-photo': handleGymPhotoUpload,
  '/feedback': handleFeedbackScreenshotUpload,
  '/spray-photo': handleSprayWallPhotoUpload,
  '/spray-test': handleSprayWallTestDataUpload,
  '/aurora-credentials': handleAuroraCredentials,
  '/aurora-import': handleAuroraImport,
  '/moonboard-import': handleMoonBoardImport,
  '/board-handoff': handleKilterCredentialsHandoff,
  '/export': (request, response) => handleUserDataExport(request, response, new URL(request.url ?? '/', origin)),
  '/session': (request, response) => handleSessionState(request, response, new URL(request.url ?? '/', origin)),
};
let httpServer: Server;
let origin: string;
let blocker: ReturnType<typeof postgres>;
let observer: ReturnType<typeof postgres>;
let schemaHidden = false;
let cleanupFailed = false;
const sockets = new Set<WebSocket>();
const servers: { http: Server; wss: WebSocketServer; pingInterval: NodeJS.Timeout; url: string }[] = [];
const pending = new Set<Promise<unknown>>();
const redisKeys = new Set<string>();
type OwnedChild = {
  process: ChildProcess;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  receipt?: Record<string, unknown>;
};
const children: OwnedChild[] = [];
let connectionBaseline = 0;
let notificationBaseline = 0;

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
        timer = setTimeout(() => reject(new Error('Owned admission fixture deadline')), milliseconds);
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
async function until(predicate: () => boolean | Promise<boolean>, milliseconds = 4000) {
  const deadline = performance.now() + milliseconds;
  while (!(await predicate())) {
    if (performance.now() >= deadline) throw new Error('Owned admission observation deadline');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function startOwnedChild() {
  const child = fork(new URL('./helpers/deletion-admission-ws-process.ts', import.meta.url), [], {
    execArgv: ['--import', createRequire(import.meta.url).resolve('tsx')],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: {
      PATH: process.env.PATH ?? '',
      NODE_ENV: 'test',
      VITEST: 'true',
      TZ: 'UTC',
      CI: process.env.CI ?? '',
      GITHUB_ACTIONS: process.env.GITHUB_ACTIONS ?? '',
      DATABASE_URL: getWorkerDatabaseUrl(),
      READ_REPLICA_URL: '',
      REDIS_URL: process.env.REDIS_URL ?? '',
      NEXTAUTH_SECRET: secret,
      KILTER_LIVE_SYNC_ENABLED: '0',
      DEBUG_SQL: 'false',
      BOARDSESH_ADMISSION_FIXTURE_DB_NAME: getWorkerDatabaseName(),
      BOARDSESH_ADMISSION_FIXTURE_CANONICAL:
        process.env.VITEST === 'true' && !process.env.CI && process.env.SKIP_TEST_INFRA !== '1' ? '1' : '0',
    },
  });
  const owned: OwnedChild = {
    process: child,
    closed: new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal }))),
  };
  children.push(owned);
  let complete = (_url: string) => {};
  let fail = () => {};
  const ready = new Promise<string>((resolve, reject) => {
    complete = resolve;
    fail = () => reject(new Error('Owned WS child did not become ready'));
  });
  void ready.catch(() => undefined);
  child.once('error', fail);
  child.once('close', fail);
  child.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object') return;
    const result = message as Record<string, unknown>;
    if (result.type === 'failure') fail();
    if (result.type === 'closed') owned.receipt = result;
    if (
      result.type === 'ready' &&
      typeof result.url === 'string' &&
      /^ws:\/\/127\.0\.0\.1:\d+\/graphql$/.test(result.url)
    )
      complete(result.url);
  });
  return { ...owned, url: await bounded(ready, 20000) };
}
async function stopOwnedChild(owned: OwnedChild) {
  try {
    if (owned.process.connected) owned.process.send({ type: 'stop' });
    const closed = await bounded(owned.closed, 10000);
    if (
      closed.code !== 0 ||
      closed.signal !== null ||
      !owned.receipt ||
      owned.receipt.registryDrained !== true ||
      owned.receipt.listenersClosed !== true ||
      owned.receipt.poolsClosed !== true ||
      owned.receipt.redisClosed !== true
    )
      throw new Error('Owned WS child shutdown was not clean');
  } catch {
    if (owned.process.exitCode === null && owned.process.signalCode === null) owned.process.kill('SIGKILL');
    await bounded(owned.closed, 3000);
    throw new Error('Owned WS child required forced cleanup; fixture retained');
  }
}
async function clearIssuerBarrier() {
  await db.execute(sql`DROP TRIGGER IF EXISTS ${sql.identifier(issuerTriggerName)} ON mobile_refresh_tokens`);
  await db.execute(sql`DROP FUNCTION IF EXISTS ${sql.identifier(issuerTriggerName)}()`);
}
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Owned admission fixture has no TCP port');
  return `http://127.0.0.1:${address.port}`;
}
async function native(path: string, body: unknown = {}, token?: string): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(7000),
  });
}
/** `token` null sends no Authorization header at all. */
async function graphql(token: string | null, query = '{ authenticatedUserId }') {
  const response = await createYogaInstance().fetch('http://localhost/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token === null ? {} : { Authorization: `Bearer ${token}` }) },
    body: JSON.stringify({ query }),
  });
  return { status: response.status, body: (await response.json()) as GraphqlBody };
}
/**
 * What the app's interceptor (`packages/mobile/src/lib/auth-interceptor.ts`)
 * and the web reader (`credential-admission.server.ts`) read as a refusal: HTTP
 * 401 carrying exactly one UNAUTHENTICATED error and no data.
 */
const REFUSED = {
  status: 401,
  body: { errors: [{ message: 'Authentication is required', extensions: { code: 'UNAUTHENTICATED' } }] },
} as const;
/** No stamps is a credential from before BA-04 PR 1. The web JWE carries `gen` only. */
async function tokens(userId = ownerId, stamps: { gen?: number; ngen?: number } = {}) {
  const webStamp = stamps.gen === undefined ? {} : { gen: stamps.gen };
  return {
    jwe: await publicJwt.encode({ token: { sub: userId, ...webStamp }, secret, maxAge: 3600 }),
    jws: await new SignJWT({ sub: userId, ...stamps })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer('boardsesh')
      .setAudience('boardsesh-mobile')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(secret)),
  };
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
async function warm(credentials: Awaited<ReturnType<typeof tokens>>, userId = ownerId) {
  expect((await validateNextAuthToken(credentials.jwe))?.userId).toBe(userId);
  expect((await validateMobileJwt(credentials.jws))?.userId).toBe(userId);
  expect((await validateToken(credentials.jwe))?.userId).toBe(userId);
  expect((await validateToken(credentials.jws))?.userId).toBe(userId);
}
async function cutoff(deletedAt: Date | null = new Date()) {
  await db
    .insert(authSubjectCutoffs)
    .values({ userId: ownerId, generation: 1, revokedThrough: new Date(), deletedAt, lastOperationId: randomUUID() });
}
async function hideAuthority() {
  await db.execute(sql`ALTER TABLE auth_subject_cutoffs RENAME TO ${sql.identifier(hiddenCutoffTable)}`);
  schemaHidden = true;
}
async function restoreAuthority() {
  if (!schemaHidden) return;
  await db.execute(sql`ALTER TABLE ${sql.identifier(hiddenCutoffTable)} RENAME TO auth_subject_cutoffs`);
  schemaHidden = false;
}
async function seedRefresh(stamps: { subjectGeneration: number; nativeGeneration: number } | null = null) {
  const refreshToken = randomUUID();
  await db.insert(mobileRefreshTokens).values({
    userId: ownerId,
    tokenHash: createHash('sha256').update(refreshToken).digest('hex'),
    expiresAt: new Date(Date.now() + 60000),
    ...(stamps ? { ...stamps, authenticatedAt: new Date(), sessionId: randomUUID() } : {}),
  });
  return refreshToken;
}
const ownerEmail = () => `${ownerId}@admission.example.test`;
async function seedPassword(password: string) {
  // 4 rounds: these tests are about what a sign-in is stamped with, not bcrypt cost.
  await db.insert(userCredentials).values({ userId: ownerId, passwordHash: await bcrypt.hash(password, 4) });
}
async function signIn(password: string): Promise<TokenPair> {
  const response = await native('/credentials', { email: ownerEmail(), password });
  expect(response.status).toBe(200);
  return (await response.json()) as TokenPair;
}
async function claimsOf(jwt: string) {
  return (await jwtVerify(jwt, new TextEncoder().encode(secret), { issuer: 'boardsesh', audience: 'boardsesh-mobile' }))
    .payload;
}
/**
 * A real staged password reset: enforced projection, reserved email, forgot,
 * then consume. It bumps the generation through `recordSecurityMutation`.
 */
async function stagedReset(newPassword: string) {
  const authority = {
    expectedProjectionId: randomUUID(),
    expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
    expectedWriterEpoch: 1,
    emailVerificationEnabled: false,
  };
  await db.transaction(async (transaction) => {
    await prepareProjectionUnderUsersTableLock(transaction, { projectionId: authority.expectedProjectionId });
    await transaction
      .update(authEmailProjection)
      .set({ phase: 'enforced' })
      .where(eq(authEmailProjection.projectionId, authority.expectedProjectionId));
  });
  await db.transaction((transaction) =>
    reserveEnforcedEmail(transaction, { ...authority, rawEmail: ownerEmail(), requestedUserId: ownerId }),
  );
  const forgot = await requestPasswordRecovery(db, authority, {
    protocolVersion: AUTH_PROTOCOL_VERSION,
    operation: 'forgot-password',
    requestId: randomUUID(),
    issuedAt: Date.now(),
    payload: { email: ownerEmail() },
  });
  if (forgot.outcome !== 'accepted' || !forgot.mailPlan) throw new Error('Owned reset fixture issued no link');
  const reset = await consumePasswordRecovery(db, authority, {
    protocolVersion: AUTH_PROTOCOL_VERSION,
    operation: 'reset-password',
    requestId: randomUUID(),
    issuedAt: Date.now(),
    payload: { token: forgot.mailPlan.token, email: ownerEmail(), password: newPassword, confirmPassword: newPassword },
  });
  expect(reset.outcome).toBe('reset');
  const [row] = await db.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, ownerId));
  expect(row).toMatchObject({ generation: 1, nativeGeneration: 0, deletedAt: null });
}
async function acknowledged(client: Awaited<ReturnType<typeof connect>>) {
  await until(() => client.frames.some((frame) => frame.type === 'connection_ack'));
}
async function refreshRows() {
  return db
    .select()
    .from(mobileRefreshTokens)
    .where(eq(mobileRefreshTokens.userId, ownerId))
    .orderBy(mobileRefreshTokens.id);
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
          throw new Error('Issuance passed the lock barrier');
        }),
      ]),
      2000,
    );
  } finally {
    stopped = true;
    await polling;
  }
}
async function webSocketServer() {
  const http = createServer();
  const setup = setupWebSocketServer(http);
  const url = (await listen(http)).replace('http:', 'ws:') + '/graphql';
  const server = { http, ...setup, url };
  servers.push(server);
  return server;
}
/** `token` null sends a connection_init with no credential. */
async function connect(url: string, token: string | null) {
  const socket = new WebSocket(url, 'graphql-transport-ws');
  sockets.add(socket);
  const frames: { type: string; id?: string; payload?: unknown }[] = [];
  const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));
  socket.on('message', (message) => {
    const buffer = Array.isArray(message)
      ? Buffer.concat(message)
      : Buffer.isBuffer(message)
        ? message
        : Buffer.from(message);
    frames.push(JSON.parse(buffer.toString('utf8')) as (typeof frames)[number]);
  });
  await bounded(
    new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    }),
  );
  socket.send(JSON.stringify({ type: 'connection_init', payload: token === null ? {} : { authToken: token } }));
  return { socket, frames, closed };
}
/** A handshake the server refused: closed with `code`, never acknowledged. */
async function closedWithoutAck(client: Awaited<ReturnType<typeof connect>>, code: number) {
  expect(await bounded(client.closed, 4000)).toBe(code);
  expect(client.frames.some((frame) => frame.type === 'connection_ack')).toBe(false);
}

describe('mounted deletion admission against the owned primary database', () => {
  beforeAll(async () => {
    const address = new URL(getWorkerDatabaseUrl());
    const canonical =
      (['1', 'true'].includes(process.env.CI ?? '') && process.env.GITHUB_ACTIONS === 'true') ||
      (process.env.VITEST === 'true' && !process.env.CI && process.env.SKIP_TEST_INFRA !== '1');
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname) ||
      !(['15478'].includes(address.port) || (address.port === '5433' && canonical)) ||
      address.pathname !== `/${getWorkerDatabaseName()}` ||
      process.env.DATABASE_URL !== getWorkerDatabaseUrl()
    )
      throw new Error('Admission proof requires the exact owned backend worker database');
    const options = {
      max: 1,
      connect_timeout: 3,
      onnotice: () => {},
      connection: { statement_timeout: 6000, lock_timeout: 4000 },
    };
    blocker = postgres(address.href, options);
    observer = postgres(address.href, options);
    httpServer = createServer((request, response) => {
      const handler = routes[new URL(request.url ?? '/', 'http://localhost').pathname];
      if (!handler) {
        response.writeHead(404).end();
        return;
      }
      void track(handler(request, response)).catch(() => {
        response.writeHead(500).end();
      });
    });
    origin = await listen(httpServer);
    expect(await redisClientManager.connect()).toBe(true);
  });
  beforeEach(async () => {
    if (cleanupFailed || pending.size || schemaHidden) throw new Error('Previous admission fixture did not settle');
    vi.stubEnv('NEXTAUTH_SECRET', secret);
    vi.stubEnv('CURRENT_STORE_ACCOUNT_DELETION_MODE', '');
    vi.stubEnv('AUTH_CUTOFF_ENFORCEMENT', '');
    __resetNativeAuthStateForTests();
    connectionBaseline = getConnectionCount();
    notificationBaseline = pubsub.getRuntimeStats().notification.subscribers;
    await clearIssuerBarrier();
    await db.delete(authEmailReservationMembers);
    await db.delete(authEmailReservations);
    await db.delete(authSecurityMutationEvents);
    await db.delete(authSubjectCutoffs);
    await db.delete(authEmailProjection);
    await db.delete(authPasswordRecoveryTokens).where(inArray(authPasswordRecoveryTokens.userId, [ownerId, otherId]));
    await db.delete(authPasswordRecoveryState).where(inArray(authPasswordRecoveryState.userId, [ownerId, otherId]));
    await db.delete(users).where(inArray(users.id, [ownerId, otherId]));
    await db.insert(users).values([
      { id: ownerId, email: `${ownerId}@admission.example.test`, name: 'Deleted credential owner' },
      { id: otherId, email: `${otherId}@admission.example.test`, name: 'Unaffected credential owner' },
    ]);
  });
  afterEach(async () => {
    // Start every owned child drain even if another cleanup phase fails.
    const childDrain = Promise.allSettled(children.splice(0).map(stopOwnedChild));
    let failed = false;
    try {
      await restoreAuthority();
      for (const socket of sockets) socket.terminate();
      sockets.clear();
      for (const server of servers.splice(0)) {
        clearInterval(server.pingInterval);
        for (const socket of server.wss.clients) socket.terminate();
        await bounded(
          new Promise<void>((resolve, reject) => server.wss.close((error) => (error ? reject(error) : resolve()))),
          4000,
        );
        await bounded(
          new Promise<void>((resolve, reject) => server.http.close((error) => (error ? reject(error) : resolve()))),
          4000,
        );
      }
      // graphql-ws does not await its async onDisconnect from raw TCP close.
      // Observe real registries before any following worker/table reset.
      await until(
        () =>
          getConnectionCount() === connectionBaseline &&
          pubsub.getRuntimeStats().notification.subscribers === notificationBaseline,
      );
      await bounded(Promise.allSettled(pending));
      await clearIssuerBarrier();
      if (redisKeys.size) await redisClientManager.getClients().publisher.del(...redisKeys);
      redisKeys.clear();
    } catch {
      failed = true;
    }
    if ((await childDrain).some((result) => result.status === 'rejected')) failed = true;
    stopClientUsageReporter();
    __resetSessionUserRateLimitForTests();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    if (failed) {
      cleanupFailed = true;
      throw new Error('Owned admission cleanup failed; fixture retained');
    }
  });
  afterAll(async () => {
    await blocker?.end({ timeout: 3 });
    await observer?.end({ timeout: 3 });
    if (httpServer)
      await new Promise<void>((resolve, reject) => httpServer.close((error) => (error ? reject(error) : resolve())));
    await redisClientManager.disconnect();
  });

  it('denies all warm direct and dispatch validators after mounted reserved deletion, preserving the other UID', async () => {
    const credentials = await tokens(),
      other = await tokens(otherId);
    await warm(credentials);
    await warm(other, otherId);
    const projectionId = randomUUID();
    await db.transaction(async (transaction) => {
      await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
      await transaction
        .update(authEmailProjection)
        .set({ phase: 'enforced' })
        .where(eq(authEmailProjection.projectionId, projectionId));
    });
    vi.stubEnv('CURRENT_STORE_ACCOUNT_DELETION_MODE', 'reserved-staging');
    vi.stubEnv('CURRENT_STORE_AUTH_PROJECTION_ID', projectionId);
    vi.stubEnv('CURRENT_STORE_AUTH_WRITER_EPOCH', '1');
    expect(
      (await graphql(credentials.jwe, 'mutation { deleteAccount(input: { removeSetterName: false }) }')).body,
    ).toEqual({ data: { deleteAccount: true } });
    expect(await validateNextAuthToken(credentials.jwe)).toBeNull();
    expect(await validateMobileJwt(credentials.jws)).toBeNull();
    expect(await validateToken(credentials.jwe)).toBeNull();
    expect(await validateToken(credentials.jws)).toBeNull();
    // Refused, not served as anonymous: 401 signs the app out, and a new
    // socket is closed 4401 before any ACK.
    expect(await graphql(credentials.jwe)).toEqual(REFUSED);
    expect(await graphql(credentials.jws)).toEqual(REFUSED);
    const server = await webSocketServer();
    await closedWithoutAck(await connect(server.url, credentials.jws), 4401);
    await closedWithoutAck(await connect(server.url, credentials.jwe), 4401);
    await warm(other, otherId);
    await acknowledged(await connect(server.url, other.jws));
    // The tombstone survives physical deletion and remains authoritative even
    // if a legacy writer incorrectly recreates the same UID.
    await db.insert(users).values({ id: ownerId, email: `${ownerId}@resurrected.example.test` });
    vi.stubEnv('CURRENT_STORE_ACCOUNT_DELETION_MODE', '');
    expect(await validateToken(credentials.jwe)).toBeNull();
  });

  it('denies an unstamped credential once its generation moves, and legacy physical deletion without a tombstone', async () => {
    const unstamped = await tokens(),
      other = await tokens(otherId);
    await warm(unstamped);
    await warm(other, otherId);
    await cutoff(null);
    // Issued before BA-04 PR 1, so under generation 0, the only one there was.
    expect(await validateNextAuthToken(unstamped.jwe)).toBeNull();
    expect(await validateMobileJwt(unstamped.jws)).toBeNull();
    expect(await validateToken(unstamped.jwe)).toBeNull();
    expect(await validateToken(unstamped.jws)).toBeNull();
    expect((await graphql(unstamped.jwe)).body.errors?.[0].extensions?.code).toBe('UNAUTHENTICATED');
    // The other account's generation did not move.
    await warm(other, otherId);
    const current = await tokens(ownerId, { gen: 1, ngen: 0 });
    await warm(current);
    expect(
      (await graphql(current.jwe, 'mutation { deleteAccount(input: { removeSetterName: false }) }')).body.data
        ?.deleteAccount,
    ).toBe(true);
    await db.delete(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, ownerId));
    // No tombstone and generation 0 again: the unstamped stamp matches, the missing user does not.
    expect(await validateToken(unstamped.jwe)).toBeNull();
    expect(await validateMobileJwt(unstamped.jws)).toBeNull();
    expect(await validateToken(current.jwe)).toBeNull();
    // A missing account is refused the same way as a tombstoned one.
    expect(await graphql(current.jws)).toEqual(REFUSED);
    await closedWithoutAck(await connect((await webSocketServer()).url, current.jws), 4401);
    await warm(other, otherId);
  });

  it('ends the web cookie, native JWT, refresh token and sockets at a real reset; a fresh sign-in works straight after', async () => {
    await seedPassword('owned-cutoff-password-before');
    const pair = await signIn('owned-cutoff-password-before');
    expect(await claimsOf(pair.jwt)).toMatchObject({ sub: ownerId, gen: 0, ngen: 0 });
    // What the web stamps at sign-in today, and a cookie from before the claim.
    const web = await tokens(ownerId, { gen: 0 }),
      legacy = await tokens();
    const server = await webSocketServer();
    const appSocket = await connect(server.url, pair.jwt),
      webSocket = await connect(server.url, web.jwe);
    await acknowledged(appSocket);
    await acknowledged(webSocket);
    expect((await validateMobileJwt(pair.jwt))?.userId).toBe(ownerId);
    await warm(web);
    await warm(legacy);

    await stagedReset('owned-cutoff-password-after');

    expect(await validateMobileJwt(pair.jwt)).toBeNull();
    expect(await validateToken(pair.jwt)).toBeNull();
    expect(await validateNextAuthToken(web.jwe)).toBeNull();
    expect(await validateToken(legacy.jwe)).toBeNull();
    expect(await validateToken(legacy.jws)).toBeNull();
    // A refused bearer is answered 401, not served as anonymous: the app's
    // interceptor refreshes, the refresh below is 401 too, and it signs out.
    // The web reader (credential-admission.server.ts) reads the same denial.
    expect(await graphql(pair.jwt)).toEqual(REFUSED);
    expect(await graphql(web.jwe)).toEqual(REFUSED);
    expect(await graphql(legacy.jwe)).toEqual(REFUSED);
    expect(await graphql(legacy.jws)).toEqual(REFUSED);
    expect((await native('/refresh', { refreshToken: pair.refreshToken })).status).toBe(401);
    // Idle sockets: the sweep closes both with no frame from the client.
    expect(await bounded(Promise.all([appSocket.closed, webSocket.closed]), 4000)).toEqual([4401, 4401]);
    // A backgrounded phone reconnecting with the same JWT is refused at the handshake.
    await closedWithoutAck(await connect(server.url, pair.jwt), 4401);
    await closedWithoutAck(await connect(server.url, web.jwe), 4401);

    const fresh = await signIn('owned-cutoff-password-after');
    expect(await claimsOf(fresh.jwt)).toMatchObject({ sub: ownerId, gen: 1, ngen: 0 });
    expect((await validateMobileJwt(fresh.jwt))?.userId).toBe(ownerId);
    const rotated = await native('/refresh', { refreshToken: fresh.refreshToken });
    expect(rotated.status).toBe(200);
    const rotatedPair = (await rotated.json()) as TokenPair;
    expect(await claimsOf(rotatedPair.jwt)).toMatchObject({ gen: 1, ngen: 0 });
    expect((await validateMobileJwt(rotatedPair.jwt))?.userId).toBe(ownerId);
    expect(await graphql(rotatedPair.jwt)).toEqual({ status: 200, body: { data: { authenticatedUserId: ownerId } } });
    await warm(await tokens(ownerId, { gen: 1, ngen: 0 }));
    const freshSocket = await connect(server.url, rotatedPair.jwt);
    await acknowledged(freshSocket);
    // Longer than one sweep.
    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect(freshSocket.socket.readyState).toBe(WebSocket.OPEN);
  }, 20000);

  it.each([
    [
      'a stamped row after a reset',
      { subjectGeneration: 0, nativeGeneration: 0 },
      { generation: 1, nativeGeneration: 0 },
    ],
    [
      'a stamped row after an app sign-out',
      { subjectGeneration: 0, nativeGeneration: 0 },
      { generation: 0, nativeGeneration: 1 },
    ],
    ['a row from before the stamps', null, { generation: 1, nativeGeneration: 0 }],
  ] as const)(
    'refuses to rotate %s, so the app signs out instead of looping refresh -> 401',
    async (_label, stamps, generations) => {
      const refreshToken = await seedRefresh(stamps);
      const before = await refreshRows();
      await db.insert(authSubjectCutoffs).values({
        userId: ownerId,
        ...generations,
        revokedThrough: new Date(),
        lastOperationId: randomUUID(),
      });
      const response = await native('/refresh', { refreshToken });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Account is not available' });
      // Nothing was minted, and the refused parent was left exactly as it was.
      expect(await refreshRows()).toEqual(before);
      // The app's JWT from before is ended too; the website only by a reset,
      // never by an app sign-out (decision 10).
      const earlier = await tokens(ownerId, { gen: 0, ngen: 0 });
      expect(await validateMobileJwt(earlier.jws)).toBeNull();
      expect((await validateNextAuthToken(earlier.jwe))?.userId).toBe(
        generations.generation === 0 ? ownerId : undefined,
      );
      // Credentials stamped with the current generations are used.
      await warm(await tokens(ownerId, { gen: generations.generation, ngen: generations.nativeGeneration }));
    },
  );

  it('keeps a socket open while the read fails, even past a moved generation, and closes it once the read answers', async () => {
    const credentials = await tokens(ownerId, { gen: 0, ngen: 0 }),
      server = await webSocketServer();
    const client = await connect(server.url, credentials.jws);
    await acknowledged(client);
    const locked = barrier(),
      release = barrier();
    const lockHolder = track(
      blocker.begin(async (transaction) => {
        await transaction`LOCK TABLE users IN ACCESS EXCLUSIVE MODE`;
        locked.release();
        await release.promise;
      }),
    );
    try {
      await bounded(locked.promise);
      // The generation moves while no admission read can answer.
      await cutoff(null);
      // Two and a half sweeps, every one of them unavailable.
      await new Promise((resolve) => setTimeout(resolve, 2500));
      expect(client.socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      release.release();
      await bounded(lockHolder);
    }
    expect(await bounded(client.closed, 4000)).toBe(4401);
  }, 15000);

  it('closes idle sockets in two backend processes when a real reset moves the generation', async () => {
    await seedPassword('owned-cutoff-two-process-before');
    const pair = await signIn('owned-cutoff-two-process-before');
    const web = await tokens(ownerId, { gen: 0 });
    const [first, second] = await Promise.all([startOwnedChild(), startOwnedChild()]);
    expect(first.process.pid).not.toBe(second.process.pid);
    const clients = await Promise.all([
      connect(first.url, pair.jwt),
      connect(second.url, web.jwe),
      connect(first.url, web.jwe),
      connect(second.url, pair.jwt),
    ]);
    for (const client of clients) await acknowledged(client);
    await stagedReset('owned-cutoff-two-process-after');
    expect(await bounded(Promise.all(clients.map((client) => client.closed)), 4000)).toEqual([4401, 4401, 4401, 4401]);
  }, 45000);

  it('under observe admits what only a cutoff refuses, never a deleted account, and staged writers will not run', async () => {
    const credentials = await tokens(ownerId, { gen: 0, ngen: 0 }),
      refreshToken = await seedRefresh({ subjectGeneration: 0, nativeGeneration: 0 }),
      server = await webSocketServer();
    const client = await connect(server.url, credentials.jws);
    await acknowledged(client);
    vi.stubEnv('AUTH_CUTOFF_ENFORCEMENT', 'observe');
    await cutoff(null);
    await warm(credentials);
    expect(await graphql(credentials.jws)).toEqual({ status: 200, body: { data: { authenticatedUserId: ownerId } } });
    const rotated = await native('/refresh', { refreshToken });
    expect(rotated.status).toBe(200);
    // Exactly the build before BA-04 PR 2: the child copies the parent's stale stamps.
    expect(await claimsOf(((await rotated.json()) as TokenPair).jwt)).toMatchObject({ gen: 0, ngen: 0 });
    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect(client.socket.readyState).toBe(WebSocket.OPEN);

    const projectionId = randomUUID();
    await db.transaction(async (transaction) => {
      await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
      await transaction
        .update(authEmailProjection)
        .set({ phase: 'enforced' })
        .where(eq(authEmailProjection.projectionId, projectionId));
    });
    vi.stubEnv('CURRENT_STORE_ACCOUNT_DELETION_MODE', 'reserved-staging');
    vi.stubEnv('CURRENT_STORE_AUTH_PROJECTION_ID', projectionId);
    vi.stubEnv('CURRENT_STORE_AUTH_WRITER_EPOCH', '1');
    const refused = await graphql(credentials.jwe, 'mutation { deleteAccount(input: { removeSetterName: false }) }');
    expect(refused.body.errors?.[0].extensions?.code).toBe('SERVICE_UNAVAILABLE');
    expect(await db.select({ id: users.id }).from(users).where(eq(users.id, ownerId))).toHaveLength(1);
    vi.stubEnv('CURRENT_STORE_ACCOUNT_DELETION_MODE', '');

    await db.update(authSubjectCutoffs).set({ deletedAt: new Date() }).where(eq(authSubjectCutoffs.userId, ownerId));
    expect(await validateToken(credentials.jwe)).toBeNull();
    expect(await validateToken(credentials.jws)).toBeNull();
    expect(await bounded(client.closed, 4000)).toBe(4401);
    // Under observe a deletion is still refused, on both transports.
    expect(await graphql(credentials.jws)).toEqual(REFUSED);
    await closedWithoutAck(await connect(server.url, credentials.jws), 4401);

    await db.update(authSubjectCutoffs).set({ deletedAt: null }).where(eq(authSubjectCutoffs.userId, ownerId));
    vi.stubEnv('AUTH_CUTOFF_ENFORCEMENT', 'enforce');
    expect(await validateToken(credentials.jwe)).toBeNull();
    expect(await validateToken(credentials.jws)).toBeNull();
    expect(await graphql(credentials.jws)).toEqual(REFUSED);
  }, 15000);

  it('answers an outage 503 and 1013, never 401 or 4401, even for a credential a cutoff has ended', async () => {
    const stale = await tokens(ownerId, { gen: 0, ngen: 0 }),
      server = await webSocketServer();
    await cutoff(null);
    await hideAuthority();
    try {
      for (const token of [stale.jws, stale.jwe]) {
        const unavailable = await graphql(token);
        expect(unavailable.status).toBe(503);
        expect(unavailable.body.errors?.[0].extensions?.code).toBe('SERVICE_UNAVAILABLE');
        await closedWithoutAck(await connect(server.url, token), 1013);
      }
      // No credential needs no read, so it stays anonymous through the outage.
      expect(await graphql(null, '{ __typename }')).toEqual({ status: 200, body: { data: { __typename: 'Query' } } });
      await acknowledged(await connect(server.url, null));
    } finally {
      await restoreAuthority();
    }
    // The first answer that can be read is the refusal.
    expect(await graphql(stale.jws)).toEqual(REFUSED);
    await closedWithoutAck(await connect(server.url, stale.jws), 4401);
  });

  it('keeps no credential, and an expired or foreign one, anonymous: only a refused credential gets 401', async () => {
    const server = await webSocketServer();
    // Deleted, so a credential that reached admission would be refused.
    await cutoff();
    const signingKey = new TextEncoder().encode(secret);
    const nativeClaims = () =>
      new SignJWT({ sub: ownerId, gen: 0, ngen: 0 })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer('boardsesh')
        .setAudience('boardsesh-mobile');
    const expiredJws = await nativeClaims()
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(signingKey);
    const foreignJws = await nativeClaims()
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(`${secret}-another-deployment`));
    const expiredJwe = await publicJwt.encode({ token: { sub: ownerId, gen: 0 }, secret, maxAge: -3600 });
    const anonymous = {
      status: 200,
      body: {
        data: null,
        errors: [expect.objectContaining({ extensions: expect.objectContaining({ code: 'UNAUTHENTICATED' }) })],
      },
    };
    for (const token of [null, expiredJws, foreignJws, expiredJwe, 'not-a-token']) {
      expect(await graphql(token), String(token)).toEqual(anonymous);
      await acknowledged(await connect(server.url, token));
    }
    // The same account's live credential is the one that is refused.
    expect(await graphql((await tokens(ownerId, { gen: 0, ngen: 0 })).jws)).toEqual(REFUSED);
  });

  it.each([
    ['a string', 'one'],
    ['a negative number', -1],
    ['a fraction', 0.5],
  ] as const)(
    'refuses a credential whose gen stamp is %s with 401 and 4401, never as anonymous',
    async (_label, malformedStamp) => {
      // No cutoff row: generation 0, so only the stamp itself is wrong.
      const server = await webSocketServer();
      const jws = await new SignJWT({ sub: ownerId, gen: malformedStamp, ngen: 0 })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setIssuer('boardsesh')
        .setAudience('boardsesh-mobile')
        .setExpirationTime('1h')
        .sign(new TextEncoder().encode(secret));
      const jwe = await publicJwt.encode({ token: { sub: ownerId, gen: malformedStamp }, secret, maxAge: 3600 });
      for (const token of [jws, jwe]) {
        expect(await graphql(token)).toEqual(REFUSED);
        await closedWithoutAck(await connect(server.url, token), 4401);
      }
    },
  );

  it('refuses an app JWT after an app sign-out moved the native generation, and keeps the website', async () => {
    const server = await webSocketServer();
    await db.insert(authSubjectCutoffs).values({
      userId: ownerId,
      generation: 0,
      nativeGeneration: 1,
      revokedThrough: new Date(),
      lastOperationId: randomUUID(),
    });
    const credentials = await tokens(ownerId, { gen: 0, ngen: 0 });
    expect(await graphql(credentials.jws)).toEqual(REFUSED);
    await closedWithoutAck(await connect(server.url, credentials.jws), 4401);
    // The website carries no native stamp, so an app sign-out never ends it (decision 10).
    expect(await graphql(credentials.jwe)).toEqual({ status: 200, body: { data: { authenticatedUserId: ownerId } } });
    await acknowledged(await connect(server.url, credentials.jwe));
    // An app credential issued after the sign-out is used.
    const current = await tokens(ownerId, { gen: 0, ngen: 1 });
    expect(await graphql(current.jws)).toEqual({ status: 200, body: { data: { authenticatedUserId: ownerId } } });
    await acknowledged(await connect(server.url, current.jws));
  });

  it('returns fixed unavailable on actual primary schema failure and admits the exact warm credentials after recovery', async () => {
    const credentials = await tokens();
    await warm(credentials);
    await hideAuthority();
    try {
      await expect(validateNextAuthToken(credentials.jwe)).rejects.toBeInstanceOf(AuthAdmissionUnavailableError);
      await expect(validateMobileJwt(credentials.jws)).rejects.toBeInstanceOf(AuthAdmissionUnavailableError);
      await expect(validateToken(credentials.jwe)).rejects.toBeInstanceOf(AuthAdmissionUnavailableError);
      const result = await graphql(credentials.jwe);
      expect(result.status).toBe(503);
      expect(result.body.errors?.[0].extensions?.code).toBe('SERVICE_UNAVAILABLE');
      expect(JSON.stringify(result.body)).not.toContain(hiddenCutoffTable);
      for (const path of [
        '/ocr',
        '/avatar',
        '/gym-photo',
        '/feedback',
        '/spray-photo',
        '/spray-test',
        '/watch-code',
        '/aurora-credentials',
        '/aurora-import',
        '/moonboard-import',
        '/board-handoff',
        '/export',
      ]) {
        const response = await native(path, {}, credentials.jwe);
        expect(response.status, path).toBe(503);
        expect(response.headers.get('cache-control'), path).toContain('no-store');
        expect(await response.json()).toEqual({ error: 'Authentication is temporarily unavailable' });
      }
      const session = await fetch(`${origin}/session`, {
        headers: { Authorization: `Bearer ${credentials.jws}` },
        signal: AbortSignal.timeout(3000),
      });
      expect(session.status).toBe(503);
      expect(session.headers.get('cache-control')).toContain('no-store');
      expect(await session.json()).toEqual({ error: 'Authentication is temporarily unavailable' });
    } finally {
      await restoreAuthority();
    }
    await warm(credentials);
    expect((await graphql(credentials.jwe)).body).toEqual({ data: { authenticatedUserId: ownerId } });
  });

  it('preserves warm credentials during signing-secret absence and never reuses crypto across a secret rotation', async () => {
    const credentials = await tokens();
    await warm(credentials);
    vi.stubEnv('NEXTAUTH_SECRET', '');
    await expect(validateNextAuthToken(credentials.jwe)).rejects.toBeInstanceOf(AuthAdmissionUnavailableError);
    await expect(validateMobileJwt(credentials.jws)).rejects.toBeInstanceOf(AuthAdmissionUnavailableError);
    expect((await graphql(credentials.jwe)).status).toBe(503);
    vi.stubEnv('NEXTAUTH_SECRET', `${secret}-rotated`);
    expect(await validateToken(credentials.jwe)).toBeNull();
    expect(await validateToken(credentials.jws)).toBeNull();
    vi.stubEnv('NEXTAUTH_SECRET', secret);
    await warm(credentials);
  });

  it('keeps transfer and watch one-shot capabilities intact through a pre-consumption authority outage', async () => {
    const credentials = await tokens();
    const codeResponse = await native('/watch-code', {}, credentials.jwe);
    expect(codeResponse.status).toBe(200);
    const { code } = (await codeResponse.json()) as { code: string };
    redisKeys.add(`boardsesh:watch:pair:${code}`);
    const transfer = transferToken();
    await hideAuthority();
    try {
      expect((await native('/exchange', { transferToken: transfer })).status).toBe(503);
      expect((await native('/watch', { code })).status).toBe(503);
    } finally {
      await restoreAuthority();
    }
    expect((await native('/exchange', { transferToken: transfer })).status).toBe(200);
    expect((await native('/watch', { code })).status).toBe(200);
  });

  it('returns unavailable on a missing native signing secret without consuming transfer or refresh credentials', async () => {
    const transfer = transferToken(),
      refreshToken = await seedRefresh(),
      before = await refreshRows();
    vi.stubEnv('NEXTAUTH_SECRET', '');
    expect((await native('/exchange', { transferToken: transfer })).status).toBe(503);
    expect((await native('/refresh', { refreshToken })).status).toBe(503);
    expect(await refreshRows()).toEqual(before);
    vi.stubEnv('NEXTAUTH_SECRET', secret);
    expect((await native('/exchange', { transferToken: transfer })).status).toBe(200);
    expect((await native('/refresh', { refreshToken })).status).toBe(200);
  });

  it('does not issue descendants of pending transfer, refresh or watch credentials after deletion', async () => {
    const credentials = await tokens();
    const transfer = transferToken(),
      refreshToken = await seedRefresh();
    const response = await native('/watch-code', {}, credentials.jwe);
    expect(response.status).toBe(200);
    const { code } = (await response.json()) as { code: string };
    redisKeys.add(`boardsesh:watch:pair:${code}`);
    expect(
      (await graphql(credentials.jwe, 'mutation { deleteAccount(input: { removeSetterName: false }) }')).body.data
        ?.deleteAccount,
    ).toBe(true);
    expect((await native('/exchange', { transferToken: transfer })).status).toBe(401);
    expect((await native('/refresh', { refreshToken })).status).toBe(401);
    expect((await native('/watch', { code })).status).toBe(401);
    expect(await refreshRows()).toEqual([]);
  });

  it('does not consume a newer B watch capability when A admission awaited a primary lock', async () => {
    const credentials = await tokens();
    const response = await native('/watch-code', {}, credentials.jwe);
    expect(response.status).toBe(200);
    const { code } = (await response.json()) as { code: string };
    const key = `boardsesh:watch:pair:${code}`;
    redisKeys.add(key);
    const locked = barrier(),
      release = barrier();
    let blockingPid = 0;
    const authorityLock = track(
      blocker.begin(async (transaction) => {
        const [pid] = await transaction<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        blockingPid = pid.pid;
        await transaction`LOCK TABLE users IN ACCESS EXCLUSIVE MODE`;
        locked.release();
        await release.promise;
      }),
    );
    let pairing: Promise<Response> | undefined;
    try {
      await bounded(locked.promise);
      pairing = track(native('/watch', { code }));
      // The blocked admission proves the mounted handler already read A's
      // pending UID from Redis. Replace only this fixture's exact key with B.
      await waitForLock(blockingPid, pairing);
      await redisClientManager.getClients().publisher.set(key, otherId, 'EX', 60);
    } finally {
      release.release();
      await bounded(authorityLock);
    }
    expect((await bounded(pairing!)).status).toBe(401);
    expect(await redisClientManager.getClients().publisher.get(key)).toBe(otherId);
    const replacement = await native('/watch', { code });
    expect(replacement.status).toBe(200);
    expect(((await replacement.json()) as TokenPair).userId).toBe(otherId);
  });

  it('waits for the user before touching refresh rows, then rejects a deletion winner without deadlock or descendants', async () => {
    const refreshToken = await seedRefresh();
    const locked = barrier(),
      release = barrier();
    let blockingPid = 0;
    const deletion = track(
      blocker.begin(async (transaction) => {
        const [pid] = await transaction<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        blockingPid = pid.pid;
        await transaction`SELECT id FROM users WHERE id=${ownerId} FOR UPDATE`;
        locked.release();
        await release.promise;
        await transaction`DELETE FROM users WHERE id=${ownerId}`;
      }),
    );
    let refresh: Promise<Response> | undefined;
    try {
      await bounded(locked.promise);
      refresh = track(native('/refresh', { refreshToken }));
      await waitForLock(blockingPid, refresh);
      // A separate connection can still lock the refresh row: the pending
      // issuer is blocked on users and has not inverted the deletion order.
      const [row] = await observer`SELECT id FROM mobile_refresh_tokens WHERE user_id=${ownerId} FOR UPDATE NOWAIT`;
      expect(row).toBeDefined();
    } finally {
      release.release();
      await bounded(deletion);
    }
    expect((await bounded(refresh!)).status).toBe(401);
    expect(await refreshRows()).toEqual([]);
  });

  it('rejects unsupported repeatable-read issuance without consuming a valid refresh credential', async () => {
    const refreshToken = await seedRefresh(),
      before = await refreshRows();
    await expect(
      db.transaction(async (transaction) => {
        await transaction.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
        await requireHumanSubjectForIssuance(transaction, ownerId);
      }),
    ).rejects.toBeInstanceOf(AuthAdmissionUnavailableError);
    expect(await refreshRows()).toEqual(before);
    const response = await native('/refresh', { refreshToken });
    expect(response.status).toBe(200);
    const pair = (await response.json()) as TokenPair;
    const verified = await jwtVerify(pair.jwt, new TextEncoder().encode(secret), {
      issuer: 'boardsesh',
      audience: 'boardsesh-mobile',
    });
    expect(verified.payload.sub).toBe(ownerId);
    expect(verified.payload.exp! - verified.payload.iat!).toBe(7 * 24 * 60 * 60);
    expect(pair.userId).toBe(ownerId);
  });

  it('lets a real refresh issuer commit first, then deletion cascades its new row and denies the returned JWT', async () => {
    const credentials = await tokens(),
      refreshToken = await seedRefresh();
    // The generated identifiers and UID are fixed fixture constants. The
    // trigger pauses the actual mounted INSERT after the real issuer obtained
    // its user KEY SHARE lock, without replacing issuer/admission code.
    await db.execute(
      sql.raw(`CREATE FUNCTION ${issuerTriggerName}() RETURNS trigger LANGUAGE plpgsql AS $owned$
      BEGIN IF NEW.user_id='${ownerId}' THEN PERFORM pg_advisory_xact_lock(${issuerAdvisoryKey}); END IF; RETURN NEW; END; $owned$`),
    );
    await db.execute(
      sql`CREATE TRIGGER ${sql.identifier(issuerTriggerName)} BEFORE INSERT ON mobile_refresh_tokens FOR EACH ROW EXECUTE FUNCTION ${sql.identifier(issuerTriggerName)}()`,
    );
    const locked = barrier(),
      release = barrier();
    let blockingPid = 0;
    const held = track(
      blocker.begin(async (transaction) => {
        const [pid] = await transaction<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        blockingPid = pid.pid;
        await transaction`SELECT pg_advisory_xact_lock(${issuerAdvisoryKey})`;
        locked.release();
        await release.promise;
      }),
    );
    let refresh: Promise<Response> | undefined;
    let deletion: ReturnType<typeof graphql> | undefined;
    try {
      await bounded(locked.promise);
      refresh = track(native('/refresh', { refreshToken }));
      await waitForLock(blockingPid, refresh);
      const [issuer] = await observer<
        { pid: number }[]
      >`SELECT pid FROM pg_stat_activity WHERE ${blockingPid}=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock'`;
      expect(issuer?.pid).toBeGreaterThan(0);
      deletion = track(graphql(credentials.jwe, 'mutation { deleteAccount(input: { removeSetterName: false }) }'));
      await waitForLock(issuer.pid, deletion);
    } finally {
      release.release();
      await bounded(held);
    }
    const refreshResponse = await bounded(refresh!);
    expect(refreshResponse.status).toBe(200);
    const pair = (await refreshResponse.json()) as TokenPair;
    expect((await bounded(deletion!)).body.data?.deleteAccount).toBe(true);
    expect(await refreshRows()).toEqual([]);
    expect(await validateMobileJwt(pair.jwt)).toBeNull();
    expect((await native('/refresh', { refreshToken: pair.refreshToken })).status).toBe(401);
  });

  it.each(['/exchange', '/watch'])(
    'prevents %s issuance when deletion commits while the issuer waits for its user lock',
    async (path) => {
      let body: { transferToken: string } | { code: string };
      if (path === '/exchange') body = { transferToken: transferToken() };
      else {
        const credentials = await tokens();
        const response = await native('/watch-code', {}, credentials.jwe);
        expect(response.status).toBe(200);
        const { code } = (await response.json()) as { code: string };
        redisKeys.add(`boardsesh:watch:pair:${code}`);
        body = { code };
      }
      const locked = barrier(),
        release = barrier();
      let blockingPid = 0;
      const deletion = track(
        blocker.begin(async (transaction) => {
          const [pid] = await transaction<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          blockingPid = pid.pid;
          await transaction`SELECT id FROM users WHERE id=${ownerId} FOR UPDATE`;
          locked.release();
          await release.promise;
          await transaction`DELETE FROM users WHERE id=${ownerId}`;
        }),
      );
      let issuance: Promise<Response> | undefined;
      try {
        await bounded(locked.promise);
        issuance = track(native(path, body));
        await waitForLock(blockingPid, issuance);
      } finally {
        release.release();
        await bounded(deletion);
      }
      expect((await bounded(issuance!)).status).toBe(401);
      expect(await refreshRows()).toEqual([]);
      // Claims may already have been consumed before transactional denial.
      // This deliberately makes no universal one-shot retryability claim.
    },
  );

  it('denies the same cached JWE in two independent backend processes after committed deletion', async () => {
    const credentials = await tokens();
    const [first, second] = await Promise.all([startOwnedChild(), startOwnedChild()]);
    expect(first.process.pid).toBeDefined();
    expect(second.process.pid).toBeDefined();
    expect(first.process.pid).not.toBe(second.process.pid);
    const clients = await Promise.all([connect(first.url, credentials.jwe), connect(second.url, credentials.jwe)]);
    await until(() => clients.every((client) => client.frames.some((frame) => frame.type === 'connection_ack')));
    // Both processes admit the exact same bytes twice before deletion. Their
    // crypto caches, bounded runners and human-binding maps are independent.
    for (const id of ['warm-first', 'warm-cached']) {
      for (const client of clients)
        client.socket.send(JSON.stringify({ type: 'subscribe', id, payload: { query: '{ authenticatedUserId }' } }));
      await until(() =>
        clients.every((client) =>
          client.frames.some(
            (frame) =>
              frame.type === 'next' &&
              frame.id === id &&
              (frame.payload as { data?: { authenticatedUserId?: unknown } } | undefined)?.data?.authenticatedUserId ===
                ownerId,
          ),
        ),
      );
    }
    expect(
      (await graphql(credentials.jwe, 'mutation { deleteAccount(input: { removeSetterName: false }) }')).body.data
        ?.deleteAccount,
    ).toBe(true);
    for (const [index, client] of clients.entries())
      client.socket.send(
        JSON.stringify({ id: `after-${index}`, type: 'subscribe', payload: { query: '{ authenticatedUserId }' } }),
      );
    expect(await bounded(Promise.all(clients.map((client) => client.closed)), 4000)).toEqual([4401, 4401]);
    for (const client of clients)
      expect(
        JSON.stringify(client.frames.filter((frame) => frame.type === 'next' && frame.id?.startsWith('after-'))),
      ).not.toContain(ownerId);
  }, 45000);

  it('closes an idle authenticated socket by the admission sweep and gives unavailable handshakes no ACK', async () => {
    const credentials = await tokens(),
      server = await webSocketServer();
    const idle = await connect(server.url, credentials.jwe);
    await vi.waitFor(() => expect(idle.frames.some((frame) => frame.type === 'connection_ack')).toBe(true));
    const subscribersBefore = pubsub.getRuntimeStats().notification.subscribers;
    idle.socket.send(
      JSON.stringify({
        type: 'subscribe',
        id: 'silent-notifications',
        payload: {
          query: 'subscription { notificationReceived { notification { uuid } } }',
        },
      }),
    );
    await until(() => pubsub.getRuntimeStats().notification.subscribers === subscribersBefore + 1);
    expect(idle.frames.some((frame) => frame.type === 'next')).toBe(false);
    await cutoff();
    expect(await bounded(idle.closed, 4000)).toBe(4401);
    await until(() => pubsub.getRuntimeStats().notification.subscribers === subscribersBefore);
    await db.delete(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, ownerId));
    await hideAuthority();
    try {
      const unavailable = await connect(server.url, credentials.jwe);
      expect(await bounded(unavailable.closed, 3000)).toBe(1013);
      expect(unavailable.frames.some((frame) => frame.type === 'connection_ack')).toBe(false);
    } finally {
      await restoreAuthority();
    }
    await warm(credentials);
  });

  it('keeps idle sockets through an outage, and closes one that starts a subscription so it can reconnect', async () => {
    const credentials = await tokens(),
      server = await webSocketServer();
    const client = await connect(server.url, credentials.jwe);
    await vi.waitFor(() => expect(client.frames.some((frame) => frame.type === 'connection_ack')).toBe(true));
    await hideAuthority();
    try {
      // Long enough for at least one sweep to fail.
      await new Promise((resolve) => setTimeout(resolve, 1600));
      expect(client.socket.readyState).toBe(WebSocket.OPEN);
      client.socket.send(
        JSON.stringify({
          type: 'subscribe',
          id: 'during-outage',
          payload: { query: 'subscription { notificationReceived { notification { uuid } } }' },
        }),
      );
      expect(await bounded(client.closed, 4000)).toBe(1013);
    } finally {
      await restoreAuthority();
    }
    const reconnected = await connect(server.url, credentials.jwe);
    await vi.waitFor(() => expect(reconnected.frames.some((frame) => frame.type === 'connection_ack')).toBe(true));
    await cutoff();
    expect(await bounded(reconnected.closed, 4000)).toBe(4401);
  });

  it('delivers a notification without a per-event primary read', async () => {
    // Freeze the sweep and hide the authority, so any read made for this
    // delivery would fail and close the socket.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const credentials = await tokens(),
      server = await webSocketServer();
    const client = await connect(server.url, credentials.jwe);
    const poll = async (predicate: () => boolean) => {
      const deadline = Date.now() + 3000;
      while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('Owned notification fixture deadline');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    await poll(() => client.frames.some((frame) => frame.type === 'connection_ack'));
    const beforeSubscribers = pubsub.getRuntimeStats().notification.subscribers;
    client.socket.send(
      JSON.stringify({
        type: 'subscribe',
        id: 'notifications',
        payload: {
          query: 'subscription { notificationReceived { notification { uuid actorDisplayName } } }',
        },
      }),
    );
    await poll(() => pubsub.getRuntimeStats().notification.subscribers === beforeSubscribers + 1);
    const notificationUuid = randomUUID();
    await db
      .insert(notifications)
      .values({ uuid: notificationUuid, recipientId: ownerId, actorId: otherId, type: 'new_follower' });
    const notification = {
      uuid: notificationUuid,
      type: 'new_follower' as const,
      isRead: false,
      createdAt: new Date().toISOString(),
    };
    await hideAuthority();
    try {
      pubsub.publishNotificationEvent(ownerId, {
        notification: { ...notification, actorDisplayName: 'Delivered during an outage' },
      });
      await poll(() => JSON.stringify(client.frames).includes('Delivered during an outage'));
      expect(client.socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      await restoreAuthority();
    }
    client.socket.close();
    await poll(() => pubsub.getRuntimeStats().notification.subscribers === beforeSubscribers);
  });

  it('admits a same-tick burst of warm credentials through one primary read', async () => {
    const burstUserIds = Array.from({ length: 40 }, () => randomUUID());
    await db
      .insert(users)
      .values(burstUserIds.map((id) => ({ id, email: `${id}@example.test`, name: 'Admission burst' })));
    try {
      const credentials = await Promise.all(burstUserIds.map((id) => tokens(id)));
      for (const credential of credentials) await validateMobileJwt(credential.jws);
      const mainPoolSelect = vi.spyOn(db, 'select');
      const admissionStatement = vi.spyOn(getAdmissionPool(), 'unsafe');
      const results = await Promise.all(credentials.map((credential) => validateMobileJwt(credential.jws)));
      expect(results.map((result) => result?.userId)).toEqual(burstUserIds);
      expect(admissionStatement).toHaveBeenCalledTimes(1);
      expect(mainPoolSelect).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      await db.delete(users).where(inArray(users.id, burstUserIds));
    }
  });

  it('decides generations from that same one read: no added statement per request or per burst', async () => {
    const burstUserIds = Array.from({ length: 40 }, () => randomUUID());
    await db
      .insert(users)
      .values(burstUserIds.map((id) => ({ id, email: `${id}@example.test`, name: 'Admission burst' })));
    // Every other account has been reset once.
    const resetUserIds = burstUserIds.filter((_userId, index) => index % 2 === 1);
    await db.insert(authSubjectCutoffs).values(
      resetUserIds.map((userId) => ({
        userId,
        generation: 1,
        revokedThrough: new Date(),
        lastOperationId: randomUUID(),
      })),
    );
    try {
      const unstamped = await Promise.all(burstUserIds.map((id) => tokens(id)));
      const current = await Promise.all(
        burstUserIds.map((id) => tokens(id, { gen: resetUserIds.includes(id) ? 1 : 0, ngen: 0 })),
      );
      // Warm the crypto cache, so only admission is left to measure.
      for (const credential of unstamped) await validateNextAuthToken(credential.jwe);
      for (const credential of current) {
        await validateMobileJwt(credential.jws);
        await validateNextAuthToken(credential.jwe);
      }
      const mainPoolSelect = vi.spyOn(db, 'select');
      const admissionStatement = vi.spyOn(getAdmissionPool(), 'unsafe');

      expect((await validateToken(current[0].jwe))?.userId).toBe(burstUserIds[0]);
      expect(admissionStatement).toHaveBeenCalledTimes(1);

      const [currentResults, unstampedResults] = await Promise.all([
        Promise.all(current.map((credential) => validateMobileJwt(credential.jws))),
        Promise.all(unstamped.map((credential) => validateNextAuthToken(credential.jwe))),
      ]);
      expect(currentResults.map((result) => result?.userId)).toEqual(burstUserIds);
      expect(unstampedResults.map((result) => result?.userId)).toEqual(
        burstUserIds.map((id) => (resetUserIds.includes(id) ? undefined : id)),
      );
      // 80 validations of 40 accounts, all in one tick: one more read.
      expect(admissionStatement).toHaveBeenCalledTimes(2);
      expect(mainPoolSelect).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      await db.delete(authSubjectCutoffs).where(inArray(authSubjectCutoffs.userId, resetUserIds));
      await db.delete(users).where(inArray(users.id, burstUserIds));
    }
  });
});
