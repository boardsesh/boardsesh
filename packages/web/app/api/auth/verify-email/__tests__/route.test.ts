import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const mockCheckRateLimit = vi.fn();
const mockGetClientIp = vi.fn();
vi.mock('@/app/lib/auth/rate-limiter', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  getClientIp: (...args: unknown[]) => mockGetClientIp(...args),
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => ({ _type: 'and', args })),
  eq: vi.fn((col: unknown, val: unknown) => ({ _type: 'eq', col, val })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ _type: 'sql', strings, values })),
}));

const mockSelectLimit = vi.fn();
const mockSelectWhere = vi.fn((_predicate: unknown) => ({ limit: mockSelectLimit }));
const mockDeleteWhere = vi.fn().mockResolvedValue(undefined);
const mockTxUpdateWhere = vi.fn().mockResolvedValue(undefined);
const mockTxUpdateSet = vi.fn(() => ({ where: mockTxUpdateWhere }));
const mockTransaction = vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
  await fn({
    update: () => ({ set: mockTxUpdateSet }),
    delete: () => ({ where: mockDeleteWhere }),
  });
});

vi.mock('@/app/lib/db/db', () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ where: mockSelectWhere }) }),
    delete: () => ({ where: mockDeleteWhere }),
    transaction: (fn: (tx: unknown) => Promise<void>) => mockTransaction(fn),
  }),
}));

vi.mock('@/app/lib/db/schema', () => ({
  users: { id: 'users.id', email: 'users.email' },
  verificationTokens: { identifier: 'verification_tokens.identifier', token: 'verification_tokens.token' },
}));

import { GET } from '../route';

function createRequest(params: Record<string, string>): NextRequest {
  const url = new URL('http://localhost/api/auth/verify-email');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return new NextRequest(url, { method: 'GET' });
}

const FUTURE = new Date(Date.now() + 60 * 60 * 1000);

describe('GET /api/auth/verify-email', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetClientIp.mockReturnValue('127.0.0.1');
    mockCheckRateLimit.mockReturnValue({ limited: false, retryAfterSeconds: 0 });
    mockSelectLimit.mockReset();
  });

  it('verifies a current token against the exact account despite an email twin', async () => {
    mockSelectLimit
      .mockResolvedValueOnce([{ identifier: 'email-verification:v2:user:user-1', token: 'tok-1', expires: FUTURE }])
      .mockResolvedValueOnce([{ id: 'user-1' }]);

    const response = await GET(createRequest({ token: 'tok-1', email: 'FOO@Example.com' }));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/auth/login?verified=true');
    expect(mockTxUpdateWhere).toHaveBeenCalledWith({ _type: 'eq', col: 'users.id', val: 'user-1' });
  });

  it('accepts a raw-case legacy identifier when exactly one account matches', async () => {
    mockSelectLimit
      .mockResolvedValueOnce([{ identifier: 'Foo@example.com', token: 'tok-1', expires: FUTURE }])
      .mockResolvedValueOnce([{ id: 'legacy-user' }]);

    const response = await GET(createRequest({ token: 'tok-1', email: 'foo@example.com' }));

    expect(response.headers.get('location')).toContain('/auth/login?verified=true');
    expect(mockTxUpdateWhere).toHaveBeenCalledWith({ _type: 'eq', col: 'users.id', val: 'legacy-user' });
  });

  it('rejects a legacy token when duplicate normalized emails make its owner ambiguous', async () => {
    mockSelectLimit
      .mockResolvedValueOnce([{ identifier: 'Foo@example.com', token: 'tok-1', expires: FUTURE }])
      .mockResolvedValueOnce([{ id: 'mixed-case-twin' }, { id: 'lower-case-twin' }]);

    const response = await GET(createRequest({ token: 'tok-1', email: 'foo@example.com' }));

    expect(response.headers.get('location')).toContain('error=InvalidToken');
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockTxUpdateWhere).not.toHaveBeenCalled();
  });

  it('rejects a current token when the supplied email no longer matches its owner', async () => {
    mockSelectLimit
      .mockResolvedValueOnce([{ identifier: 'email-verification:v2:user:user-1', token: 'tok-1', expires: FUTURE }])
      .mockResolvedValueOnce([]);

    const response = await GET(createRequest({ token: 'tok-1', email: 'other@example.com' }));

    expect(response.headers.get('location')).toContain('error=InvalidToken');
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('rejects a duplicated raw token rather than selecting an arbitrary account', async () => {
    mockSelectLimit.mockResolvedValueOnce([
      { identifier: 'email-verification:v2:user:user-1', token: 'tok-1', expires: FUTURE },
      { identifier: 'email-verification:v2:user:user-2', token: 'tok-1', expires: FUTURE },
    ]);

    const response = await GET(createRequest({ token: 'tok-1', email: 'foo@example.com' }));

    expect(response.headers.get('location')).toContain('error=InvalidToken');
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('redirects to TokenExpired and deletes only that token row', async () => {
    mockSelectLimit.mockResolvedValueOnce([
      { identifier: 'email-verification:v2:user:user-1', token: 'tok-1', expires: new Date(Date.now() - 1000) },
    ]);

    const response = await GET(createRequest({ token: 'tok-1', email: 'foo@example.com' }));

    expect(response.headers.get('location')).toContain('error=TokenExpired');
    expect(mockDeleteWhere).toHaveBeenCalledWith({
      _type: 'and',
      args: [
        { _type: 'eq', col: 'verification_tokens.identifier', val: 'email-verification:v2:user:user-1' },
        { _type: 'eq', col: 'verification_tokens.token', val: 'tok-1' },
      ],
    });
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});
