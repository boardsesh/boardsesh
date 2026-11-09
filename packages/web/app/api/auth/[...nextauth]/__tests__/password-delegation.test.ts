// @vitest-environment node
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { decode } from 'next-auth/jwt';
vi.mock('server-only', () => ({}));
const { legacyAuthorize, legacySignIn } = vi.hoisted(() => ({ legacyAuthorize: vi.fn(), legacySignIn: vi.fn() }));
vi.mock('@/app/lib/auth/auth-options', async () => {
  const { default: CredentialsProvider } = await import('next-auth/providers/credentials');
  return {
    authOptions: {
      secret: 'owned-nextauth-fixture-secret',
      session: { strategy: 'jwt' },
      providers: [CredentialsProvider({ credentials: { email: {}, password: {} }, authorize: legacyAuthorize })],
      callbacks: { signIn: legacySignIn },
      logger: { error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    },
  };
});
import { GET, POST } from '../route';

// Replace only Next's ambient request I/O. The public NextAuth App Router handler,
// CSRF checks, callbacks, JWT encoder, cookie assembly, and our HTTP wrapper run.
const requestStorage = new AsyncLocalStorage<NextRequest>();
const require = createRequire(import.meta.url);
const nextIo = require('next/headers') as {
  headers: () => Promise<Headers>;
  cookies: () => Promise<{ getAll: () => { name: string; value: string }[] }>;
};
const secret = 'owned-nextauth-fixture-secret';
const rpcSecret = 'dedicated-rpc-test-server-secret-at-least-32';
const baseUrl = 'http://localhost:3000';
const selected = { id: 'backend-selected', email: 'Duplicate@example.com', name: 'Climber', image: null };
let cookies: Map<string, string>;
let csrfToken: string;
let clientAddress: string;
let nextClientOctet = 1;

function remember(response: Response) {
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(';');
    const separator = pair.indexOf('=');
    cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
}
async function invoke(
  path: string,
  form?: Record<string, string>,
  parameters = path.split('/'),
  forwardedFor = clientAddress,
) {
  const request = new NextRequest(`${baseUrl}/api/auth/${path}`, {
    method: form ? 'POST' : 'GET',
    headers: {
      Cookie: [...cookies].map(([name, cookie]) => `${name}=${cookie}`).join('; '),
      'X-Forwarded-For': forwardedFor,
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(form ? { body: new URLSearchParams(form) } : {}),
  });
  const context = { params: Promise.resolve({ nextauth: parameters }) };
  return requestStorage.run(request, () => (form ? POST(request, context) : GET(request, context)));
}
async function password(forwardedFor = clientAddress) {
  return invoke(
    'callback/credentials',
    {
      email: selected.email,
      password: 'submitted-password',
      csrfToken,
      json: 'true',
      callbackUrl: baseUrl,
    },
    ['callback', 'credentials'],
    forwardedFor,
  );
}
function backendResponse(
  options: { verified?: boolean; outcome?: string; status?: number; privateField?: boolean } = {},
) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (typeof init?.body !== 'string') throw new Error('Expected serialized command');
    const command = JSON.parse(init.body) as { requestId: string };
    const body =
      options.outcome === 'invalid_credentials'
        ? { protocolVersion: 2, operation: 'password', requestId: command.requestId, outcome: 'invalid_credentials' }
        : {
            protocolVersion: 2,
            operation: 'password',
            requestId: command.requestId,
            outcome: 'authenticated',
            user: selected,
            verification: { userId: selected.id, required: true, verified: options.verified ?? true },
            ...(options.privateField ? { mailPlan: { token: 'private' } } : {}),
          };
    return Response.json(body, { status: options.status ?? 200 });
  });
}
beforeAll(() => {
  vi.spyOn(nextIo, 'headers').mockImplementation(async () => requestStorage.getStore()?.headers ?? new Headers());
  vi.spyOn(nextIo, 'cookies').mockImplementation(async () => ({
    getAll: () => requestStorage.getStore()?.cookies.getAll() ?? [],
  }));
});
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'backend-staging');
  vi.stubEnv('CURRENT_STORE_AUTH_BACKEND_ORIGIN', 'http://127.0.0.1:54321');
  vi.stubEnv('CURRENT_STORE_AUTH_RPC_SECRET', rpcSecret);
  vi.stubEnv('NEXTAUTH_URL', baseUrl);
  vi.stubEnv('NEXTAUTH_SECRET', secret);
  vi.stubEnv('AUTH_COOKIE_DOMAIN', '');
  vi.stubEnv('VERCEL_ENV', '');
  // A distinct address per case keeps the real per-client login limit in play.
  clientAddress = `198.51.100.${nextClientOctet++}`;
  cookies = new Map();
  const response = await invoke('csrf');
  remember(response);
  csrfToken = ((await response.json()) as { csrfToken: string }).csrfToken;
  expect(csrfToken).toBeTruthy();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterAll(() => vi.restoreAllMocks());

