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
vi.mock('@boardsesh/email', () => ({
  sendVerificationEmail: (...args: unknown[]) => mockSendVerificationEmail(...args),
}));

const mockCaptureException = vi.fn();
vi.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

const mockDeleteWhere = vi.fn().mockResolvedValue(undefined);
const mockValues = vi.fn().mockResolvedValue(undefined);
const lookup = vi.hoisted(() => ({ stored: [] as StoredAccount[] }));
vi.mock('@boardsesh/db/queries/account-email', async () => {
  const { fakeAccountEmailLookup } = await import('@/app/test-utils/account-email-lookup');
  return fakeAccountEmailLookup(() => lookup.stored);
});
const mockTransaction = vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
  await fn({
    delete: () => ({ where: mockDeleteWhere }),
    insert: () => ({ values: mockValues }),
  });
});

vi.mock('@/app/lib/db/db', () => ({
  getDb: () => ({
    transaction: (fn: (tx: unknown) => Promise<void>) => mockTransaction(fn),
  }),
}));

vi.mock('@/app/lib/db/schema', () => ({
  verificationTokens: { identifier: 'verification_tokens.identifier' },
}));

import type { StoredAccount } from '@/app/test-utils/account-email-lookup';
import { findAccountsByEmail } from '@boardsesh/db/queries/account-email';
import { POST } from '../route';

