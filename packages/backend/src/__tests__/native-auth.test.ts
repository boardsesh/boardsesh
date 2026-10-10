// @ts-nocheck — __tests__ is excluded from tsconfig.json, so the type-aware
// lint can't resolve node globals or `node:*` specifiers. Type-checking happens
// at test-run time via vitest.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { decodeJwt, SignJWT } from 'jose';
import { notificationDevices } from '@boardsesh/db/schema/app';
import { mobileRefreshTokens } from '@boardsesh/db/schema/auth';

// ---------------------------------------------------------------------------
// Test secret — must match what verifyTransferToken reads from env
// ---------------------------------------------------------------------------

const TEST_SECRET = 'test-secret-for-native-auth-tests';
process.env.NEXTAUTH_SECRET = TEST_SECRET;

// ---------------------------------------------------------------------------
// Mocks (must be hoisted before importing the handler)
// ---------------------------------------------------------------------------

// Mock the db module. We use a full chain mock for insert/update/delete/select.
const mockDbInsertValues = vi.fn(async () => []);
const mockDbUpdateSet = vi.fn();
const mockDbUpdateWhere = vi.fn();
const mockDbUpdateReturning = vi.fn(async () => []);
const mockDbDeleteWhere = vi.fn();
const mockDbDeleteReturning = vi.fn(async () => []);

