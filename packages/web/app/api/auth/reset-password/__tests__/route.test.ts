import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { NextRequest } from 'next/server';
import { AUTH_BACKEND_UNAVAILABLE, RECOVERY_COMMAND_PATHS } from '@boardsesh/auth-protocol';
import { mintDeviceToken, verifyDeviceToken } from '@boardsesh/auth-protocol/device-token';
import { CLOUDFLARE_ORIGIN_PROOF_HEADER } from '@boardsesh/consent/origin-proof';
vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({
  rate: vi.fn(),
  ip: vi.fn(() => '127.0.0.1'),
  delay: vi.fn(async () => {}),
  database: vi.fn(() => {
    throw new Error('No web credential SQL');
  }),
  hash: vi.fn(() => {
    throw new Error('No web hashing');
  }),
}));
vi.mock('@/app/lib/auth/rate-limiter', () => ({ checkRateLimit: mocks.rate, getClientIp: mocks.ip }));
vi.mock('@/app/lib/auth/password-reset', () => ({ consistentDelay: mocks.delay }));
vi.mock('@/app/lib/db/db', () => ({ getDb: mocks.database }));
vi.mock('bcryptjs', () => ({ default: { hash: mocks.hash }, hash: mocks.hash }));
import { POST } from '../route';
const uuid = '6f1c1f3e-8d7a-4b7e-9a35-3f4a1f0f2b11';
const versioned = `pr1_${'A'.repeat(43)}`;
const submitted = {
  email: ' Stored.Case@Example.test ',
  token: uuid,
  password: ' raw é\u0301 password ',
  confirmPassword: ' raw é\u0301 password ',
};
const proofSecret = 'owned-zone-origin-proof-secret-at-least-32';
const edgeHeaders = { 'X-Forwarded-For': '198.51.100.7, 203.0.113.9, 172.70.1.2', 'CF-Connecting-IP': '203.0.113.9' };
function request(body: unknown = submitted, headers: Record<string, string> = {}, raw = false) {
  return new NextRequest('https://www.boardsesh.test/api/auth/reset-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: 'next-auth.session-token=existing-sibling', ...headers },
    body: raw ? String(body) : JSON.stringify(body),
  });
}
function commandBody(options: RequestInit | undefined): Record<string, unknown> {
  if (typeof options?.body !== 'string') throw new Error('Owned serialized command missing');
  return JSON.parse(options.body) as Record<string, unknown>;
}
function backend(reply: Record<string, unknown> = { outcome: 'reset' }, status = 200) {
  return vi.fn<typeof fetch>(async (_url, options) => {
    const command = commandBody(options) as Record<string, unknown>;
    return Response.json(
      { protocolVersion: 2, operation: command.operation, requestId: command.requestId, ...reply },
      { status },
    );
  });
}
function privacy(response: Response) {
  expect(response.headers.getSetCookie()).toEqual([]);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'legacy');
  vi.stubEnv('CURRENT_STORE_AUTH_BACKEND_ORIGIN', 'https://backend.boardsesh.test');
  vi.stubEnv('CURRENT_STORE_AUTH_RPC_SECRET', 'owned-default-reset-service-secret-32bytes');
  vi.stubEnv('NEXTAUTH_SECRET', 'different-cookie-key');
  vi.stubEnv('NEXTAUTH_URL', 'https://www.boardsesh.test');
  vi.stubEnv('CLOUDFLARE_ORIGIN_PROOF_SECRET', '');
  vi.stubEnv('CLOUDFLARE_ORIGIN_PROOF_NEXT_SECRET', '');
  mocks.rate.mockReturnValue({ limited: false, retryAfterSeconds: 0 });
});
afterEach(() => {
  expect(mocks.database).not.toHaveBeenCalled();
  expect(mocks.hash).not.toHaveBeenCalled();
  expect(mocks.delay).toHaveBeenCalledWith(expect.any(Number), 1500);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe('public reset delegates every default credential mutation', () => {
  it.each([undefined, '', 'legacy'])('uses private reset in default mode %j for UUID and pr1', async (mode) => {
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', mode);
    const send = backend();
    vi.stubGlobal('fetch', send);
    for (const token of [uuid, versioned]) {
      const payload = { ...submitted, token };
      const response = await POST(request(payload));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        message: 'Password reset successful. You can now sign in with your new password.',
      });
      privacy(response);
      const [url, options] = send.mock.calls.at(-1) ?? [];
      expect(url).toBe(`https://backend.boardsesh.test${RECOVERY_COMMAND_PATHS['reset-password']}`);
      expect(commandBody(options)).toMatchObject({ payload });
      expect(new Headers(options?.headers).get('Cookie')).toBeNull();
    }
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('publishes optional reset recognition without a login, freshness claim, or public token', async () => {
    const secret = 'owned-default-reset-device-recognition-key-32bytes';
    const { token } = await mintDeviceToken({ userId: 'reset-owner', secret });
    const send = backend({ outcome: 'reset', deviceToken: token });
    vi.stubGlobal('fetch', send);
    const response = await POST(request());
    expect(response.status).toBe(200);
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toContain('__Host-boardsesh.device=');
    expect(cookies[0]).toContain('HttpOnly');
    expect(cookies[0]).toContain('SameSite=Lax');
    expect(cookies[0]).toContain('Secure');
    expect(cookies[0]).not.toContain('Domain=');
    expect(cookies[0]).not.toMatch(/session|auth_time|viewer/);
    expect(await response.json()).toEqual({
      message: 'Password reset successful. You can now sign in with your new password.',
    });
    expect(await verifyDeviceToken(token, { userId: 'reset-owner', secret })).not.toBeNull();
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  });
  it('keeps staged reset on the qualified existing path', async () => {
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'backend-staging');
    const send = backend();
    vi.stubGlobal('fetch', send);
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(send.mock.calls[0][0]).toBe('https://backend.boardsesh.test/api/internal/auth/current-store/reset-password');
    privacy(response);
  });
  it.each([
    [{ outcome: 'invalid_or_expired' }, 200, 400, 'Invalid or expired reset link'],
    [{ outcome: 'legacy_unbound' }, 503, 503, AUTH_BACKEND_UNAVAILABLE],
    [{ outcome: 'error', code: 'replayed' }, 409, 503, AUTH_BACKEND_UNAVAILABLE],
    [{ outcome: 'error', code: 'validation_error', message: 'Invalid reset token' }, 400, 400, 'Invalid reset token'],
    [
      { outcome: 'error', code: 'rate_limited', retryAfterSeconds: 31 },
      429,
      429,
      'Too many requests. Please try again later.',
    ],
  ] as const)(
    'maps an authoritative reply without exposing private fields',
    async (reply, privateStatus, status, error) => {
      const send = backend(reply, privateStatus);
      vi.stubGlobal('fetch', send);
      const response = await POST(request());
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error });
      if (status === 429) expect(response.headers.get('Retry-After')).toBe('31');
      expect(send).toHaveBeenCalledOnce();
      privacy(response);
    },
  );
  it('forwards malformed payload untouched for backend validation', async () => {
    const send = backend({ outcome: 'error', code: 'validation_error', message: 'Invalid reset token' }, 400);
    vi.stubGlobal('fetch', send);
    const response = await POST(request({ email: false, token: 'x', password: 1, confirmPassword: null }));
    expect(response.status).toBe(400);
    expect(commandBody(send.mock.calls[0][1])).toMatchObject({
      payload: { email: false, token: 'x', password: 1, confirmPassword: null },
    });
    privacy(response);
  });
  it.each(['lost-reply', 'old-backend', 'missing-config'])(
    'preserves sibling cookies on %s without fallback or retry',
    async (failure) => {
      const send = vi.fn<typeof fetch>(async () => {
        if (failure === 'lost-reply') throw new Error('private committed acknowledgement lost');
        return Response.json({ error: 'disabled' }, { status: 404 });
      });
      vi.stubGlobal('fetch', send);
      if (failure === 'missing-config') vi.stubEnv('CURRENT_STORE_AUTH_BACKEND_ORIGIN', '');
      const response = await POST(request());
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: AUTH_BACKEND_UNAVAILABLE });
      expect(send).toHaveBeenCalledTimes(failure === 'missing-config' ? 0 : 1);
      privacy(response);
    },
  );
  it.each(['pr1_short', 'PR1_upper'])('rejects supported malformed capability %s before RPC', async (token) => {
    const send = backend();
    vi.stubGlobal('fetch', send);
    const response = await POST(request({ ...submitted, token }));
    expect(response.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
    privacy(response);
  });
  it.each(['pr2_future', 'PR99_unknown'])('reserves future capability %s as unavailable before RPC', async (token) => {
    const send = backend();
    vi.stubGlobal('fetch', send);
    const response = await POST(request({ ...submitted, token }));
    expect(response.status).toBe(503);
    expect(send).not.toHaveBeenCalled();
    privacy(response);
  });
  it('keeps the default public5/60 bucket and refuses before RPC', async () => {
    mocks.rate.mockReturnValue({ limited: true, retryAfterSeconds: 25 });
    const send = backend();
    vi.stubGlobal('fetch', send);
    const response = await POST(request(submitted, edgeHeaders));
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('25');
    expect(mocks.rate).toHaveBeenCalledWith('reset-password:127.0.0.1', 5, 60000);
    expect(send).not.toHaveBeenCalled();
    privacy(response);
  });
  it('uses the existing trusted public key only in staged mode', async () => {
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'backend-staging');
    mocks.rate.mockReturnValue({ limited: true, retryAfterSeconds: 25 });
    const response = await POST(request(submitted, edgeHeaders));
    expect(response.status).toBe(429);
    expect(mocks.rate).toHaveBeenCalledWith('reset-password:203.0.113.9', 5, 60000);
    privacy(response);
  });
  it.each([false, true])('only zone-vouched origin context enters private metadata, proven=%s', async (proven) => {
    vi.stubEnv('CLOUDFLARE_ORIGIN_PROOF_SECRET', proofSecret);
    const send = backend();
    vi.stubGlobal('fetch', send);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const response = await POST(
      request(
        { ...submitted, clientAddress: '8.8.8.8' },
        { ...edgeHeaders, ...(proven ? { [CLOUDFLARE_ORIGIN_PROOF_HEADER]: proofSecret } : {}) },
      ),
    );
    expect(response.status).toBe(200);
    const command = commandBody(send.mock.calls[0][1]) as Record<string, unknown>;
    if (proven) expect(command.clientAddress).toBe('203.0.113.9');
    else expect(command).not.toHaveProperty('clientAddress');
    expect(command.payload).toMatchObject({ clientAddress: '8.8.8.8' });
    privacy(response);
  });
  it.each(['legacy', 'backend-staging'])('preserves malformedJSON policy and safe diagnostics in %s', async (mode) => {
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', mode);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const send = backend();
    vi.stubGlobal('fetch', send);
    const response = await POST(request('private-password-pr1_secret', {}, true));
    expect(response.status).toBe(mode === 'legacy' ? 500 : 503);
    expect(send).not.toHaveBeenCalled();
    if (mode === 'legacy') expect(errors).toHaveBeenCalledWith('Password reset request failed');
    else expect(errors).not.toHaveBeenCalled();
    expect(JSON.stringify(errors.mock.calls)).not.toContain('private-password');
    privacy(response);
  });
  it('refuses unknown modes before parsing or sending', async () => {
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'unknown');
    const send = backend();
    vi.stubGlobal('fetch', send);
    const response = await POST(request('private malformed', {}, true));
    expect(response.status).toBe(503);
    expect(send).not.toHaveBeenCalled();
    privacy(response);
  });
});
