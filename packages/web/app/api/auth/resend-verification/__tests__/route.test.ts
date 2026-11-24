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
  return new NextRequest(`${origin}/api/auth/resend-verification`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe.each(['legacy', 'backend-staging'])('UID resend public adapter, mode=%s', (mode) => {
  const token = `ev1_${'B'.repeat(43)}`;
  const recipient = 'Committed+Tag@example.com';
  const generic = { message: 'If an account exists and needs verification, a verification email will be sent' };
  const mailPlan = { kind: 'uid-email-verification-v1', recipient, token, expiresAt: '2026-11-06T10:00:00.000Z' };
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', mode);
    vi.stubEnv('CURRENT_STORE_AUTH_BACKEND_ORIGIN', 'http://127.0.0.1:54321');
    vi.stubEnv('CURRENT_STORE_AUTH_RPC_SECRET', 'dedicated-resend-fixture-secret-at-least-32');
    vi.stubEnv('CLOUDFLARE_ORIGIN_PROOF_SECRET', '');
    vi.stubEnv('CLOUDFLARE_ORIGIN_PROOF_SECRET_NEXT', '');
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
  it('derives service context only from the vouched origin request in default mode', async () => {
    const proofSecret = 'owned-issuer-origin-proof-secret-at-least-32';
    vi.stubEnv('CLOUDFLARE_ORIGIN_PROOF_SECRET', proofSecret);
    const sent = backend({ outcome: 'accepted' }, 200);
    await POST(
      createRequest({ email: 'context@example.test', clientAddress: '198.51.100.200' }, undefined, {
        'X-Forwarded-For': '198.51.100.7, 172.70.1.2',
        'CF-Connecting-IP': '203.0.113.9',
        [CLOUDFLARE_ORIGIN_PROOF_HEADER]: proofSecret,
      }),
    );
    const init = sent.mock.calls[0]?.[1];
    if (typeof init?.body !== 'string') throw new Error('Expected serialized command');
    const command = JSON.parse(init.body) as Record<string, unknown>;
    if (mode === 'legacy') expect(command.clientAddress).toBe('203.0.113.9');
    else expect(command).not.toHaveProperty('clientAddress');
    expect(mocks.rate).toHaveBeenCalledWith('resend-verification:203.0.113.9', 5, 60_000);
  });
  it('ignores forged edge visitor and payload context when the zone proof is absent', async () => {
    vi.stubEnv('CLOUDFLARE_ORIGIN_PROOF_SECRET', 'owned-issuer-origin-proof-secret-at-least-32');
    const sent = backend({ outcome: 'accepted' }, 200);
    await POST(
      createRequest({ email: 'context@example.test', clientAddress: '198.51.100.200' }, undefined, {
        'X-Forwarded-For': '198.51.100.7, 172.70.1.2',
        'CF-Connecting-IP': '203.0.113.9',
      }),
    );
    const init = sent.mock.calls[0]?.[1];
    if (typeof init?.body !== 'string') throw new Error('Expected serialized command');
    expect(JSON.parse(init.body)).not.toHaveProperty('clientAddress');
    expect(mocks.rate).toHaveBeenCalledWith('resend-verification:172.70.1.2', 5, 60_000);
  });
  it('keeps the trusted public bucket when caller-controlled first hops change', async () => {
    const sent = backend({ outcome: 'accepted' }, 200);
    for (const prefix of ['198.51.100.7', '198.51.100.8']) {
      await POST(
        createRequest({ email: 'context@example.test', clientAddress: '198.51.100.200' }, undefined, {
          'X-Forwarded-For': `${prefix}, 203.0.113.10`,
          'CF-Connecting-IP': '198.51.100.200',
        }),
      );
    }
    for (const call of sent.mock.calls) {
      if (typeof call[1].body !== 'string') throw new Error('Expected serialized command');
      expect(JSON.parse(call[1].body)).not.toHaveProperty('clientAddress');
    }
    expect(mocks.rate).toHaveBeenNthCalledWith(1, 'resend-verification:203.0.113.10', 5, 60_000);
    expect(mocks.rate).toHaveBeenNthCalledWith(2, 'resend-verification:203.0.113.10', 5, 60_000);
  });
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
    expect(response.status).toBe(mode === 'legacy' ? 500 : 200);
    expect(await response.json()).toEqual(mode === 'legacy' ? { error: 'Failed to send verification email' } : generic);
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
    vi.stubEnv('CLOUDFLARE_ORIGIN_PROOF_SECRET', '');
    vi.stubEnv('CLOUDFLARE_ORIGIN_PROOF_SECRET_NEXT', '');
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
  it('preserves the released malformed-JSON status without RPC or SQL', async () => {
    const send = vi.fn();
    vi.stubGlobal('fetch', send);
    const response = await POST(
      new NextRequest('http://localhost/api/auth/resend-verification', {
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
