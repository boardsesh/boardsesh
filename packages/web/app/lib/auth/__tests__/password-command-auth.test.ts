// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import CredentialsProvider from 'next-auth/providers/credentials';
import { createPasswordCommandClient } from '../password-command-client.server';
import type { NextAuthOptions } from 'next-auth';
import type { PasswordReply } from '@boardsesh/auth-protocol';
vi.mock('server-only', () => ({}));
import {
  admitPasswordLogin,
  createPasswordCommandAuthRequest,
  unavailablePasswordAuthResponse,
} from '../password-command-auth.server';

const reply: Extract<PasswordReply, { outcome: 'authenticated' }> = {
  protocolVersion: 2,
  operation: 'password',
  requestId: 'e363934b-b7ba-41ba-a279-52185daa100e',
  outcome: 'authenticated',
  user: { id: 'selected', email: 'duplicate@example.com', name: null, image: null },
  verification: { userId: 'selected', required: true, verified: false },
};
function base() {
  return {
    providers: [
      CredentialsProvider({ id: 'native-oauth', credentials: {}, authorize: async () => ({ id: 'native' }) }),
      CredentialsProvider({ credentials: {}, authorize: async () => ({ id: 'local-fallback' }) }),
    ],
    callbacks: { signIn: vi.fn(async () => true) },
  } satisfies NextAuthOptions;
}
function provider(options: NextAuthOptions) {
  const configured = options.providers.find((entry) => (entry.options?.id ?? entry.id) === 'credentials');
  if (!configured || configured.type !== 'credentials') throw new Error('Missing credentials provider');
  return { ...configured, ...configured.options };
}
function parameters(userId: string) {
  return {
    user: { id: userId },
    account: { provider: 'credentials', type: 'credentials' as const, providerAccountId: userId },
    credentials: {},
  };
}
afterEach(() => vi.unstubAllEnvs());

