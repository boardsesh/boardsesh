import { createHmac, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// Transport/database seams around the actual released public handler.
// jose, SignJWT and all signature/claim verification execute unmodified.
vi.mock('../db/client', () => {
  const database = {
    insert: vi.fn(() => ({ values: vi.fn(async () => []) })),
    execute: async () => [{ transaction_isolation: 'read committed' }],
    transaction: async (callback: (transaction: unknown) => unknown) => callback(database),
  };
  return { db: database, dbRead: {} };
});
// This file is about token clocks. Deletion admission has its own suite.
vi.mock('../auth/human-admission', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../auth/human-admission')>()),
  isHumanSubjectActive: vi.fn(async () => true),
  readHumanSubjectState: vi.fn(async () => ({ generation: 0, nativeGeneration: 0, deniedSessionKeys: new Set() })),
  requireHumanSubjectForIssuance: vi.fn(async () => ({
    generation: 0,
    nativeGeneration: 0,
    deniedSessionKeys: new Set(),
  })),
}));
vi.mock('../handlers/cors', () => ({ applyCorsHeaders: vi.fn(() => true) }));
vi.mock('../redis/client', () => ({
  redisClientManager: {
    isRedisConnected: vi.fn(() => false),
    isRedisConfigured: vi.fn(() => false),
    getClients: vi.fn(() => ({ publisher: {} })),
  },
}));
vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { handleNativeAuthExchange, __resetNativeAuthStateForTests } = await import('../handlers/native-auth');
const { validateMobileJwt } = await import('../middleware/auth');
const NOW = new Date('2026-11-04T21:00:00.000Z');
const NOW_SECONDS = NOW.getTime() / 1000;
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;
const LEGACY_SECRET = 'boardsesh-native-clock-test-verification-key';
const LEGACY_KEY = new TextEncoder().encode(LEGACY_SECRET);
const CLOCK_TOLERANCE_SECONDS = 60;

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
  const { payload, protectedHeader } = await jwtVerify(pair.jwt, LEGACY_KEY, {
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

function user() {
  return randomUUID();
}

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

describe('released native JWT clock compatibility', () => {
  it.each([0, 1, 60, 61])(
    'validates exchange output with %s seconds between iat and relative expiry reads',
    async (delay) => {
      const userId = user();
      const { pair, payload } = await actualNativePair(userId, NOW, delay);
      expect(await validateMobileJwt(pair.jwt)).toMatchObject({ userId });
      expect(payload.exp).toBe(NOW_SECONDS + SEVEN_DAYS_SECONDS + delay);
    },
  );

  it.each([1, CLOCK_TOLERANCE_SECONDS])('accepts a producer node ahead by %s seconds', async (ahead) => {
    const userId = user();
    const { pair } = await actualNativePair(userId, new Date(NOW.getTime() + ahead * 1000));
    expect(await validateMobileJwt(pair.jwt)).toMatchObject({ userId });
  });

  it('keeps the original expiry and rejects the token once the 60-second grace ends', async () => {
    const userId = user();
    const sourceTime = new Date(NOW.getTime() - (SEVEN_DAYS_SECONDS + 59) * 1000);
    const { pair, payload } = await actualNativePair(userId, sourceTime);
    expect(payload.exp).toBe(NOW_SECONDS - 59);
    expect(await validateMobileJwt(pair.jwt)).toMatchObject({ userId });
    const validUntil = new Date((payload.exp! + CLOCK_TOLERANCE_SECONDS) * 1000);
    vi.setSystemTime(new Date(validUntil.getTime() - 1));
    expect(await validateMobileJwt(pair.jwt)).toMatchObject({ userId });
    vi.setSystemTime(validUntil);
    expect(await validateMobileJwt(pair.jwt)).toBeNull();
  });
});
