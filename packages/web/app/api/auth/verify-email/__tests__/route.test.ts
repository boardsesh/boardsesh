// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { AUTH_PROTOCOL_VERSION, type VerifyEmailReply } from '@boardsesh/auth-protocol';
import { loadServerResources } from '@/app/lib/i18n/server';
import { SUPPORTED_LOCALES } from '@/app/lib/i18n/config';
vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  limit: vi.fn(),
  transaction: vi.fn(),
  updateWhere: vi.fn(),
  deleteWhere: vi.fn(),
  rate: vi.fn(),
}));
vi.mock('@/app/lib/auth/rate-limiter', () => ({ checkRateLimit: mocks.rate, getClientIp: () => '127.0.0.1' }));
vi.mock('@/app/lib/db/db', () => ({
  getDb: () => {
    mocks.getDb();
    return {
      select: () => ({ from: () => ({ where: () => ({ limit: mocks.limit }) }) }),
      delete: () => ({ where: mocks.deleteWhere }),
      transaction: mocks.transaction,
    };
  },
}));
const lookup = vi.hoisted(() => ({ stored: [] as StoredAccount[] }));
vi.mock('@boardsesh/db/queries/account-email', async () => {
  const { fakeAccountEmailLookup } = await import('@/app/test-utils/account-email-lookup');
  return fakeAccountEmailLookup(() => lookup.stored);
});
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { StoredAccount } from '@/app/test-utils/account-email-lookup';
import { GET } from '../route';

const token = `ev1_${'A'.repeat(43)}`;
const legacyToken = 'a363934b-b7ba-41ba-a279-52185daa100e';
const email = 'Climber+tag@example.com';
const origin = 'https://www.boardsesh.test';

function request(
  presentedToken: string | null = token,
  presentedEmail: string | null = email,
  locale = 'en-US',
  requestOrigin = origin,
) {
  const url = new URL('/api/auth/verify-email', requestOrigin);
  if (presentedToken !== null) url.searchParams.set('token', presentedToken);
  if (presentedEmail !== null) url.searchParams.set('email', presentedEmail);
  return new NextRequest(url, {
    headers: { Cookie: `next-auth.session-token=existing-login; boardsesh-locale=${encodeURIComponent(locale)}` },
  });
}
function backend(
  outcome: Exclude<VerifyEmailReply['outcome'], 'error'>,
  status = outcome === 'legacy_unbound' ? 503 : 200,
) {
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    if (typeof init.body !== 'string') throw new Error('Expected serialized command');
    const command = JSON.parse(init.body) as { requestId: string };
    return Response.json(
      { protocolVersion: AUTH_PROTOCOL_VERSION, operation: 'verify-email', requestId: command.requestId, outcome },
      { status },
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
function privacy(response: Response) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('CDN-Cache-Control')).toBe('no-store');
  expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store');
  expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  expect(response.headers.get('X-Robots-Tag')).toBe('noindex, follow');
  expect(response.headers.getSetCookie()).toEqual([]);
  expect(response.headers.has('Refresh')).toBe(false);
}
async function unavailable(response: Response) {
  expect(response.status).toBe(503);
  privacy(response);
  expect(response.headers.get('Location')).toBeNull();
  expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
  expect(response.headers.get('Retry-After')).toBe('30');
  const body = await response.text();
  expect(body).toContain('30');
  for (const privateText of [token, legacyToken, email, 'AuthBackendUnavailable', 'http', '<script', '<html']) {
    expect(body).not.toContain(privateText);
  }
  expect(mocks.getDb).not.toHaveBeenCalled();
  return body;
}

