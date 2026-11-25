import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({
  rate: vi.fn(),
  ip: vi.fn(() => '127.0.0.1'),
  mail: vi.fn(),
  telemetry: vi.fn(),
  transaction: vi.fn(),
  lookup: vi.fn(),
}));
vi.mock('@/app/lib/auth/rate-limiter', () => ({ checkRateLimit: mocks.rate, getClientIp: mocks.ip }));
vi.mock('@boardsesh/email', () => ({ sendVerificationEmail: mocks.mail }));
vi.mock('@sentry/nextjs', () => ({ captureException: mocks.telemetry }));
vi.mock('@/app/lib/db/db', () => ({
  getDb: () => {
    mocks.transaction();
    throw new Error('Web identity SQL is forbidden');
  },
}));
vi.mock('@boardsesh/db/queries/account-email', () => ({ findAccountsByEmail: mocks.lookup }));
import { findAccountsByEmail } from '@boardsesh/db/queries/account-email';
import { POST } from '../route';
import { CLOUDFLARE_ORIGIN_PROOF_HEADER } from '@/app/lib/auth/trusted-client-ip.server';
const mockCheckRateLimit = mocks.rate;
const mockSendVerificationEmail = mocks.mail;
const mockCaptureException = mocks.telemetry;
const mockTransaction = mocks.transaction;
function createRequest(
  body: Record<string, unknown>,
  origin = 'http://localhost',
  headers: Record<string, string> = {},
) {
  return new NextRequest(`${origin}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
const edgeHeaders = { 'X-Forwarded-For': '198.51.100.7, 203.0.113.9, 172.70.1.2', 'CF-Connecting-IP': '203.0.113.9' };

describe.each(['legacy', 'backend-staging'])('registration public adapter, mode=%s', (mode) => {
  const token = `ev1_${'A'.repeat(43)}`;
  const committedEmail = 'Committed@example.com';
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', mode);
    vi.stubEnv('CURRENT_STORE_AUTH_BACKEND_ORIGIN', 'http://127.0.0.1:54321');
    vi.stubEnv('CURRENT_STORE_AUTH_RPC_SECRET', 'dedicated-register-fixture-secret-at-least-32');
    vi.stubEnv('CLOUDFLARE_ORIGIN_PROOF_SECRET', '');
    vi.stubEnv('CLOUDFLARE_ORIGIN_PROOF_SECRET_NEXT', '');
    vi.stubEnv('BASE_URL', 'https://www.boardsesh.test');
    mockCheckRateLimit.mockReturnValue({ limited: false, retryAfterSeconds: 0 });
    mockSendVerificationEmail.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  it('derives service context only from the vouched origin request in default mode', async () => {
    const proofSecret = 'owned-issuer-origin-proof-secret-at-least-32';
    vi.stubEnv('CLOUDFLARE_ORIGIN_PROOF_SECRET', proofSecret);
    const sent = backend(created(false), 201);
    await POST(
      createRequest(
        { email: 'context@example.test', password: 'owned context password', clientAddress: '198.51.100.200' },
        undefined,
        {
          'X-Forwarded-For': '198.51.100.7, 172.70.1.2',
          'CF-Connecting-IP': '203.0.113.9',
          [CLOUDFLARE_ORIGIN_PROOF_HEADER]: proofSecret,
        },
      ),
    );
    const init = sent.mock.calls[0]?.[1];
    if (typeof init?.body !== 'string') throw new Error('Expected serialized command');
    const command = JSON.parse(init.body) as Record<string, unknown>;
    if (mode === 'legacy') expect(command.clientAddress).toBe('203.0.113.9');
    else expect(command).not.toHaveProperty('clientAddress');
    expect(mocks.rate).toHaveBeenCalledWith('register:203.0.113.9', 10, 60_000);
  });
  it('ignores forged edge visitor and payload context when the zone proof is absent', async () => {
    vi.stubEnv('CLOUDFLARE_ORIGIN_PROOF_SECRET', 'owned-issuer-origin-proof-secret-at-least-32');
    const sent = backend(created(false), 201);
    await POST(
      createRequest(
        { email: 'context@example.test', password: 'owned context password', clientAddress: '198.51.100.200' },
        undefined,
        { 'X-Forwarded-For': '198.51.100.7, 172.70.1.2', 'CF-Connecting-IP': '203.0.113.9' },
      ),
    );
    const init = sent.mock.calls[0]?.[1];
    if (typeof init?.body !== 'string') throw new Error('Expected serialized command');
    expect(JSON.parse(init.body)).not.toHaveProperty('clientAddress');
    expect(mocks.rate).toHaveBeenCalledWith('register:172.70.1.2', 10, 60_000);
  });
  it('keeps the trusted public bucket when caller-controlled first hops change', async () => {
    const sent = backend(created(false), 201);
    for (const prefix of ['198.51.100.7', '198.51.100.8']) {
      await POST(
        createRequest(
          { email: 'context@example.test', password: 'owned context password', clientAddress: '198.51.100.200' },
          undefined,
          { 'X-Forwarded-For': `${prefix}, 203.0.113.10`, 'CF-Connecting-IP': '198.51.100.200' },
        ),
      );
    }
    for (const call of sent.mock.calls) {
      if (typeof call[1].body !== 'string') throw new Error('Expected serialized command');
      expect(JSON.parse(call[1].body)).not.toHaveProperty('clientAddress');
    }
    expect(mocks.rate).toHaveBeenNthCalledWith(1, 'register:203.0.113.10', 10, 60_000);
    expect(mocks.rate).toHaveBeenNthCalledWith(2, 'register:203.0.113.10', 10, 60_000);
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
    expect(findAccountsByEmail).not.toHaveBeenCalled();
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
    vi.stubEnv('CLOUDFLARE_ORIGIN_PROOF_SECRET', '');
    vi.stubEnv('CLOUDFLARE_ORIGIN_PROOF_SECRET_NEXT', '');
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
  it('preserves the released malformed-JSON status without RPC or SQL', async () => {
    const send = vi.fn();
    vi.stubGlobal('fetch', send);
    const response = await POST(
      new NextRequest('http://localhost/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      }),
    );
    expect(response.status).toBe(mode === 'legacy' ? 500 : 503);
    expect(send).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });
  it('answers unavailable for an unknown mode before limiter key construction', async () => {
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'unknown-mode');
    const send = vi.fn();
    vi.stubGlobal('fetch', send);
    const response = await POST(createRequest({ email: 'x' }));
    expect(response.status).toBe(503);
    expect(send).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});
