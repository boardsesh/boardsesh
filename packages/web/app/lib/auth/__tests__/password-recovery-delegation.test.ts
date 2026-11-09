import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { NextRequest } from 'next/server';
import { AUTH_BACKEND_UNAVAILABLE } from '@boardsesh/auth-protocol';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({
  database: vi.fn(() => {
    throw new Error('Legacy database access forbidden');
  }),
  hash: vi.fn(() => {
    throw new Error('Legacy bcrypt forbidden');
  }),
  mail: vi.fn(),
  capture: vi.fn(),
  rate: vi.fn(),
  delay: vi.fn(async () => {}),
}));
vi.mock('@/app/lib/db/db', () => ({ getDb: mocks.database }));
vi.mock('bcryptjs', () => ({ default: { hash: mocks.hash } }));
vi.mock('@boardsesh/email', () => ({ sendPasswordResetEmail: mocks.mail }));
vi.mock('@sentry/nextjs', () => ({ captureException: mocks.capture }));
vi.mock('@/app/lib/auth/rate-limiter', () => ({ checkRateLimit: mocks.rate, getClientIp: () => 'owned-ip' }));
vi.mock('@/app/lib/auth/password-reset', () => ({
  consistentDelay: mocks.delay,
  hashResetToken: vi.fn(),
  getPasswordResetIdentifier: vi.fn(),
}));
import { POST as forgot } from '../../../api/auth/forgot-password/route';
import { POST as reset } from '../../../api/auth/reset-password/route';

const token = `pr1_${'A'.repeat(43)}`;
const email = 'Climber+tag@example.test';
const plan = { kind: 'uid-password-reset-v1', recipient: email, token, expiresAt: '2026-11-05T04:00:00.000Z' };
const submitted = {
  email: 'wrong-hint@example.test',
  token,
  password: 'new-password',
  confirmPassword: 'new-password',
};

