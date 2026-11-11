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
vi.mock('@boardsesh/email', () => ({
  sendVerificationEmail: (...args: unknown[]) => mockSendVerificationEmail(...args),
}));

const mockCaptureException = vi.fn();
vi.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

const { mockHash } = vi.hoisted(() => ({
  mockHash: vi.fn<(password: string, cost: number) => Promise<string>>(async () => 'hashed-password'),
}));
vi.mock('bcryptjs', () => ({
  hash: (password: string, cost: number) => mockHash(password, cost),
}));

const mockSelectLimit = vi.fn();
const mockProfileValues = vi.fn();
const { mockUserProfilesTable } = vi.hoisted(() => ({ mockUserProfilesTable: { userId: 'user_profiles.userId' } }));
const mockTransaction = vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
  await fn({
    insert: (table: unknown) => ({
      values: (record: Record<string, unknown>) => {
        if (table === mockUserProfilesTable) mockProfileValues(record);
        return Promise.resolve(undefined);
      },
    }),
  });
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
  userProfiles: mockUserProfilesTable,
  verificationTokens: { identifier: 'verification_tokens.identifier' },
}));

import { POST } from '../route';

function createRequest(
  body: Record<string, unknown>,
  origin = 'http://localhost',
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(`${origin}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const edgeHeaders = {
  'X-Forwarded-For': '198.51.100.7, 203.0.113.9, 172.70.1.2',
  'CF-Connecting-IP': '203.0.113.9',
};

describe('POST /api/auth/register', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetClientIp.mockReturnValue('127.0.0.1');
    mockCheckRateLimit.mockReturnValue({ limited: false, retryAfterSeconds: 0 });
    mockSelectLimit.mockResolvedValue([]); // no existing user
    mockSendVerificationEmail.mockResolvedValue(undefined);
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'legacy');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('keeps the legacy limiter key when staged auth is off', async () => {
    mockCheckRateLimit.mockReturnValueOnce({ limited: true, retryAfterSeconds: 30 });
    const response = await POST(
      createRequest({ email: 'limited@example.com', password: 'password123' }, undefined, edgeHeaders),
    );
    expect(response.status).toBe(429);
    expect(mockCheckRateLimit).toHaveBeenCalledWith('register:127.0.0.1', 10, 60_000);
    expect(mockGetClientIp).toHaveBeenCalledOnce();
  });

  // Sign-in compares an unknown address against a cost-12 stand-in. A new
  // account hashed at any other cost would make its wrong-password answer take a
  // different time from an unknown address, and reveal that it exists.
  it('hashes the new password at bcrypt cost 12, the cost sign-in compares unknown addresses at', async () => {
    const response = await POST(createRequest({ email: 'cost@example.com', password: 'password123' }));
    expect(response.status).toBe(201);
    expect(mockHash).toHaveBeenCalledOnce();
    expect(mockHash).toHaveBeenCalledWith('password123', 12);
  });

  it.each(['0', '1'])('creates a public account with privacy controls enabled=%s', async (flag) => {
    vi.stubEnv('BOARDSESH_PRIVACY_ENABLED', flag);
    try {
      const response = await POST(createRequest({ email: 'rollout@example.com', password: 'password123' }));
      expect(response.status).toBe(201);
      // Only the user id: the column defaults make the account public.
      expect(mockProfileValues).toHaveBeenCalledWith({ userId: expect.any(String) });
    } finally {
      vi.unstubAllEnvs();
    }
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
      await POST(createRequest({ email: 'test@example.com', password: 'password123' }, 'https://www.boardsesh.com'));
      const [, , baseUrl] = mockSendVerificationEmail.mock.calls[0] as [string, string, string];
      expect(baseUrl).toBe('https://www.boardsesh.com');
      expect(baseUrl).not.toBe('http://localhost:3000');
    } finally {
      if (savedBaseUrl !== undefined) process.env.BASE_URL = savedBaseUrl;
    }
  });

  it('falls back to the request origin when BASE_URL is present but empty', async () => {
    // Dockerfile.web's runner stage declares `ENV BASE_URL=$BASE_URL`, which is
    // the empty string in an image built without the build arg — present, not
    // absent. With `??` that empty string wins and every link in the email
    // loses its origin.
    const savedBaseUrl = process.env.BASE_URL;
    process.env.BASE_URL = '';
    try {
      await POST(createRequest({ email: 'test@example.com', password: 'password123' }, 'https://www.boardsesh.com'));
      const [, , baseUrl] = mockSendVerificationEmail.mock.calls[0] as [string, string, string];
      expect(baseUrl).toBe('https://www.boardsesh.com');
    } finally {
      if (savedBaseUrl === undefined) delete process.env.BASE_URL;
      else process.env.BASE_URL = savedBaseUrl;
    }
  });

  it('reports a verification-email failure to Sentry while returning the account response', async () => {
    const smtpError = new Error('smtp failed');
    mockSendVerificationEmail.mockRejectedValueOnce(smtpError);

    const response = await POST(createRequest({ email: 'test@example.com', password: 'password123' }));

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ emailSent: false, requiresVerification: true });
    expect(mockCaptureException).toHaveBeenCalledWith(smtpError, expect.objectContaining({ tags: expect.anything() }));
  });
});

describe('backend-staging registration public adapter', () => {
  const token = `ev1_${'A'.repeat(43)}`;
  const committedEmail = 'Committed@example.com';
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'backend-staging');
    vi.stubEnv('CURRENT_STORE_AUTH_BACKEND_ORIGIN', 'http://127.0.0.1:54321');
    vi.stubEnv('CURRENT_STORE_AUTH_RPC_SECRET', 'dedicated-register-fixture-secret-at-least-32');
    vi.stubEnv('BASE_URL', 'https://www.boardsesh.test');
    mockCheckRateLimit.mockReturnValue({ limited: false, retryAfterSeconds: 0 });
    mockSendVerificationEmail.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  it('keys the staged limiter on the trusted client, not the first forwarded hop', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    mockCheckRateLimit.mockReturnValueOnce({ limited: true, retryAfterSeconds: 30 });
    const response = await POST(
      createRequest({ email: 'limited@example.com', password: 'password123' }, undefined, edgeHeaders),
    );
    expect(response.status).toBe(429);
    expect(mockCheckRateLimit).toHaveBeenCalledWith('register:203.0.113.9', 10, 60_000);
    expect(mockGetClientIp).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  function backend(outcome: Record<string, unknown>, status: number) {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      if (typeof init.body !== 'string') throw new Error('Expected serialized command');
      const command = JSON.parse(init.body) as { requestId: string };
      return Response.json(
        { protocolVersion: 2, operation: 'register', requestId: command.requestId, ...outcome },
        { status },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }
  function created(requiresVerification: boolean) {
    return {
      outcome: 'created',
      userId: 'private-user-id',
      createdAt: '2026-11-04T10:00:00.000Z',
      requiresVerification,
      ...(requiresVerification
        ? {
            mailPlan: {
              kind: 'uid-email-verification-v1',
              recipient: committedEmail,
              token,
              expiresAt: '2026-11-05T10:00:00.000Z',
            },
          }
        : {}),
    };
  }
  it('uses the exact committed recipient/token only for web SMTP and publishes the legacy fields', async () => {
    const fetchMock = backend(created(true), 201);
    const response = await POST(
      createRequest({ email: 'Request@example.com', password: 'submitted-password' }, 'https://attacker.test'),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      message: 'Account created. Please check your email to verify your account.',
      requiresVerification: true,
      emailSent: true,
    });
    expect(mockSendVerificationEmail).toHaveBeenCalledWith(committedEmail, token, 'https://www.boardsesh.test');
    expect(mockSelectLimit).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('honors backend verification policy without inspecting the web flag or leaking an internal receipt', async () => {
    backend(created(false), 201);
    const response = await POST(createRequest({ email: 'x', password: 'x' }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      message: 'Account created. You can now log in.',
      requiresVerification: false,
    });
    expect(mockSendVerificationEmail).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });
  it('keeps committed creation on SMTP failure and reports no private error cause', async () => {
    const fetchMock = backend(created(true), 201);
    const failure = new Error(`smtp private ${committedEmail} ${token}`);
    mockSendVerificationEmail.mockRejectedValue(failure);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await POST(createRequest({ email: 'x', password: 'x' }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      message: 'Account created. Please request a new verification email.',
      requiresVerification: true,
      emailSent: false,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockCaptureException).toHaveBeenCalledOnce();
    const [reported] = mockCaptureException.mock.calls[0] as [Error];
    expect(reported).not.toBe(failure);
    expect(reported.message).not.toContain(token);
    expect(reported).not.toHaveProperty('cause');
    expect(consoleSpy).not.toHaveBeenCalled();
  });
  it.each([
    [
      { outcome: 'error', code: 'validation_error', message: 'Invalid email address' },
      400,
      400,
      'Invalid email address',
    ],
    [
      { outcome: 'error', code: 'exists' },
      409,
      409,
      'An account with this email already exists. Please sign in with your existing account.',
    ],
    [{ outcome: 'error', code: 'replayed' }, 409, 503, 'AuthBackendUnavailable'],
    [{ outcome: 'error', code: 'unavailable' }, 503, 503, 'AuthBackendUnavailable'],
  ] as const)(
    'maps the finite domain outcome %j without local writes',
    async (outcome, backendStatus, publicStatus, message) => {
      backend(outcome, backendStatus);
      const response = await POST(createRequest({ email: 'x', password: 'x' }));
      expect(response.status).toBe(publicStatus);
      expect(await response.json()).toEqual({ error: message });
      expect(mockTransaction).not.toHaveBeenCalled();
      expect(mockSendVerificationEmail).not.toHaveBeenCalled();
    },
  );
  it('maps a rate limit with an exact bounded retry header', async () => {
    backend({ outcome: 'error', code: 'rate_limited', retryAfterSeconds: 10 }, 429);
    const response = await POST(createRequest({ email: 'x' }));
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('10');
  });
  it('fails before any registration command if canonical mail origin is unavailable', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('BASE_URL', '');
    vi.stubEnv('NEXTAUTH_URL', '');
    const fetchMock = backend(created(true), 201);
    const response = await POST(createRequest({ email: 'x' }, 'https://attacker.test'));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'AuthBackendUnavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });
  it('returns 503 for lost replies without retries, fallback, secret telemetry, or mail', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error(`private ${token}`));
    vi.stubGlobal('fetch', fetchMock);
    const response = await POST(createRequest({ email: 'x', password: 'secret' }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'AuthBackendUnavailable' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockSendVerificationEmail).not.toHaveBeenCalled();
  });
});
