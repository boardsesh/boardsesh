// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mock bcrypt — the route imports the named `hash` export
const mockBcryptHash = vi.fn();
vi.mock('bcryptjs', () => ({
  hash: (...args: unknown[]) => mockBcryptHash(...args),
  default: {
    hash: (...args: unknown[]) => mockBcryptHash(...args),
  },
}));

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

vi.mock('@/app/lib/db/db', () => ({
  getDb: () => ({
    select: (...args: unknown[]) => mockSelect(...args),
    transaction: (...args: unknown[]) => mockTransaction(...args),
  }),
}));

vi.mock('@/app/lib/db/schema', () => ({
  users: { email: 'users.email' },
  userCredentials: { userId: 'userCredentials.userId' },
  userProfiles: { userId: 'userProfiles.userId' },
  verificationTokens: { identifier: 'verificationTokens.identifier' },
}));

function createRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const validBody = {
  email: 'test@example.com',
  password: 'password123',
  name: 'Test User',
};

describe('POST /api/auth/register', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockGetClientIp.mockReturnValue('127.0.0.1');
    mockCheckRateLimit.mockReturnValue({ limited: false, retryAfterSeconds: 0 });
    mockBcryptHash.mockResolvedValue('$2a$12$hashedpassword');

    // Default: no existing user
    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ limit: mockLimit });
    mockLimit.mockResolvedValue([]);

    // Default: transaction succeeds
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
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

    it('registers user with emailVerified set and requiresVerification false', async () => {
      // Re-import to pick up env changes
      vi.resetModules();
      const { POST } = await import('../route');

      const response = await POST(createRequest(validBody));
      expect(response.status).toBe(201);

      const data = await response.json();
      expect(data.requiresVerification).toBe(false);
      expect(data.emailSent).toBe(false);
      expect(mockSendVerificationEmail).not.toHaveBeenCalled();
    });

    it('does not create verification token in transaction', async () => {
      vi.resetModules();
      const { POST } = await import('../route');

      let insertCallCount = 0;
      mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
        const tx = {
          insert: () => {
            insertCallCount++;
            return { values: vi.fn().mockResolvedValue(undefined) };
          },
        };
        await fn(tx);
      });

      await POST(createRequest(validBody));
      // 3 inserts: user, credentials, profile (no verification token)
      expect(insertCallCount).toBe(3);
    });
  });

  describe('with SMTP configured', () => {
    beforeEach(() => {
      vi.stubEnv('SMTP_USER', 'user@fastmail.com');
      vi.stubEnv('SMTP_PASSWORD', 'app-password');
      vi.stubEnv('EMAIL_VERIFICATION_ENABLED', '');
      vi.stubEnv('NEXTAUTH_URL', 'http://localhost:3000');
    });

    it('sends verification email and returns emailSent true', async () => {
      vi.resetModules();
      const { POST } = await import('../route');

      mockSendVerificationEmail.mockResolvedValue(undefined);

      const response = await POST(createRequest(validBody));
      expect(response.status).toBe(201);

      const data = await response.json();
      expect(data.requiresVerification).toBe(false);
      expect(data.emailSent).toBe(true);
      expect(mockSendVerificationEmail).toHaveBeenCalledWith(
        'test@example.com',
        expect.any(String),
        'http://localhost:3000',
      );
    });

    it('still returns 201 when verification email fails to send', async () => {
      vi.resetModules();
      const { POST } = await import('../route');

      mockSendVerificationEmail.mockRejectedValue(new Error('SMTP error'));

      const response = await POST(createRequest(validBody));
      expect(response.status).toBe(201);

      const data = await response.json();
      expect(data.requiresVerification).toBe(false);
      expect(data.emailSent).toBe(false);
    });

    it('creates verification token in transaction', async () => {
      vi.resetModules();
      const { POST } = await import('../route');

      let insertCallCount = 0;
      mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
        const tx = {
          insert: () => {
            insertCallCount++;
            return { values: vi.fn().mockResolvedValue(undefined) };
          },
        };
        await fn(tx);
      });

      mockSendVerificationEmail.mockResolvedValue(undefined);

      await POST(createRequest(validBody));
      // 4 inserts: user, credentials, profile, verification token
      expect(insertCallCount).toBe(4);
    });
  });

  describe('with EMAIL_VERIFICATION_ENABLED=false kill switch', () => {
    beforeEach(() => {
      vi.stubEnv('SMTP_USER', 'user@fastmail.com');
      vi.stubEnv('SMTP_PASSWORD', 'app-password');
      vi.stubEnv('EMAIL_VERIFICATION_ENABLED', 'false');
    });

    it('skips verification even when SMTP is configured', async () => {
      vi.resetModules();
      const { POST } = await import('../route');

      const response = await POST(createRequest(validBody));
      expect(response.status).toBe(201);

      const data = await response.json();
      expect(data.emailSent).toBe(false);
      expect(mockSendVerificationEmail).not.toHaveBeenCalled();
    });
  });

  describe('validation and error handling', () => {
    beforeEach(() => {
      vi.stubEnv('SMTP_USER', '');
      vi.stubEnv('SMTP_PASSWORD', '');
      vi.stubEnv('EMAIL_VERIFICATION_ENABLED', '');
    });

    it('returns 400 for invalid email', async () => {
      vi.resetModules();
      const { POST } = await import('../route');

      const response = await POST(createRequest({ ...validBody, email: 'not-an-email' }));
      expect(response.status).toBe(400);
    });

    it('returns 400 for short password', async () => {
      vi.resetModules();
      const { POST } = await import('../route');

      const response = await POST(createRequest({ ...validBody, password: 'short' }));
      expect(response.status).toBe(400);
    });

    it('returns 409 when user already exists', async () => {
      vi.resetModules();
      const { POST } = await import('../route');

      mockLimit.mockResolvedValue([{ id: 'existing-user', email: 'test@example.com' }]);

      const response = await POST(createRequest(validBody));
      expect(response.status).toBe(409);
    });

    it('returns 429 when rate limited', async () => {
      vi.resetModules();
      const { POST } = await import('../route');

      mockCheckRateLimit.mockReturnValue({ limited: true, retryAfterSeconds: 30 });

      const response = await POST(createRequest(validBody));
      expect(response.status).toBe(429);
      expect(response.headers.get('Retry-After')).toBe('30');
    });

    it('returns 409 on race condition (unique constraint)', async () => {
      vi.resetModules();
      const { POST } = await import('../route');

      mockTransaction.mockRejectedValue({ code: '23505' });

      const response = await POST(createRequest(validBody));
      expect(response.status).toBe(409);
    });
  });
});
