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

const mockSendPasswordResetEmail = vi.fn();
vi.mock('@boardsesh/email', () => ({
  sendPasswordResetEmail: (...args: unknown[]) => mockSendPasswordResetEmail(...args),
}));

const mockCaptureException = vi.fn();
vi.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

const lookup = vi.hoisted(() => ({ stored: [] as StoredAccount[] }));
vi.mock('@boardsesh/db/queries/account-email', async () => {
  const { fakeAccountEmailLookup } = await import('@/app/test-utils/account-email-lookup');
  return fakeAccountEmailLookup(() => lookup.stored);
});

const mockDeleteWhere = vi.fn().mockResolvedValue(undefined);
const mockValues = vi.fn().mockResolvedValue(undefined);
const mockTxDelete = vi.fn(() => ({ where: mockDeleteWhere }));
const mockTxInsert = vi.fn(() => ({ values: mockValues }));
const mockTransaction = vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
  await fn({ delete: mockTxDelete, insert: mockTxInsert });
});

vi.mock('@/app/lib/db/db', () => ({
  getDb: () => ({
    transaction: (fn: (tx: unknown) => Promise<void>) => mockTransaction(fn),
  }),
}));

vi.mock('@/app/lib/db/schema', () => ({
  verificationTokens: { identifier: 'verificationTokens.identifier' },
}));

import type { StoredAccount } from '@/app/test-utils/account-email-lookup';
import { POST } from '../route';

const passwordAccount: StoredAccount = { id: 'user-1', email: 'test@example.com', passwordHash: '$2b$12$stored' };

