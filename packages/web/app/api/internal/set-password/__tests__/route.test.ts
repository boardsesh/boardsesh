import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { NextRequest, NextResponse } from 'next/server';
import { POST } from '../route';

const controls = vi.hoisted(() => ({
  snapshot: vi.fn(),
  createClient: vi.fn(),
  command: vi.fn(),
  delegate: vi.fn(),
  rate: vi.fn(),
  address: vi.fn(),
  vouched: vi.fn(),
  database: vi.fn(),
  hash: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/auth/admitted-session.server', () => ({ getAdmittedServerSessionSnapshot: controls.snapshot }));
vi.mock('@/app/lib/auth/pre-enforcement-set-password-client.server', () => ({
  createPreEnforcementSetPasswordCommandClient: controls.createClient,
}));
vi.mock('@/app/lib/auth/set-password-command.server', () => ({ delegateSetPassword: controls.delegate }));
vi.mock('@/app/lib/auth/rate-limiter', () => ({ checkRateLimit: controls.rate, getClientIp: controls.address }));
vi.mock('@/app/lib/auth/trusted-client-ip.server', () => ({ cloudflareVouchedVisitorAddress: controls.vouched }));
vi.mock('@/app/lib/db/db', () => ({ getDb: controls.database }));
vi.mock('bcryptjs', () => ({ hash: controls.hash }));

const password = 'testpass123';
const viewer = 'user-1:pending-login-identity';
const source = Object.freeze({ credential: 'the-held-jwe', cookieName: '__Secure-next-auth.session-token' });
function request(body: unknown = { password, confirmPassword: password }, expected: string | null = viewer) {
  return new NextRequest('https://www.boardsesh.com/api/internal/set-password', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(expected === null ? {} : { 'X-Boardsesh-Expected-Viewer': expected }),
    },
    body: JSON.stringify(body),
  });
}
function signedIn(authSessionId?: string) {
  return {
    session: { user: { id: 'user-1' }, ...(authSessionId === undefined ? {} : { authSessionId }) },
    legacyCredential: source,
  };
}
function noWrites(response: Response) {
  expect(response.headers.getSetCookie()).toEqual([]);
  expect(controls.database).not.toHaveBeenCalled();
  expect(controls.hash).not.toHaveBeenCalled();
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('CURRENT_STORE_SET_PASSWORD_MODE', 'legacy');
  vi.stubEnv('AUTH_IDENTITY_MIRROR', 'off');
  controls.snapshot.mockResolvedValue(signedIn());
  controls.createClient.mockReturnValue({ setPassword: controls.command });
  controls.command.mockResolvedValue({ outcome: 'set' });
  controls.delegate.mockResolvedValue(null);
  controls.rate.mockReturnValue({ limited: false, retryAfterSeconds: 0 });
  controls.address.mockReturnValue('127.0.0.1');
  controls.vouched.mockReturnValue(null);
  controls.database.mockImplementation(() => {
    throw new Error('WEB_PASSWORD_SQL_FORBIDDEN');
  });
  controls.hash.mockImplementation(() => {
    throw new Error('WEB_PASSWORD_HASH_FORBIDDEN');
  });
});
afterEach(() => vi.unstubAllEnvs());

