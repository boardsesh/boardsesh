import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

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

const mockDeleteWhere = vi.fn().mockResolvedValue(undefined);
const mockValues = vi.fn().mockResolvedValue(undefined);
const mockUserSelect = vi.fn();
const mockTransaction = vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
  await fn({
    delete: () => ({ where: mockDeleteWhere }),
    insert: () => ({ values: mockValues }),
  });
});

vi.mock('@/app/lib/db/db', () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: mockUserSelect }) }) }),
    transaction: (fn: (tx: unknown) => Promise<void>) => mockTransaction(fn),
  }),
}));

vi.mock('@/app/lib/db/schema', () => ({
  users: { email: 'users.email' },
  verificationTokens: { identifier: 'verification_tokens.identifier' },
}));

import { POST } from '../route';

function createRequest(body: Record<string, unknown>, origin = 'http://localhost'): NextRequest {
  return new NextRequest(`${origin}/api/auth/resend-verification`, {
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
    // User exists and is unverified
    mockUserSelect.mockResolvedValue([{ id: 'user-1', emailVerified: null }]);
    mockSendVerificationEmail.mockResolvedValue(undefined);
    // Make consistentDelay a no-op: first Date.now() call returns startTime=0,
    // subsequent calls return 2000ms so elapsed >= MIN_RESPONSE_TIME_MS and no
    // setTimeout is scheduled.
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(2000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses BASE_URL env var for verification email link when set', async () => {
    const savedBaseUrl = process.env.BASE_URL;
    process.env.BASE_URL = 'https://www.boardsesh.com';
    try {
      const response = await POST(createRequest({ email: 'test@example.com' }, 'https://attacker.com'));
      expect(response.status).toBe(200);
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
      const response = await POST(createRequest({ email: 'test@example.com' }, 'https://www.boardsesh.com'));
      expect(response.status).toBe(200);
      const [, , baseUrl] = mockSendVerificationEmail.mock.calls[0] as [string, string, string];
      expect(baseUrl).toBe('https://www.boardsesh.com');
      expect(baseUrl).not.toBe('http://localhost:3000');
    } finally {
      if (savedBaseUrl !== undefined) process.env.BASE_URL = savedBaseUrl;
    }
  });
});