function request(operation: 'forgot-password' | 'reset-password', body: unknown, raw = false) {
  return new NextRequest(`https://www.boardsesh.test/api/auth/${operation}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: 'next-auth.session-token=existing-sibling',
      'X-Forwarded-For': '198.51.100.7, 203.0.113.9, 172.70.1.2',
      'CF-Connecting-IP': '203.0.113.9',
    },
    body: raw ? String(body) : JSON.stringify(body),
  });
}
function backend(outcome: Record<string, unknown>, status = 200) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (typeof init?.body !== 'string') throw new Error('Expected serialized command');
    const command = JSON.parse(init.body) as { requestId: string; operation: string; protocolVersion: number };
    expect(command.protocolVersion).toBe(2);
    return Response.json(
      { protocolVersion: 2, requestId: command.requestId, operation: command.operation, ...outcome },
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
  vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'backend-staging');
  vi.stubEnv('CURRENT_STORE_AUTH_BACKEND_ORIGIN', 'https://backend.boardsesh.test');
  vi.stubEnv('CURRENT_STORE_AUTH_RPC_SECRET', 'owned-distinct-recovery-rpc-secret-32bytes');
  vi.stubEnv('NEXTAUTH_SECRET', 'different-cookie-key');
  vi.stubEnv('BASE_URL', 'https://www.boardsesh.test');
  vi.stubEnv('NEXTAUTH_URL', 'https://www.boardsesh.test');
  mocks.rate.mockReturnValue({ limited: false, retryAfterSeconds: 0 });
  mocks.mail.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('actual public recovery routes with strict backend delegation', () => {
  it('sends only the committed mail plan and projects a generic reply without private credentials', async () => {
    const transport = backend({ outcome: 'accepted', mailPlan: plan });
    vi.stubGlobal('fetch', transport);
    const response = await forgot(
      request('forgot-password', { email: 'Submitted@example.test', recipient: 'attacker@example.test' }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      message: 'If an account exists for this email, a reset link will be sent.',
    });
    expect(mocks.mail).toHaveBeenCalledWith(email, token, 'https://www.boardsesh.test');
    expect(transport.mock.calls[0][0]).toBe(
      'https://backend.boardsesh.test/api/internal/auth/current-store/forgot-password',
    );
    expect(mocks.database).not.toHaveBeenCalled();
    privacy(response);
  });
  it('keeps authoritative absence generic without SMTP or legacy SQL', async () => {
    vi.stubGlobal('fetch', backend({ outcome: 'accepted' }));
    const response = await forgot(request('forgot-password', { email }));
    expect(response.status).toBe(200);
    expect(mocks.mail).not.toHaveBeenCalled();
    expect(mocks.database).not.toHaveBeenCalled();
    privacy(response);
  });
  it('keeps delivery failures generic and reports only a new constant error without original cause', async () => {
    vi.stubGlobal('fetch', backend({ outcome: 'accepted', mailPlan: plan }));
    mocks.mail.mockRejectedValue(new Error(`SMTP secret ${token} ${email} password`));
    const response = await forgot(request('forgot-password', { email }));
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain(token);
    expect(mocks.capture).toHaveBeenCalledOnce();
    const error = mocks.capture.mock.calls[0][0] as Error;
    expect(error.message).toBe('Password recovery email delivery failed');
    expect(error.cause).toBeUndefined();
    privacy(response);
  });
  it('validates configured canonical mail origin before any RPC or receipt write', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('BASE_URL', '');
    vi.stubEnv('NEXTAUTH_URL', '');
    const transport = backend({ outcome: 'accepted', mailPlan: plan });
    vi.stubGlobal('fetch', transport);
    const response = await forgot(request('forgot-password', { email }));
    expect(response.status).toBe(503);
    expect(transport).not.toHaveBeenCalled();
    expect(mocks.mail).not.toHaveBeenCalled();
    privacy(response);
  });
  it('preserves the public success contract without credentials or cookies for a wrong email hint', async () => {
    const transport = backend({ outcome: 'reset' });
    vi.stubGlobal('fetch', transport);
    const response = await reset(request('reset-password', submitted));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      message: 'Password reset successful. You can now sign in with your new password.',
    });
    expect(transport.mock.calls[0][0]).toBe(
      'https://backend.boardsesh.test/api/internal/auth/current-store/reset-password',
    );
    expect(mocks.database).not.toHaveBeenCalled();
    expect(mocks.hash).not.toHaveBeenCalled();
    privacy(response);
  });
  it('maps authoritative invalid-or-expired to the released finite400', async () => {
    vi.stubGlobal('fetch', backend({ outcome: 'invalid_or_expired' }));
    const response = await reset(request('reset-password', submitted));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid or expired reset link' });
    privacy(response);
  });
  it('keeps live legacy provenance uncertainty retryable without local consumption', async () => {
    vi.stubGlobal('fetch', backend({ outcome: 'legacy_unbound' }, 503));
    const response = await reset(
      request('reset-password', { ...submitted, token: 'a363934b-b7ba-41ba-a279-52185daa100e' }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: AUTH_BACKEND_UNAVAILABLE });
    expect(mocks.database).not.toHaveBeenCalled();
    privacy(response);
  });
  it.each([forgot, reset])(
    'keeps transport uncertainty unavailable without logs, retry, cookies or fallback',
    async (route) => {
      const transport = vi.fn().mockRejectedValue(new Error(`private ${token} ${email}`));
      vi.stubGlobal('fetch', transport);
      const response = await route(request(route === forgot ? 'forgot-password' : 'reset-password', submitted));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: AUTH_BACKEND_UNAVAILABLE });
      expect(transport).toHaveBeenCalledOnce();
      expect(mocks.database).not.toHaveBeenCalled();
      expect(mocks.capture).not.toHaveBeenCalled();
      privacy(response);
    },
  );
  it.each([forgot, reset])('preserves public rate limit and response floor before any command', async (route) => {
    mocks.rate.mockReturnValue({ limited: true, retryAfterSeconds: 30 });
    const transport = vi.fn();
    vi.stubGlobal('fetch', transport);
    const response = await route(request(route === forgot ? 'forgot-password' : 'reset-password', submitted));
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('30');
    expect(mocks.rate).toHaveBeenCalledWith(
      `${route === forgot ? 'forgot-password' : 'reset-password'}:203.0.113.9`,
      5,
      60_000,
    );
    expect(mocks.delay).toHaveBeenCalledWith(expect.any(Number), 1500);
    expect(transport).not.toHaveBeenCalled();
    expect(response.headers.getSetCookie()).toEqual([]);
  });
  it.each(['pr1_short', 'PR1_upper'])(
    'rejects malformed current namespace %s without calling any writer',
    async (malformed) => {
      const transport = vi.fn();
      vi.stubGlobal('fetch', transport);
      const response = await reset(request('reset-password', { ...submitted, token: malformed }));
      expect(response.status).toBe(400);
      expect(transport).not.toHaveBeenCalled();
      expect(mocks.database).not.toHaveBeenCalled();
      privacy(response);
    },
  );
  it.each([token, 'pr2_future', 'PR99_unknown'])(
    'never sends reserved namespace %s to disabled legacy SQL',
    async (capability) => {
      vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'legacy');
      const transport = vi.fn();
      vi.stubGlobal('fetch', transport);
      const response = await reset(request('reset-password', { ...submitted, token: capability }));
      expect(response.status).toBe(503);
      expect(transport).not.toHaveBeenCalled();
      expect(mocks.database).not.toHaveBeenCalled();
      privacy(response);
    },
  );
  it.each([forgot, reset])(
    'does not forward malformed-body SyntaxError input excerpts into logs or Sentry',
    async (route) => {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      const response = await route(
        request(route === forgot ? 'forgot-password' : 'reset-password', `pr1_secret_password_${email}`, true),
      );
      expect(response.status).toBe(503);
      expect(errorLog).not.toHaveBeenCalled();
      expect(mocks.capture).not.toHaveBeenCalled();
      expect(mocks.database).not.toHaveBeenCalled();
      privacy(response);
    },
  );
  it.each([forgot, reset])(
    'maps unknown active mode to unavailable without parse reflection or fallback',
    async (route) => {
      vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'unknown');
      const response = await route(request(route === forgot ? 'forgot-password' : 'reset-password', submitted));
      expect(response.status).toBe(503);
      expect(mocks.database).not.toHaveBeenCalled();
      privacy(response);
    },
  );
  it.each([forgot, reset])(
    'keeps malformed legacy JSON diagnostics fixed while preserving the released500',
    async (route) => {
      vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'legacy');
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      const response = await route(
        request(route === forgot ? 'forgot-password' : 'reset-password', `pr1_submitted_password_${email}`, true),
      );
      expect(response.status).toBe(500);
      expect(errorLog).toHaveBeenCalledWith(
        route === forgot ? 'Forgot password request failed' : 'Password reset request failed',
      );
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain('pr1_submitted');
      expect(mocks.capture).not.toHaveBeenCalled();
      expect(mocks.database).not.toHaveBeenCalled();
      privacy(response);
    },
  );
});