describe('request-local backend password verdict', () => {
  it('keeps the legacy authorize and every other option, and needs no transport configuration when disabled', async () => {
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'legacy');
    const original = base();
    const factory = vi.fn();
    const scoped = createPasswordCommandAuthRequest(original, factory);
    expect(scoped.options.providers[0]).toBe(original.providers[0]);
    expect(scoped.options.callbacks).toBe(original.callbacks);
    await expect(provider(scoped.options).authorize({ email: 'x', password: 'y' }, { headers: {} })).resolves.toEqual({
      id: 'local-fallback',
    });
    expect(factory).not.toHaveBeenCalled();
  });
  it('reports a password legacy authorize accepts, and not one it rejects', async () => {
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'legacy');
    const accepted = vi.fn();
    await provider(createPasswordCommandAuthRequest(base(), undefined, accepted).options).authorize(
      { email: 'x', password: 'right' },
      { headers: {} },
    );
    expect(accepted).toHaveBeenCalledOnce();

    const rejecting = {
      ...base(),
      providers: [CredentialsProvider({ credentials: {}, authorize: async () => null })],
    } satisfies NextAuthOptions;
    accepted.mockClear();
    await expect(
      provider(createPasswordCommandAuthRequest(rejecting, undefined, accepted).options).authorize(
        { email: 'x', password: 'wrong' },
        { headers: {} },
      ),
    ).resolves.toBeNull();
    expect(accepted).not.toHaveBeenCalled();
  });
  it('reports a password the backend accepts, and not one it rejects', async () => {
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'backend-staging');
    const accepted = vi.fn();
    const scoped = createPasswordCommandAuthRequest(
      base(),
      () => ({ password: async () => reply, register: vi.fn() }),
      accepted,
    );
    await provider(scoped.options).authorize({ email: reply.user.email, password: 'x' }, { headers: {} });
    expect(accepted).toHaveBeenCalledOnce();

    accepted.mockClear();
    const denied = createPasswordCommandAuthRequest(
      base(),
      () => ({
        password: async () => ({
          protocolVersion: 2 as const,
          operation: 'password' as const,
          requestId: reply.requestId,
          outcome: 'invalid_credentials' as const,
        }),
        register: vi.fn(),
      }),
      accepted,
    );
    await provider(denied.options).authorize({ email: 'x', password: 'y' }, { headers: {} });
    expect(accepted).not.toHaveBeenCalled();
  });
  it('preserves the actual custom native provider and replaces exactly one effective credentials ID', () => {
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'backend-staging');
    const original = base();
    const scoped = createPasswordCommandAuthRequest(original);
    expect(scoped.options.providers[0]).toBe(original.providers[0]);
    expect(scoped.options.providers[1]).not.toBe(original.providers[1]);
    expect(scoped.options.providers.filter((entry) => (entry.options?.id ?? entry.id) === 'credentials')).toHaveLength(
      1,
    );
  });
  it('uses selected UID verification and never calls the legacy signIn lookup', async () => {
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'backend-staging');
    const original = base();
    const scoped = createPasswordCommandAuthRequest(original, () => ({
      password: async () => reply,
      register: vi.fn(),
    }));
    await expect(
      provider(scoped.options).authorize({ email: 'duplicate@example.com', password: 'x' }, { headers: {} }),
    ).resolves.toEqual(reply.user);
    await expect(scoped.options.callbacks?.signIn?.(parameters('selected'))).resolves.toBe(
      '/auth/verify-request?error=EmailNotVerified',
    );
    expect(original.callbacks.signIn).not.toHaveBeenCalled();
  });
  it('does not leak a successful verdict into an independent request for the same email', async () => {
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'backend-staging');
    const first = createPasswordCommandAuthRequest(base(), () => ({
      password: async () => ({ ...reply, verification: { ...reply.verification, verified: true } }),
      register: vi.fn(),
    }));
    const second = createPasswordCommandAuthRequest(base(), () => ({ password: async () => reply, register: vi.fn() }));
    await provider(first.options).authorize({ email: reply.user.email, password: 'x' }, { headers: {} });
    await provider(second.options).authorize({ email: reply.user.email, password: 'x' }, { headers: {} });
    await expect(first.options.callbacks?.signIn?.(parameters('selected'))).resolves.toBe(true);
    await expect(second.options.callbacks?.signIn?.(parameters('selected'))).resolves.toBe(
      '/auth/verify-request?error=EmailNotVerified',
    );
  });
  it('rejects a signIn callback for another UID without a legacy fallback', async () => {
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'backend-staging');
    const scoped = createPasswordCommandAuthRequest(base(), () => ({ password: async () => reply, register: vi.fn() }));
    await provider(scoped.options).authorize({ email: reply.user.email, password: 'x' }, { headers: {} });
    await expect(scoped.options.callbacks?.signIn?.(parameters('another'))).rejects.toThrow('AuthBackendUnavailable');
    expect(scoped.unavailable()).toBe(true);
  });
  it('only maps the explicit invalid_credentials verdict to authorize null', async () => {
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'backend-staging');
    const denied = createPasswordCommandAuthRequest(base(), () => ({
      password: async () => ({
        protocolVersion: 2,
        operation: 'password',
        requestId: reply.requestId,
        outcome: 'invalid_credentials',
      }),
      register: vi.fn(),
    }));
    await expect(
      provider(denied.options).authorize({ email: 'x', password: 'y' }, { headers: {} }),
    ).resolves.toBeNull();
    expect(denied.unavailable()).toBe(false);
    const unavailable = createPasswordCommandAuthRequest(base(), () => ({
      password: async () => ({
        protocolVersion: 2,
        operation: 'password',
        requestId: reply.requestId,
        outcome: 'error',
        code: 'replayed',
      }),
      register: vi.fn(),
    }));
    await expect(
      provider(unavailable.options).authorize({ email: 'x', password: 'y' }, { headers: {} }),
    ).rejects.toThrow('AuthBackendUnavailable');
    expect(unavailable.unavailable()).toBe(true);
  });
});

