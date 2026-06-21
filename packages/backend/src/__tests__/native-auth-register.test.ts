// @ts-nocheck — __tests__ is excluded from tsconfig.json, so the type-aware
// lint can't resolve node globals or `node:*` specifiers. Type-checking happens
// at test-run time via vitest.
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { compare } from 'bcryptjs';
import { users, userCredentials, userProfiles, mobileRefreshTokens } from '@boardsesh/db/schema/auth';

// ---------------------------------------------------------------------------
// Test secret — must match what generateTokenPair reads from env
// ---------------------------------------------------------------------------

process.env.NEXTAUTH_SECRET = 'test-secret-for-native-auth-register-tests';

// ---------------------------------------------------------------------------
// Mocks (hoisted before importing the handler)
//
// A queue of rows for each `.select()....limit()` await, plus an insert-call
// recorder so tests can assert which tables were written. `db` and the
// transaction's `tx` share one chain so the same queue drains across both and
// generateTokenPair's mobileRefreshTokens insert (run with `tx`) is recorded.
// ---------------------------------------------------------------------------

const mockDbSelectQueue: unknown[][] = [];
const insertCalls: { table: unknown; values: unknown }[] = [];
// When set, the NEXT insert(...).values(...) rejects with this error (and then
// clears) — lets tests drive the transaction's catch path (23505 race → 409,
// any other throw → 500).
let nextInsertError: unknown = null;

function makeAwaitableInsert(): Promise<unknown[]> & { onConflictDoNothing: () => Promise<unknown[]> } {
  const promise = Promise.resolve([]) as Promise<unknown[]> & { onConflictDoNothing: () => Promise<unknown[]> };
  promise.onConflictDoNothing = () => Promise.resolve([]);
  return promise;
}

function makeChain() {
  const chain = {
    select() {
      return chain;
    },
    from() {
      return chain;
    },
    where() {
      return chain;
    },
    limit() {
      const rows = mockDbSelectQueue.shift() ?? [];
      return Promise.resolve(rows);
    },
    insert(table: unknown) {
      return {
        values(values: unknown) {
          insertCalls.push({ table, values });
          if (nextInsertError) {
            const error = nextInsertError;
            nextInsertError = null;
            return Promise.reject(error);
          }
          return makeAwaitableInsert();
        },
      };
    },
  };
  return chain;
}

const chain = makeChain();

vi.mock('../db/client', () => ({
  db: {
    select: (...args: unknown[]) => chain.select(...args),
    insert: (...args: unknown[]) => chain.insert(...args),
    transaction: async (callback: (tx: unknown) => unknown) => callback(chain),
  },
}));

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

const { handleNativeAuthRegister, __resetNativeAuthStateForTests, __fillRateLimitMapForTests } =
  await import('../handlers/native-auth');

// ---------------------------------------------------------------------------
// Request / response helpers (mirror native-auth-credentials.test.ts)
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
  emitter.url = '/auth/native/register';
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

function queueSelect(rows: unknown[]): void {
  mockDbSelectQueue.push(rows);
}

function insertsFor(table: unknown): { table: unknown; values: unknown }[] {
  return insertCalls.filter((call) => call.table === table);
}

