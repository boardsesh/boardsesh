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
vi.mock('@/app/lib/email/email-service', () => ({
  sendPasswordResetEmail: (...args: unknown[]) => mockSendPasswordResetEmail(...args),
}));

const mockCaptureException = vi.fn();
vi.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

const mockUserLimit = vi.fn();
const mockCredentialsLimit = vi.fn();
const mockDeleteWhere = vi.fn().mockResolvedValue(undefined);
const mockValues = vi.fn().mockResolvedValue(undefined);
const mockTxDelete = vi.fn(() => ({ where: mockDeleteWhere }));
const mockTxInsert = vi.fn(() => ({ values: mockValues }));
const mockTransaction = vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
  await fn({ delete: mockTxDelete, insert: mockTxInsert });
});

const mockSelect = vi.fn((selection?: Record<string, unknown>) => {
  const limitMock = selection?.id ? mockUserLimit : mockCredentialsLimit;
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
    transaction: (fn: (tx: unknown) => Promise<void>) => mockTransaction(fn),
  }),
}));

vi.mock('@/app/lib/db/schema', () => ({
  users: { id: 'users.id', email: 'users.email' },
  userCredentials: { userId: 'user_credentials.userId' },
  verificationTokens: { identifier: 'verificationTokens.identifier' },
}));

import { POST } from '../route';

function createRequest(body: Record<string, unknown>, origin = 'http://localhost'): NextRequest {
  return new NextRequest(`${origin}/api/auth/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/auth/forgot-password', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetClientIp.mockReturnValue('127.0.0.1');
    mockCheckRateLimit.mockReturnValue({ limited: false, retryAfterSeconds: 0 });
  });

  it('returns 429 when rate limited', async () => {
    mockCheckRateLimit.mockReturnValueOnce({ limited: true, retryAfterSeconds: 30 });

    const response = await POST(createRequest({ email: 'test@example.com' }));
    expect(response.status).toBe(429);
  });

  it('returns 400 for invalid email', async () => {
    const response = await POST(createRequest({ email: 'bad-email' }));
    expect(response.status).toBe(400);
  });

  it('returns generic response when user is not found', async () => {
    mockUserLimit.mockResolvedValue([]);

    const response = await POST(createRequest({ email: 'missing@example.com' }));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.message).toContain('If an account exists');
    expect(mockSendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('sends reset email for valid credential account', async () => {
    mockUserLimit.mockResolvedValue([{ id: 'user-1' }]);
    mockCredentialsLimit.mockResolvedValue([{ userId: 'user-1' }]);

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

  it('derives reset link base URL from the request origin, not a hardcoded fallback', async () => {
    mockUserLimit.mockResolvedValue([{ id: 'user-1' }]);
    mockCredentialsLimit.mockResolvedValue([{ userId: 'user-1' }]);

    const prodOrigin = 'https://www.boardsesh.com';
    await POST(createRequest({ email: 'test@example.com' }, prodOrigin));

    const [, , baseUrl] = mockSendPasswordResetEmail.mock.calls[0] as [string, string, string];
    expect(baseUrl).toBe(prodOrigin);
    expect(baseUrl).not.toBe('http://localhost:3000');
  });

  it('returns generic response and does not send email for OAuth-only account', async () => {
    mockUserLimit.mockResolvedValue([{ id: 'oauth-user' }]);
    mockCredentialsLimit.mockResolvedValue([]);

    const response = await POST(createRequest({ email: 'oauth@example.com' }));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.message).toContain('If an account exists');
    expect(mockSendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('returns 200 generic message when email delivery fails (no user enumeration)', async () => {
    mockUserLimit.mockResolvedValue([{ id: 'user-1' }]);
    mockCredentialsLimit.mockResolvedValue([{ userId: 'user-1' }]);
    mockSendPasswordResetEmail.mockRejectedValue(new Error('smtp failed'));

    const response = await POST(createRequest({ email: 'test@example.com' }));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.message).toContain('If an account exists');
  });

  it('reports the SMTP failure to Sentry while keeping the response generic', async () => {
    mockUserLimit.mockResolvedValue([{ id: 'user-1' }]);
    mockCredentialsLimit.mockResolvedValue([{ userId: 'user-1' }]);
    const smtpError = new Error('smtp failed');
    mockSendPasswordResetEmail.mockRejectedValue(smtpError);

    const response = await POST(createRequest({ email: 'test@example.com' }));

    expect(response.status).toBe(200);
    expect(mockCaptureException).toHaveBeenCalledWith(smtpError, expect.objectContaining({ tags: expect.anything() }));
  });

  it('returns 500 when database transaction fails', async () => {
    mockUserLimit.mockResolvedValue([{ id: 'user-1' }]);
    mockCredentialsLimit.mockResolvedValue([{ userId: 'user-1' }]);
    mockTransaction.mockRejectedValueOnce(new Error('db transaction failed'));

    const response = await POST(createRequest({ email: 'test@example.com' }));
    expect(response.status).toBe(500);
  });
});