function createRequest(
  body: Record<string, unknown>,
  origin = 'http://localhost',
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(`${origin}/api/auth/resend-verification`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const edgeHeaders = {
  'X-Forwarded-For': '198.51.100.7, 203.0.113.9, 172.70.1.2',
  'CF-Connecting-IP': '203.0.113.9',
};

describe('POST /api/auth/resend-verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetClientIp.mockReturnValue('127.0.0.1');
    mockCheckRateLimit.mockReturnValue({ limited: false, retryAfterSeconds: 0 });
    // User exists and is unverified
    lookup.stored = [{ id: 'user-1', email: 'test@example.com', emailVerified: null }];
    mockSendVerificationEmail.mockResolvedValue(undefined);
    // Make consistentDelay a no-op: first Date.now() call returns startTime=0,
    // subsequent calls return 2000ms so elapsed >= MIN_RESPONSE_TIME_MS and no
    // setTimeout is scheduled.
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(2000);
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'legacy');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('keys the staged limiter on the trusted client, not the first forwarded hop', async () => {
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'backend-staging');
    mockCheckRateLimit.mockReturnValueOnce({ limited: true, retryAfterSeconds: 30 });
    const response = await POST(createRequest({ email: 'test@example.com' }, undefined, edgeHeaders));
    expect(response.status).toBe(429);
    expect(mockCheckRateLimit).toHaveBeenCalledWith('resend-verification:203.0.113.9', 5, 60_000);
    expect(mockGetClientIp).not.toHaveBeenCalled();
  });

  it('keeps the legacy limiter key when staged auth is off', async () => {
    mockCheckRateLimit.mockReturnValueOnce({ limited: true, retryAfterSeconds: 30 });
    const response = await POST(createRequest({ email: 'test@example.com' }, undefined, edgeHeaders));
    expect(response.status).toBe(429);
    expect(mockCheckRateLimit).toHaveBeenCalledWith('resend-verification:127.0.0.1', 5, 60_000);
    expect(mockGetClientIp).toHaveBeenCalledOnce();
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

  describe('any capitalisation (BA-02)', () => {
    const mixedCase: StoredAccount = { id: 'mixed', email: 'Mixed.Case@Example.test', emailVerified: null };

    it.each([
      ['exactly as stored', 'Mixed.Case@Example.test'],
      ['in lowercase', 'mixed.case@example.test'],
    ])('sends the link to the stored address when it is typed %s', async (_case, typed) => {
      lookup.stored = [mixedCase];

      const response = await POST(createRequest({ email: typed }));

      expect(response.status).toBe(200);
      expect(mockSendVerificationEmail.mock.calls[0][0]).toBe('Mixed.Case@Example.test');
      expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({ identifier: 'Mixed.Case@Example.test' }));
    });

    it('sends nothing for an address several accounts share in other capitals', async () => {
      lookup.stored = [mixedCase, { id: 'sibling', email: 'mixed.case@example.test', emailVerified: null }];

      const response = await POST(createRequest({ email: 'MIXED.CASE@EXAMPLE.TEST' }));

      expect(response.status).toBe(200);
      expect(mockSendVerificationEmail).not.toHaveBeenCalled();
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('sends nothing to an account that is already verified', async () => {
      lookup.stored = [{ ...mixedCase, emailVerified: new Date('2026-01-01T00:00:00Z') }];

      await POST(createRequest({ email: 'mixed.case@example.test' }));

      expect(mockSendVerificationEmail).not.toHaveBeenCalled();
    });
  });

  it('reports a verification-email failure to Sentry', async () => {
    const smtpError = new Error('smtp failed');
    mockSendVerificationEmail.mockRejectedValueOnce(smtpError);

    const response = await POST(createRequest({ email: 'test@example.com' }));

    expect(response.status).toBe(500);
    expect(mockCaptureException).toHaveBeenCalledWith(smtpError, expect.objectContaining({ tags: expect.anything() }));
  });
});

describe('UID resend public adapter', () => {
  const token = `ev1_${'B'.repeat(43)}`;
  const recipient = 'Committed+Tag@example.com';
  const generic = { message: 'If an account exists and needs verification, a verification email will be sent' };
  const mailPlan = { kind: 'uid-email-verification-v1', recipient, token, expiresAt: '2026-11-06T10:00:00.000Z' };
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'backend-staging');
    vi.stubEnv('CURRENT_STORE_AUTH_BACKEND_ORIGIN', 'http://127.0.0.1:54321');
    vi.stubEnv('CURRENT_STORE_AUTH_RPC_SECRET', 'dedicated-resend-fixture-secret-at-least-32');
    vi.stubEnv('BASE_URL', 'https://www.boardsesh.test');
    mockCheckRateLimit.mockReturnValue({ limited: false, retryAfterSeconds: 0 });
    mockSendVerificationEmail.mockResolvedValue(undefined);
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(2000);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  function backend(outcome: Record<string, unknown>, status = 200) {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      if (typeof init.body !== 'string') throw new Error('Expected serialized command');
      const command = JSON.parse(init.body) as { requestId: string };
      return Response.json(
        { protocolVersion: 2, operation: 'resend-verification', requestId: command.requestId, ...outcome },
        { status },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }
  it('publishes the same generic response with or without a committed private mail plan', async () => {
    const noMail = backend({ outcome: 'accepted' });
    let response = await POST(createRequest({ email: 'unrelated@example.com' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(generic);
    expect(mockSendVerificationEmail).not.toHaveBeenCalled();
    expect(noMail).toHaveBeenCalledOnce();
    const withMail = backend({ outcome: 'accepted', mailPlan });
    response = await POST(createRequest({ email: 'unrelated@example.com' }, 'https://attacker.test'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(generic);
    expect(mockSendVerificationEmail).toHaveBeenCalledWith(recipient, token, 'https://www.boardsesh.test');
    expect(withMail).toHaveBeenCalledOnce();
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(findAccountsByEmail).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });
  it('keeps SMTP failure indistinguishable in public status/body and strips private exception context', async () => {
    const fetchMock = backend({ outcome: 'accepted', mailPlan });
    const privateError = new Error(`SMTP ${recipient} ${token}`);
    mockSendVerificationEmail.mockRejectedValue(privateError);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await POST(createRequest({ email: 'unrelated@example.com' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(generic);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockCaptureException).toHaveBeenCalledOnce();
    const [reported] = mockCaptureException.mock.calls[0] as [Error];
    expect(reported).not.toBe(privateError);
    expect(reported.message).not.toContain(token);
    expect(reported.message).not.toContain(recipient);
    expect(reported).not.toHaveProperty('cause');
    expect(consoleSpy).not.toHaveBeenCalled();
  });
  it('validates the canonical mail origin before any command even when no mail would be needed', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('BASE_URL', '');
    vi.stubEnv('NEXTAUTH_URL', '');
    const fetchMock = backend({ outcome: 'accepted' });
    const response = await POST(createRequest({ email: 'nobody@example.com' }, 'https://attacker.test'));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'AuthBackendUnavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });
  it.each([
    [
      { outcome: 'error', code: 'validation_error', message: 'Invalid email address' },
      400,
      400,
      'Invalid email address',
    ],
    [{ outcome: 'error', code: 'replayed' }, 409, 503, 'AuthBackendUnavailable'],
    [{ outcome: 'error', code: 'unavailable' }, 503, 503, 'AuthBackendUnavailable'],
  ] as const)('maps only finite authoritative outcomes %j', async (outcome, serviceStatus, publicStatus, error) => {
    backend(outcome, serviceStatus);
    const response = await POST(createRequest({ email: 'candidate@example.com' }));
    expect(response.status).toBe(publicStatus);
    expect(await response.json()).toEqual({ error });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockSendVerificationEmail).not.toHaveBeenCalled();
  });
  it('retains local and backend rate-limit responses without entering the local credential store', async () => {
    const fetchMock = backend({ outcome: 'error', code: 'rate_limited', retryAfterSeconds: 12 }, 429);
    let response = await POST(createRequest({ email: 'candidate@example.com' }));
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('12');
    mockCheckRateLimit.mockReturnValue({ limited: true, retryAfterSeconds: 20 });
    response = await POST(createRequest({ email: 'candidate@example.com' }));
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('20');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mockTransaction).not.toHaveBeenCalled();
  });
  it('fails closed on a lost reply without retry, local fallback, or raw telemetry', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error(`private ${recipient} ${token}`));
    vi.stubGlobal('fetch', fetchMock);
    const response = await POST(createRequest({ email: 'candidate@example.com' }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'AuthBackendUnavailable' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(findAccountsByEmail).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });
  it('retains the1500ms response floor without claiming equal SMTP timing', async () => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-05T10:00:00.000Z'));
    backend({ outcome: 'accepted' });
    let settled = false;
    const pending = POST(createRequest({ email: 'candidate@example.com' })).then((response) => {
      settled = true;
      return response;
    });
    await vi.advanceTimersByTimeAsync(1499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).status).toBe(200);
    expect(settled).toBe(true);
  });
});