describe('a login that asks for a first-party web session (#7596)', () => {
  const session = { sessionId: 'session-1', token: 'token-1', expiresAt: '2026-12-18T00:00:00.000Z', generation: 3 };
  const proof = {
    version: 1 as const,
    userId: 'selected',
    authSessionId: 'session-1',
    generation: 3,
    authenticatedAt: '2026-11-18T00:00:00.000Z',
    linkGuarded: true,
  };
  const verified = { userId: 'selected', required: false, verified: true };
  const presented = { kind: 'canonical-token' as const, token: 'previous-token' };

  async function loginWith(answer: PasswordReply) {
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'backend-staging');
    const password = vi.fn(async () => answer);
    const scoped = createPasswordCommandAuthRequest(base(), () => ({ password, register: vi.fn() }), undefined, null, {
      webSession: { presented },
    });
    await provider(scoped.options)
      .authorize({ email: reply.user.email, password: 'x' }, { headers: {} })
      .catch(() => null);
    return { scoped, password };
  }

  it('sends the presented session and keeps the issued one', async () => {
    const { scoped, password } = await loginWith({
      ...reply,
      verification: verified,
      credentialProof: proof,
      webSession: session,
    });
    expect(password).toHaveBeenCalledWith(reply.user.email, 'x', undefined, { webSession: { presented } });
    await expect(scoped.options.callbacks?.signIn?.(parameters('selected'))).resolves.toBe(true);
    expect(scoped.unavailable()).toBe(false);
    expect(scoped.issuedWebSession()).toEqual(session);
  });

  it.each([
    ['no session', { verification: verified, credentialProof: proof }],
    ['no proof', { verification: verified, webSession: session }],
    [
      'a proof for another session',
      { verification: verified, credentialProof: { ...proof, authSessionId: 'other' }, webSession: session },
    ],
    [
      'a proof at another generation',
      { verification: verified, credentialProof: { ...proof, generation: 4 }, webSession: session },
    ],
    ['a session for an account awaiting verification', { webSession: session, credentialProof: proof }],
  ])('treats a verified-looking reply with %s as unavailable', async (_case, fields) => {
    const { scoped } = await loginWith({ ...reply, ...fields });
    expect(scoped.unavailable()).toBe(true);
    expect(scoped.issuedWebSession()).toBeUndefined();
  });

  it('issues nothing and keeps the verification redirect for an account awaiting verification', async () => {
    const { scoped } = await loginWith(reply);
    await expect(scoped.options.callbacks?.signIn?.(parameters('selected'))).resolves.toBe(
      '/auth/verify-request?error=EmailNotVerified',
    );
    expect(scoped.unavailable()).toBe(false);
    expect(scoped.issuedWebSession()).toBeUndefined();
  });

  it('never asks for a session when the caller did not', async () => {
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'backend-staging');
    const password = vi.fn(async () => reply);
    const scoped = createPasswordCommandAuthRequest(base(), () => ({ password, register: vi.fn() }));
    await provider(scoped.options).authorize({ email: reply.user.email, password: 'x' }, { headers: {} });
    expect(password).toHaveBeenCalledWith(reply.user.email, 'x', undefined);
  });
});

describe('on the standalone server, whose request URL is its bind address', () => {
  const bindAddress = 'https://0.0.0.0:3000/api/auth/callback/credentials';
  const www = 'https://www.boardsesh.com/auth/error?error=AuthBackendUnavailable';

  it('points the unavailable result at the configured site', async () => {
    vi.stubEnv('NEXTAUTH_URL', 'https://www.boardsesh.com');
    expect(await unavailablePasswordAuthResponse(bindAddress).json()).toEqual({ url: www });
  });

  it('points a client over its login limit at the configured site', async () => {
    vi.stubEnv('NEXTAUTH_URL', 'https://www.boardsesh.com');
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'backend-staging');
    const attempt = () =>
      admitPasswordLogin(new Request(bindAddress, { method: 'POST', headers: { 'X-Forwarded-For': '203.0.113.201' } }))
        .limitedResponse;
    for (let count = 0; count < 10; count += 1) expect(attempt()).toBeNull();
    const limited = attempt();
    expect(limited?.status).toBe(429);
    expect(await limited?.json()).toEqual({ url: www });
  });
});