describe('default set-password facade and source custody', () => {
  it('sends the held source and actual absent SID, independently of optional body identity', async () => {
    const response = await POST(
      request({ password, confirmPassword: password, expectedUserId: 'spoof', expectedAuthSessionId: 'spoof-sid' }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      message: 'Password set successfully. You can now log in with your email and password.',
    });
    expect(controls.snapshot).toHaveBeenCalledExactlyOnceWith({ method: 'POST' });
    expect(controls.command).toHaveBeenCalledExactlyOnceWith(
      {
        credential: source.credential,
        password,
        confirmPassword: password,
        viewer: { userId: 'user-1', authSessionId: null },
      },
      undefined,
    );
    expect(controls.rate.mock.calls).toEqual([
      ['set-password:127.0.0.1', 5, 60_000],
      ['set-password:user:user-1', 5, 60_000],
    ]);
    noWrites(response);
  });
  it('keeps a server-resolved SID beyond the optional public body limit and only forwards vouched client context', async () => {
    const sid = 's'.repeat(1025);
    controls.snapshot.mockResolvedValue(signedIn(sid));
    controls.vouched.mockReturnValue('8.8.8.8');
    const response = await POST(request(undefined, `user-1:${sid}`));
    expect(response.status).toBe(200);
    expect(controls.command).toHaveBeenCalledWith(
      expect.objectContaining({ viewer: { userId: 'user-1', authSessionId: sid } }),
      '8.8.8.8',
    );
    noWrites(response);
  });
  it('retains an existing staged/canonical delegate response without creating the new client', async () => {
    const staged = NextResponse.json({ outcome: 'set' });
    controls.delegate.mockResolvedValue(staged);
    controls.snapshot.mockResolvedValue({ ...signedIn(), legacyCredential: null });
    expect(await POST(request())).toBe(staged);
    expect(controls.createClient).not.toHaveBeenCalled();
    noWrites(staged);
  });
  it('refuses a missing paired source after the same public guards, never reselecting or writing', async () => {
    controls.snapshot.mockResolvedValue({ ...signedIn(), legacyCredential: null });
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(controls.createClient).not.toHaveBeenCalled();
    noWrites(response);
  });
  it.each([
    [{ outcome: 'already_set' }, 409, { error: 'Password already set.' }],
    [{ outcome: 'unauthenticated' }, 401, { error: 'Unauthorized' }],
    [{ outcome: 'identity_changed' }, 409, { code: 'viewer_changed', error: 'Reload this page.' }],
    [
      { outcome: 'error', code: 'rate_limited', retryAfterSeconds: 23 },
      429,
      { error: 'Too many requests. Please try again later.' },
    ],
    [{ outcome: 'error', code: 'replayed' }, 503, { error: 'Service temporarily unavailable' }],
    [{ outcome: 'error', code: 'unavailable' }, 503, { error: 'Service temporarily unavailable' }],
    [{ outcome: 'error', code: 'rolled_back' }, 500, { error: 'An error occurred while setting the password' }],
  ])('maps acknowledged %j to public %s without cookie or local work', async (reply, status, body) => {
    controls.command.mockResolvedValue(reply);
    const response = await POST(request());
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(body);
    if (reply.outcome === 'identity_changed') expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    if (status === 503) expect(response.headers.get('Retry-After')).toBe('1');
    if (status === 429) expect(response.headers.get('Retry-After')).toBe('23');
    noWrites(response);
  });
  it('answers unknown acknowledgement unavailable, with exactly one send', async () => {
    controls.command.mockRejectedValue(new Error('lost committed acknowledgement'));
    // The strict client sanitizes transport errors before they reach this facade.
    const { AuthBackendUnavailableError } = await import('@/app/lib/auth/password-command-client.server');
    controls.command.mockRejectedValue(new AuthBackendUnavailableError());
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(controls.command).toHaveBeenCalledOnce();
    noWrites(response);
  });
});

describe('unchanged public precedence', () => {
  it('refuses invalid mode before session resolution', async () => {
    vi.stubEnv('CURRENT_STORE_SET_PASSWORD_MODE', 'invalid');
    expect((await POST(request())).status).toBe(503);
    expect(controls.snapshot).not.toHaveBeenCalled();
  });
  it('returns401 for anonymous without a viewer, before rates/body/client', async () => {
    controls.snapshot.mockResolvedValue({ session: null, legacyCredential: null });
    expect((await POST(request(undefined, null))).status).toBe(401);
    expect(controls.rate).not.toHaveBeenCalled();
    expect(controls.createClient).not.toHaveBeenCalled();
  });
  it.each(['user-2:other', 'user-1:old', 'anonymous', null])(
    'refuses stale/missing viewer %s before rates/body/client',
    async (expected) => {
      const response = await POST(request({ password: 'short' }, expected));
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ code: 'viewer_changed', error: 'Reload this page.' });
      expect(controls.rate).not.toHaveBeenCalled();
      expect(controls.createClient).not.toHaveBeenCalled();
      noWrites(response);
    },
  );
  it('answers viewer_changed for a signed-out cookie and signed-in viewer', async () => {
    controls.snapshot.mockResolvedValue({ session: null, legacyCredential: null });
    expect((await POST(request())).status).toBe(409);
    expect(controls.rate).not.toHaveBeenCalled();
  });
  it.each([1, 2])('keeps independent rate limit%s before body/client', async (limitedCall) => {
    if (limitedCall === 2) controls.rate.mockReturnValueOnce({ limited: false, retryAfterSeconds: 0 });
    controls.rate.mockReturnValueOnce({ limited: true, retryAfterSeconds: 30 });
    const response = await POST(request({ password: 'short' }));
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('30');
    expect(controls.rate).toHaveBeenCalledTimes(limitedCall);
    expect(controls.createClient).not.toHaveBeenCalled();
  });
  it.each([
    { password: 'short', confirmPassword: 'short' },
    { password: 'a'.repeat(129), confirmPassword: 'a'.repeat(129) },
    { confirmPassword: password },
    { password, confirmPassword: 'different' },
    { password, confirmPassword: password, expectedAuthSessionId: 's'.repeat(1025) },
  ])('validates public input%j before any private operation', async (body) => {
    expect((await POST(request(body))).status).toBe(400);
    expect(controls.delegate).not.toHaveBeenCalled();
    expect(controls.createClient).not.toHaveBeenCalled();
  });
  it('retains malformed JSON400 after rates and before delegate/client', async () => {
    const response = await POST(
      new NextRequest('https://www.boardsesh.com/api/internal/set-password', {
        method: 'POST',
        headers: { 'X-Boardsesh-Expected-Viewer': viewer },
        body: 'invalid{{',
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid request body' });
    expect(controls.rate).toHaveBeenCalledTimes(2);
    expect(controls.delegate).not.toHaveBeenCalled();
    expect(controls.createClient).not.toHaveBeenCalled();
  });
});
