// @ts-nocheck — __tests__ is excluded from tsconfig.json, so the type-aware
// lint can't resolve node globals or `node:*` specifiers. Type-checking happens
// at test-run time via vitest.
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { compare, hash } from 'bcryptjs';

vi.mock('bcryptjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('bcryptjs')>();
  return { ...actual, compare: vi.fn(actual.compare) };
});

// ---------------------------------------------------------------------------
// Test secret — must match what generateTokenPair reads from env
// ---------------------------------------------------------------------------

const TEST_SECRET = 'test-secret-for-native-auth-credentials-tests';
process.env.NEXTAUTH_SECRET = TEST_SECRET;

// ---------------------------------------------------------------------------
// Mocks (must be hoisted before importing the handler)
// ---------------------------------------------------------------------------

// db.select() returns rows queued via mockDbSelectQueue. Every chained call is
// a no-op that returns the same chain object; .limit() resolves the queued row.
const mockDbSelectQueue: unknown[][] = [];
const mockDbInsertValues = vi.fn(async () => []);

vi.mock('../db/client', () => {
  function makeSelectChain(): unknown {
    const chain = {
      from() {
        return chain;
      },
      innerJoin() {
        return chain;
      },
      where() {
        return chain;
      },
      limit() {
        return Promise.resolve(mockDbSelectQueue.shift() ?? []);
      },
    };
    return chain;
  }

  const insertChain = {
    values: (...args: unknown[]) => mockDbInsertValues(...args),
  };

  return {
    db: {
      select: vi.fn(() => makeSelectChain()),
      insert: vi.fn(() => insertChain),
    },
  };
});

vi.mock('../handlers/cors', () => ({
  applyCorsHeaders: vi.fn(() => true),
}));

vi.mock('../redis/client', () => ({
  redisClientManager: {
    isRedisConnected: vi.fn(() => false),
    isRedisConfigured: vi.fn(() => false),
    getClients: vi.fn(() => ({ publisher: {} })),
  },
}));

const { handleNativeAuthCredentials, __resetNativeAuthStateForTests, __fillRateLimitMapForTests } =
  await import('../handlers/native-auth');

// ---------------------------------------------------------------------------
// Request / response helpers
// ---------------------------------------------------------------------------

interface MockReq extends EventEmitter {
  method?: string;
  url?: string;
  headers: Record<string, string | string[]>;
  socket: Partial<Socket>;
  destroy: () => void;
}

function makeRequest(opts: { method: string; body?: unknown; rawBody?: string; remoteAddress?: string }): MockReq {
  const emitter = new EventEmitter() as MockReq;
  emitter.method = opts.method;
  emitter.url = '/auth/native/credentials';
  emitter.headers = {};
  emitter.socket = { remoteAddress: opts.remoteAddress ?? '127.0.0.1' };
  emitter.destroy = vi.fn();

  setImmediate(() => {
    if (opts.rawBody !== undefined) {
      emitter.emit('data', Buffer.from(opts.rawBody, 'utf8'));
    } else if (opts.body !== undefined) {
      emitter.emit('data', Buffer.from(JSON.stringify(opts.body), 'utf8'));
    }
    emitter.emit('end');
  });

  return emitter;
}

interface MockRes {
  statusCode: number;
  body: string;
  headers: Record<string, unknown>;
  headersSent: boolean;
  writeHead: (status: number, headers?: Record<string, unknown>) => void;
  end: (body?: string) => void;
  setHeader: (name: string, value: unknown) => void;
}

function makeResponse(): MockRes {
  const res: MockRes = {
    statusCode: 0,
    body: '',
    headers: {},
    headersSent: false,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headersSent = true;
      if (headers) Object.assign(this.headers, headers);
    },
    end(body) {
      if (body !== undefined) this.body = body;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
  };
  return res;
}

function parseBody(res: MockRes): Record<string, unknown> {
  return JSON.parse(res.body) as Record<string, unknown>;
}

function parseJwtSubject(res: MockRes): unknown {
  const jwt = parseBody(res).jwt;
  if (typeof jwt !== 'string') throw new Error('Expected JWT response');
  const encodedPayload = jwt.split('.')[1];
  if (!encodedPayload) throw new Error('Expected JWT payload');
  const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as { sub?: unknown };
  return payload.sub;
}

