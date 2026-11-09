import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const mockCheckRateLimit = vi.fn();
const mockGetClientIp = vi.fn();
vi.mock('@/app/lib/auth/rate-limiter', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  getClientIp: (...args: unknown[]) => mockGetClientIp(...args),
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => ({ _type: 'and', args })),
  eq: vi.fn((col: unknown, val: unknown) => ({ _type: 'eq', col, val })),
  gt: vi.fn((col: unknown, val: unknown) => ({ _type: 'gt', col, val })),
  inArray: vi.fn((col: unknown, values: unknown[]) => ({ _type: 'inArray', col, values })),
  isNull: vi.fn((col: unknown) => ({ _type: 'isNull', col })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ _type: 'sql', strings, values })),
}));

vi.mock('@/app/lib/auth/password-reset', () => ({
  PASSWORD_RESET_IDENTIFIER_PREFIX: 'password-reset:',
  PASSWORD_RESET_USER_IDENTIFIER_PREFIX: 'password-reset:v2:user:',
  getPasswordResetIdentifier: (userId: string) => `password-reset:v2:user:${userId}`,
  getPasswordResetUserId: (identifier: string) =>
    identifier.startsWith('password-reset:v2:user:')
      ? identifier.slice('password-reset:v2:user:'.length) || null
      : null,
  getLegacyPasswordResetEmail: (identifier: string) => {
    const prefix = 'password-reset:';
    if (!identifier.startsWith(prefix) || identifier.startsWith('password-reset:v2:user:')) return null;
    return identifier.slice(prefix.length) || null;
  },
  hashResetToken: (token: string) => `sha256:${token}`,
  consistentDelay: async () => {},
}));

const mockHash = vi.fn();
vi.mock('bcryptjs', () => ({
  default: {
    hash: (...args: unknown[]) => mockHash(...args),
  },
}));

const mockTokenLimit = vi.fn();
const mockUserLimit = vi.fn();
const mockTxCredentialsLimit = vi.fn();
const mockTxUpdateWhere = vi.fn().mockResolvedValue(undefined);
const mockTxUserUpdateWhere = vi.fn().mockResolvedValue(undefined);
const mockTxTokenDeleteWhere = vi.fn().mockResolvedValue(undefined);
const mockTxInsertValues = vi.fn().mockResolvedValue(undefined);
const mockDeleteWhere = vi.fn().mockResolvedValue(undefined);
const mockDelete = vi.fn((_table?: unknown) => ({ where: mockDeleteWhere }));
const mockTransaction = vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
  const tx = {
    select: () => ({ from: () => ({ where: () => ({ limit: mockTxCredentialsLimit }) }) }),
    update: (table: { userId?: unknown }) => ({
      set: () => ({
        where: table.userId === 'userCredentials.userId' ? mockTxUpdateWhere : mockTxUserUpdateWhere,
      }),
    }),
    insert: () => ({ values: mockTxInsertValues }),
    delete: () => ({ where: mockTxTokenDeleteWhere }),
  };
  await fn(tx);
});

const mockSelect = vi.fn((selection?: Record<string, unknown>) => {
  const limitMock = selection?.id ? mockUserLimit : mockTokenLimit;
  return {
    from: () => ({
      where: (predicate: unknown) => {
        if (selection?.id) mockUserWhere(predicate);
        else mockTokenWhere(predicate);
        return { limit: limitMock };
      },
    }),
  };
});

const mockUserWhere = vi.fn();
const mockTokenWhere = vi.fn();

vi.mock('@/app/lib/db/db', () => ({
  getDb: () => ({
    select: (selection?: Record<string, unknown>) => mockSelect(selection),
    delete: (table?: unknown) => mockDelete(table),
    transaction: (fn: (tx: unknown) => Promise<void>) => mockTransaction(fn),
  }),
}));

vi.mock('@/app/lib/db/schema', () => ({
  verificationTokens: {
    identifier: 'verificationTokens.identifier',
    token: 'verificationTokens.token',
    expires: 'verificationTokens.expires',
  },
  users: { id: 'users.id', email: 'users.email', emailVerified: 'users.emailVerified' },
  userCredentials: { userId: 'userCredentials.userId' },
}));

import { POST } from '../route';

function createRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/auth/reset-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/auth/reset-password', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetClientIp.mockReturnValue('127.0.0.1');
    mockCheckRateLimit.mockReturnValue({ limited: false, retryAfterSeconds: 0 });
    mockHash.mockResolvedValue('hashed-password');
    mockTxCredentialsLimit.mockResolvedValue([{ userId: 'user-1' }]);
  });

  it('returns 429 when rate limited', async () => {
    mockCheckRateLimit.mockReturnValueOnce({ limited: true, retryAfterSeconds: 25 });

    const response = await POST(
      createRequest({
        email: 'test@example.com',
        token: crypto.randomUUID(),
        password: 'validpassword',
        confirmPassword: 'validpassword',
      }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('25');
  });

  it('returns 400 for invalid request body', async () => {
    const response = await POST(createRequest({ email: 'bad', token: 'x', password: '123', confirmPassword: '123' }));
    expect(response.status).toBe(400);
  });

  it('returns 400 when reset token does not exist (no cleanup delete to avoid DoS)', async () => {
    mockTokenLimit.mockResolvedValue([]);

    const response = await POST(
      createRequest({
        email: 'test@example.com',
        token: crypto.randomUUID(),
        password: 'validpassword',
        confirmPassword: 'validpassword',
      }),
    );

    expect(response.status).toBe(400);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('returns 400 without mutating anything when the token belongs to a different email', async () => {
    // The token identifies one user row. A different email in the link must not
    // make the route select or update a same-address twin.
    mockTokenLimit.mockResolvedValue([{ identifier: 'password-reset:v2:user:user-1' }]);
    mockUserLimit.mockResolvedValue([{ id: 'user-1', email: 'owner@example.com' }]);

    const response = await POST(
      createRequest({
        email: 'attacker@example.com',
        token: crypto.randomUUID(),
        password: 'validpassword',
        confirmPassword: 'validpassword',
      }),
    );

    expect(response.status).toBe(400);
    expect(mockHash).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('resets password successfully', async () => {
    mockTokenLimit.mockResolvedValue([{ identifier: 'password-reset:v2:user:user-1' }]);
    mockUserLimit.mockResolvedValue([{ id: 'user-1', email: 'test@example.com' }]);

    const response = await POST(
      createRequest({
        email: 'test@example.com',
        token: crypto.randomUUID(),
        password: 'validpassword',
        confirmPassword: 'validpassword',
      }),
    );

    expect(response.status).toBe(200);
    expect(mockHash).toHaveBeenCalledWith('validpassword', 12);
    expect(mockTransaction).toHaveBeenCalled();
    expect(mockTxUpdateWhere).toHaveBeenCalled();
    expect(mockTxUpdateWhere).toHaveBeenCalledWith({ _type: 'eq', col: 'userCredentials.userId', val: 'user-1' });
    expect(mockUserWhere).toHaveBeenCalledWith({ _type: 'eq', col: 'users.id', val: 'user-1' });
    expect(mockTxTokenDeleteWhere).toHaveBeenCalledWith({
      _type: 'and',
      args: [
        { _type: 'eq', col: 'verificationTokens.identifier', val: 'password-reset:v2:user:user-1' },
        { _type: 'eq', col: 'verificationTokens.token', val: expect.stringMatching(/^sha256:/) },
      ],
    });
  });

  it('accepts a raw-case legacy token when its email has exactly one account', async () => {
    mockTokenLimit.mockResolvedValue([{ identifier: 'password-reset:Foo@example.com' }]);
    mockUserLimit.mockResolvedValue([{ id: 'legacy-owner', email: 'Foo@example.com' }]);

    const response = await POST(
      createRequest({
        email: 'foo@example.com',
        token: crypto.randomUUID(),
        password: 'validpassword',
        confirmPassword: 'validpassword',
      }),
    );

    expect(response.status).toBe(200);
    expect(mockTxUpdateWhere).toHaveBeenCalledWith({
      _type: 'eq',
      col: 'userCredentials.userId',
      val: 'legacy-owner',
    });
  });

  it('rejects a legacy email-only token while duplicate accounts make its owner ambiguous', async () => {
    mockTokenLimit.mockResolvedValue([{ identifier: 'password-reset:Foo@example.com' }]);
    mockUserLimit.mockResolvedValue([
      { id: 'mixed-case-twin', email: 'Foo@example.com' },
      { id: 'lower-case-twin', email: 'foo@example.com' },
    ]);

    const response = await POST(
      createRequest({
        email: 'foo@example.com',
        token: crypto.randomUUID(),
        password: 'validpassword',
        confirmPassword: 'validpassword',
      }),
    );

    expect(response.status).toBe(400);
    expect(mockHash).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('returns 400 when token is expired (simulated by empty SELECT result from db-side expiry filter)', async () => {
    // The WHERE clause includes gt(expires, now), so an expired token returns no rows.
    // We do NOT delete here to avoid a DoS where an attacker invalidates a victim's token.
    mockTokenLimit.mockResolvedValue([]);

    const response = await POST(
      createRequest({
        email: 'test@example.com',
        token: crypto.randomUUID(),
        password: 'validpassword',
        confirmPassword: 'validpassword',
      }),
    );

    expect(response.status).toBe(400);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('inserts credentials when user does not already have password credentials', async () => {
    mockTokenLimit.mockResolvedValue([{ identifier: 'password-reset:v2:user:oauth-user' }]);
    mockUserLimit.mockResolvedValue([{ id: 'oauth-user', email: 'oauth@example.com' }]);
    mockTxCredentialsLimit.mockResolvedValue([]);

    const response = await POST(
      createRequest({
        email: 'oauth@example.com',
        token: crypto.randomUUID(),
        password: 'validpassword',
        confirmPassword: 'validpassword',
      }),
    );

    expect(response.status).toBe(200);
    expect(mockTxInsertValues).toHaveBeenCalled();
  });

  it('returns 500 when transaction fails unexpectedly', async () => {
    mockTokenLimit.mockResolvedValue([{ identifier: 'password-reset:v2:user:user-1' }]);
    mockUserLimit.mockResolvedValue([{ id: 'user-1', email: 'test@example.com' }]);
    mockTransaction.mockRejectedValueOnce(new Error('db transaction failed'));

    const response = await POST(
      createRequest({
        email: 'test@example.com',
        token: crypto.randomUUID(),
        password: 'validpassword',
        confirmPassword: 'validpassword',
      }),
    );

    expect(response.status).toBe(500);
  });
});
