// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mock rate limiter
const mockCheckRateLimit = vi.fn();
const mockGetClientIp = vi.fn();
vi.mock('@/app/lib/auth/rate-limiter', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  getClientIp: (...args: unknown[]) => mockGetClientIp(...args),
}));

// Mock email service
const mockSendVerificationEmail = vi.fn();
vi.mock('@/app/lib/email/email-service', () => ({
  sendVerificationEmail: (...args: unknown[]) => mockSendVerificationEmail(...args),
}));

// Mock database
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockLimit = vi.fn();
const mockTransaction = vi.fn();
const mockDelete = vi.fn();
const mockInsert = vi.fn();

vi.mock('@/app/lib/db/db', () => ({
  getDb: () => ({
    select: (...args: unknown[]) => mockSelect(...args),
    transaction: (...args: unknown[]) => mockTransaction(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
    insert: (...args: unknown[]) => mockInsert(...args),
  }),
}));

vi.mock('@/app/lib/db/schema', () => ({
  users: { email: 'users.email', emailVerified: 'users.emailVerified' },
  verificationTokens: { identifier: 'verificationTokens.identifier' },
}));

function createRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/auth/resend-verification', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/auth/resend-verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetClientIp.mockReturnValue('127.0.0.1');
    mockCheckRateLimit.mockReturnValue({ limited: false, retryAfterSeconds: 0 });

    // Default DB chain
    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ limit: mockLimit });

    // Default transaction
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        delete: () => ({ where: vi.fn().mockResolvedValue(undefined) }),
        insert: () => ({ values: vi.fn().mockResolvedValue(undefined) }),
      };
      await fn(tx);
    });
  });

  describe('without SMTP configured', () => {
    beforeEach(() => {
      vi.stubEnv('SMTP_USER', '');
      vi.stubEnv('SMTP_PASSWORD', '');
      vi.stubEnv('EMAIL_VERIFICATION_ENABLED', '');
    });

    it('returns generic 200 without querying DB or sending email', async () => {
      vi.resetModules();
      const { POST } = await import('../route');

      const response = await POST(createRequest({ email: 'test@example.com' }));
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.message).toBeTruthy();
      expect(mockSelect).not.toHaveBeenCalled();
      expect(mockSendVerificationEmail).not.toHaveBeenCalled();
    });
  });

  describe('with EMAIL_VERIFICATION_ENABLED=false', () => {
    beforeEach(() => {
      vi.stubEnv('SMTP_USER', 'user@fastmail.com');
      vi.stubEnv('SMTP_PASSWORD', 'app-password');
      vi.stubEnv('EMAIL_VERIFICATION_ENABLED', 'false');
    });

    it('returns generic 200 even when SMTP is configured', async () => {
      vi.resetModules();
      const { POST } = await import('../route');

      const response = await POST(createRequest({ email: 'test@example.com' }));
      expect(response.status).toBe(200);

      expect(mockSelect).not.toHaveBeenCalled();
      expect(mockSendVerificationEmail).not.toHaveBeenCalled();
    });
  });

  describe('with SMTP configured and verification active', () => {
    beforeEach(() => {
      vi.stubEnv('SMTP_USER', 'user@fastmail.com');
      vi.stubEnv('SMTP_PASSWORD', 'app-password');
      vi.stubEnv('EMAIL_VERIFICATION_ENABLED', '');
      vi.stubEnv('NEXTAUTH_URL', 'http://localhost:3000');
    });

    it('sends verification email for unverified user', async () => {
      vi.resetModules();
      const { POST } = await import('../route');

      mockLimit.mockResolvedValue([{ email: 'test@example.com', emailVerified: null }]);
      mockSendVerificationEmail.mockResolvedValue(undefined);

      const response = await POST(createRequest({ email: 'test@example.com' }));
      expect(response.status).toBe(200);
      expect(mockSendVerificationEmail).toHaveBeenCalled();
      expect(mockTransaction).toHaveBeenCalled();
    });

    it('returns generic message for already-verified user without sending email', async () => {
      vi.resetModules();
      const { POST } = await import('../route');

      mockLimit.mockResolvedValue([{ email: 'test@example.com', emailVerified: new Date() }]);

      const response = await POST(createRequest({ email: 'test@example.com' }));
      expect(response.status).toBe(200);
      expect(mockSendVerificationEmail).not.toHaveBeenCalled();
    });

    it('returns generic message for non-existent user without sending email', async () => {
      vi.resetModules();
      const { POST } = await import('../route');

      mockLimit.mockResolvedValue([]);

      const response = await POST(createRequest({ email: 'nonexistent@example.com' }));
      expect(response.status).toBe(200);
      expect(mockSendVerificationEmail).not.toHaveBeenCalled();
    });

    it('returns 400 for invalid email', async () => {
      vi.resetModules();
      const { POST } = await import('../route');

      const response = await POST(createRequest({ email: 'not-an-email' }));
      expect(response.status).toBe(400);
    });

    it('returns 429 when rate limited', async () => {
      vi.resetModules();
      const { POST } = await import('../route');

      mockCheckRateLimit.mockReturnValue({ limited: true, retryAfterSeconds: 30 });

      const response = await POST(createRequest({ email: 'test@example.com' }));
      expect(response.status).toBe(429);
    });

    it('returns 500 when email send fails', async () => {
      vi.resetModules();
      const { POST } = await import('../route');

      mockLimit.mockResolvedValue([{ email: 'test@example.com', emailVerified: null }]);
      mockSendVerificationEmail.mockRejectedValue(new Error('SMTP error'));

      const response = await POST(createRequest({ email: 'test@example.com' }));
      expect(response.status).toBe(500);
    });
  });
});
