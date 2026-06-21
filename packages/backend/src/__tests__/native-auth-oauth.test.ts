// @ts-nocheck — __tests__ is excluded from tsconfig.json, so the type-aware
// lint can't resolve node globals or `node:*` specifiers. Type-checking happens
// at test-run time via vitest.
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { users, accounts, userProfiles, mobileRefreshTokens } from '@boardsesh/db/schema/auth';

// ---------------------------------------------------------------------------
// Env — generateTokenPair signs with NEXTAUTH_SECRET; the Google verifier
// needs at least one configured client ID to accept an audience.
// ---------------------------------------------------------------------------

process.env.NEXTAUTH_SECRET = 'test-secret-for-native-auth-oauth-tests';
process.env.APPLE_BUNDLE_ID = 'com.boardsesh.app';
process.env.GOOGLE_IOS_CLIENT_ID = 'ios-client.apps.googleusercontent.com';
process.env.GOOGLE_ANDROID_CLIENT_ID = 'android-client.apps.googleusercontent.com';
process.env.GOOGLE_WEB_CLIENT_ID = 'web-client.apps.googleusercontent.com';

// ---------------------------------------------------------------------------
// Mocks (hoisted before importing the handler)
// ---------------------------------------------------------------------------

// A queue of rows for each `.select()....limit()` await, plus call recorders so
// tests can assert which tables were written. `db` and the transaction's `tx`
// share one chain so the same queue drains across both.
const mockDbSelectQueue: unknown[][] = [];
const insertCalls: { table: unknown; values: unknown }[] = [];
const updateCalls: { table: unknown; values: unknown }[] = [];

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
          return makeAwaitableInsert();
        },
      };
    },
    update(table: unknown) {
      return {
        set(values: unknown) {
          return {
            where() {
              updateCalls.push({ table, values });
              return Promise.resolve([]);
            },
          };
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
    update: (...args: unknown[]) => chain.update(...args),
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

// Partial-mock jose: keep the real SignJWT (generateTokenPair must mint a real
// JWT we can assert on) but stub the network-bound JWKS + verify so no request
// is made. createRemoteJWKSet runs at module load; the returned resolver is
// never invoked because jwtVerify itself is mocked.
vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>();
  return {
    ...actual,
    createRemoteJWKSet: vi.fn(() => vi.fn()),
    jwtVerify: vi.fn(),
  };
});

const { jwtVerify } = await import('jose');
const { handleNativeAuthOAuth, __resetNativeAuthStateForTests, __fillRateLimitMapForTests } =
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
  emitter.url = '/auth/native/oauth';
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
  await handleNativeAuthOAuth(req as unknown as IncomingMessage, res as unknown as ServerResponse);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleNativeAuthOAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetNativeAuthStateForTests();
    mockDbSelectQueue.length = 0;
    insertCalls.length = 0;
    updateCalls.length = 0;
  });

  it('creates a new user (+ profile + account link) for an unknown Google identity', async () => {
    jwtVerify.mockResolvedValueOnce({
      payload: { sub: 'google-sub-1', email: 'new@example.com', email_verified: true, name: 'New Person' },
    });
    queueSelect([]); // no existing account for (google, sub)
    queueSelect([]); // no existing user by email

    const req = makeRequest({ method: 'POST', body: { provider: 'google', identityToken: 'tok' } });
    const res = makeResponse();
    await callHandler(req, res);

    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(typeof body.jwt).toBe('string');
    expect(typeof body.refreshToken).toBe('string');
    expect(body.expiresAt).toBeDefined();

    // Exactly one new user, one profile, one account link, one refresh token.
    expect(insertsFor(users)).toHaveLength(1);
    expect(insertsFor(userProfiles)).toHaveLength(1);
    expect(insertsFor(accounts)).toHaveLength(1);
    expect(insertsFor(mobileRefreshTokens)).toHaveLength(1);
    const userValues = insertsFor(users)[0].values as Record<string, unknown>;
    expect(userValues.email).toBe('new@example.com');
    expect(userValues.name).toBe('New Person');
    expect(userValues.emailVerified).toBeInstanceOf(Date);
    const accountValues = insertsFor(accounts)[0].values as Record<string, unknown>;
    expect(accountValues).toMatchObject({ provider: 'google', providerAccountId: 'google-sub-1', type: 'oauth' });
  });

  it('links by stable sub when the account already exists (no new user)', async () => {
    jwtVerify.mockResolvedValueOnce({
      payload: { sub: 'google-sub-2', email: 'someone@example.com', email_verified: true },
    });
    queueSelect([{ userId: 'existing-user' }]); // account link found by (provider, sub)

    const req = makeRequest({ method: 'POST', body: { provider: 'google', identityToken: 'tok' } });
    const res = makeResponse();
    await callHandler(req, res);

    expect(res.statusCode).toBe(200);
    // Resolved via the sub link — no user/profile/account writes, only the
    // refresh-token insert from generateTokenPair.
    expect(insertsFor(users)).toHaveLength(0);
    expect(insertsFor(userProfiles)).toHaveLength(0);
    expect(insertsFor(accounts)).toHaveLength(0);
    expect(insertsFor(mobileRefreshTokens)).toHaveLength(1);
  });

  it('links a native sign-in to an existing web user by email (no duplicate users row)', async () => {
    jwtVerify.mockResolvedValueOnce({
      payload: { sub: 'apple-sub-1', email: 'web-user@example.com', email_verified: true },
    });
    queueSelect([]); // no account link by sub
    queueSelect([{ id: 'web-user', emailVerified: null }]); // matched by email

    const req = makeRequest({
      method: 'POST',
      body: { provider: 'apple', identityToken: 'tok', name: { firstName: 'Web', lastName: 'User' } },
    });
    const res = makeResponse();
    await callHandler(req, res);

    expect(res.statusCode).toBe(200);
    // No new user — link the existing one.
    expect(insertsFor(users)).toHaveLength(0);
    expect(insertsFor(accounts)).toHaveLength(1);
    expect((insertsFor(accounts)[0].values as Record<string, unknown>).userId).toBe('web-user');
    // Provider asserted a verified email and the user wasn't verified → promote.
    expect(updateCalls.filter((call) => call.table === users)).toHaveLength(1);
    expect(insertsFor(mobileRefreshTokens)).toHaveLength(1);
  });

  it('does not re-verify the email when the existing user is already verified', async () => {
    jwtVerify.mockResolvedValueOnce({
      payload: { sub: 'apple-sub-9', email: 'verified@example.com', email_verified: true },
    });
    queueSelect([]); // no account link
    queueSelect([{ id: 'verified-user', emailVerified: new Date('2024-01-01') }]);

    const req = makeRequest({ method: 'POST', body: { provider: 'apple', identityToken: 'tok' } });
    const res = makeResponse();
    await callHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(updateCalls.filter((call) => call.table === users)).toHaveLength(0);
  });

  it('does NOT link to an existing account when the provider email is unverified', async () => {
    // Security: auto-linking an unverified provider email would let an attacker
    // who can mint a token for a victim's email claim take over that account.
    // The unverified identity must create its own user, anchored on its sub.
    jwtVerify.mockResolvedValueOnce({
      payload: { sub: 'google-sub-unverified', email: 'victim@example.com', email_verified: false },
    });
    queueSelect([]); // no account link by sub; the email-link path is skipped (unverified)

    const req = makeRequest({ method: 'POST', body: { provider: 'google', identityToken: 'tok' } });
    const res = makeResponse();
    await callHandler(req, res);

    expect(res.statusCode).toBe(200);
    // A fresh user is created (not linked) and owns the new account row.
    expect(insertsFor(users)).toHaveLength(1);
    expect(insertsFor(accounts)).toHaveLength(1);
    const newUserId = (insertsFor(users)[0].values as Record<string, unknown>).id;
    expect((insertsFor(accounts)[0].values as Record<string, unknown>).userId).toBe(newUserId);
    // No existing user's email was promoted to verified.
    expect(updateCalls.filter((call) => call.table === users)).toHaveLength(0);
  });

  it('resolves an Apple resubmission with no email via the stored sub', async () => {
    // Apple only returns the email on first authorization; later tokens omit it.
    jwtVerify.mockResolvedValueOnce({ payload: { sub: 'apple-sub-2' } });
    queueSelect([{ userId: 'apple-user' }]); // account link found by sub

    const req = makeRequest({ method: 'POST', body: { provider: 'apple', identityToken: 'tok' } });
    const res = makeResponse();
    await callHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(insertsFor(users)).toHaveLength(0);
    expect(insertsFor(mobileRefreshTokens)).toHaveLength(1);
  });

  it('rejects a brand-new identity that carries no email', async () => {
    jwtVerify.mockResolvedValueOnce({ payload: { sub: 'apple-sub-3' } });
    queueSelect([]); // no account link, and no email to match a user

    const req = makeRequest({ method: 'POST', body: { provider: 'apple', identityToken: 'tok' } });
    const res = makeResponse();
    await callHandler(req, res);

    expect(res.statusCode).toBe(401);
    expect(insertsFor(users)).toHaveLength(0);
  });

  it('returns 401 when the identity token fails verification', async () => {
    jwtVerify.mockRejectedValueOnce(new Error('signature verification failed'));

    const req = makeRequest({ method: 'POST', body: { provider: 'google', identityToken: 'bad' } });
    const res = makeResponse();
    await callHandler(req, res);

    expect(res.statusCode).toBe(401);
    expect(parseBody(res).error).toBe('Invalid or expired identity token');
    expect(jwtVerify).toHaveBeenCalledTimes(1);
  });

  it('enforces the Apple nonce when the client supplies one', async () => {
    // Token carries SHA-256(nonce) but the raw nonce we send hashes differently.
    jwtVerify.mockResolvedValueOnce({ payload: { sub: 'apple-sub-4', email: 'n@example.com', nonce: 'not-the-hash' } });

    const req = makeRequest({
      method: 'POST',
      body: { provider: 'apple', identityToken: 'tok', nonce: 'raw-nonce' },
    });
    const res = makeResponse();
    await callHandler(req, res);

    expect(res.statusCode).toBe(401);
  });

  it('returns 400 for an unsupported provider (before any verification)', async () => {
    const req = makeRequest({ method: 'POST', body: { provider: 'facebook', identityToken: 'tok' } });
    const res = makeResponse();
    await callHandler(req, res);

    expect(res.statusCode).toBe(400);
    expect(jwtVerify).not.toHaveBeenCalled();
  });

  it('returns 400 when identityToken is missing', async () => {
    const req = makeRequest({ method: 'POST', body: { provider: 'apple' } });
    const res = makeResponse();
    await callHandler(req, res);
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).error).toBe('identityToken is required');
  });

  it('returns 400 for a non-object body', async () => {
    const req = makeRequest({ method: 'POST', body: 'nope' });
    const res = makeResponse();
    await callHandler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid JSON', async () => {
    const req = makeRequest({ method: 'POST', rawBody: '{{{ not json' });
    const res = makeResponse();
    await callHandler(req, res);
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).error).toBe('Invalid JSON body');
  });

  it('returns 405 for non-POST methods', async () => {
    const req = makeRequest({ method: 'GET' });
    const res = makeResponse();
    await callHandler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it('returns 429 once the per-IP rate limit is exceeded', async () => {
    for (let i = 0; i < 10; i++) {
      jwtVerify.mockResolvedValueOnce({ payload: { sub: `sub-${i}`, email: 'rl@example.com' } });
      queueSelect([{ userId: 'rl-user' }]); // resolve via sub link each time
      const req = makeRequest({
        method: 'POST',
        body: { provider: 'google', identityToken: 'tok' },
        remoteAddress: '10.0.0.77',
      });
      const res = makeResponse();
      await callHandler(req, res);
      expect(res.statusCode).toBe(200);
    }

    const req = makeRequest({
      method: 'POST',
      body: { provider: 'google', identityToken: 'tok' },
      remoteAddress: '10.0.0.77',
    });
    const res = makeResponse();
    await callHandler(req, res);
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBeDefined();
  });

  it('returns 503 when the rate-limit map is full', async () => {
    __fillRateLimitMapForTests(50_000);
    const req = makeRequest({
      method: 'POST',
      body: { provider: 'google', identityToken: 'tok' },
      remoteAddress: '10.0.0.88',
    });
    const res = makeResponse();
    await callHandler(req, res);
    expect(res.statusCode).toBe(503);
  });
});
