import { createHmac, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createPrototypeEnvironment } from '../environment';
import {
  createPrototypeLegacyHandler,
  PROTOTYPE_LEGACY_KEY,
  PROTOTYPE_LEGACY_NATIVE_CLOCK_TOLERANCE_SECONDS,
  verifyLegacyNativeProof,
} from '../legacy-bridge';
import { PROTOTYPE_ISSUER } from '../oauth-options';

// These are transport/database seams around the actual released public handler.
// jose, SignJWT and all signature/claim verification execute unmodified.
vi.mock('../../../db/client', () => {
  const database = {
    insert: vi.fn(() => ({ values: vi.fn(async () => []) })),
    execute: async () => [{ transaction_isolation: 'read committed' }],
    transaction: async (callback: (transaction: unknown) => unknown) => callback(database),
  };
  return { db: database, dbRead: {} };
});
// This file is about token clocks. Deletion admission has its own suite.
vi.mock('../../human-admission', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../human-admission')>()),
  isHumanSubjectActive: vi.fn(async () => true),
  readHumanSubjectState: vi.fn(async () => ({ generation: 0, nativeGeneration: 0, deniedSessionKeys: new Set() })),
  requireHumanSubjectForIssuance: vi.fn(async () => ({
    generation: 0,
    nativeGeneration: 0,
    deniedSessionKeys: new Set(),
  })),
}));
vi.mock('../../../handlers/cors', () => ({ applyCorsHeaders: vi.fn(() => true) }));
vi.mock('../../../redis/client', () => ({
  redisClientManager: {
    isRedisConnected: vi.fn(() => false),
    isRedisConfigured: vi.fn(() => false),
    getClients: vi.fn(() => ({ publisher: {} })),
  },
}));
vi.mock('../../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { handleNativeAuthExchange, __resetNativeAuthStateForTests } = await import('../../../handlers/native-auth');
const { validateMobileJwt } = await import('../../../middleware/auth');
const NOW = new Date('2026-11-04T21:00:00.000Z');
const NOW_SECONDS = NOW.getTime() / 1000;
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;
const LEGACY_SECRET = new TextDecoder().decode(PROTOTYPE_LEGACY_KEY);
type Environment = Awaited<ReturnType<typeof createPrototypeEnvironment>>;
let environment: Environment;

interface ProducerResponse {
  statusCode: number;
  headersSent: boolean;
  body: string;
  writeHead: (status: number, headers?: Record<string, unknown>) => void;
  setHeader: (name: string, content: unknown) => void;
  end: (body?: string) => void;
}

function producerRequest(transferToken: string): IncomingMessage {
  const emitter = new EventEmitter() as EventEmitter & {
    method: string;
    url: string;
    headers: Record<string, string>;
    socket: { remoteAddress: string };
    destroy: () => void;
  };
  emitter.method = 'POST';
  emitter.url = '/auth/native/exchange';
  emitter.headers = {};
  emitter.socket = { remoteAddress: '127.0.0.1' };
  emitter.destroy = vi.fn();
  setImmediate(() => {
    emitter.emit('data', Buffer.from(JSON.stringify({ transferToken })));
    emitter.emit('end');
  });
  return emitter as unknown as IncomingMessage;
}

async function actualNativePair(userId: string, sourceTime = NOW, encoderDelaySeconds = 0) {
  const issuedAt = Math.floor(sourceTime.getTime() / 1000);
  const encoded = Buffer.from(
    JSON.stringify({ userId, nextPath: '/app', iat: issuedAt, exp: issuedAt + 120 }),
  ).toString('base64url');
  const transferToken = `${encoded}.${createHmac('sha256', LEGACY_SECRET).update(encoded).digest('base64url')}`;
  const response: ProducerResponse = {
    statusCode: 0,
    headersSent: false,
    body: '',
    writeHead(status) {
      this.statusCode = status;
      this.headersSent = true;
    },
    setHeader() {},
    end(body) {
      this.body = body ?? '';
    },
  };
  const originalDate = globalThis.Date;
  let noArgumentClockReads = 0;
  // generateTokenPair's explicit new Date(milliseconds) is unaffected. The
  // real jose setIssuedAt and setExpirationTime('7d') make consecutive no-arg
  // reads, so a genuine second boundary/process pause changes the signed span.
  const sourceDate = new Proxy(originalDate, {
    construct(target, argumentsList, newTarget) {
      if (argumentsList.length === 0) {
        noArgumentClockReads += 1;
        return Reflect.construct(
          target,
          [sourceTime.getTime() + (noArgumentClockReads >= 2 ? encoderDelaySeconds * 1000 : 0)],
          newTarget,
        );
      }
      return Reflect.construct(target, argumentsList, newTarget);
    },
    get(target, property, receiver) {
      return property === 'now' ? () => sourceTime.getTime() : Reflect.get(target, property, receiver);
    },
  });
  vi.stubGlobal('Date', sourceDate);
  try {
    await handleNativeAuthExchange(producerRequest(transferToken), response as unknown as ServerResponse);
  } finally {
    vi.unstubAllGlobals();
  }
  expect(response.statusCode).toBe(200);
  expect(noArgumentClockReads).toBeGreaterThanOrEqual(2);
  const pair = JSON.parse(response.body) as { userId: string; jwt: string; refreshToken: string; expiresAt: string };
  expect(pair.userId).toBe(userId);
  expect(pair.refreshToken).toMatch(/^[a-f0-9]{64}$/);
  const { payload, protectedHeader } = await jwtVerify(pair.jwt, PROTOTYPE_LEGACY_KEY, {
    algorithms: ['HS256'],
    issuer: 'boardsesh',
    audience: 'boardsesh-mobile',
    currentDate: sourceTime,
    clockTolerance: 60,
  });
  expect(protectedHeader.typ).toBe('JWT');
  expect(payload.iat).toBe(issuedAt);
  expect(payload.exp).toBe(issuedAt + SEVEN_DAYS_SECONDS + encoderDelaySeconds);
  expect(payload.auth_time).toBeUndefined();
  expect(payload.authSessionId).toBeUndefined();
  expect(pair.expiresAt).toBe(new Date(sourceTime.getTime() + SEVEN_DAYS_SECONDS * 1000).toISOString());
  return { pair, payload };
}

async function user() {
  const userId = randomUUID();
  await environment.database.insert(environment.schema.user).values({
    id: userId,
    name: 'Actual native clock fixture',
    email: `${userId}@example.test`,
    emailVerified: true,
  });
  return userId;
}

function bridgeRequest(credential: string, path = '/prototype-legacy-bridge', cookie?: string) {
  return new Request(`${PROTOTYPE_ISSUER}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${credential}`,
      origin: 'https://www.boardsesh.test',
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: '{}',
  });
}

