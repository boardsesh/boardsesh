import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { NextRequest } from 'next/server';
import { POST } from '../route';

// Mock server-only
vi.mock('server-only', () => ({}));

// Mock getServerSession
const mockGetServerSession = vi.fn();
vi.mock('@/app/lib/auth/admitted-session.server', () => ({
  getAdmittedServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

// Mock auth options
vi.mock('@/app/lib/auth/auth-options', () => ({
  authOptions: {},
}));

// Mock bcrypt
const mockBcryptHash = vi.fn();
vi.mock('bcryptjs', () => ({
  default: {
    hash: (...args: unknown[]) => mockBcryptHash(...args),
  },
  hash: (...args: unknown[]) => mockBcryptHash(...args),
}));

// Mock rate limiter
const mockCheckRateLimit = vi.fn();
const mockGetClientIp = vi.fn();
vi.mock('@/app/lib/auth/rate-limiter', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  getClientIp: (...args: unknown[]) => mockGetClientIp(...args),
}));

// Mock database
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockLimit = vi.fn();
const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockTransaction = vi.fn();

vi.mock('@/app/lib/db/db', () => ({
  getDb: () => ({
    select: (...args: unknown[]) => mockSelect(...args),
    insert: (...args: unknown[]) => mockInsert(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
    transaction: (...args: unknown[]) => mockTransaction(...args),
  }),
}));

vi.mock('@/app/lib/db/schema', () => ({
  userCredentials: { userId: 'userCredentials.userId' },
  users: { id: 'users.id', emailVerified: 'users.emailVerified' },
}));

// What the www guard sends for the mocked `{ user: { id: 'user-1' } }` session.
const USER_1_VIEWER = 'user-1:pending-login-identity';

function createRequest(body: Record<string, unknown>, expectedViewer: string | null = USER_1_VIEWER): NextRequest {
  return new NextRequest('http://localhost/api/internal/set-password', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(expectedViewer === null ? {} : { 'X-Boardsesh-Expected-Viewer': expectedViewer }),
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/internal/set-password', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetClientIp.mockReturnValue('127.0.0.1');
    mockCheckRateLimit.mockReturnValue({ limited: false, retryAfterSeconds: 0 });
    mockBcryptHash.mockResolvedValue('$2a$12$hashedpassword');

    // Default: chain select().from().where().limit()
    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ limit: mockLimit });
  });

  it('returns 401 when not authenticated', async () => {
    mockGetServerSession.mockResolvedValue(null);

    const response = await POST(createRequest({ password: 'testpass123', confirmPassword: 'testpass123' }, null));
    expect(response.status).toBe(401);

    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 429 when IP rate limited', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: 'user-1' } });
    mockCheckRateLimit.mockReturnValueOnce({ limited: true, retryAfterSeconds: 30 });

    const response = await POST(createRequest({ password: 'testpass123', confirmPassword: 'testpass123' }));
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('30');
  });

  it('returns 429 when user rate limited', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: 'user-1' } });
    // First call (IP) passes, second call (user) fails
    mockCheckRateLimit
      .mockReturnValueOnce({ limited: false, retryAfterSeconds: 0 })
      .mockReturnValueOnce({ limited: true, retryAfterSeconds: 45 });

    const response = await POST(createRequest({ password: 'testpass123', confirmPassword: 'testpass123' }));
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('45');
  });

  it('returns 400 when password is too short', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: 'user-1' } });

    const response = await POST(createRequest({ password: 'short', confirmPassword: 'short' }));
    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.error).toContain('at least 8 characters');
  });

  it('returns 400 when passwords do not match', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: 'user-1' } });

    const response = await POST(createRequest({ password: 'testpass123', confirmPassword: 'different123' }));
    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.error).toContain('do not match');
  });

  it('returns 400 when password is missing', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: 'user-1' } });

    const response = await POST(createRequest({ confirmPassword: 'testpass123' }));
    expect(response.status).toBe(400);
  });

  it('returns 409 when password is already set', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: 'user-1' } });
    mockLimit.mockResolvedValue([{ userId: 'user-1' }]);

    const response = await POST(createRequest({ password: 'testpass123', confirmPassword: 'testpass123' }));
    expect(response.status).toBe(409);

    const data = await response.json();
    expect(data.error).toBe('Password already set.');
  });

  it('sets password successfully for OAuth-only user', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: 'user-1' } });
    // No existing credentials
    mockLimit.mockResolvedValue([]);
    // Transaction succeeds
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        insert: () => ({ values: vi.fn().mockResolvedValue(undefined) }),
        update: () => ({
          set: () => ({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      };
      await fn(tx);
    });

    const response = await POST(createRequest({ password: 'testpass123', confirmPassword: 'testpass123' }));
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.message).toContain('Password set successfully');
    expect(mockBcryptHash).toHaveBeenCalledWith('testpass123', 12);
    expect(mockTransaction).toHaveBeenCalled();
  });

  it('handles race condition with 409', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: 'user-1' } });
    mockLimit.mockResolvedValue([]);
    // Transaction fails with unique constraint
    mockTransaction.mockRejectedValue({ code: '23505' });

    const response = await POST(createRequest({ password: 'testpass123', confirmPassword: 'testpass123' }));
    expect(response.status).toBe(409);

    const data = await response.json();
    expect(data.error).toBe('Password already set.');
  });

  it('returns 500 on unexpected error', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: 'user-1' } });
    mockLimit.mockResolvedValue([]);
    mockTransaction.mockRejectedValue(new Error('DB connection failed'));

    const response = await POST(createRequest({ password: 'testpass123', confirmPassword: 'testpass123' }));
    expect(response.status).toBe(500);
  });

  it('returns 400 when request body is malformed JSON', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: 'user-1' } });

    const request = new NextRequest('http://localhost/api/internal/set-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Boardsesh-Expected-Viewer': USER_1_VIEWER },
      body: 'not valid json{{{',
    });

    const response = await POST(request);
    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.error).toBe('Invalid request body');
  });

  it('returns 400 when password exceeds max length', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: 'user-1' } });

    const longPassword = 'a'.repeat(129);
    const response = await POST(createRequest({ password: longPassword, confirmPassword: longPassword }));
    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.error).toContain('less than 128 characters');
  });

  describe('expected viewer', () => {
    const body = { password: 'testpass123', confirmPassword: 'testpass123' };
    function expectNothingTouched() {
      expect(mockCheckRateLimit).not.toHaveBeenCalled();
      expect(mockSelect).not.toHaveBeenCalled();
      expect(mockBcryptHash).not.toHaveBeenCalled();
      expect(mockTransaction).not.toHaveBeenCalled();
    }

    it.each([
      ['another account', 'user-2:login-2'],
      ['another login of the same account', 'user-1:login-older'],
      ['a signed-out tab', 'anonymous'],
    ])('answers 409 viewer_changed and writes nothing when the tab shows %s', async (_label, expected) => {
      mockGetServerSession.mockResolvedValue({ user: { id: 'user-1' } });

      const response = await POST(createRequest(body, expected));

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ code: 'viewer_changed', error: 'Reload this page.' });
      expectNothingTouched();
    });

    it('refuses a signed-in cookie whose request names no viewer, since the guard always names one', async () => {
      mockGetServerSession.mockResolvedValue({ user: { id: 'user-1' } });

      const response = await POST(createRequest(body, null));

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ code: 'viewer_changed', error: 'Reload this page.' });
      expectNothingTouched();
    });

    it('answers 409 when the tab names an account and the cookie is signed out', async () => {
      mockGetServerSession.mockResolvedValue(null);

      const response = await POST(createRequest(body));

      expect(response.status).toBe(409);
      expectNothingTouched();
    });
  });
});