vi.mock('../db/client', () => {
  const insertChain = {
    values: (...args: unknown[]) => mockDbInsertValues(...args),
  };
  const updateChain = {
    set: (...args: unknown[]) => {
      mockDbUpdateSet(...args);
      return updateChain;
    },
    where: (...args: unknown[]) => {
      mockDbUpdateWhere(...args);
      return updateChain;
    },
    returning: (...args: unknown[]) => mockDbUpdateReturning(...args),
  };
  const deleteChain = {
    where: (...args: unknown[]) => {
      mockDbDeleteWhere(...args);
      return deleteChain;
    },
    returning: (...args: unknown[]) => mockDbDeleteReturning(...args),
  };
  return {
    db: {
      insert: vi.fn(() => insertChain),
      update: vi.fn(() => updateChain),
      delete: vi.fn(() => deleteChain),
      transaction: vi.fn(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          insert: vi.fn(() => insertChain),
          update: vi.fn(() => updateChain),
          delete: vi.fn(() => deleteChain),
        };
        return fn(tx);
      }),
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

const {
  handleNativeAuthExchange,
  handleNativeAuthRefresh,
  handleNativeAuthRevoke,
  __resetNativeAuthStateForTests,
  __fillConsumedTokenMapForTests,
  __fillRateLimitMapForTests,
} = await import('../handlers/native-auth');

const { validateMobileJwt, validateToken } = await import('../middleware/auth');
const { db } = await import('../db/client');
const mockedDatabase = db as unknown as {
  update: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
};

// ---------------------------------------------------------------------------
// Transfer token generation helper (mirrors the web-side HMAC signing)
// ---------------------------------------------------------------------------

function createTransferToken(
  userId: string,
  opts?: { expiresInSeconds?: number; secret?: string; issuedAt?: number; creationProof?: Record<string, unknown> },
): string {
  const secret = opts?.secret ?? TEST_SECRET;
  const now = Math.floor(Date.now() / 1000);
  const iat = opts?.issuedAt ?? now;
  const exp = iat + (opts?.expiresInSeconds ?? 120);

  const payload = { userId, nextPath: '/app', iat, exp, ...opts?.creationProof };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');

  return `${encodedPayload}.${signature}`;
}

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
  emitter.url = '/auth/native/exchange';
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleNativeAuthExchange', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetNativeAuthStateForTests();
    // Default: db insert succeeds (for generateTokenPair)
    mockDbInsertValues.mockResolvedValue([]);
  });

  it('returns JWT + refresh token for a valid transfer token', async () => {
    const transferToken = createTransferToken('user-abc');
    const req = makeRequest({ method: 'POST', body: { transferToken } });
    const res = makeResponse();

    await handleNativeAuthExchange(req as unknown as IncomingMessage, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body.jwt).toBeDefined();
    expect(typeof body.jwt).toBe('string');
    expect(body.refreshToken).toBeDefined();
    expect(typeof body.refreshToken).toBe('string');
    expect(body.expiresAt).toBeDefined();
    expect(body.userId).toBe('user-abc');
    expect(body.accountCreation).toBeUndefined();
  });

  it.each(['valid', 'foreign-user', 'foreign-provider', 'missing-attempt'] as const)(
    'preserves only signed bound browser creation proof: %s',
    async (scenario) => {
      const userId = '602c83bf-e090-4c90-9f7e-08ca0b6b5dad';
      const accountCreation = {
        userId: scenario === 'foreign-user' ? '45642f07-423c-49e1-854e-814beaa0df64' : userId,
        accountCreated: true,
        provider: 'apple',
        createdAt: '2026-10-10T00:00:00.000Z',
      };
      const creationProof = {
        accountCreation,
        authSessionId: 'login-1',
        provider: scenario === 'foreign-provider' ? 'google' : 'apple',
        ...(scenario === 'missing-attempt' ? {} : { attemptId: 'a'.repeat(32) }),
      };
      const transferToken = createTransferToken(userId, { creationProof });
      const req = makeRequest({ method: 'POST', body: { transferToken } });
      const res = makeResponse();
      await handleNativeAuthExchange(req as unknown as IncomingMessage, res as unknown as ServerResponse);
      expect(res.statusCode).toBe(200);
      expect(parseBody(res).userId).toBe(userId);
      expect(parseBody(res).accountCreation).toEqual(scenario === 'valid' ? accountCreation : undefined);
    },
  );

  it('returns 401 for an expired transfer token', async () => {
    // Token expired 60 seconds ago
    const transferToken = createTransferToken('user-abc', { expiresInSeconds: -60 });
    const req = makeRequest({ method: 'POST', body: { transferToken } });
    const res = makeResponse();

    await handleNativeAuthExchange(req as unknown as IncomingMessage, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(401);
    const body = parseBody(res);
    expect(body.error).toBe('Invalid or expired transfer token');
  });

  it('returns 401 for a transfer token with invalid signature', async () => {
    const transferToken = createTransferToken('user-abc', { secret: 'wrong-secret' });
    const req = makeRequest({ method: 'POST', body: { transferToken } });
    const res = makeResponse();

    await handleNativeAuthExchange(req as unknown as IncomingMessage, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(401);
    const body = parseBody(res);
    expect(body.error).toBe('Invalid or expired transfer token');
  });

  it('returns 409 for a replayed transfer token', async () => {
    const transferToken = createTransferToken('user-abc');

    // First request succeeds
    const req1 = makeRequest({ method: 'POST', body: { transferToken } });
    const res1 = makeResponse();
    await handleNativeAuthExchange(req1 as unknown as IncomingMessage, res1 as unknown as ServerResponse);
    expect(res1.statusCode).toBe(200);

    // Second request with the same token is rejected as replay
    const req2 = makeRequest({ method: 'POST', body: { transferToken } });
    const res2 = makeResponse();
    await handleNativeAuthExchange(req2 as unknown as IncomingMessage, res2 as unknown as ServerResponse);

    expect(res2.statusCode).toBe(409);
    const body = parseBody(res2);
    expect(body.error).toBe('Transfer token has already been used');
  });

  it('returns 400 for missing transferToken field', async () => {
    const req = makeRequest({ method: 'POST', body: {} });
    const res = makeResponse();
    await handleNativeAuthExchange(req as unknown as IncomingMessage, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(400);
    const body = parseBody(res);
    expect(body.error).toBe('transferToken is required');
  });

  it('returns 400 for non-object body', async () => {
    const req = makeRequest({ method: 'POST', body: 'not-an-object' });
    const res = makeResponse();
    await handleNativeAuthExchange(req as unknown as IncomingMessage, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(400);
  });

  it('returns 405 for non-POST methods', async () => {
    const req = makeRequest({ method: 'GET' });
    const res = makeResponse();
    await handleNativeAuthExchange(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    expect(res.statusCode).toBe(405);
  });

  it('returns 401 for malformed token (no dot separator)', async () => {
    const req = makeRequest({ method: 'POST', body: { transferToken: 'no-dot-here' } });
    const res = makeResponse();
    await handleNativeAuthExchange(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    expect(res.statusCode).toBe(401);
  });

  it('returns 503 when consumed token map is full', async () => {
    __fillConsumedTokenMapForTests(10_000);
    const transferToken = createTransferToken('user-abc');
    const req = makeRequest({ method: 'POST', body: { transferToken } });
    const res = makeResponse();
    await handleNativeAuthExchange(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    expect(res.statusCode).toBe(503);
    expect(parseBody(res).error).toBe('Service temporarily overloaded');
  });

  it('returns 503 when rate limit map is full', async () => {
    __fillRateLimitMapForTests(50_000);
    const req = makeRequest({ method: 'POST', body: { transferToken: 'payload.sig' }, remoteAddress: '10.0.0.1' });
    const res = makeResponse();
    await handleNativeAuthExchange(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    expect(res.statusCode).toBe(503);
    expect(parseBody(res).error).toBe('Service temporarily overloaded');
  });

  it('returns 400 for truly malformed JSON body', async () => {
    const req = makeRequest({ method: 'POST', rawBody: 'not valid json {{{' });
    const res = makeResponse();
    await handleNativeAuthExchange(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).error).toBe('Invalid JSON body');
  });

  it('returns 401 for a transfer token with an unreasonably long lifetime', async () => {
    // Token with a 1-hour lifetime (far exceeding the 125s max)
    const transferToken = createTransferToken('user-abc', { expiresInSeconds: 3600 });
    const req = makeRequest({ method: 'POST', body: { transferToken } });
    const res = makeResponse();

    await handleNativeAuthExchange(req as unknown as IncomingMessage, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(401);
    const body = parseBody(res);
    expect(body.error).toBe('Invalid or expired transfer token');
  });
});

describe('handleNativeAuthRefresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetNativeAuthStateForTests();
    mockDbInsertValues.mockResolvedValue([]);
  });

  it('returns new JWT + refresh token for a valid refresh token', async () => {
    const rawRefreshToken = crypto.randomUUID();
    const tokenHash = crypto.createHash('sha256').update(rawRefreshToken).digest('hex');

    // Simulate the DB returning the token row when revoked
    mockDbUpdateReturning.mockResolvedValueOnce([
      {
        id: 'token-id-1',
        userId: 'user-abc',
        tokenHash,
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), // 90 days from now
        createdAt: new Date(),
        revokedAt: new Date(),
      },
    ]);

    const req = makeRequest({ method: 'POST', body: { refreshToken: rawRefreshToken } });
    const res = makeResponse();

    await handleNativeAuthRefresh(req as unknown as IncomingMessage, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body.jwt).toBeDefined();
    expect(typeof body.jwt).toBe('string');
    expect(body.refreshToken).toBeDefined();
    expect(typeof body.refreshToken).toBe('string');
    expect(body.expiresAt).toBeDefined();
  });

  it('returns 401 for a revoked refresh token', async () => {
    const rawRefreshToken = crypto.randomUUID();

    // DB returns empty — token already revoked or doesn't exist
    mockDbUpdateReturning.mockResolvedValueOnce([]);

    const req = makeRequest({ method: 'POST', body: { refreshToken: rawRefreshToken } });
    const res = makeResponse();

    await handleNativeAuthRefresh(req as unknown as IncomingMessage, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(401);
    const body = parseBody(res);
    expect(body.error).toBe('Invalid refresh token');
  });

  it('returns 401 for an expired refresh token', async () => {
    const rawRefreshToken = crypto.randomUUID();
    const tokenHash = crypto.createHash('sha256').update(rawRefreshToken).digest('hex');

    // Token exists but expired yesterday
    mockDbUpdateReturning.mockResolvedValueOnce([
      {
        id: 'token-id-2',
        userId: 'user-abc',
        tokenHash,
        expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000), // expired 1 day ago
        createdAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000),
        revokedAt: new Date(),
      },
    ]);

    const req = makeRequest({ method: 'POST', body: { refreshToken: rawRefreshToken } });
    const res = makeResponse();

    await handleNativeAuthRefresh(req as unknown as IncomingMessage, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(401);
    const body = parseBody(res);
    expect(body.error).toBe('Refresh token expired');
  });

  it('returns 400 for missing refreshToken field', async () => {
    const req = makeRequest({ method: 'POST', body: {} });
    const res = makeResponse();
    await handleNativeAuthRefresh(req as unknown as IncomingMessage, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(400);
    const body = parseBody(res);
    expect(body.error).toBe('refreshToken is required');
  });

  it('returns 405 for non-POST methods', async () => {
    const req = makeRequest({ method: 'GET' });
    const res = makeResponse();
    await handleNativeAuthRefresh(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    expect(res.statusCode).toBe(405);
  });

  it('returns 500 when NEXTAUTH_SECRET is unset during token generation', async () => {
    // Set up valid refresh token revocation
    mockDbUpdateReturning.mockResolvedValueOnce([
      {
        id: 'token-id',
        userId: 'user-abc',
        tokenHash: 'hash',
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
        createdAt: new Date(),
        revokedAt: new Date(),
      },
    ]);

    const savedSecret = process.env.NEXTAUTH_SECRET;
    delete process.env.NEXTAUTH_SECRET;

    try {
      const refreshToken = crypto.randomUUID();
      const req = makeRequest({ method: 'POST', body: { refreshToken } });
      const res = makeResponse();
      await handleNativeAuthRefresh(req as unknown as IncomingMessage, res as unknown as ServerResponse);
      expect(res.statusCode).toBe(500);
      expect(parseBody(res).error).toBe('Internal server error');
    } finally {
      process.env.NEXTAUTH_SECRET = savedSecret;
    }
  });
});

describe('Rate limiting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetNativeAuthStateForTests();
    mockDbInsertValues.mockResolvedValue([]);
  });

  it('returns 429 after 10 requests from the same IP in the exchange endpoint', async () => {
    // Make 10 requests — all should pass rate limiting (they'll fail for other
    // reasons like invalid tokens, but the status code won't be 429).
    for (let requestIndex = 0; requestIndex < 10; requestIndex++) {
      const req = makeRequest({
        method: 'POST',
        body: { transferToken: `payload${requestIndex}.sig${requestIndex}` },
        remoteAddress: '10.0.0.99',
      });
      const res = makeResponse();
      await handleNativeAuthExchange(req as unknown as IncomingMessage, res as unknown as ServerResponse);
      // These will be 401 (invalid token), not 429
      expect(res.statusCode).not.toBe(429);
    }

    // 11th request should be rate-limited
    const req = makeRequest({
      method: 'POST',
      body: { transferToken: 'payload.sig' },
      remoteAddress: '10.0.0.99',
    });
    const res = makeResponse();
    await handleNativeAuthExchange(req as unknown as IncomingMessage, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(429);
    const body = parseBody(res);
    expect(body.error).toContain('Rate limit exceeded');
  });

  it('rate limits the refresh endpoint independently per IP', async () => {
    // 10 requests from the same IP
    for (let requestIndex = 0; requestIndex < 10; requestIndex++) {
      const req = makeRequest({
        method: 'POST',
        body: { refreshToken: `token-${requestIndex}` },
        remoteAddress: '10.0.0.50',
      });
      const res = makeResponse();
      await handleNativeAuthRefresh(req as unknown as IncomingMessage, res as unknown as ServerResponse);
      expect(res.statusCode).not.toBe(429);
    }

    // 11th request from same IP
    const req = makeRequest({
      method: 'POST',
      body: { refreshToken: 'token-overflow' },
      remoteAddress: '10.0.0.50',
    });
    const res = makeResponse();
    await handleNativeAuthRefresh(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    expect(res.statusCode).toBe(429);
  });

  it('does not rate limit requests from a different IP', async () => {
    // Exhaust rate limit for 10.0.0.99
    for (let requestIndex = 0; requestIndex < 11; requestIndex++) {
      const req = makeRequest({
        method: 'POST',
        body: { transferToken: `payload${requestIndex}.sig${requestIndex}` },
        remoteAddress: '10.0.0.99',
      });
      const res = makeResponse();
      await handleNativeAuthExchange(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    }

    // A request from a different IP should not be rate-limited
    const req = makeRequest({
      method: 'POST',
      body: { transferToken: 'payload.sig' },
      remoteAddress: '10.0.0.100',
    });
    const res = makeResponse();
    await handleNativeAuthExchange(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    expect(res.statusCode).not.toBe(429);
  });
});

describe('getClientIp (security)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetNativeAuthStateForTests();
    mockDbInsertValues.mockResolvedValue([]);
  });

  it('uses socket.remoteAddress and ignores X-Forwarded-For', async () => {
    // Exhaust rate limit for the socket address 10.0.0.1
    for (let requestIndex = 0; requestIndex < 11; requestIndex++) {
      const req = makeRequest({
        method: 'POST',
        body: { transferToken: `p${requestIndex}.s${requestIndex}` },
        remoteAddress: '10.0.0.1',
      });
      const res = makeResponse();
      await handleNativeAuthExchange(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    }

    // Now send from 10.0.0.1 with X-Forwarded-For set to a different IP.
    // If the handler incorrectly trusts XFF, this request would NOT be rate
    // limited. With the fix, it should be rate limited because remoteAddress
    // is still 10.0.0.1.
    const req = makeRequest({
      method: 'POST',
      body: { transferToken: 'payload.sig' },
      remoteAddress: '10.0.0.1',
    });
    // Add a spoofed X-Forwarded-For header
    (req as MockReq).headers['x-forwarded-for'] = '192.168.1.100';
    const res = makeResponse();
    await handleNativeAuthExchange(req as unknown as IncomingMessage, res as unknown as ServerResponse);

    // Should still be rate limited because we use remoteAddress, not XFF
    expect(res.statusCode).toBe(429);
  });
});

describe('handleNativeAuthRevoke', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetNativeAuthStateForTests();
    mockDbInsertValues.mockResolvedValue([]);
  });

  it('returns 200 with { revoked: true } for a valid refresh token', async () => {
    const rawRefreshToken = crypto.randomUUID();

    // First db.update().returning() finds the token and returns the userId
    mockDbUpdateReturning.mockResolvedValueOnce([
      {
        userId: 'user-abc',
      },
    ]);

    const req = makeRequest({ method: 'POST', body: { refreshToken: rawRefreshToken } });
    const res = makeResponse();

    await handleNativeAuthRevoke(req as unknown as IncomingMessage, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body.revoked).toBe(true);
  });

  it('returns 401 for a revoked or missing refresh token', async () => {
    const rawRefreshToken = crypto.randomUUID();

    // DB returns empty — token already revoked or doesn't exist
    mockDbUpdateReturning.mockResolvedValueOnce([]);

    const req = makeRequest({ method: 'POST', body: { refreshToken: rawRefreshToken } });
    const res = makeResponse();

    await handleNativeAuthRevoke(req as unknown as IncomingMessage, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(401);
    const body = parseBody(res);
    expect(body.error).toBe('Invalid refresh token');
    // A consumed secret cannot disable devices registered by a newer login.
    expect(mockDbUpdateSet).toHaveBeenCalledTimes(1);
    expect(mockDbUpdateSet).not.toHaveBeenCalledWith(expect.objectContaining({ active: false }));
  });

  it('revokes ALL tokens for the user, not just the submitted one', async () => {
    const rawRefreshToken = crypto.randomUUID();

    // First db.update().returning() finds the token and returns the userId
    mockDbUpdateReturning.mockResolvedValueOnce([
      {
        userId: 'user-xyz',
      },
    ]);

    const req = makeRequest({ method: 'POST', body: { refreshToken: rawRefreshToken } });
    const res = makeResponse();

    await handleNativeAuthRevoke(req as unknown as IncomingMessage, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(200);

    // All account cleanup uses the same transaction:
    // 1. Revoke the submitted token (with returning() to get userId)
    // 2. Revoke ALL remaining tokens for that user (by userId)
    // 3. Disable account push registrations.
    expect(mockDbUpdateSet).toHaveBeenCalledTimes(3);
    expect(mockDbUpdateWhere).toHaveBeenCalledTimes(3);
    expect(mockDbUpdateSet).toHaveBeenLastCalledWith({ active: false, updatedAt: expect.any(Date) });
    expect(mockedDatabase.update).not.toHaveBeenCalled();
    expect(mockedDatabase.transaction).toHaveBeenCalledOnce();
  });

  it('is not rate limited (exempt from shared auth rate limiter)', async () => {
    // Exhaust the shared rate limit from one IP using the exchange endpoint
    for (let requestIndex = 0; requestIndex < 11; requestIndex++) {
      const req = makeRequest({
        method: 'POST',
        body: { transferToken: `payload${requestIndex}.sig${requestIndex}` },
        remoteAddress: '10.0.0.200',
      });
      const res = makeResponse();
      await handleNativeAuthExchange(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    }

    // Revoke from the same IP should NOT be rate limited
    const rawRefreshToken = crypto.randomUUID();
    mockDbUpdateReturning.mockResolvedValueOnce([{ userId: 'user-revoke' }]);

    const req = makeRequest({
      method: 'POST',
      body: { refreshToken: rawRefreshToken },
      remoteAddress: '10.0.0.200',
    });
    const res = makeResponse();
    await handleNativeAuthRevoke(req as unknown as IncomingMessage, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body.revoked).toBe(true);
  });

  it('returns 405 for non-POST methods', async () => {
    const req = makeRequest({ method: 'GET' });
    const res = makeResponse();
    await handleNativeAuthRevoke(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    expect(res.statusCode).toBe(405);
  });

  it('returns 400 when refreshToken is missing', async () => {
    const req = makeRequest({ method: 'POST', body: {} });
    const res = makeResponse();
    await handleNativeAuthRevoke(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).error).toBe('refreshToken is required');
  });

  it('revokes an expired-but-unrevoked token and cleans up the user session', async () => {
    const rawRefreshToken = crypto.randomUUID();

    // The token exists in the DB and hasn't been revoked, but it IS expired.
    // The revoke handler checks `revoked_at IS NULL` but not expiry — this is
    // intentional: an expired token that was never revoked should still allow
    // the client to trigger a full sign-out (revoking all of that user's tokens).
    mockDbUpdateReturning.mockResolvedValueOnce([
      {
        userId: 'user-expired',
      },
    ]);

    const req = makeRequest({ method: 'POST', body: { refreshToken: rawRefreshToken } });
    const res = makeResponse();

    await handleNativeAuthRevoke(req as unknown as IncomingMessage, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body.revoked).toBe(true);

    // Token expiry does not prevent push cleanup with the refresh secret.
    expect(mockDbUpdateSet).toHaveBeenCalledTimes(3);
    expect(mockDbUpdateWhere).toHaveBeenCalledTimes(3);
    expect(mockDbUpdateSet).toHaveBeenLastCalledWith({ active: false, updatedAt: expect.any(Date) });
  });

  it('cleans up push devices with the refresh secret after the bearer expires', async () => {
    const expiredBearer = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-expired-bearer')
      .setIssuer('boardsesh')
      .setAudience('boardsesh-mobile')
      .setExpirationTime(Math.floor(Date.now() / 1000) - 120)
      .sign(new TextEncoder().encode(TEST_SECRET));
    expect(await validateMobileJwt(expiredBearer)).toBeNull();
    mockDbUpdateReturning.mockResolvedValueOnce([{ userId: 'user-expired-bearer' }]);
    const req = makeRequest({ method: 'POST', body: { refreshToken: crypto.randomUUID() } });
    req.headers.authorization = `Bearer ${expiredBearer}`;
    const res = makeResponse();
    await handleNativeAuthRevoke(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    expect(res.statusCode).toBe(200);
    expect(mockDbUpdateSet).toHaveBeenLastCalledWith({ active: false, updatedAt: expect.any(Date) });
  });

  it('rolls back the claimed refresh secret when device cleanup fails', async () => {
    let committedTokenRevocation = false;
    const updatedTables: unknown[] = [];
    mockedDatabase.transaction.mockImplementationOnce(async (operation) => {
      let stagedTokenRevocation = false;
      const transaction = {
        update: (table: unknown) => {
          updatedTables.push(table);
          return {
            set: () => ({
              where: () => {
                if (table === notificationDevices) throw new Error('device write unavailable');
                stagedTokenRevocation = true;
                return { returning: async () => [{ userId: 'user-rollback' }] };
              },
            }),
          };
        },
      };
      // Mimic the database transaction contract: only a fulfilled callback commits.
      const result = await operation(transaction);
      committedTokenRevocation = stagedTokenRevocation;
      return result;
    });
    const req = makeRequest({ method: 'POST', body: { refreshToken: crypto.randomUUID() } });
    const res = makeResponse();
    await handleNativeAuthRevoke(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    expect(res.statusCode).toBe(500);
    expect(updatedTables).toEqual([mobileRefreshTokens, mobileRefreshTokens, notificationDevices]);
    expect(committedTokenRevocation).toBe(false);
    expect(mockedDatabase.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// JWT helper — creates a signed mobile JWS for testing validateMobileJwt
// ---------------------------------------------------------------------------

const jwtSecret = new TextEncoder().encode(TEST_SECRET);

async function createTestJwt(
  claims: Record<string, unknown> = {},
  options: { issuer?: string; audience?: string; expiresIn?: string } = {},
): Promise<string> {
  const builder = new SignJWT({ sub: 'test-user', ...claims })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '1h');

  if (options.issuer !== undefined) builder.setIssuer(options.issuer);
  if (options.audience !== undefined) builder.setAudience(options.audience);

  return builder.sign(jwtSecret);
}

// ---------------------------------------------------------------------------
// validateMobileJwt tests
// ---------------------------------------------------------------------------

describe('validateMobileJwt', () => {
  it('returns { userId, isAuthenticated: true } for a valid mobile JWT', async () => {
    const token = await createTestJwt({}, { issuer: 'boardsesh', audience: 'boardsesh-mobile' });
    const result = await validateMobileJwt(token);

    expect(result).not.toBeNull();
    expect(result?.userId).toBe('test-user');
    expect(result?.isAuthenticated).toBe(true);
    expect(result?.credentialExpiresAt).toBe(Number(decodeJwt(token).exp) * 1000);
  });

  it('returns null for a JWT with wrong issuer', async () => {
    const token = await createTestJwt({}, { issuer: 'wrong-issuer', audience: 'boardsesh-mobile' });
    const result = await validateMobileJwt(token);

    expect(result).toBeNull();
  });

  it('returns null for a JWT with wrong audience', async () => {
    const token = await createTestJwt({}, { issuer: 'boardsesh', audience: 'wrong-audience' });
    const result = await validateMobileJwt(token);

    expect(result).toBeNull();
  });

  it('returns null for an expired JWT', async () => {
    const token = await createTestJwt({}, { issuer: 'boardsesh', audience: 'boardsesh-mobile', expiresIn: '-1h' });
    const result = await validateMobileJwt(token);

    expect(result).toBeNull();
  });

  it('returns null for a JWT with no sub claim', async () => {
    // Override sub with undefined to remove it from the payload
    const token = await createTestJwt({ sub: undefined }, { issuer: 'boardsesh', audience: 'boardsesh-mobile' });
    const result = await validateMobileJwt(token);

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validateToken dispatch tests
// ---------------------------------------------------------------------------

describe('validateToken', () => {
  it('dispatches a JWS token (3 segments) to the mobile validator', async () => {
    const token = await createTestJwt({}, { issuer: 'boardsesh', audience: 'boardsesh-mobile' });
    // JWS tokens have exactly 3 dot-separated segments
    expect(token.split('.').length).toBe(3);

    const result = await validateToken(token);

    expect(result).not.toBeNull();
    expect(result?.userId).toBe('test-user');
    expect(result?.isAuthenticated).toBe(true);
    expect(result?.credentialExpiresAt).toBe(Number(decodeJwt(token).exp) * 1000);
    expect(await validateToken(token)).toEqual(result);
  });

  it('returns null for a token with 2 segments', async () => {
    const result = await validateToken('segment1.segment2');
    expect(result).toBeNull();
  });

  it('returns null for a token with 4 segments', async () => {
    const result = await validateToken('segment1.segment2.segment3.segment4');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// MAX_BODY_BYTES enforcement
// ---------------------------------------------------------------------------

describe('MAX_BODY_BYTES enforcement', () => {
  it('rejects exchange request body exceeding 4096 bytes', async () => {
    __resetNativeAuthStateForTests();
    const oversizedBody = 'x'.repeat(5000);
    const req = new EventEmitter() as MockReq;
    req.method = 'POST';
    req.headers = {};
    req.socket = { remoteAddress: '10.99.0.1' };
    req.destroy = vi.fn();

    setImmediate(() => {
      req.emit('data', Buffer.from(oversizedBody, 'utf8'));
    });

    const res = makeResponse();
    await handleNativeAuthExchange(req as unknown as IncomingMessage, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// WebSocket auth path verification
// ---------------------------------------------------------------------------

describe('WebSocket auth path', () => {
  it('validateToken accepts mobile JWTs (same path used by WS connectionParams)', async () => {
    // The WebSocket setup extracts authToken from connectionParams and passes
    // it to validateToken (formerly validateNextAuthToken). This test confirms
    // mobile JWTs (3-segment JWS) are accepted through that unified path.
    const secret = new TextEncoder().encode(TEST_SECRET);
    const jwt = await new SignJWT({ sub: 'ws-test-user' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .setIssuer('boardsesh')
      .setAudience('boardsesh-mobile')
      .sign(secret);

    const result = await validateToken(jwt);
    expect(result).not.toBeNull();
    expect(result?.userId).toBe('ws-test-user');
    expect(result?.isAuthenticated).toBe(true);
  });
});
