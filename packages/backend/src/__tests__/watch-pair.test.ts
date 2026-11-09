// @ts-nocheck — __tests__ is excluded from tsconfig.json, so the type-aware
// lint can't resolve node globals or `node:*` specifiers. Type-checking happens
// at test-run time via vitest.
/**
 * Tests for the Garmin watch pairing endpoints:
 *   POST /api/watch/pair-code  (authed — mints a short single-use code)
 *   POST /api/watch/pair       (unauthed — exchanges the code for a token pair)
 *
 * generateTokenPair runs for real (signs a JWT + inserts a refresh row via the
 * mocked db), so these also cover the token-pair shape. Redis is mocked so we
 * can drive SET NX collisions and the atomic compare-and-delete consume path deterministically.
 */
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const TEST_SECRET = 'test-secret-for-watch-pair-tests';
process.env.NEXTAUTH_SECRET = TEST_SECRET;

const USER_ID = 'user-watch-pair-test';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockDbInsertValues = vi.fn(async () => []);
// These handler tests assume an active account. Admission has its own suites
// (deletion-credential-admission and admission-read-coalescer).
vi.mock('../auth/admission-read-coalescer', () => ({
  createAdmissionCoalescer: () => async () => true,
}));

vi.mock('../db/client', () => {
  const insertChain = { values: (...args: unknown[]) => mockDbInsertValues(...args) };
  const selection = {
    from: () => selection,
    leftJoin: () => selection,
    where: () => selection,
    limit: () => {
      const rows = [{ id: USER_ID, deletedAt: null }];
      return Object.assign(Promise.resolve(rows), { for: () => Promise.resolve(rows) });
    },
  };
  const database = {
    select: vi.fn(() => selection),
    insert: vi.fn(() => insertChain),
    execute: async () => [{ transaction_isolation: 'read committed' }],
    transaction: async (callback: (transaction: unknown) => unknown) => callback(database),
  };
  return { db: database };
});

vi.mock('../handlers/cors', () => ({
  applyCorsHeaders: vi.fn(() => true),
}));

const validateTokenMock = vi.fn(async () => ({ userId: USER_ID, isAuthenticated: true }));
vi.mock('../middleware/auth', () => ({
  validateToken: (token: string) => validateTokenMock(token),
}));

const isRedisConnectedMock = vi.fn(() => true);
const redisSetMock = vi.fn(async () => 'OK');
let pendingPairOwner: string | null = USER_ID;
const redisGetMock = vi.fn(async () => pendingPairOwner);
const redisCompareDeleteMock = vi.fn(
  async (_script: string, _keyCount: number, _key: string, expectedOwner: string) => {
    if (pendingPairOwner !== expectedOwner) return null;
    const owner = pendingPairOwner;
    pendingPairOwner = null;
    return owner;
  },
);
vi.mock('../redis/client', () => ({
  redisClientManager: {
    isRedisConnected: () => isRedisConnectedMock(),
    getClients: () => ({
      publisher: {
        set: (...args: unknown[]) => redisSetMock(...args),
        get: (...args: unknown[]) => redisGetMock(...args),
        eval: (...args: unknown[]) => redisCompareDeleteMock(...args),
      },
    }),
  },
}));

const { handleWatchPairCode, handleWatchPair, __resetNativeAuthStateForTests } =
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

function makeRequest(opts: { method: string; body?: unknown; authHeader?: string }): MockReq {
  const emitter = new EventEmitter() as MockReq;
  emitter.method = opts.method;
  emitter.url = '/api/watch/pair';
  emitter.headers = {};
  if (opts.authHeader) emitter.headers.authorization = opts.authHeader;
  emitter.socket = { remoteAddress: '127.0.0.1' };
  emitter.destroy = vi.fn();
  setImmediate(() => {
    if (opts.body !== undefined) {
      emitter.emit('data', Buffer.from(JSON.stringify(opts.body), 'utf8'));
    }
    emitter.emit('end');
  });
  return emitter;
}

function makeResponse() {
  return {
    statusCode: 0,
    body: '',
    headers: {},
    writeHead(status: number, headers?: Record<string, unknown>) {
      this.statusCode = status;
      if (headers) Object.assign(this.headers, headers);
    },
    end(body?: string) {
      if (body !== undefined) this.body = body;
    },
    setHeader(name: string, value: unknown) {
      this.headers[name] = value;
    },
  };
}

