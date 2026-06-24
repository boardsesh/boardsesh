import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const mockCheckRateLimit = vi.fn();
const mockGetClientIp = vi.fn();
vi.mock('@/app/lib/auth/rate-limiter', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  getClientIp: (...args: unknown[]) => mockGetClientIp(...args),
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
    update: (table: unknown) => ({
      set: () => ({
        where: table === 'userCredentials' ? mockTxUpdateWhere : mockTxUserUpdateWhere,
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
      where: () => ({
        limit: limitMock,
      }),
    }),
  };
});

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
  userCredentials: 'userCredentials',
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

  it('returns 400 when reset token does not exist', async () => {
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
  });

  it('resets password successfully', async () => {
    mockTokenLimit.mockResolvedValue([{ expires: new Date(Date.now() + 60_000) }]);
    mockUserLimit.mockResolvedValue([{ id: 'user-1' }]);

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
  });

  it('returns 400 when token is expired', async () => {
    mockTokenLimit.mockResolvedValue([{ expires: new Date(Date.now() - 60_000) }]);
    mockUserLimit.mockResolvedValue([{ id: 'user-1' }]);

    const response = await POST(
      createRequest({
        email: 'test@example.com',
        token: crypto.randomUUID(),
        password: 'validpassword',
        confirmPassword: 'validpassword',
      }),
    );

    expect(response.status).toBe(400);
    expect(mockDelete).toHaveBeenCalled();
  });

  it('inserts credentials when user does not already have password credentials', async () => {
    mockTokenLimit.mockResolvedValue([{ expires: new Date(Date.now() + 60_000) }]);
    mockUserLimit.mockResolvedValue([{ id: 'oauth-user' }]);
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
    mockTokenLimit.mockResolvedValue([{ expires: new Date(Date.now() + 60_000) }]);
    mockUserLimit.mockResolvedValue([{ id: 'user-1' }]);
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
