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
import { mobileRefreshTokens, authSessionDenials, authEmailProjection } from '@boardsesh/db/schema/auth';

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

// These handler tests assume an active account. Admission has its own suites
// (deletion-credential-admission and admission-read-coalescer).
vi.mock('../auth/admission-read-coalescer', () => ({
  // An active account with no cutoff row: generation 0, native generation 0.
  createAdmissionCoalescer: () => async () => ({ generation: 0, nativeGeneration: 0, deniedSessionKeys: new Set() }),
}));

vi.mock('../db/client', () => {
  function selectChain(projection?: Record<string, unknown>) {
    let rows =
      projection && 'deletedAt' in projection
        ? [{ id: 'unit-subject', deletedAt: null }]
        : [
            {
              userId: 'user-abc',
              expiresAt: new Date(Date.now() + 86400000),
              subjectGeneration: null,
              nativeGeneration: null,
              authenticatedAt: null,
            },
          ];
    const selection = {
      from: (table: unknown) => {
        if (table === authSessionDenials || table === authEmailProjection) rows = [];
        return selection;
      },
      leftJoin: () => selection,
      where: () => selection,
      limit: () => Object.assign(Promise.resolve(rows), { for: () => Promise.resolve(rows) }),
      for: () => Promise.resolve([{ id: 'unit-subject' }]),
      // oxlint-disable-next-line unicorn/no-thenable -- Model Drizzle's awaitable query builder.
      then: (resolve: (result: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
    };
    return selection;
  }
  const insertChain = {
    values: (...args: unknown[]) =>
      Object.assign(mockDbInsertValues(...args), {
        onConflictDoUpdate: () => ({
          returning: async () => [
            {
              userId: 'user-abc',
              generation: 0,
              nativeGeneration: 1,
              revokedThrough: new Date(),
              lastOperationId: crypto.randomUUID(),
            },
          ],
        }),
      }),
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
      select: vi.fn(selectChain),
      insert: vi.fn(() => insertChain),
      update: vi.fn(() => updateChain),
      delete: vi.fn(() => deleteChain),
      transaction: vi.fn(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          execute: async () => [{ transaction_isolation: 'read committed' }],
          select: vi.fn(selectChain),
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
  __fillRefreshRateLimitMapForTests,
  __fillInvalidRefreshRateLimitMapForTests,
} = await import('../handlers/native-auth');

const { validateMobileJwt, validateToken } = await import('../middleware/auth');
const { db } = await import('../db/client');
const { logger } = await import('../utils/logger');
const mockedDatabase = db as unknown as {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
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

  it('never upgrades a source transfer generation to the current database generation', async () => {
    const transferToken = createTransferToken('user-abc', { creationProof: { gen: 1, authSessionId: 'source-login' } });
    const req = makeRequest({ method: 'POST', body: { transferToken } });
    const res = makeResponse();
    await handleNativeAuthExchange(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    expect(res.statusCode).toBe(401);
    expect(mockDbInsertValues).not.toHaveBeenCalled();
  });
  it.each([false, true])('inherits only guarded source proof age (guarded=%s)', async (guarded) => {
    const authenticationTime = Math.floor(Date.now() / 1000) - 120;
    const transferToken = createTransferToken('user-abc', {
      creationProof: {
        gen: 0,
        authSessionId: 'source-login',
        auth_time: authenticationTime,
        ...(guarded ? { link_guarded: true } : {}),
      },
    });
    const req = makeRequest({ method: 'POST', body: { transferToken } });
    const res = makeResponse();
    await handleNativeAuthExchange(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    expect(res.statusCode).toBe(200);
    const payload = decodeJwt(parseBody(res).jwt as string);
    expect(payload.gen).toBe(0);
    expect(payload.auth_time).toBe(guarded ? authenticationTime : undefined);
    expect(payload.sid).not.toBe('source-login');
  });
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

  it('returns retryable 503 when NEXTAUTH_SECRET is unset during token generation', async () => {
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
      expect(res.statusCode).toBe(503);
      expect(parseBody(res).error).toBe('Authentication is temporarily unavailable');
    } finally {
      process.env.NEXTAUTH_SECRET = savedSecret;
    }
  });

  it.each(['hint', 'transaction', 'commit'])(
    'returns 503 for an unavailable %s without logging private errors',
    async (phase) => {
      let transactionCompletedSuccessfully = false;
      const failure = Object.assign(new Error('private fixture payload must not reach logs'), { code: 'ECONNRESET' });
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
      const error = vi.spyOn(logger, 'error').mockImplementation(() => logger);
      if (phase === 'hint') {
        mockedDatabase.select.mockImplementationOnce(() => {
          throw failure;
        });
      } else if (phase === 'commit') {
        mockDbUpdateReturning.mockResolvedValueOnce([
          { userId: 'unit-subject', expiresAt: new Date(Date.now() + 90_000) },
        ]);
        mockedDatabase.transaction.mockImplementationOnce(async (operation) => {
          const committedResult = await operation({
            execute: async () => [{ transaction_isolation: 'read committed' }],
            select: mockedDatabase.select,
            update: mockedDatabase.update,
            insert: mockedDatabase.insert,
          });
          transactionCompletedSuccessfully = committedResult.status === 200;
          throw failure;
        });
      } else {
        mockedDatabase.transaction.mockRejectedValueOnce(failure);
      }
      try {
        const res = makeResponse();
        await handleNativeAuthRefresh(
          makeRequest({ method: 'POST', body: { refreshToken: crypto.randomUUID() } }) as unknown as IncomingMessage,
          res as unknown as ServerResponse,
        );
        expect(res.statusCode).toBe(503);
        expect(parseBody(res)).toEqual({ error: 'Token refresh is temporarily unavailable' });
        expect(warn.mock.calls).toEqual([['[NativeAuth] Token refresh unavailable']]);
        expect(error).not.toHaveBeenCalled();
        if (phase === 'commit') {
          expect(transactionCompletedSuccessfully).toBe(true);
          expect(mockDbInsertValues).toHaveBeenCalledTimes(1);
        }
      } finally {
        warn.mockRestore();
        error.mockRestore();
      }
    },
  );

  it('does not turn failed success publication after commit into a retryable refusal', async () => {
    mockDbUpdateReturning.mockResolvedValueOnce([
      {
        id: 'publication-row',
        userId: 'unit-subject',
        expiresAt: new Date(Date.now() + 90_000),
      },
    ]);
    const res = makeResponse();
    res.end = () => {
      throw new Error('fixture socket closed');
    };
    const successLog = vi.spyOn(logger, 'info').mockImplementation(() => logger);
    try {
      await expect(
        handleNativeAuthRefresh(
          makeRequest({ method: 'POST', body: { refreshToken: crypto.randomUUID() } }) as unknown as IncomingMessage,
          res as unknown as ServerResponse,
        ),
      ).rejects.toThrow('fixture socket closed');
      expect(res.statusCode).toBe(200);
      expect(successLog.mock.calls).toEqual([['[NativeAuth] Token refresh successful']]);
    } finally {
      successLog.mockRestore();
    }
  });
});

describe('Rate limiting', () => {
  it('stores only a namespaced SHA-256 digest for the presented refresh secret', async () => {
    const refreshToken = 'synthetic-secret-never-retained-in-quota-key';
    const expectedKey = `refresh:${crypto.createHash('sha256').update(refreshToken).digest('hex')}`;
    const observedKeys: string[] = [];
    const actualSet = Object.getOwnPropertyDescriptor(Map.prototype, 'set')?.value as typeof Map.prototype.set;
    if (typeof actualSet !== 'function') throw new Error('Map intrinsic unavailable');
    const set = vi.spyOn(Map.prototype, 'set').mockImplementation(function (key, entry) {
      if (typeof key === 'string' && key.startsWith('refresh:')) observedKeys.push(key);
      return actualSet.call(this, key, entry);
    });
    try {
      const res = makeResponse();
      await handleNativeAuthRefresh(
        makeRequest({ method: 'POST', body: { refreshToken } }) as unknown as IncomingMessage,
        res as unknown as ServerResponse,
      );
      expect(res.statusCode).toBe(401);
    } finally {
      set.mockRestore();
    }
    expect(observedKeys).toContain(expectedKey);
    expect(observedKeys.some((key) => key.includes(refreshToken))).toBe(false);
  });

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

  it('admits distinct refresh secrets sharing one proxy address', async () => {
    for (let requestIndex = 0; requestIndex < 30; requestIndex++) {
      const req = makeRequest({
        method: 'POST',
        body: { refreshToken: `different-token-${requestIndex}` },
        remoteAddress: '10.0.0.50',
      });
      const res = makeResponse();
      await handleNativeAuthRefresh(req as unknown as IncomingMessage, res as unknown as ServerResponse);
      expect(res.statusCode).toBe(401);
    }
  });

  it('limits the same refresh secret across addresses and returns Retry-After', async () => {
    for (let requestIndex = 0; requestIndex <= 10; requestIndex++) {
      const req = makeRequest({
        method: 'POST',
        body: { refreshToken: 'one-repeated-refresh-secret' },
        remoteAddress: `10.0.0.${requestIndex}`,
      });
      const res = makeResponse();
      await handleNativeAuthRefresh(req as unknown as IncomingMessage, res as unknown as ServerResponse);
      expect(res.statusCode).toBe(requestIndex < 10 ? 401 : 429);
      if (requestIndex === 10) {
        expect(Number(res.headers['Retry-After'])).toBeGreaterThan(0);
        expect(Number(res.headers['Retry-After'])).toBeLessThanOrEqual(60);
      }
    }
  });

  it('starts a fresh refresh window exactly at the previous deadline', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(2_000_000);
    try {
      for (let requestIndex = 0; requestIndex < 11; requestIndex++) {
        const req = makeRequest({ method: 'POST', body: { refreshToken: 'window-secret' } });
        const res = makeResponse();
        await handleNativeAuthRefresh(req as unknown as IncomingMessage, res as unknown as ServerResponse);
        expect(res.statusCode).toBe(requestIndex < 10 ? 401 : 429);
      }
      now.mockReturnValue(2_060_000);
      const res = makeResponse();
      await handleNativeAuthRefresh(
        makeRequest({ method: 'POST', body: { refreshToken: 'window-secret' } }) as unknown as IncomingMessage,
        res as unknown as ServerResponse,
      );
      expect(res.statusCode).toBe(401);
    } finally {
      now.mockRestore();
    }
  });

  it('refuses existing-client capacity after lookup without consuming the token', async () => {
    __fillRefreshRateLimitMapForTests(50_000);
    const res = makeResponse();
    await handleNativeAuthRefresh(
      makeRequest({ method: 'POST', body: { refreshToken: 'capacity-secret' } }) as unknown as IncomingMessage,
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(503);
    expect(parseBody(res)).toEqual({ error: 'Service temporarily overloaded' });
    expect(mockedDatabase.select).toHaveBeenCalledTimes(1);
    expect(mockedDatabase.transaction).not.toHaveBeenCalled();
  });

  it('keeps missing-token admission separate from full existing-client capacity', async () => {
    __fillRefreshRateLimitMapForTests(50_000);
    mockedDatabase.select.mockImplementationOnce(() => ({
      from: () => ({ where: () => ({ limit: async () => [] }) }),
    }));
    const res = makeResponse();
    await handleNativeAuthRefresh(
      makeRequest({ method: 'POST', body: { refreshToken: 'missing-secret' } }) as unknown as IncomingMessage,
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(401);
    expect(parseBody(res)).toEqual({ error: 'Invalid refresh token' });
    expect(mockedDatabase.transaction).not.toHaveBeenCalled();
  });

  it('rotates an unseen existing secret while invalid-secret capacity is exhausted', async () => {
    __fillInvalidRefreshRateLimitMapForTests(49_999);
    for (const refreshToken of ['last-invalid-space', 'invalid-capacity-overflow']) {
      mockedDatabase.select.mockImplementationOnce(() => ({
        from: () => ({ where: () => ({ limit: async () => [] }) }),
      }));
      const res = makeResponse();
      await handleNativeAuthRefresh(
        makeRequest({ method: 'POST', body: { refreshToken } }) as unknown as IncomingMessage,
        res as unknown as ServerResponse,
      );
      expect(res.statusCode).toBe(refreshToken === 'last-invalid-space' ? 401 : 503);
    }
    expect(mockedDatabase.transaction).not.toHaveBeenCalled();

    mockDbUpdateReturning.mockResolvedValueOnce([
      {
        id: 'existing-refresh-row',
        userId: 'user-abc',
        expiresAt: new Date(Date.now() + 90_000),
        createdAt: new Date(),
      },
    ]);
    const res = makeResponse();
    await handleNativeAuthRefresh(
      makeRequest({
        method: 'POST',
        body: { refreshToken: 'previously-unseen-valid-secret' },
      }) as unknown as IncomingMessage,
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(200);
    expect(typeof parseBody(res).refreshToken).toBe('string');
    expect(mockedDatabase.transaction).toHaveBeenCalledTimes(1);
    expect(mockDbInsertValues).toHaveBeenCalledTimes(1);
  });

  it('throttles repeated missing secrets before lookup even when client capacity is full', async () => {
    __fillRefreshRateLimitMapForTests(50_000);
    for (let requestIndex = 0; requestIndex <= 10; requestIndex++) {
      if (requestIndex < 10) {
        mockedDatabase.select.mockImplementationOnce(() => ({
          from: () => ({ where: () => ({ limit: async () => [] }) }),
        }));
      }
      const res = makeResponse();
      await handleNativeAuthRefresh(
        makeRequest({
          method: 'POST',
          body: { refreshToken: 'repeated-missing-secret' },
          remoteAddress: `10.0.0.${requestIndex}`,
        }) as unknown as IncomingMessage,
        res as unknown as ServerResponse,
      );
      expect(res.statusCode).toBe(requestIndex < 10 ? 401 : 429);
      if (requestIndex === 10) expect(Number(res.headers['Retry-After'])).toBeGreaterThan(0);
    }
    expect(mockedDatabase.select).toHaveBeenCalledTimes(10);
    expect(mockedDatabase.transaction).not.toHaveBeenCalled();
  });

  it('bounds invalid-capacity eviction scans and admits missing secrets again after expiry', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(4_000_000);
    __fillInvalidRefreshRateLimitMapForTests(50_000);
    const actualIterator = Map.prototype[Symbol.iterator];
    let invalidCapacityScans = 0;
    const iterator = vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(function () {
      if (this.has('refresh:invalid-test-0')) invalidCapacityScans++;
      return actualIterator.call(this);
    });
    try {
      for (let requestIndex = 0; requestIndex < 5; requestIndex++) {
        now.mockReturnValue(4_000_000 + requestIndex * 250);
        mockedDatabase.select.mockImplementationOnce(() => ({
          from: () => ({ where: () => ({ limit: async () => [] }) }),
        }));
        const res = makeResponse();
        await handleNativeAuthRefresh(
          makeRequest({
            method: 'POST',
            body: { refreshToken: `overflow-${requestIndex}` },
          }) as unknown as IncomingMessage,
          res as unknown as ServerResponse,
        );
        expect(res.statusCode).toBe(503);
        expect(invalidCapacityScans).toBe(requestIndex === 4 ? 2 : 1);
      }
      now.mockReturnValue(4_060_000);
      mockedDatabase.select.mockImplementationOnce(() => ({
        from: () => ({ where: () => ({ limit: async () => [] }) }),
      }));
      const recovered = makeResponse();
      await handleNativeAuthRefresh(
        makeRequest({ method: 'POST', body: { refreshToken: 'after-invalid-expiry' } }) as unknown as IncomingMessage,
        recovered as unknown as ServerResponse,
      );
      expect(recovered.statusCode).toBe(401);
      expect(invalidCapacityScans).toBe(3);
    } finally {
      iterator.mockRestore();
      now.mockRestore();
    }
  });

  it('evicts expired refresh capacity and leaves sign-in capacity independent', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(3_000_000);
    try {
      __fillRefreshRateLimitMapForTests(50_000);
      const exchangeResponse = makeResponse();
      await handleNativeAuthExchange(
        makeRequest({ method: 'POST', body: { transferToken: 'invalid.signature' } }) as unknown as IncomingMessage,
        exchangeResponse as unknown as ServerResponse,
      );
      expect(exchangeResponse.statusCode).toBe(401);
      now.mockReturnValue(3_060_000);
      const refreshResponse = makeResponse();
      await handleNativeAuthRefresh(
        makeRequest({ method: 'POST', body: { refreshToken: 'new-after-expiry' } }) as unknown as IncomingMessage,
        refreshResponse as unknown as ServerResponse,
      );
      expect(refreshResponse.statusCode).toBe(401);
    } finally {
      now.mockRestore();
    }
  });

  it('keeps refresh independent of exhausted sign-in buckets and capacity', async () => {
    __fillRateLimitMapForTests(50_000);
    const res = makeResponse();
    await handleNativeAuthRefresh(
      makeRequest({ method: 'POST', body: { refreshToken: 'independent-secret' } }) as unknown as IncomingMessage,
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(401);
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

  it('revokes a live refresh token without requiring a live bearer', async () => {
    const rawRefreshToken = crypto.randomUUID();

    // JWT expiry does not end the longer-lived refresh proof. A still-live
    // refresh secret can sign out the native account without a valid bearer.
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

    // Bearer expiry does not prevent push cleanup with a live refresh secret.
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
      const selection = {
        from: () => selection,
        where: () => selection,
        for: async () => [{ id: 'user-rollback' }],
        // oxlint-disable-next-line unicorn/no-thenable -- Model Drizzle's awaitable query builder.
        then: (resolve: (result: unknown[]) => unknown) =>
          Promise.resolve([{ userId: 'user-rollback', expiresAt: new Date(Date.now() + 86400000) }]).then(resolve),
      };
      const transaction = {
        execute: async () => [{ transaction_isolation: 'read committed' }],
        delete: () => ({ where: async () => [] }),
        select: () => selection,
        insert: () => ({
          values: () => ({
            onConflictDoUpdate: () => ({
              returning: async () => [
                {
                  userId: 'user-abc',
                  generation: 0,
                  nativeGeneration: 1,
                  revokedThrough: new Date(),
                  lastOperationId: crypto.randomUUID(),
                },
              ],
            }),
          }),
        }),
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
it('retains distributed transfer replay evidence through maximum signed lifetime and both clock tolerances', async () => {
  __resetNativeAuthStateForTests();
  const { redisClientManager } = await import('../redis/client');
  const publisher = { exists: vi.fn(async () => 0), set: vi.fn(async () => 'OK') };
  vi.mocked(redisClientManager.isRedisConnected).mockReturnValue(true);
  vi.mocked(redisClientManager.getClients).mockReturnValue({ publisher });
  const milliseconds = Math.floor(Date.now() / 1000) * 1000;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(milliseconds);
  vi.stubEnv('AUTH_LEGACY_BRIDGE_MODE', 'on');
  try {
    const transferToken = createTransferToken('user-abc', { issuedAt: milliseconds / 1000 + 5, expiresInSeconds: 125 });
    const req = makeRequest({ method: 'POST', body: { transferToken } });
    const res = makeResponse();
    await handleNativeAuthExchange(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    expect(res.statusCode).toBe(200);
    expect(publisher.set.mock.calls[0][3]).toBeGreaterThan(125 + 5 + 5);
  } finally {
    clock.mockRestore();
    vi.unstubAllEnvs();
    vi.mocked(redisClientManager.isRedisConnected).mockReturnValue(false);
  }
});
it('preserves a consumed transfer across separate consumer clocks and independent Redis wall time', async () => {
  __resetNativeAuthStateForTests();
  const { redisClientManager } = await import('../redis/client');
  const base = Math.floor(Date.now() / 1000) * 1000;
  let redisWall = base;
  const entries = new Map<string, number>();
  const publisher = {
    exists: vi.fn(async (key: string) => ((entries.get(key) ?? 0) > redisWall ? 1 : 0)),
    set: vi.fn(async (key: string, _contents: string, _expiry: string, seconds: number) => {
      if ((entries.get(key) ?? 0) > redisWall) return null;
      entries.set(key, redisWall + seconds * 1000);
      return 'OK';
    }),
  };
  vi.mocked(redisClientManager.isRedisConnected).mockReturnValue(true);
  vi.mocked(redisClientManager.getClients).mockReturnValue({ publisher });
  const clock = vi.spyOn(Date, 'now').mockReturnValue(base + 60000);
  vi.stubEnv('AUTH_LEGACY_BRIDGE_MODE', 'on');
  try {
    const transferToken = createTransferToken('user-abc', { issuedAt: base / 1000 + 65, expiresInSeconds: 125 });
    const first = makeResponse();
    await handleNativeAuthExchange(
      makeRequest({ method: 'POST', body: { transferToken } }) as unknown as IncomingMessage,
      first as unknown as ServerResponse,
    );
    expect(first.statusCode).toBe(200);
    redisWall = base + 255000;
    clock.mockReturnValue(base + 195000);
    const replay = makeResponse();
    await handleNativeAuthExchange(
      makeRequest({
        method: 'POST',
        body: { transferToken },
        remoteAddress: '127.0.0.2',
      }) as unknown as IncomingMessage,
      replay as unknown as ServerResponse,
    );
    expect(replay.statusCode).toBe(409);
    expect(publisher.set).toHaveBeenCalledTimes(1);
  } finally {
    clock.mockRestore();
    vi.unstubAllEnvs();
    vi.mocked(redisClientManager.isRedisConnected).mockReturnValue(false);
  }
});
it('refuses transfer exchange when distributed replay protection is unavailable in bridge-on mode', async () => {
  __resetNativeAuthStateForTests();
  const { redisClientManager } = await import('../redis/client');
  vi.mocked(redisClientManager.isRedisConnected).mockReturnValue(false);
  vi.stubEnv('AUTH_LEGACY_BRIDGE_MODE', 'on');
  try {
    const transferToken = createTransferToken('user-abc');
    const res = makeResponse();
    await handleNativeAuthExchange(
      makeRequest({ method: 'POST', body: { transferToken } }) as unknown as IncomingMessage,
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(503);
  } finally {
    vi.unstubAllEnvs();
  }
});