async function callHandler(req: MockReq, res: MockRes): Promise<void> {
  await handleNativeAuthRegister(req as unknown as IncomingMessage, res as unknown as ServerResponse);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleNativeAuthRegister', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetNativeAuthStateForTests();
    mockDbSelectQueue.length = 0;
    insertCalls.length = 0;
    nextInsertError = null;
  });

  it('creates the account and returns a JWT + refresh token (auto-login)', async () => {
    queueSelect([]); // no existing user

    const req = makeRequest({
      method: 'POST',
      body: { email: 'new@example.com', password: 'longenough', name: 'Crusher' },
    });
    const res = makeResponse();
    await callHandler(req, res);

    expect(res.statusCode).toBe(201);
    const body = parseBody(res);
    expect(typeof body.jwt).toBe('string');
    expect(typeof body.refreshToken).toBe('string');
    expect(body.expiresAt).toBeDefined();

    // The three account rows + the refresh-token row from generateTokenPair.
    expect(insertsFor(users)).toHaveLength(1);
    expect(insertsFor(userCredentials)).toHaveLength(1);
    expect(insertsFor(userProfiles)).toHaveLength(1);
    expect(insertsFor(mobileRefreshTokens)).toHaveLength(1);

    const userValues = insertsFor(users)[0].values as Record<string, unknown>;
    expect(userValues.email).toBe('new@example.com');
    expect(userValues.name).toBe('Crusher');
    expect(userValues.emailVerified).toBeInstanceOf(Date);
  });

  it('stores a bcrypt hash, never the plaintext password', async () => {
    queueSelect([]);

    const req = makeRequest({
      method: 'POST',
      body: { email: 'hash@example.com', password: 'super-secret-pw' },
    });
    const res = makeResponse();
    await callHandler(req, res);

    expect(res.statusCode).toBe(201);
    const credValues = insertsFor(userCredentials)[0].values as Record<string, unknown>;
    expect(credValues.passwordHash).not.toBe('super-secret-pw');
    expect(await compare('super-secret-pw', credValues.passwordHash as string)).toBe(true);
  });

  it('normalizes the email (trim + lowercase) before storing', async () => {
    queueSelect([]);

    const req = makeRequest({
      method: 'POST',
      body: { email: '  NEW@Example.COM  ', password: 'longenough' },
    });
    const res = makeResponse();
    await callHandler(req, res);

    expect(res.statusCode).toBe(201);
    const userValues = insertsFor(users)[0].values as Record<string, unknown>;
    expect(userValues.email).toBe('new@example.com');
  });

  it('creates an UNVERIFIED account when email verification is enabled', async () => {
    process.env.EMAIL_VERIFICATION_ENABLED = 'true';
    try {
      queueSelect([]);
      const req = makeRequest({
        method: 'POST',
        body: { email: 'verify@example.com', password: 'longenough' },
      });
      const res = makeResponse();
      await callHandler(req, res);

      expect(res.statusCode).toBe(201);
      const userValues = insertsFor(users)[0].values as Record<string, unknown>;
      expect(userValues.emailVerified).toBeNull();
    } finally {
      delete process.env.EMAIL_VERIFICATION_ENABLED;
    }
  });

  it('falls back to the email local-part when no name is given', async () => {
    queueSelect([]);

    const req = makeRequest({
      method: 'POST',
      body: { email: 'sloper@example.com', password: 'longenough' },
    });
    const res = makeResponse();
    await callHandler(req, res);

    expect(res.statusCode).toBe(201);
    const userValues = insertsFor(users)[0].values as Record<string, unknown>;
    expect(userValues.name).toBe('sloper');
  });

  it('returns 409 when an account already exists for that email', async () => {
    queueSelect([{ id: 'existing-user', email: 'taken@example.com' }]);

    const req = makeRequest({
      method: 'POST',
      body: { email: 'taken@example.com', password: 'longenough' },
    });
    const res = makeResponse();
    await callHandler(req, res);

    expect(res.statusCode).toBe(409);
    expect(parseBody(res).error).toBe(
      'An account with this email already exists. Please sign in with your existing account.',
    );
    // No rows written when the email is taken.
    expect(insertsFor(users)).toHaveLength(0);
  });

  it('maps a 23505 unique-violation race to 409 (no token pair)', async () => {
    queueSelect([]); // pre-check passes…
    nextInsertError = { code: '23505' }; // …but the users insert loses the race
    const req = makeRequest({
      method: 'POST',
      body: { email: 'racer@example.com', password: 'longenough' },
    });
    const res = makeResponse();
    await callHandler(req, res);

    expect(res.statusCode).toBe(409);
    expect(parseBody(res).error).toBe('An account with this email already exists');
    expect(parseBody(res).jwt).toBeUndefined();
  });

  it('rolls back and returns 500 when a transaction insert throws', async () => {
    queueSelect([]);
    nextInsertError = new Error('db exploded');
    const req = makeRequest({
      method: 'POST',
      body: { email: 'boom@example.com', password: 'longenough' },
    });
    const res = makeResponse();
    await callHandler(req, res);

    expect(res.statusCode).toBe(500);
    expect(parseBody(res).error).toBe('Internal server error');
    expect(parseBody(res).jwt).toBeUndefined();
  });

  it('returns 400 for an invalid email', async () => {
    const req = makeRequest({ method: 'POST', body: { email: 'not-an-email', password: 'longenough' } });
    const res = makeResponse();
    await callHandler(req, res);
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).error).toBe('Invalid email address');
  });

  it('returns 400 for a password shorter than 8 characters', async () => {
    const req = makeRequest({ method: 'POST', body: { email: 'x@y.zz', password: 'short' } });
    const res = makeResponse();
    await callHandler(req, res);
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).error).toBe('Password must be at least 8 characters');
  });

  it('returns 400 for a password longer than 128 characters', async () => {
    const req = makeRequest({ method: 'POST', body: { email: 'x@y.zz', password: 'a'.repeat(129) } });
    const res = makeResponse();
    await callHandler(req, res);
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).error).toBe('Password must be less than 128 characters');
  });

  it('returns 400 for a name longer than 100 characters', async () => {
    const req = makeRequest({
      method: 'POST',
      body: { email: 'x@y.zz', password: 'longenough', name: 'a'.repeat(101) },
    });
    const res = makeResponse();
    await callHandler(req, res);
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).error).toBe('Name must be less than 100 characters');
  });

  it('returns 400 when email is missing', async () => {
    const req = makeRequest({ method: 'POST', body: { password: 'longenough' } });
    const res = makeResponse();
    await callHandler(req, res);
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).error).toBe('email and password are required');
  });

  it('returns 400 when password is missing', async () => {
    const req = makeRequest({ method: 'POST', body: { email: 'x@y.zz' } });
    const res = makeResponse();
    await callHandler(req, res);
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).error).toBe('email and password are required');
  });

  it('returns 400 for a non-object body', async () => {
    const req = makeRequest({ method: 'POST', body: 'not-an-object' });
    const res = makeResponse();
    await callHandler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for an invalid JSON body', async () => {
    const req = makeRequest({ method: 'POST', rawBody: 'not valid json {{{' });
    const res = makeResponse();
    await callHandler(req, res);
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).error).toBe('Invalid JSON body');
  });

  it('returns 400 for an oversized request body', async () => {
    // readBody caps the body at 4096 bytes and rejects beyond it; the handler
    // maps that to a 400 (same as a malformed body).
    const req = makeRequest({ method: 'POST', rawBody: 'x'.repeat(5000) });
    const res = makeResponse();
    await callHandler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('returns 405 for non-POST methods', async () => {
    const req = makeRequest({ method: 'GET' });
    const res = makeResponse();
    await callHandler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it('returns 429 when the per-IP rate limit is exceeded', async () => {
    // 10 successful registrations fill the bucket (limit is 10/min/IP).
    for (let i = 0; i < 10; i++) {
      queueSelect([]); // duplicate pre-check miss
      const req = makeRequest({
        method: 'POST',
        body: { email: `crew${i}@example.com`, password: 'longenough' },
        remoteAddress: '10.0.0.77',
      });
      const res = makeResponse();
      await callHandler(req, res);
      expect(res.statusCode).toBe(201);
    }

    const req = makeRequest({
      method: 'POST',
      body: { email: 'crew11@example.com', password: 'longenough' },
      remoteAddress: '10.0.0.77',
    });
    const res = makeResponse();
    await callHandler(req, res);
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBeDefined();
  });

  it('returns 503 when the rate limit map is full', async () => {
    __fillRateLimitMapForTests(50_000);
    const req = makeRequest({
      method: 'POST',
      body: { email: 'x@y.zz', password: 'longenough' },
      remoteAddress: '10.0.0.88',
    });
    const res = makeResponse();
    await callHandler(req, res);
    expect(res.statusCode).toBe(503);
    expect(parseBody(res).error).toBe('Service temporarily overloaded');
  });
});