function queueSelect(rows: unknown[]): void {
  mockDbSelectQueue.push(rows);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleNativeAuthCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetNativeAuthStateForTests();
    mockDbSelectQueue.length = 0;
    mockDbInsertValues.mockResolvedValue([]);
  });

  it('returns JWT + refresh token for valid email + password', async () => {
    const passwordHash = await hash('correct-horse', 10);
    queueSelect([{ userId: 'user-1', passwordHash }]);

    const req = makeRequest({
      method: 'POST',
      body: { email: 'test@example.com', password: 'correct-horse' },
    });
    const res = makeResponse();

    await handleNativeAuthCredentials(req as unknown as IncomingMessage, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body.jwt).toBeDefined();
    expect(typeof body.jwt).toBe('string');
    expect(body.refreshToken).toBeDefined();
    expect(typeof body.refreshToken).toBe('string');
    expect(body.expiresAt).toBeDefined();
  });

  it('lower-cases and trims the submitted email before lookup', async () => {
    const passwordHash = await hash('correct-horse', 10);
    queueSelect([{ userId: 'user-1', passwordHash }]);

    const req = makeRequest({
      method: 'POST',
      body: { email: '  TEST@Example.COM  ', password: 'correct-horse' },
    });
    const res = makeResponse();

    await handleNativeAuthCredentials(req as unknown as IncomingMessage, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(200);
  });

  it('authenticates a legacy account whose stored email uses mixed casing', async () => {
    const passwordHash = await hash('legacy-password', 10);
    queueSelect([{ userId: 'legacy-user', passwordHash }]);

    const req = makeRequest({
      method: 'POST',
      body: { email: 'legacy.user@example.com', password: 'legacy-password' },
    });
    const res = makeResponse();

    await handleNativeAuthCredentials(req as unknown as IncomingMessage, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(200);
    expect(mockDbInsertValues).toHaveBeenCalledWith(expect.objectContaining({ userId: 'legacy-user' }));
  });

  it('authenticates a later password match among duplicate-by-case accounts', async () => {
    const firstPasswordHash = await hash('first-password', 10);
    const secondPasswordHash = await hash('second-password', 10);
    queueSelect([
      { userId: 'first-user', passwordHash: firstPasswordHash },
      { userId: 'second-user', passwordHash: secondPasswordHash },
    ]);

    const req = makeRequest({
      method: 'POST',
      body: { email: 'DUPLICATE@example.com', password: 'second-password' },
    });
    const res = makeResponse();

    await handleNativeAuthCredentials(req as unknown as IncomingMessage, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(200);
    expect(mockDbInsertValues).toHaveBeenCalledWith(expect.objectContaining({ userId: 'second-user' }));
    expect(parseJwtSubject(res)).toBe('second-user');
  });

  it('returns 401 for an unknown email', async () => {
    queueSelect([]); // user lookup miss

    const req = makeRequest({
      method: 'POST',
      body: { email: 'nobody@example.com', password: 'whatever' },
    });
    const res = makeResponse();

    await handleNativeAuthCredentials(req as unknown as IncomingMessage, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(401);
    expect(parseBody(res).error).toBe('Invalid email or password');
  });

  it('returns 401 for a wrong password', async () => {
    const passwordHash = await hash('correct-horse', 10);
    queueSelect([{ userId: 'user-1', passwordHash }]);

    const req = makeRequest({
      method: 'POST',
      body: { email: 'test@example.com', password: 'wrong-password' },
    });
    const res = makeResponse();

    await handleNativeAuthCredentials(req as unknown as IncomingMessage, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(401);
    expect(parseBody(res).error).toBe('Invalid email or password');
  });

  it('returns the generic 401 when every duplicate-by-case password is wrong', async () => {
    const firstPasswordHash = await hash('first-password', 10);
    const secondPasswordHash = await hash('second-password', 10);
    queueSelect([
      { userId: 'first-user', passwordHash: firstPasswordHash },
      { userId: 'second-user', passwordHash: secondPasswordHash },
    ]);

    const req = makeRequest({
      method: 'POST',
      body: { email: 'duplicate@example.com', password: 'wrong-password' },
    });
    const res = makeResponse();

    await handleNativeAuthCredentials(req as unknown as IncomingMessage, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(401);
    expect(parseBody(res).error).toBe('Invalid email or password');
    expect(mockDbInsertValues).not.toHaveBeenCalled();
  });

  it('returns the generic 401 when duplicate-by-case accounts share the submitted password', async () => {
    const sharedPasswordHash = await hash('shared-password', 10);
    queueSelect([
      { userId: 'first-user', passwordHash: sharedPasswordHash },
      { userId: 'second-user', passwordHash: sharedPasswordHash },
    ]);

    const req = makeRequest({
      method: 'POST',
      body: { email: 'duplicate@example.com', password: 'shared-password' },
    });
    const res = makeResponse();

    await handleNativeAuthCredentials(req as unknown as IncomingMessage, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(401);
    expect(parseBody(res).error).toBe('Invalid email or password');
    expect(mockDbInsertValues).not.toHaveBeenCalled();
  });

  it('bounds bcrypt work for an oversized duplicate-by-case account group', async () => {
    const passwordHash = await hash('candidate-password', 10);
    queueSelect(
      Array.from({ length: 9 }, (_, index) => ({
        userId: `candidate-${index}`,
        passwordHash,
      })),
    );

    const req = makeRequest({
      method: 'POST',
      body: { email: 'duplicate@example.com', password: 'candidate-password' },
    });
    const res = makeResponse();

    await handleNativeAuthCredentials(req as unknown as IncomingMessage, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(401);
    expect(parseBody(res).error).toBe('Invalid email or password');
    expect(vi.mocked(compare)).toHaveBeenCalledTimes(8);
    expect(mockDbInsertValues).not.toHaveBeenCalled();
  });

  it('returns 401 for an OAuth-only user (no userCredentials row)', async () => {
    queueSelect([]); // inner join excludes the user with no credentials row

    const req = makeRequest({
      method: 'POST',
      body: { email: 'oauth@example.com', password: 'anything' },
    });
    const res = makeResponse();

    await handleNativeAuthCredentials(req as unknown as IncomingMessage, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(401);
    expect(parseBody(res).error).toBe('Invalid email or password');
  });

  it('returns 400 when email is missing', async () => {
    const req = makeRequest({ method: 'POST', body: { password: 'x' } });
    const res = makeResponse();
    await handleNativeAuthCredentials(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).error).toBe('email and password are required');
  });

  it('returns 400 when password is missing', async () => {
    const req = makeRequest({ method: 'POST', body: { email: 'x@y.z' } });
    const res = makeResponse();
    await handleNativeAuthCredentials(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).error).toBe('email and password are required');
  });

  it('returns 400 when email is the wrong type', async () => {
    const req = makeRequest({ method: 'POST', body: { email: 123, password: 'x' } });
    const res = makeResponse();
    await handleNativeAuthCredentials(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for non-object body', async () => {
    const req = makeRequest({ method: 'POST', body: 'not-an-object' });
    const res = makeResponse();
    await handleNativeAuthCredentials(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid JSON body', async () => {
    const req = makeRequest({ method: 'POST', rawBody: 'not valid json {{{' });
    const res = makeResponse();
    await handleNativeAuthCredentials(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).error).toBe('Invalid JSON body');
  });

  it('returns 405 for non-POST methods', async () => {
    const req = makeRequest({ method: 'GET' });
    const res = makeResponse();
    await handleNativeAuthCredentials(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    expect(res.statusCode).toBe(405);
  });

  it('returns 429 when the per-IP rate limit is exceeded', async () => {
    const passwordHash = await hash('pw', 10);

    // Make 10 successful requests to fill the bucket (limit is 10/min/IP).
    for (let i = 0; i < 10; i++) {
      queueSelect([{ userId: 'user-1', passwordHash }]);
      const req = makeRequest({
        method: 'POST',
        body: { email: 'test@example.com', password: 'pw' },
        remoteAddress: '10.0.0.55',
      });
      const res = makeResponse();
      await handleNativeAuthCredentials(req as unknown as IncomingMessage, res as unknown as ServerResponse);
      expect(res.statusCode).toBe(200);
    }

    // 11th request from the same IP should be rate limited.
    const req = makeRequest({
      method: 'POST',
      body: { email: 'test@example.com', password: 'pw' },
      remoteAddress: '10.0.0.55',
    });
    const res = makeResponse();
    await handleNativeAuthCredentials(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBeDefined();
  });

  it('returns 503 when the rate limit map is full', async () => {
    __fillRateLimitMapForTests(50_000);
    const req = makeRequest({
      method: 'POST',
      body: { email: 'x@y.z', password: 'pw' },
      remoteAddress: '10.0.0.99',
    });
    const res = makeResponse();
    await handleNativeAuthCredentials(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    expect(res.statusCode).toBe(503);
    expect(parseBody(res).error).toBe('Service temporarily overloaded');
  });
});
