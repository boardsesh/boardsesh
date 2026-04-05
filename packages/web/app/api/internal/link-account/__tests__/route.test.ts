import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mock server-only
vi.mock('server-only', () => ({}));

// Mock getServerSession
const mockGetServerSession = vi.fn();
vi.mock('next-auth/next', () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

// Mock auth options
vi.mock('@/app/lib/auth/auth-options', () => ({
  authOptions: {},
}));

// Mock cookies
const mockCookieSet = vi.fn();
const mockCookieDelete = vi.fn();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    set: (...args: unknown[]) => mockCookieSet(...args),
    delete: (...args: unknown[]) => mockCookieDelete(...args),
  }),
}));

// Mock account-link-intent
const mockIssueAccountLinkIntentToken = vi.fn();
vi.mock('@/app/lib/auth/account-link-intent', () => ({
  issueAccountLinkIntentToken: (...args: unknown[]) => mockIssueAccountLinkIntentToken(...args),
  ACCOUNT_LINK_INTENT_COOKIE: 'account-link-intent',
}));

// Mock database
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockLimit = vi.fn();
const mockDelete = vi.fn();
const mockDeleteWhere = vi.fn();

vi.mock('@/app/lib/db/db', () => ({
  getDb: () => ({
    select: (...args: unknown[]) => mockSelect(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
  }),
}));

vi.mock('@/app/lib/db/schema', () => ({
  accounts: { userId: 'accounts.userId', provider: 'accounts.provider' },
  userCredentials: { userId: 'userCredentials.userId' },
}));

// Mock drizzle-orm operators
vi.mock('drizzle-orm', () => ({
  eq: (...args: unknown[]) => ({ type: 'eq', args }),
  and: (...args: unknown[]) => ({ type: 'and', args }),
  count: () => 'count()',
}));

import { POST, DELETE } from '../route';

function createDeleteRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/internal/link-account', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Helper to set up the mock chain for the DELETE handler's three DB queries:
 * 1. Check if provider is linked: select().from().where().limit()
 * 2. Count total providers (Promise.all): select().from().where() (no limit)
 * 3. Check password exists (Promise.all): select().from().where().limit()
 */
function setupDeleteMocks(
  linkedResult: Record<string, unknown>[],
  providerCount?: number,
  passwordResult?: Record<string, unknown>[],
) {
  // All three queries share select -> from -> where chain
  mockSelect.mockReturnValue({ from: mockFrom });
  mockFrom.mockReturnValue({ where: mockWhere });

  // Query 1: linked check ends with .limit()
  const limitChain = { limit: mockLimit };
  mockWhere.mockReturnValueOnce(limitChain);
  mockLimit.mockResolvedValueOnce(linkedResult);

  if (providerCount !== undefined && passwordResult !== undefined) {
    // Query 2 (count): .where() resolves directly (no .limit())
    mockWhere.mockResolvedValueOnce([{ total: providerCount }]);
    // Query 3 (password): .where() returns { limit }, then .limit() resolves
    mockWhere.mockReturnValueOnce(limitChain);
    mockLimit.mockResolvedValueOnce(passwordResult);
  }

  // delete().where() chain
  mockDelete.mockReturnValue({ where: mockDeleteWhere });
  mockDeleteWhere.mockResolvedValue(undefined);
}

describe('POST /api/internal/link-account', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when not authenticated', async () => {
    mockGetServerSession.mockResolvedValue(null);

    const response = await POST();
    expect(response.status).toBe(401);

    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('sets cookie and returns success when authenticated', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: 'user-1' } });
    mockIssueAccountLinkIntentToken.mockReturnValue('test-token-123');

    const response = await POST();
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.success).toBe(true);

    expect(mockIssueAccountLinkIntentToken).toHaveBeenCalledWith('user-1');
    expect(mockCookieSet).toHaveBeenCalledWith(
      'account-link-intent',
      'test-token-123',
      {
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
        path: '/',
        maxAge: 300,
      },
    );
  });
});

describe('DELETE /api/internal/link-account', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when not authenticated', async () => {
    mockGetServerSession.mockResolvedValue(null);

    const response = await DELETE(createDeleteRequest({ provider: 'google' }));
    expect(response.status).toBe(401);

    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 400 for invalid provider name', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: 'user-1' } });

    const response = await DELETE(createDeleteRequest({ provider: 'twitter' }));
    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.error).toBe('Invalid provider');
  });

  it('returns 404 when provider is not linked', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: 'user-1' } });
    setupDeleteMocks([]);

    const response = await DELETE(createDeleteRequest({ provider: 'google' }));
    expect(response.status).toBe(404);

    const data = await response.json();
    expect(data.error).toBe('Provider not linked');
  });

  it('returns 400 when trying to unlink last auth method (1 provider, no password)', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: 'user-1' } });
    setupDeleteMocks([{ provider: 'google' }], 1, []);

    const response = await DELETE(createDeleteRequest({ provider: 'google' }));
    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.error).toContain("Can't disconnect your only sign-in method");
  });

  it('successfully unlinks when user has password', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: 'user-1' } });
    setupDeleteMocks([{ provider: 'google' }], 1, [{ userId: 'user-1' }]);

    const response = await DELETE(createDeleteRequest({ provider: 'google' }));
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.success).toBe(true);
    expect(mockDelete).toHaveBeenCalled();
  });

  it('successfully unlinks when user has other providers', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: 'user-1' } });
    setupDeleteMocks([{ provider: 'google' }], 2, []);

    const response = await DELETE(createDeleteRequest({ provider: 'google' }));
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.success).toBe(true);
    expect(mockDelete).toHaveBeenCalled();
  });
});