function canonicalCookie(response: Response) {
  const header = response.headers.getSetCookie().find((cookie) => cookie.includes('better-auth.session_token='));
  expect(header).toBeDefined();
  return header!.split(';')[0];
}

beforeAll(async () => {
  environment = await createPrototypeEnvironment();
});
afterAll(async () => environment?.close());
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('NEXTAUTH_SECRET', LEGACY_SECRET);
  __resetNativeAuthStateForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('actual released native JWT clock compatibility', () => {
  it.each([0, 1, 60])(
    'accepts actual issuer output with %s seconds between iat and relative expiry reads',
    async (delay) => {
      const userId = await user();
      const { pair, payload } = await actualNativePair(userId, NOW, delay);
      expect(await validateMobileJwt(pair.jwt)).toMatchObject({ userId });
      const proof = await verifyLegacyNativeProof(pair.jwt, NOW);
      expect(proof).toMatchObject({
        userId,
        issuedAt: NOW,
        expiresAt: new Date(payload.exp! * 1000),
        validUntil: new Date((payload.exp! + 60) * 1000),
        clockToleranceSeconds: PROTOTYPE_LEGACY_NATIVE_CLOCK_TOLERANCE_SECONDS,
        originalAuthenticatedAt: null,
      });
      const handler = createPrototypeLegacyHandler(environment.database);
      const bridged = await handler(bridgeRequest(pair.jwt));
      expect(bridged.status).toBe(200);
      const { sessionId } = (await bridged.json()) as { sessionId: string };
      const [session] = await environment.database
        .select()
        .from(environment.schema.session)
        .where(eq(environment.schema.session.id, sessionId));
      const [lineage] = await environment.database
        .select()
        .from(environment.schema.prototypeLegacyLineage)
        .where(eq(environment.schema.prototypeLegacyLineage.sessionId, sessionId));
      expect(session.createdAt).toEqual(new Date(0));
      expect(session.originalAuthenticatedAt).toBeNull();
      expect(session.expiresAt).toEqual(proof!.validUntil);
      expect(lineage.originalExpiresAt).toEqual(proof!.expiresAt);
      expect(
        (
          await handler(
            new Request(`${PROTOTYPE_ISSUER}/list-sessions`, { headers: { cookie: canonicalCookie(bridged) } }),
          )
        ).status,
      ).toBe(403);
    },
  );

  it('rejects actual issuer output beyond the named 60-second encoder-read allowance', async () => {
    const userId = await user();
    const { pair } = await actualNativePair(userId, NOW, 61);
    expect(await validateMobileJwt(pair.jwt)).toMatchObject({ userId });
    expect(await verifyLegacyNativeProof(pair.jwt, NOW)).toBeNull();
    expect((await createPrototypeLegacyHandler(environment.database)(bridgeRequest(pair.jwt))).status).toBe(401);
  });

  it.each([1, 60])(
    'accepts an actual producer node ahead by the bounded %s seconds without upgrading age',
    async (ahead) => {
      const userId = await user();
      const { pair, payload } = await actualNativePair(userId, new Date(NOW.getTime() + ahead * 1000));
      const proof = await verifyLegacyNativeProof(pair.jwt, NOW);
      expect(proof).toMatchObject({
        userId,
        issuedAt: new Date(payload.iat! * 1000),
        originalAuthenticatedAt: null,
        expiresAt: new Date(payload.exp! * 1000),
        validUntil: new Date((payload.exp! + 60) * 1000),
        clockToleranceSeconds: 60,
      });
      expect((await createPrototypeLegacyHandler(environment.database)(bridgeRequest(pair.jwt))).status).toBe(200);
    },
  );

  it('rejects a producer node beyond the explicit ahead-clock bound', async () => {
    const userId = await user();
    const { pair } = await actualNativePair(userId, new Date(NOW.getTime() + 61_000));
    expect(await verifyLegacyNativeProof(pair.jwt, NOW)).toBeNull();
    expect((await createPrototypeLegacyHandler(environment.database)(bridgeRequest(pair.jwt))).status).toBe(401);
  });

  it('preserves original expiry while accepting exactly the installed transport grace until its last millisecond', async () => {
    const userId = await user();
    const sourceTime = new Date(NOW.getTime() - (SEVEN_DAYS_SECONDS + 59) * 1000);
    const { pair, payload } = await actualNativePair(userId, sourceTime);
    expect(payload.exp).toBe(NOW_SECONDS - 59);
    expect(await validateMobileJwt(pair.jwt)).toMatchObject({ userId });
    const validUntil = new Date((payload.exp! + 60) * 1000);
    const handler = createPrototypeLegacyHandler(environment.database);
    vi.setSystemTime(new Date(validUntil.getTime() - 1));
    expect(await verifyLegacyNativeProof(pair.jwt)).toMatchObject({
      expiresAt: new Date(payload.exp! * 1000),
      validUntil,
      originalAuthenticatedAt: null,
    });
    expect((await handler(bridgeRequest(pair.jwt))).status).toBe(200);
    vi.setSystemTime(validUntil);
    expect(await verifyLegacyNativeProof(pair.jwt)).toBeNull();
    expect(await validateMobileJwt(pair.jwt)).toBeNull();
    expect((await handler(bridgeRequest(pair.jwt))).status).toBe(401);
    expect((await createPrototypeLegacyHandler(environment.database)(bridgeRequest(pair.jwt))).status).toBe(401);
  });

  it('an ahead-clock old token cannot bypass a persisted cutoff even for an already-known lineage', async () => {
    const userId = await user();
    const { pair } = await actualNativePair(userId, new Date(NOW.getTime() + 60_000));
    const handler = createPrototypeLegacyHandler(environment.database);
    expect((await handler(bridgeRequest(pair.jwt))).status).toBe(200);
    // Retain the known lineage/session to isolate the cutoff comparison itself.
    // Raw iat is newer, but its conservative lower bound equals the cutoff.
    await environment.database.insert(environment.schema.prototypeUserCutoff).values({ userId, revokedThrough: NOW });
    expect((await verifyLegacyNativeProof(pair.jwt))?.issuedAt.getTime()).toBe(NOW.getTime() + 60_000);
    expect((await handler(bridgeRequest(pair.jwt))).status).toBe(401);
    expect((await createPrototypeLegacyHandler(environment.database)(bridgeRequest(pair.jwt))).status).toBe(401);
  });

  it('ahead-clock tolerance never admits a synthetic authentication time in the receiver future', async () => {
    const userId = await user();
    const { payload } = await actualNativePair(userId, new Date(NOW.getTime() + 60_000));
    // Adversarial claim fixture, not a claim that the actual producer emits auth_time.
    const synthetic = await new SignJWT({ ...payload, auth_time: NOW_SECONDS + 1 } as JWTPayload)
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .sign(PROTOTYPE_LEGACY_KEY);
    expect(await verifyLegacyNativeProof(synthetic, NOW)).toBeNull();
    expect((await createPrototypeLegacyHandler(environment.database)(bridgeRequest(synthetic))).status).toBe(401);
  });

  it.each([
    { label: 'numeric subject', subject: 42 },
    { label: 'object subject', subject: { id: 'not-a-user-id' } },
    { label: 'array subject', subject: ['not-a-user-id'] },
    { label: 'null subject', subject: null },
    { label: 'empty subject', subject: '' },
    { label: 'blank subject', subject: '   ' },
  ])('rejects authenticated but malformed $label claims before a database lookup', async ({ subject }) => {
    const userId = await user();
    const { payload } = await actualNativePair(userId);
    // Adversarial re-signing fixture only: the released producer emits strings.
    // jwtVerify's requiredClaims checks presence, not the type of a subject.
    const malformed = await new SignJWT({ ...payload, sub: subject } as unknown as JWTPayload)
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .sign(PROTOTYPE_LEGACY_KEY);
    expect(await verifyLegacyNativeProof(malformed, NOW)).toBeNull();
    expect((await createPrototypeLegacyHandler(environment.database)(bridgeRequest(malformed))).status).toBe(401);
  });

  it('does not revive an actual issued credential after canonical sign-out and handler recreation', async () => {
    const userId = await user();
    const { pair } = await actualNativePair(userId);
    const handler = createPrototypeLegacyHandler(environment.database);
    const bridged = await handler(bridgeRequest(pair.jwt));
    expect(bridged.status).toBe(200);
    const cookie = canonicalCookie(bridged);
    expect((await handler(bridgeRequest(pair.jwt, '/sign-out', cookie))).status).toBe(200);
    expect((await createPrototypeLegacyHandler(environment.database)(bridgeRequest(pair.jwt))).status).toBe(401);
  });
});