beforeEach(() => {
  vi.clearAllMocks();
  lookup.stored = [{ id: 'legacy-owner', email }];
  vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'backend-staging');
  vi.stubEnv('CURRENT_STORE_AUTH_BACKEND_ORIGIN', 'http://127.0.0.1:54321');
  vi.stubEnv('CURRENT_STORE_AUTH_RPC_SECRET', 'dedicated-verification-fixture-secret-32bytes');
  vi.stubEnv('NEXTAUTH_URL', '');
  vi.stubEnv('BASE_URL', '');
  mocks.rate.mockReturnValue({ limited: false, retryAfterSeconds: 0 });
  mocks.deleteWhere.mockResolvedValue(undefined);
  mocks.updateWhere.mockResolvedValue(undefined);
  mocks.transaction.mockImplementation(async (callback: (transaction: unknown) => Promise<void>) =>
    callback({
      update: () => ({ set: () => ({ where: mocks.updateWhere }) }),
      delete: () => ({ where: mocks.deleteWhere }),
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('verification limiter key', () => {
  const edgeRequest = () =>
    new NextRequest(`${origin}/api/auth/verify-email?token=${legacyToken}&email=${encodeURIComponent(email)}`, {
      headers: { 'X-Forwarded-For': '198.51.100.7, 203.0.113.9, 172.70.1.2', 'CF-Connecting-IP': '203.0.113.9' },
    });
  it('keys the staged limiter on the trusted client, not the first forwarded hop', async () => {
    mocks.rate.mockReturnValue({ limited: true, retryAfterSeconds: 30 });
    const response = await GET(edgeRequest());
    expect(response.headers.get('Location')).toContain('error=TooManyAttempts');
    expect(mocks.rate).toHaveBeenCalledWith('verify-email:203.0.113.9', 20, 60_000);
  });
  it('keeps the legacy limiter key when staged auth is off', async () => {
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'legacy');
    mocks.rate.mockReturnValue({ limited: true, retryAfterSeconds: 30 });
    const response = await GET(edgeRequest());
    expect(response.headers.get('Location')).toContain('error=TooManyAttempts');
    expect(mocks.rate).toHaveBeenCalledWith('verify-email:127.0.0.1', 20, 60_000);
  });
});

describe('UID verification public reader', () => {
  it.each(SUPPORTED_LOCALES)('renders the real %s catalog as a retryable503 at the original URL', async (locale) => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('private transport details'));
    vi.stubGlobal('fetch', fetchMock);
    const original = request(token, email, locale);
    const response = await GET(original);
    const text = await unavailable(response);
    const resources = await loadServerResources(locale, ['auth']);
    const verification = resources.auth.verifyRequest as { retryUnavailable: string };
    expect(text.trim()).toBe(verification.retryUnavailable);
    expect(response.headers.get('Content-Language')).toBe(locale);
    expect(original.nextUrl.searchParams.get('token')).toBe(token);
    expect(original.cookies.get('next-auth.session-token')?.value).toBe('existing-login');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('uses English for an unsupported locale instead of loading a caller-selected catalog path', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unavailable')));
    const response = await GET(request(token, email, '../../private'));
    expect(await unavailable(response)).toContain('refresh this page or reopen the same verification link');
    expect(response.headers.get('Content-Language')).toBe('en-US');
  });
  it.each(['legacy', ''] as const)('keeps versioned receipts out of disabled local SQL in mode %j', async (mode) => {
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', mode);
    vi.stubEnv('CURRENT_STORE_AUTH_RPC_SECRET', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await unavailable(await GET(request()));
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(['ev2_future', 'EV1_future', 'ev9999_future', 'ev1_malformed'])(
    'recognizes reserved namespace %s before disabled dispatch',
    async (presentedToken) => {
      vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'legacy');
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      await unavailable(await GET(request(presentedToken)));
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it.each(['ev2_future', 'EV1_future'])(
    'keeps active unknown versions %s retryable instead of falling back',
    async (presentedToken) => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      await unavailable(await GET(request(presentedToken)));
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it.each([null, 'Other@example.com', 'x'.repeat(12_000)])(
    'ignores the new token email hint instead of selecting an owner from it',
    async (hint) => {
      const fetchMock = backend('verified');
      const response = await GET(request(token, hint));
      expect(response.status).toBe(307);
      privacy(response);
      expect(response.headers.get('Location')).toBe(`${origin}/auth/login?verified=true`);
      expect(mocks.getDb).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://127.0.0.1:54321/api/internal/auth/current-store/verify-email');
      if (typeof init.body !== 'string') throw new Error('Expected serialized command');
      expect(JSON.parse(init.body)).toMatchObject({
        protocolVersion: 2,
        operation: 'verify-email',
        payload: { token },
      });
      expect(Object.keys((JSON.parse(init.body) as { payload: object }).payload)).toEqual(['token']);
    },
  );
  it.each([
    ['verified', '/auth/login?verified=true'],
    ['invalid_token', '/auth/verify-request?error=InvalidToken'],
    ['expired', '/auth/verify-request?error=TokenExpired'],
  ] as const)('maps %s to the original finite307 without carrying credentials', async (outcome, target) => {
    backend(outcome);
    const response = await GET(request());
    expect(response.status).toBe(307);
    privacy(response);
    expect(response.headers.get('Location')).toBe(`${origin}${target}`);
    expect(response.headers.get('Location')).not.toContain(token);
  });
  it('retains a live unbound legacy link and sends its exact hint solely to the backend classifier', async () => {
    const fetchMock = backend('legacy_unbound');
    await unavailable(await GET(request(legacyToken)));
    const init = fetchMock.mock.calls[0][1];
    if (typeof init.body !== 'string') throw new Error('Expected serialized command');
    expect((JSON.parse(init.body) as { payload: unknown }).payload).toEqual({ token: legacyToken, email });
  });
  it('does not call unsupported historical syntax invalid solely because it exceeds the DTO token bound', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await unavailable(await GET(request('a'.repeat(257))));
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(['legacy', 'backend-staging'])(
    'preserves non-verification namespaces before any SQL in mode%s',
    async (mode) => {
      vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', mode);
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      for (const identifier of [
        'ba03-web-auth:hash',
        'password-reset:climber@example.com',
        'ba03-flow:proof',
        'ba03-lineage:proof',
      ]) {
        const response = await GET(request(legacyToken, identifier));
        expect(response.status).toBe(307);
        privacy(response);
        expect(response.headers.get('Location')).toBe(`${origin}/auth/verify-request?error=InvalidToken`);
      }
      expect(mocks.getDb).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  describe('redirecting from the standalone server, whose request URL is its bind address', () => {
    const configuredSite = 'https://site.boardsesh.test';
    const bindOrigin = 'https://0.0.0.0:3000';

    it('sends a staged verification to the configured site', async () => {
      vi.stubEnv('NEXTAUTH_URL', configuredSite);
      backend('verified');
      const response = await GET(request(token, email, 'en-US', bindOrigin));
      expect(response.headers.get('Location')).toBe(`${configuredSite}/auth/login?verified=true`);
    });

    it('sends a legacy verification to the configured site', async () => {
      vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'legacy');
      vi.stubEnv('NEXTAUTH_URL', configuredSite);
      mocks.limit.mockResolvedValueOnce([{ expires: new Date(Date.now() + 60_000) }]);
      const response = await GET(request(legacyToken, email, 'en-US', bindOrigin));
      expect(response.status).toBe(307);
      privacy(response);
      expect(response.headers.get('Location')).toBe(`${configuredSite}/auth/login?verified=true`);
    });

    it('keeps the request origin when no site is configured', async () => {
      backend('verified');
      const response = await GET(request(token, email, 'en-US', 'http://localhost:3095'));
      expect(response.headers.get('Location')).toBe('http://localhost:3095/auth/login?verified=true');
    });
  });
  it('keeps the exact unversioned legacy reader in default-off mode', async () => {
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'legacy');
    mocks.limit.mockResolvedValueOnce([{ expires: new Date(Date.now() + 60_000) }]);
    const response = await GET(request(legacyToken));
    expect(response.status).toBe(307);
    privacy(response);
    expect(response.headers.get('Location')).toBe(`${origin}/auth/login?verified=true`);
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.updateWhere).toHaveBeenCalledOnce();
    expect(mocks.deleteWhere).toHaveBeenCalledOnce();
  });
  describe('legacy links in any capitalisation (BA-02)', () => {
    const verifiedUserIds = () =>
      mocks.updateWhere.mock.calls.map(([condition]) => new PgDialect().sqlToQuery(condition as SQL).params);
    const live = () => mocks.limit.mockResolvedValueOnce([{ expires: new Date(Date.now() + 60_000) }]);

    beforeEach(() => {
      vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'legacy');
    });

    it.each([
      ['exactly as stored', 'Mixed.Case@Example.test'],
      ['in lowercase', 'mixed.case@example.test'],
    ])('verifies only the mixed-case account when the link carries its address %s', async (_case, linkEmail) => {
      lookup.stored = [{ id: 'mixed', email: 'Mixed.Case@Example.test' }];
      live();
      const response = await GET(request(legacyToken, linkEmail));
      expect(response.headers.get('Location')).toBe(`${origin}/auth/login?verified=true`);
      expect(verifiedUserIds()).toEqual([['mixed']]);
    });

    it('verifies the group member the link names exactly, never its sibling', async () => {
      lookup.stored = [
        { id: 'mixed', email: 'Mixed.Case@Example.test' },
        { id: 'sibling', email: 'mixed.case@example.test' },
      ];
      live();
      await GET(request(legacyToken, 'Mixed.Case@Example.test'));
      expect(verifiedUserIds()).toEqual([['mixed']]);
    });

    it('refuses an address several accounts share in other capitals and keeps the link', async () => {
      lookup.stored = [
        { id: 'mixed', email: 'Mixed.Case@Example.test' },
        { id: 'sibling', email: 'mixed.case@example.test' },
      ];
      live();
      const response = await GET(request(legacyToken, 'MIXED.CASE@EXAMPLE.TEST'));
      expect(response.headers.get('Location')).toBe(`${origin}/auth/verify-request?error=InvalidToken`);
      expect(mocks.transaction).not.toHaveBeenCalled();
      expect(mocks.deleteWhere).not.toHaveBeenCalled();
    });

    it('refuses two accounts storing the same text instead of verifying both', async () => {
      lookup.stored = [
        { id: 'twin-a', email: 'twin@example.test' },
        { id: 'twin-b', email: 'twin@example.test' },
      ];
      live();
      const response = await GET(request(legacyToken, 'twin@example.test'));
      expect(response.headers.get('Location')).toBe(`${origin}/auth/verify-request?error=InvalidToken`);
      expect(mocks.updateWhere).not.toHaveBeenCalled();
    });

    it('still cleans up a link whose address no account has', async () => {
      lookup.stored = [];
      live();
      const response = await GET(request(legacyToken, 'gone@example.test'));
      expect(response.headers.get('Location')).toBe(`${origin}/auth/verify-request?error=InvalidToken`);
      expect(mocks.deleteWhere).toHaveBeenCalledOnce();
      expect(mocks.transaction).not.toHaveBeenCalled();
    });
  });
  it('rejects a malformed supported token before RPC and applies the existing local attempt limit', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    let response = await GET(request('ev1_bad'));
    expect(response.headers.get('Location')).toBe(`${origin}/auth/verify-request?error=InvalidToken`);
    privacy(response);
    mocks.rate.mockReturnValue({ limited: true, retryAfterSeconds: 20 });
    response = await GET(request());
    expect(response.headers.get('Location')).toBe(`${origin}/auth/verify-request?error=TooManyAttempts`);
    privacy(response);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.getDb).not.toHaveBeenCalled();
  });
  it.each([401, 404, 500])('returns same-URL503 when the private service returns%d', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ error: 'disabled' }, { status }));
    vi.stubGlobal('fetch', fetchMock);
    await unavailable(await GET(request()));
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('rejects a v1 tagged reply even when its verdict and status look successful', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        if (typeof init.body !== 'string') throw new Error('Expected serialized command');
        const body = JSON.parse(init.body) as { requestId: string };
        return Response.json({ operation: 'verify-email', requestId: body.requestId, outcome: 'verified' });
      }),
    );
    await unavailable(await GET(request()));
  });
  it('allows a deliberate same-link retry after recovery without auto-retrying or changing its login cookie', async () => {
    const failed = vi.fn().mockRejectedValue(new Error('unavailable'));
    vi.stubGlobal('fetch', failed);
    const original = request();
    await unavailable(await GET(original));
    expect(failed).toHaveBeenCalledOnce();
    const recovered = backend('verified');
    const response = await GET(original);
    expect(response.status).toBe(307);
    privacy(response);
    expect(recovered).toHaveBeenCalledOnce();
    expect(response.headers.get('Location')).toBe(`${origin}/auth/login?verified=true`);
    expect(original.cookies.get('next-auth.session-token')?.value).toBe('existing-login');
  });
});