function createRequest(
  body: Record<string, unknown>,
  origin = 'http://localhost',
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(`${origin}/api/auth/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const edgeHeaders = {
  'X-Forwarded-For': '198.51.100.7, 203.0.113.9, 172.70.1.2',
  'CF-Connecting-IP': '203.0.113.9',
};

describe('POST /api/auth/forgot-password', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lookup.stored = [];
    mockGetClientIp.mockReturnValue('127.0.0.1');
    mockCheckRateLimit.mockReturnValue({ limited: false, retryAfterSeconds: 0 });
  });

  it('returns 429 when rate limited', async () => {
    mockCheckRateLimit.mockReturnValueOnce({ limited: true, retryAfterSeconds: 30 });

    const response = await POST(createRequest({ email: 'test@example.com' }));
    expect(response.status).toBe(429);
  });

  it('keys the staged limiter on the trusted client, not the first forwarded hop', async () => {
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'backend-staging');
    try {
      mockCheckRateLimit.mockReturnValueOnce({ limited: true, retryAfterSeconds: 30 });
      const response = await POST(createRequest({ email: 'test@example.com' }, undefined, edgeHeaders));
      expect(response.status).toBe(429);
      expect(mockCheckRateLimit).toHaveBeenCalledWith('forgot-password:203.0.113.9', 5, 60_000);
      expect(mockGetClientIp).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('keeps the legacy limiter key when staged auth is off', async () => {
    mockCheckRateLimit.mockReturnValueOnce({ limited: true, retryAfterSeconds: 30 });
    const response = await POST(createRequest({ email: 'test@example.com' }, undefined, edgeHeaders));
    expect(response.status).toBe(429);
    expect(mockCheckRateLimit).toHaveBeenCalledWith('forgot-password:127.0.0.1', 5, 60_000);
    expect(mockGetClientIp).toHaveBeenCalledOnce();
  });

  it('returns 400 for invalid email', async () => {
    const response = await POST(createRequest({ email: 'bad-email' }));
    expect(response.status).toBe(400);
  });

  it('returns generic response when user is not found', async () => {
    const response = await POST(createRequest({ email: 'missing@example.com' }));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.message).toContain('If an account exists');
    expect(mockSendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('sends reset email for valid credential account', async () => {
    lookup.stored = [passwordAccount];

    const response = await POST(createRequest({ email: 'test@example.com' }));

    expect(response.status).toBe(200);
    expect(mockTransaction).toHaveBeenCalled();
    expect(mockSendPasswordResetEmail).toHaveBeenCalled();
    // The old token must be deleted before the new one is inserted, otherwise the
    // unique identifier collides and rotation fails.
    expect(mockTxDelete).toHaveBeenCalled();
    expect(mockTxInsert).toHaveBeenCalled();
    expect(mockTxDelete.mock.invocationCallOrder[0]).toBeLessThan(mockTxInsert.mock.invocationCallOrder[0]);
  });

  it('uses BASE_URL env var instead of request origin when set', async () => {
    lookup.stored = [passwordAccount];

    const savedBaseUrl = process.env.BASE_URL;
    process.env.BASE_URL = 'https://www.boardsesh.com';
    try {
      // Even with a spoofed host in the request, the env var wins.
      await POST(createRequest({ email: 'test@example.com' }, 'https://attacker.com'));
      const [, , baseUrl] = mockSendPasswordResetEmail.mock.calls[0] as [string, string, string];
      expect(baseUrl).toBe('https://www.boardsesh.com');
    } finally {
      if (savedBaseUrl === undefined) {
        delete process.env.BASE_URL;
      } else {
        process.env.BASE_URL = savedBaseUrl;
      }
    }
  });

  it('falls back to request origin when BASE_URL is not set', async () => {
    lookup.stored = [passwordAccount];

    const savedBaseUrl = process.env.BASE_URL;
    delete process.env.BASE_URL;
    try {
      await POST(createRequest({ email: 'test@example.com' }, 'https://www.boardsesh.com'));
      const [, , baseUrl] = mockSendPasswordResetEmail.mock.calls[0] as [string, string, string];
      expect(baseUrl).toBe('https://www.boardsesh.com');
      expect(baseUrl).not.toBe('http://localhost:3000');
    } finally {
      if (savedBaseUrl !== undefined) {
        process.env.BASE_URL = savedBaseUrl;
      }
    }
  });

  it('returns generic response and does not send email for OAuth-only account', async () => {
    lookup.stored = [{ id: 'oauth-user', email: 'oauth@example.com', passwordHash: null }];

    const response = await POST(createRequest({ email: 'oauth@example.com' }));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.message).toContain('If an account exists');
    expect(mockSendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('returns 200 generic message when email delivery fails (no user enumeration)', async () => {
    lookup.stored = [passwordAccount];
    mockSendPasswordResetEmail.mockRejectedValue(new Error('smtp failed'));

    const response = await POST(createRequest({ email: 'test@example.com' }));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.message).toContain('If an account exists');
  });

  it('reports the SMTP failure to Sentry while keeping the response generic', async () => {
    lookup.stored = [passwordAccount];
    const smtpError = new Error('smtp private-password fixture-token fixture@example.test');
    mockSendPasswordResetEmail.mockRejectedValue(smtpError);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await POST(createRequest({ email: 'test@example.com' }));
      expect(response.status).toBe(200);
      expect(mockCaptureException).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ tags: expect.anything() }),
      );
      const captured = mockCaptureException.mock.calls[0][0] as Error;
      expect(captured).not.toBe(smtpError);
      expect(captured.message).toBe('Password recovery email delivery failed');
      expect(captured.cause).toBeUndefined();
      expect(captured.stack).not.toContain('fixture-token');
      expect(errorLog).toHaveBeenCalledWith('Password recovery email delivery failed');
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain('private-password');
    } finally {
      errorLog.mockRestore();
    }
  });

  describe('any capitalisation (BA-02)', () => {
    const mixedCase: StoredAccount = { id: 'mixed', email: 'Mixed.Case@Example.test', passwordHash: '$2b$12$a' };

    it.each([
      ['exactly as stored', 'Mixed.Case@Example.test'],
      ['in lowercase', 'mixed.case@example.test'],
      ['in capitals', 'MIXED.CASE@EXAMPLE.TEST'],
    ])('sends the link to the stored address when it is typed %s', async (_case, typed) => {
      lookup.stored = [mixedCase];

      const response = await POST(createRequest({ email: typed }));

      expect(response.status).toBe(200);
      expect(mockSendPasswordResetEmail).toHaveBeenCalledOnce();
      expect(mockSendPasswordResetEmail.mock.calls[0][0]).toBe('Mixed.Case@Example.test');
      expect(mockValues).toHaveBeenCalledWith(
        expect.objectContaining({ identifier: 'password-reset:Mixed.Case@Example.test' }),
      );
    });

    it('reaches the group member stored exactly as typed', async () => {
      lookup.stored = [mixedCase, { id: 'sibling', email: 'mixed.case@example.test', passwordHash: '$2b$12$b' }];

      await POST(createRequest({ email: 'Mixed.Case@Example.test' }));

      expect(mockSendPasswordResetEmail.mock.calls[0][0]).toBe('Mixed.Case@Example.test');
    });

    it('sends nothing for an address several accounts share in other capitals', async () => {
      lookup.stored = [mixedCase, { id: 'sibling', email: 'mixed.case@example.test', passwordHash: '$2b$12$b' }];

      const response = await POST(createRequest({ email: 'MIXED.CASE@EXAMPLE.TEST' }));

      expect(response.status).toBe(200);
      expect((await response.json()).message).toContain('If an account exists');
      expect(mockSendPasswordResetEmail).not.toHaveBeenCalled();
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('sends nothing for an address two accounts store as the same text', async () => {
      lookup.stored = [
        { id: 'twin-a', email: 'twin@example.test', passwordHash: '$2b$12$a' },
        { id: 'twin-b', email: 'twin@example.test', passwordHash: '$2b$12$b' },
      ];

      await POST(createRequest({ email: 'twin@example.test' }));

      expect(mockSendPasswordResetEmail).not.toHaveBeenCalled();
    });
  });

  it('returns 500 when database transaction fails', async () => {
    lookup.stored = [passwordAccount];
    mockTransaction.mockRejectedValueOnce(new Error('db transaction failed'));

    const response = await POST(createRequest({ email: 'test@example.com' }));
    expect(response.status).toBe(500);
  });
});