describe('public NextAuth App Router password delegation', () => {
  it('issues a real NextAuth cookie for the backend-selected UID without local authorize or verification lookup', async () => {
    const fetchMock = backendResponse();
    vi.stubGlobal('fetch', fetchMock);
    const response = await password();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: baseUrl });
    remember(response);
    const jwt = await decode({ token: cookies.get('next-auth.session-token'), secret });
    expect(jwt?.sub).toBe(selected.id);
    expect(jwt).not.toHaveProperty('verification');
    expect(jwt).not.toHaveProperty('mailPlan');
    expect(legacyAuthorize).not.toHaveBeenCalled();
    expect(legacySignIn).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('uses the UID-bound unverified verdict and emits no login cookie', async () => {
    vi.stubGlobal('fetch', backendResponse({ verified: false }));
    const response = await password();
    expect(((await response.json()) as { url: string }).url).toContain('/auth/verify-request?error=EmailNotVerified');
    expect(response.headers.getSetCookie().some((cookie) => cookie.startsWith('next-auth.session-token='))).toBe(false);
    expect(legacySignIn).not.toHaveBeenCalled();
  });
  it('preserves an existing encrypted login on backend failure with a real 503 and allowlisted JSON error URL', async () => {
    vi.stubGlobal('fetch', backendResponse());
    remember(await password());
    const previous = cookies.get('next-auth.session-token');
    expect(previous).toBeTruthy();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private-password-secret-url')));
    const response = await password();
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await response.json()).toEqual({ url: `${baseUrl}/auth/error?error=AuthBackendUnavailable` });
    expect(cookies.get('next-auth.session-token')).toBe(previous);
    expect((await decode({ token: previous, secret }))?.sub).toBe(selected.id);
    expect(legacyAuthorize).not.toHaveBeenCalled();
  });
  it('distinguishes wrong password from transport failure without retries', async () => {
    const fetchMock = backendResponse({ outcome: 'invalid_credentials' });
    vi.stubGlobal('fetch', fetchMock);
    const response = await password();
    expect(response.status).toBe(401);
    expect(((await response.json()) as { url: string }).url).toContain('error=CredentialsSignin');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(response.headers.getSetCookie().some((cookie) => cookie.includes('session-token='))).toBe(false);
  });
  it('fails closed on status/schema mismatch and never publishes private fields', async () => {
    vi.stubGlobal('fetch', backendResponse({ privateField: true }));
    const response = await password();
    expect(response.status).toBe(503);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await response.text()).not.toContain('private');
  });
  it('retains real CSRF enforcement before invoking the backend', async () => {
    const fetchMock = backendResponse();
    vi.stubGlobal('fetch', fetchMock);
    csrfToken = 'invalid';
    const response = await password();
    expect(((await response.json()) as { url: string }).url).toContain('csrf=true');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([
    ['callback/credentials/extra', ['callback', 'credentials', 'extra']],
    ['callback/%63redentials', ['callback', 'credentials']],
    ['signin/google', ['callback', 'credentials']],
  ])('guards context-selected credentials at %s exactly as NextAuth does', async (path, parameters) => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('unavailable'));
    vi.stubGlobal('fetch', fetchMock);
    const response = await invoke(path, { email: 'x', password: 'y', csrfToken, json: 'true' }, parameters);
    expect(response.status).toBe(503);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(legacyAuthorize).not.toHaveBeenCalled();
  });
  it.each([
    ['signout/extra', ['signout', 'extra']],
    ['%73ignout', ['signout']],
    ['callback/google', ['signout']],
  ])('keeps context-selected signout guarded at %s', async (path, parameters) => {
    const response = await invoke(path, { csrfToken, json: 'true' }, parameters);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'signout_identity_required' });
    expect(response.headers.getSetCookie()).toEqual([]);
  });
  it('stops one client before the backend while another client keeps signing in', async () => {
    const fetchMock = backendResponse({ outcome: 'invalid_credentials' });
    vi.stubGlobal('fetch', fetchMock);
    for (let attempt = 0; attempt < 10; attempt += 1) expect((await password()).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(10);

    // A forged first hop cannot buy a fresh bucket: the ingress appends the real one last.
    const limited = await password(`203.0.113.77, ${clientAddress}`);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(limited.headers.get('Cache-Control')).toBe('private, no-store');
    expect(limited.headers.getSetCookie()).toEqual([]);
    expect(await limited.json()).toEqual({ url: `${baseUrl}/auth/error?error=AuthBackendUnavailable` });
    expect(fetchMock).toHaveBeenCalledTimes(10);

    expect((await password('198.51.100.250')).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(11);
    expect(legacyAuthorize).not.toHaveBeenCalled();
  });
  it('puts no per-client limit on legacy sign-in', async () => {
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'legacy');
    legacyAuthorize.mockResolvedValue({ id: 'legacy-user', email: 'legacy@example.com' });
    legacySignIn.mockResolvedValue(true);
    vi.stubGlobal('fetch', vi.fn());
    for (let attempt = 0; attempt < 12; attempt += 1) expect((await password()).status).toBe(200);
    expect(legacyAuthorize).toHaveBeenCalledTimes(12);
  });
  it('uses the exact original credentials path in legacy mode without RPC configuration', async () => {
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'legacy');
    vi.stubEnv('CURRENT_STORE_AUTH_RPC_SECRET', '');
    legacyAuthorize.mockResolvedValue({ id: 'legacy-user', email: 'legacy@example.com' });
    legacySignIn.mockResolvedValue(true);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = await password();
    expect(response.status).toBe(200);
    remember(response);
    expect((await decode({ token: cookies.get('next-auth.session-token'), secret }))?.sub).toBe('legacy-user');
    expect(legacyAuthorize).toHaveBeenCalledOnce();
    expect(legacySignIn).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// These tests isolate the existing dispatch/password contract; admission has
// its own public-codec and mounted-handler publication coverage.
vi.mock('@/app/lib/auth/auth-response-admission.server', () => ({
  withAuthResponseAdmission: (_request: unknown, _context: unknown, invoke: () => Promise<Response>) => invoke(),
}));
