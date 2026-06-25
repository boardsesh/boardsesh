import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

// EMAIL_VERIFICATION_ENABLED is a module-level constant — must be set before
// the route module is imported and evaluated.
vi.hoisted(() => {
  process.env.EMAIL_VERIFICATION_ENABLED = 'true';
});

const mockCheckRateLimit = vi.fn();
const mockGetClientIp = vi.fn();
vi.mock('@/app/lib/auth/rate-limiter', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  getClientIp: (...args: unknown[]) => mockGetClientIp(...args),
}));

const mockSendVerificationEmail = vi.fn();
vi.mock('@/app/lib/email/email-service', () => ({
  sendVerificationEmail: (...args: unknown[]) => mockSendVerificationEmail(...args),
}));

vi.mock('bcryptjs', () => ({
  hash: async () => 'hashed-password',
}));

const mockSelectLimit = vi.fn();
const mockTransaction = vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
  const mockValues = vi.fn().mockResolvedValue(undefined);
  await fn({ insert: () => ({ values: mockValues }) });
});

vi.mock('@/app/lib/db/db', () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: mockSelectLimit }) }) }),
    transaction: (fn: (tx: unknown) => Promise<void>) => mockTransaction(fn),
  }),
}));

vi.mock('@/app/lib/db/schema', () => ({
  users: { id: 'users.id', email: 'users.email' },
  userCredentials: { userId: 'user_credentials.userId' },
  userProfiles: { userId: 'user_profiles.userId' },
  verificationTokens: { identifier: 'verification_tokens.identifier' },
}));

import { POST } from '../route';

function createRequest(body: Record<string, unknown>, origin = 'http://localhost'): NextRequest {
  return new NextRequest(`${origin}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/auth/register', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetClientIp.mockReturnValue('127.0.0.1');
    mockCheckRateLimit.mockReturnValue({ limited: false, retryAfterSeconds: 0 });
    mockSelectLimit.mockResolvedValue([]); // no existing user
    mockSendVerificationEmail.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses BASE_URL env var for verification email link when set', async () => {
    const savedBaseUrl = process.env.BASE_URL;
    process.env.BASE_URL = 'https://www.boardsesh.com';
    try {
      await POST(createRequest({ email: 'test@example.com', password: 'password123' }, 'https://attacker.com'));
      const [, , baseUrl] = mockSendVerificationEmail.mock.calls[0] as [string, string, string];
      expect(baseUrl).toBe('https://www.boardsesh.com');
    } finally {
      if (savedBaseUrl === undefined) delete process.env.BASE_URL;
      else process.env.BASE_URL = savedBaseUrl;
    }
  });

  it('falls back to request origin for verification email link when BASE_URL is not set', async () => {
    const savedBaseUrl = process.env.BASE_URL;
    delete process.env.BASE_URL;
    try {
      await POST(
        createRequest({ email: 'test@example.com', password: 'password123' }, 'https://www.boardsesh.com'),
      );
      const [, , baseUrl] = mockSendVerificationEmail.mock.calls[0] as [string, string, string];
      expect(baseUrl).toBe('https://www.boardsesh.com');
      expect(baseUrl).not.toBe('http://localhost:3000');
    } finally {
      if (savedBaseUrl !== undefined) process.env.BASE_URL = savedBaseUrl;
    }
  });
});
