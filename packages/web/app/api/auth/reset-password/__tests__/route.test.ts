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
const mockTxConsumeTokenReturning = vi.fn();
const mockTxUpdateWhere = vi.fn().mockResolvedValue(undefined);
const mockTxUserUpdateWhere = vi.fn().mockResolvedValue(undefined);
const mockTxInsertValues = vi.fn().mockResolvedValue(undefined);
const mockTransaction = vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
  let txSelectCall = 0;
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => {
            txSelectCall += 1;
            return txSelectCall === 1 ? mockUserLimit() : mockTxCredentialsLimit();
          },
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: () => ({
        where: table === 'userCredentials' ? mockTxUpdateWhere : mockTxUserUpdateWhere,
      }),
    }),
    insert: () => ({ values: mockTxInsertValues }),
    delete: () => ({ where: () => ({ returning: mockTxConsumeTokenReturning }) }),
  };
  await fn(tx);
});

vi.mock('@/app/lib/db/db', () => ({
  getDb: () => ({
    transaction: mockTransaction,
  }),
}));

vi.mock('@/app/lib/db/schema', () => ({
  verificationTokens: { identifier: 'verificationTokens.identifier', token: 'verificationTokens.token', expires: 'verificationTokens.expires' },
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
    mockUserLimit.mockResolvedValue([{ id: 'user-1' }]);
    mockTxCredentialsLimit.mockResolvedValue([{ userId: 'user-1' }]);
    mockTxConsumeTokenReturning.mockResolvedValue([{ expires: new Date(Date.now() + 60_000) }]);
  });

  it('returns 400 for invalid request body', async () => {
    const response = await POST(createRequest({ email: 'bad', token: 'x', password: '123', confirmPassword: '123' }));
    expect(response.status).toBe(400);
  });

  it('returns 400 when reset token does not exist', async () => {
    mockTxConsumeTokenReturning.mockResolvedValue([]);

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

  it('returns 400 when token is expired', async () => {
    mockTxConsumeTokenReturning.mockResolvedValue([{ expires: new Date(Date.now() - 60_000) }]);

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

  it('inserts credentials when user does not already have password credentials', async () => {
    mockUserLimit.mockResolvedValue([{ id: 'oauth-user' }]);
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