describe('per-client password sign-in limit in legacy mode', () => {
  const CLOUDFLARE_EDGE = '172.70.1.2';
  const signInUrl = 'https://www.boardsesh.test/api/auth/callback/credentials';
  let nextVisitorOctet = 60;
  function request(headers: Record<string, string>) {
    return new Request(signInUrl, { method: 'POST', headers });
  }
  function fromVisitor(visitor: string) {
    return request({ 'X-Forwarded-For': CLOUDFLARE_EDGE, 'CF-Connecting-IP': visitor });
  }
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('counts only rejected passwords: 20 right ones pass, the 11th wrong one is limited', () => {
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'legacy');
    const visitor = '203.0.113.31';
    for (let count = 0; count < 20; count += 1) {
      const admission = admitPasswordLogin(fromVisitor(visitor));
      expect(admission.limitedResponse).toBeNull();
      admission.passwordAccepted();
    }
    for (let count = 0; count < 10; count += 1)
      expect(admitPasswordLogin(fromVisitor(visitor)).limitedResponse).toBeNull();
    expect(admitPasswordLogin(fromVisitor(visitor)).limitedResponse?.status).toBe(429);
  });

  it('counts an attempt before it runs, so a parallel burst cannot all get through', () => {
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'legacy');
    const burst = Array.from({ length: 15 }, () => admitPasswordLogin(fromVisitor('203.0.113.32')));
    expect(burst.filter((admission) => admission.limitedResponse === null)).toHaveLength(10);
  });

  it('gives an attempt back only once', () => {
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'legacy');
    const visitor = '203.0.113.33';
    const accepted = admitPasswordLogin(fromVisitor(visitor));
    expect(admitPasswordLogin(fromVisitor(visitor)).limitedResponse).toBeNull(); // a rejected one stays counted
    for (let count = 0; count < 5; count += 1) accepted.passwordAccepted();
    // One counted attempt remains, so 9 more fill the 10.
    for (let count = 0; count < 9; count += 1)
      expect(admitPasswordLogin(fromVisitor(visitor)).limitedResponse).toBeNull();
    expect(admitPasswordLogin(fromVisitor(visitor)).limitedResponse?.status).toBe(429);
  });

  it.each([
    ['no forwarded hop', {}],
    ['a last hop that is not a Cloudflare edge', { 'X-Forwarded-For': '203.0.113.40' }],
    ['an internal last hop, the ingress itself', { 'X-Forwarded-For': 'fd12:3456::1' }],
    ['a Cloudflare edge with no visitor address', { 'X-Forwarded-For': CLOUDFLARE_EDGE }],
    [
      'a visitor header no Cloudflare edge vouches for',
      { 'X-Forwarded-For': '10.0.0.5', 'CF-Connecting-IP': '203.0.113.41' },
    ],
  ])('skips the limit, rather than share one bucket, with %s', (_case, headers) => {
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'legacy');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (let count = 0; count < 15; count += 1) expect(admitPasswordLogin(request(headers)).limitedResponse).toBeNull();
    // Those attempts went into no bucket, so a vouched visitor still has all 10.
    const visitor = `203.0.113.${nextVisitorOctet++}`;
    for (let count = 0; count < 10; count += 1)
      expect(admitPasswordLogin(fromVisitor(visitor)).limitedResponse).toBeNull();
  });

  it('says it skipped the limit at most once a minute', () => {
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'legacy');
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2030, 0, 1));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (let count = 0; count < 5; count += 1) admitPasswordLogin(request({}));
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
    vi.setSystemTime(Date.UTC(2030, 0, 1, 0, 0, 59));
    admitPasswordLogin(request({}));
    expect(warn).toHaveBeenCalledOnce();
    vi.setSystemTime(Date.UTC(2030, 0, 1, 0, 1, 0));
    admitPasswordLogin(request({}));
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

it('preserves a full daily backend refusal through the actual private client and public 429 mapping', async () => {
  vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'backend-staging');
  const client = createPasswordCommandClient({
    environment: {
      NODE_ENV: 'test',
      CURRENT_STORE_WEB_AUTH_MODE: 'backend-staging',
      CURRENT_STORE_AUTH_BACKEND_ORIGIN: 'https://backend.example.test',
      CURRENT_STORE_AUTH_RPC_SECRET: 'daily-private-test-rpc-secret-distinct-32bytes',
    },
    fetch: async (_input, init) => {
      if (typeof init?.body !== 'string') throw new Error('Expected serialized command');
      const command = JSON.parse(init.body) as { requestId: string };
      return Response.json(
        {
          protocolVersion: 2,
          operation: 'password',
          requestId: command.requestId,
          outcome: 'error',
          code: 'rate_limited',
          retryAfterSeconds: 86_400,
        },
        { status: 429 },
      );
    },
  });
  const scoped = createPasswordCommandAuthRequest(base(), () => client);
  expect(
    await provider(scoped.options).authorize({ email: 'owner@example.test', password: 'right' }, { headers: {} }),
  ).toBeNull();
  expect(scoped.unavailable()).toBe(false);
  expect(scoped.limited()).toBe(86_400);
  const response = unavailablePasswordAuthResponse(
    'https://www.boardsesh.test/api/auth/callback/credentials',
    scoped.limited(),
  );
  expect(response.status).toBe(429);
  expect(response.headers.get('Retry-After')).toBe('86400');
});
