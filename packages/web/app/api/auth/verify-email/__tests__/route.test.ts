import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const mockCheckRateLimit = vi.fn();
const mockGetClientIp = vi.fn();
vi.mock('@/app/lib/auth/rate-limiter', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  getClientIp: (...args: unknown[]) => mockGetClientIp(...args),
}));

// Record the predicates the route builds so assertions read what the code
// actually emitted rather than a predicate rebuilt in the test.
vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => ({ _type: 'and', args })),
  eq: vi.fn((col: unknown, val: unknown) => ({ _type: 'eq', col, val })),
  inArray: vi.fn((col: unknown, values: unknown[]) => ({ _type: 'inArray', col, values })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ _type: 'sql', strings, values })),
}));

type RecordedPredicate = { _type: string; values?: unknown[] };
type RecordedAnd = { _type: 'and'; args: RecordedPredicate[] };

const mockSelectLimit = vi.fn();
const mockSelectWhere = vi.fn((_predicate: RecordedAnd) => ({ limit: mockSelectLimit }));
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

/** The identifier list the route passed to its first `inArray(...)` predicate. */
function recordedIdentifierCandidates(): unknown[] {
  const andPredicate = mockSelectWhere.mock.calls[0][0];
  const inArrayPredicate = andPredicate.args.find((arg) => arg._type === 'inArray');
  return inArrayPredicate?.values ?? [];
}

const FUTURE = new Date(Date.now() + 60 * 60 * 1000);

describe('GET /api/auth/verify-email', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetClientIp.mockReturnValue('127.0.0.1');
    mockCheckRateLimit.mockReturnValue({ limited: false, retryAfterSeconds: 0 });
    mockSelectWhere.mockReturnValue({ limit: mockSelectLimit });
    // 1st select → the verification token; 2nd → the user row.
    mockSelectLimit
      .mockResolvedValueOnce([{ identifier: 'foo@example.com', token: 'tok-1', expires: FUTURE }])
      .mockResolvedValueOnce([{ id: 'user-1', email: 'Foo@Example.com' }]);
  });

  it('verifies a link whose email is cased differently from the stored row', async () => {
    const response = await GET(createRequest({ token: 'tok-1', email: 'FOO@Example.com' }));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/auth/login?verified=true');
    expect(mockTxUpdateSet).toHaveBeenCalledWith({ emailVerified: expect.any(Date) });
  });

  it('also tries the raw-cased identifier so pre-normalization links still resolve', async () => {
    await GET(createRequest({ token: 'tok-1', email: 'Foo@Example.com' }));

    // Both the canonical identifier and the original casing the old code stored.
    expect(recordedIdentifierCandidates()).toEqual(['foo@example.com', 'Foo@Example.com']);
  });

  it('does not duplicate the identifier when the link email is already canonical', async () => {
    await GET(createRequest({ token: 'tok-1', email: 'foo@example.com' }));

    expect(recordedIdentifierCandidates()).toEqual(['foo@example.com']);
  });

  it('marks only the account that owns the token, by id', async () => {
    const { eq } = await import('drizzle-orm');
    await GET(createRequest({ token: 'tok-1', email: 'FOO@Example.com' }));

    // Scoped to users.id — NOT to every row sharing the lower-cased email.
    expect(eq).toHaveBeenCalledWith('users.id', 'user-1');
    expect(mockTxUpdateWhere).toHaveBeenCalledWith({ _type: 'eq', col: 'users.id', val: 'user-1' });
  });

  it('redirects to InvalidToken when no candidate identifier matches', async () => {
    mockSelectLimit.mockReset();
    mockSelectLimit.mockResolvedValue([]);

    const response = await GET(createRequest({ token: 'nope', email: 'foo@example.com' }));

    expect(response.headers.get('location')).toContain('error=InvalidToken');
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('redirects to TokenExpired and clears the token when it has lapsed', async () => {
    mockSelectLimit.mockReset();
    mockSelectLimit.mockResolvedValueOnce([
      { identifier: 'foo@example.com', token: 'tok-1', expires: new Date(Date.now() - 1000) },
    ]);

    const response = await GET(createRequest({ token: 'tok-1', email: 'foo@example.com' }));

    expect(response.headers.get('location')).toContain('error=TokenExpired');
    expect(mockDeleteWhere).toHaveBeenCalledTimes(1);
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});