async function runPairCode(opts: { method: string; authHeader?: string }) {
  const req = makeRequest(opts);
  const res = makeResponse();
  await handleWatchPairCode(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  return res;
}

async function runPair(opts: { method: string; body?: unknown }) {
  const req = makeRequest(opts);
  const res = makeResponse();
  await handleWatchPair(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  return res;
}

const CODE_RE = /^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{8}$/;
const bearer = 'Bearer a.b.c';

// ---------------------------------------------------------------------------
// pair-code
// ---------------------------------------------------------------------------

describe('handleWatchPairCode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetNativeAuthStateForTests();
    validateTokenMock.mockResolvedValue({ userId: USER_ID, isAuthenticated: true });
    isRedisConnectedMock.mockReturnValue(true);
    redisSetMock.mockResolvedValue('OK');
  });

  it('returns 405 for non-POST methods', async () => {
    const res = await runPairCode({ method: 'GET', authHeader: bearer });
    expect(res.statusCode).toBe(405);
  });

  it('returns 401 when the Authorization header is missing', async () => {
    const res = await runPairCode({ method: 'POST' });
    expect(res.statusCode).toBe(401);
    expect(redisSetMock).not.toHaveBeenCalled();
  });

  it('returns 401 when the token is invalid', async () => {
    validateTokenMock.mockResolvedValue(null);
    const res = await runPairCode({ method: 'POST', authHeader: bearer });
    expect(res.statusCode).toBe(401);
  });

  it('returns 503 when Redis is unavailable', async () => {
    isRedisConnectedMock.mockReturnValue(false);
    const res = await runPairCode({ method: 'POST', authHeader: bearer });
    expect(res.statusCode).toBe(503);
    expect(redisSetMock).not.toHaveBeenCalled();
  });

  it('mints an unambiguous 8-char code bound to the user with a TTL, NX', async () => {
    const res = await runPairCode({ method: 'POST', authHeader: bearer });
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.code).toMatch(CODE_RE);
    expect(typeof parsed.expiresAt).toBe('string');
    expect(redisSetMock).toHaveBeenCalledOnce();
    const args = redisSetMock.mock.calls[0];
    expect(String(args[0])).toContain('boardsesh:watch:pair:');
    expect(args[1]).toBe(USER_ID);
    expect(args).toContain('EX');
    expect(args).toContain('NX');
  });

  it('retries on a code collision (SET NX returns null)', async () => {
    redisSetMock.mockResolvedValueOnce(null); // first candidate collides
    const res = await runPairCode({ method: 'POST', authHeader: bearer });
    expect(res.statusCode).toBe(200);
    expect(redisSetMock).toHaveBeenCalledTimes(2);
  });

  it('returns 503 when it cannot allocate a unique code after retries', async () => {
    redisSetMock.mockResolvedValue(null); // every candidate collides
    const res = await runPairCode({ method: 'POST', authHeader: bearer });
    expect(res.statusCode).toBe(503);
  });

  it('rate-limits by IP: the 11th request in a window returns 429 with Retry-After', async () => {
    // checkAuthRateLimit allows 10/min per IP (shared with the native-auth
    // endpoints). The 11th request in the window is throttled before any work.
    for (let i = 0; i < 10; i++) {
      expect((await runPairCode({ method: 'POST', authHeader: bearer })).statusCode).toBe(200);
    }
    const res = await runPairCode({ method: 'POST', authHeader: bearer });
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// pair
// ---------------------------------------------------------------------------

describe('handleWatchPair', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetNativeAuthStateForTests();
    isRedisConnectedMock.mockReturnValue(true);
    pendingPairOwner = USER_ID;
    redisGetMock.mockImplementation(async () => pendingPairOwner);
    mockDbInsertValues.mockResolvedValue([]);
  });

  it('returns 405 for non-POST methods', async () => {
    const res = await runPair({ method: 'GET' });
    expect(res.statusCode).toBe(405);
  });

  it('returns 400 when code is missing', async () => {
    const res = await runPair({ method: 'POST', body: {} });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for a wrong-length code', async () => {
    const res = await runPair({ method: 'POST', body: { code: '123' } });
    expect(res.statusCode).toBe(400);
    expect(redisGetMock).not.toHaveBeenCalled();
  });

  it('returns 503 when Redis is unavailable', async () => {
    isRedisConnectedMock.mockReturnValue(false);
    const res = await runPair({ method: 'POST', body: { code: 'ABCD2345' } });
    expect(res.statusCode).toBe(503);
  });

  it('returns 401 for an invalid or expired code (lookup miss)', async () => {
    pendingPairOwner = null;
    const res = await runPair({ method: 'POST', body: { code: 'ABCD2345' } });
    expect(res.statusCode).toBe(401);
  });

  it('exchanges a valid code for a token pair (single-use atomic comparison)', async () => {
    const res = await runPair({ method: 'POST', body: { code: 'ABCD2345' } });
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(typeof parsed.jwt).toBe('string');
    expect(typeof parsed.refreshToken).toBe('string');
    expect(typeof parsed.expiresAt).toBe('string');
    expect(redisCompareDeleteMock).toHaveBeenCalledOnce();
    expect(String(redisCompareDeleteMock.mock.calls[0][2])).toBe('boardsesh:watch:pair:ABCD2345');
    // generateTokenPair persisted a refresh token.
    expect(mockDbInsertValues).toHaveBeenCalledOnce();
  });

  it('normalizes hand entry (lowercase + separators) before lookup', async () => {
    const res = await runPair({ method: 'POST', body: { code: 'abcd-2345' } });
    expect(res.statusCode).toBe(200);
    expect(String(redisCompareDeleteMock.mock.calls[0][2])).toBe('boardsesh:watch:pair:ABCD2345');
  });

  it('mints the token pair for the user the code was bound to', async () => {
    // The code maps (in Redis) to a specific userId; the JWT must be minted for
    // exactly that user, not the fixture default.
    pendingPairOwner = 'bound-user-xyz';
    const res = await runPair({ method: 'POST', body: { code: 'ABCD2345' } });
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    // Decode the JWS payload (2nd segment) and confirm sub === the bound user.
    const payload = JSON.parse(Buffer.from(parsed.jwt.split('.')[1], 'base64url').toString('utf8'));
    expect(payload.sub).toBe('bound-user-xyz');
    expect(payload.aud).toBe('boardsesh-mobile');
  });
});
