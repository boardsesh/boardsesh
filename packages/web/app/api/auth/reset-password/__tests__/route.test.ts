import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const mockCheckRateLimit = vi.fn();
const mockGetClientIp = vi.fn();
vi.mock('@/app/lib/auth/rate-limiter', () => ({
  checkRateLimit: mockCheckRateLimit,
  getClientIp: mockGetClientIp,
}));

const mockHash = vi.fn();
vi.mock('bcryptjs', () => ({
  default: {
    hash: mockHash,
  },
}));

const mockUserLimit = vi.fn();
const mockTxCredentialsLimit = vi.fn();
const mockTxUpdateWhere = vi.fn().mockResolvedValue(undefined);
const mockTxUserUpdateWhere = vi.fn().mockResolvedValue(undefined);
const mockTxInsertValues = vi.fn().mockResolvedValue(undefined);
const mockTxConsumedTokenReturning = vi.fn();
const mockUsersTable = { id: 'users.id', email: 'users.email', emailVerified: 'users.emailVerified' };
const mockUserCredentialsTable = { userId: 'userCredentials.userId' };
const mockVerificationTokensTable = {
  identifier: 'verificationTokens.identifier',
  token: 'verificationTokens.token',
  expires: 'verificationTokens.expires',
};

const mockTransaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
  const tx = {
    delete: () => ({
      where: () => ({
        returning: mockTxConsumedTokenReturning,
      }),
    }),
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: table === mockUsersTable ? mockUserLimit : mockTxCredentialsLimit,
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: () => ({
        where: table === mockUserCredentialsTable ? mockTxUpdateWhere : mockTxUserUpdateWhere,
      }),
    }),
    insert: () => ({ values: mockTxInsertValues }),
  };
  return await fn(tx);
});

vi.mock('@/app/lib/db/db', () => ({
  getDb: () => ({
    transaction: mockTransaction,
  }),
}));

vi.mock('@/app/lib/db/schema', () => ({
  verificationTokens: mockVerificationTokensTable,
  users: mockUsersTable,
  userCredentials: mockUserCredentialsTable,
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
    mockTxConsumedTokenReturning.mockResolvedValue([{ identifier: 'password-reset:test@example.com' }]);
    mockUserLimit.mockResolvedValue([{ id: 'user-1' }]);
    mockTxCredentialsLimit.mockResolvedValue([{ userId: 'user-1' }]);
  });

  it('returns 400 for invalid request body', async () => {
    const response = await POST(createRequest({ email: 'bad', token: 'x', password: '123', confirmPassword: '123' }));
    expect(response.status).toBe(400);
  });

  it('returns 400 when token is not consumed (invalid or expired)', async () => {
    mockTxConsumedTokenReturning.mockResolvedValue([]);

    const response = await POST(
      createRequest({
        email: 'test@example.com',
        token: crypto.randomUUID(),
        password: 'validpassword',
        confirmPassword: 'validpassword',
      })
    );

    expect(response.status).toBe(400);
  });

  it('resets password successfully', async () => {
    const response = await POST(
      createRequest({
        email: 'test@example.com',
        token: crypto.randomUUID(),
        password: 'validpassword',
        confirmPassword: 'validpassword',
      })
    );

    expect(response.status).toBe(200);
    expect(mockHash).toHaveBeenCalledWith('validpassword', 12);
    expect(mockTransaction).toHaveBeenCalled();
    expect(mockTxUpdateWhere).toHaveBeenCalled();
  });

  it('inserts credentials when user does not already have password credentials', async () => {
    mockTxCredentialsLimit.mockResolvedValue([]);

    const response = await POST(
      createRequest({
        email: 'oauth@example.com',
        token: crypto.randomUUID(),
        password: 'validpassword',
        confirmPassword: 'validpassword',
      })
    );

    expect(response.status).toBe(200);
    expect(mockTxInsertValues).toHaveBeenCalled();
  });
});
