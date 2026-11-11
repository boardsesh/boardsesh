import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const mockCheckRateLimit = vi.fn();
const mockGetClientIp = vi.fn();
vi.mock('@/app/lib/auth/rate-limiter', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  getClientIp: (...args: unknown[]) => mockGetClientIp(...args),
}));

vi.mock('@/app/lib/auth/password-reset', () => ({
  getPasswordResetIdentifier: (email: string) => `password-reset:${email}`,
  hashResetToken: (token: string) => `sha256:${token}`,
  consistentDelay: async () => {},
}));

const mockHash = vi.fn();
vi.mock('bcryptjs', () => ({
  default: {
    hash: (...args: unknown[]) => mockHash(...args),
  },
}));

// Structural stand-ins so a test can see which row a write targets.
vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ and: conditions }),
  eq: (column: unknown, value: unknown) => ({ eq: [column, value] }),
  gt: (column: unknown, value: unknown) => ({ gt: [column, value] }),
  isNull: (column: unknown) => ({ isNull: column }),
}));

const lookup = vi.hoisted(() => ({ stored: [] as StoredAccount[] }));
vi.mock('@boardsesh/db/queries/account-email', async () => {
  const { fakeAccountEmailLookup } = await import('@/app/test-utils/account-email-lookup');
  return fakeAccountEmailLookup(() => lookup.stored);
});

const mockTokenLimit = vi.fn();
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

const mockSelect = vi.fn((_selection?: Record<string, unknown>) => ({
  from: () => ({
    where: () => ({
      limit: mockTokenLimit,
    }),
  }),
}));

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

import type { StoredAccount } from '@/app/test-utils/account-email-lookup';
import { POST } from '../route';

function createRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/auth/reset-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const edgeHeaders = {
  'X-Forwarded-For': '198.51.100.7, 203.0.113.9, 172.70.1.2',
  'CF-Connecting-IP': '203.0.113.9',
};
const limitedSubmission = {
  email: 'test@example.com',
  token: '6f1c1f3e-8d7a-4b7e-9a35-3f4a1f0f2b11',
  password: 'validpassword',
  confirmPassword: 'validpassword',
};

describe('POST /api/auth/reset-password', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetClientIp.mockReturnValue('127.0.0.1');
    mockCheckRateLimit.mockReturnValue({ limited: false, retryAfterSeconds: 0 });
    mockHash.mockResolvedValue('hashed-password');
    mockTxCredentialsLimit.mockResolvedValue([{ userId: 'user-1' }]);
    lookup.stored = [
      { id: 'user-1', email: 'test@example.com', passwordHash: '$2b$12$a' },
      { id: 'oauth-user', email: 'oauth@example.com' },
    ];
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

  it('keys the staged limiter on the trusted client, not the first forwarded hop', async () => {
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'backend-staging');
    try {
      mockCheckRateLimit.mockReturnValueOnce({ limited: true, retryAfterSeconds: 25 });
      const response = await POST(createRequest(limitedSubmission, edgeHeaders));
      expect(response.status).toBe(429);
      expect(mockCheckRateLimit).toHaveBeenCalledWith('reset-password:203.0.113.9', 5, 60_000);
      expect(mockGetClientIp).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('keeps the legacy limiter key when staged auth is off', async () => {
    mockCheckRateLimit.mockReturnValueOnce({ limited: true, retryAfterSeconds: 25 });
    const response = await POST(createRequest(limitedSubmission, edgeHeaders));
    expect(response.status).toBe(429);
    expect(mockCheckRateLimit).toHaveBeenCalledWith('reset-password:127.0.0.1', 5, 60_000);
    expect(mockGetClientIp).toHaveBeenCalledOnce();
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
    // The SELECT requires identifier (derived from email) AND tokenHash to match the
    // same row, so a real token paired with the wrong email yields no rows. Nothing
    // should be hashed, written, or deleted on this path.
    mockTokenLimit.mockResolvedValue([]);

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
    mockTokenLimit.mockResolvedValue([{ expires: new Date(Date.now() + 60_000) }]);

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
    mockTokenLimit.mockResolvedValue([{ expires: new Date(Date.now() + 60_000) }]);
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

  describe('any capitalisation (BA-02)', () => {
    const submission = (email: string) => ({
      email,
      token: crypto.randomUUID(),
      password: 'validpassword',
      confirmPassword: 'validpassword',
    });
    const credentialWriteTargets = () => mockTxUpdateWhere.mock.calls.map(([condition]) => condition);

    beforeEach(() => {
      mockTokenLimit.mockResolvedValue([{ expires: new Date(Date.now() + 60_000) }]);
    });

    it.each([
      ['exactly as stored', 'Mixed.Case@Example.test'],
      ['in lowercase', 'mixed.case@example.test'],
    ])('resets the mixed-case account when the link carries its address %s', async (_case, linkEmail) => {
      lookup.stored = [{ id: 'mixed', email: 'Mixed.Case@Example.test', passwordHash: '$2b$12$a' }];

      const response = await POST(createRequest(submission(linkEmail)));

      expect(response.status).toBe(200);
      expect(credentialWriteTargets()).toEqual([{ eq: [undefined, 'mixed'] }]);
    });

    it('resets the group member the link names exactly, not its sibling', async () => {
      lookup.stored = [
        { id: 'mixed', email: 'Mixed.Case@Example.test', passwordHash: '$2b$12$a' },
        { id: 'sibling', email: 'mixed.case@example.test', passwordHash: '$2b$12$b' },
      ];

      const response = await POST(createRequest(submission('mixed.case@example.test')));

      expect(response.status).toBe(200);
      expect(credentialWriteTargets()).toEqual([{ eq: [undefined, 'sibling'] }]);
    });

    it('refuses a link whose address several accounts share in other capitals', async () => {
      lookup.stored = [
        { id: 'mixed', email: 'Mixed.Case@Example.test', passwordHash: '$2b$12$a' },
        { id: 'sibling', email: 'mixed.case@example.test', passwordHash: '$2b$12$b' },
      ];

      const response = await POST(createRequest(submission('MIXED.CASE@EXAMPLE.TEST')));

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Invalid or expired reset link' });
      expect(mockHash).not.toHaveBeenCalled();
      expect(mockTransaction).not.toHaveBeenCalled();
    });
  });

  it('returns 500 when transaction fails unexpectedly', async () => {
    mockTokenLimit.mockResolvedValue([{ expires: new Date(Date.now() + 60_000) }]);
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
