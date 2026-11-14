// @vitest-environment node
import type { NextAuthOptions } from 'next-auth';
import AppleProvider from 'next-auth/providers/apple';
import { encode } from 'next-auth/jwt';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { normalizeProviderSecurityAppleCallback } from '../provider-security-apple-transport.server';
import { resumeAppleOAuthCallback } from '../web-oauth-continuation.server';

const origin = 'https://www.apple-transport.example.test';
const secret = 'owned-apple-transport-normalization-secret';
const scope = 'a'.repeat(32);
const state = 'actual-apple-authorization-state';
const stateName = '__Secure-next-auth.state';
const context = { params: Promise.resolve({ nextauth: ['callback', 'apple'] }) };
const environment = {
  NEXTAUTH_URL: origin,
  NEXTAUTH_SECRET: secret,
  CURRENT_STORE_PROVIDER_SECURITY_MODE: 'backend-staging',
  CURRENT_STORE_BROWSER_BINDING_MODE: 'backend-staging',
  CURRENT_STORE_WEB_OAUTH_MODE: 'backend-staging',
};
function base(): NextAuthOptions {
  return {
    providers: [AppleProvider({ clientId: 'owned-apple-client', clientSecret: 'owned-apple-secret' })],
    secret,
    cookies: { state: { name: stateName, options: { httpOnly: true, secure: true, sameSite: 'none' } } },
  };
}
async function request(
  options: {
    readonly claimProvider?: string;
    readonly cookie?: string | null;
    readonly host?: string;
    readonly maxAge?: number;
    readonly body?: string;
    readonly signal?: AbortSignal;
  } = {},
) {
  const signed = await encode({
    secret,
    salt: `${stateName}.${scope}`,
    maxAge: options.maxAge ?? 900,
    token: { provider: options.claimProvider ?? 'apple', value: state },
  });
  return new NextRequest('http://0.0.0.0:3000/api/auth/callback/apple', {
    method: 'POST',
    headers: {
      Host: options.host ?? new URL(origin).host,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(options.cookie === null ? {} : { Cookie: options.cookie ?? `${stateName}.${scope}=${signed}` }),
      'X-Forwarded-Host': 'foreign.example.test',
      'X-Forwarded-Proto': 'http',
    },
    body:
      options.body ??
      new URLSearchParams({
        state,
        code: 'actual-provider-code',
        id_token: 'held-for-actual-callback-verification',
      }).toString(),
    signal: options.signal,
  });
}
beforeEach(() => {
  vi.stubEnv('NEXTAUTH_URL', origin);
  vi.stubEnv('NEXTAUTH_SECRET', secret);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Apple form_post transport before selected-source admission', () => {
  it('holds an actual signed-state POST with no Lax actor or operation cookies, then restores transport only on canonical GET', async () => {
    const incoming = await request();
    const response = await normalizeProviderSecurityAppleCallback(incoming, context, base(), {
      environment,
      ready: () => true,
    });
    expect(response?.status).toBe(303);
    expect(response?.headers.get('Location')).toBe(`${origin}/api/auth/callback/apple?boardseshOAuthContinue=${scope}`);
    expect(response?.headers.getSetCookie()).toHaveLength(1);
    const header = response!.headers.getSetCookie()[0];
    expect(header).toContain(`__Secure-boardsesh.web-oauth.apple.${scope}=`);
    expect(header).toContain('; Path=/api/auth/callback/apple; Max-Age=60; HttpOnly; SameSite=Lax; Secure');
    expect(header).not.toMatch(/Domain=|browser-proof|browser-binding|provider-security|session-token/);
    const resumed = await resumeAppleOAuthCallback(
      new NextRequest(response!.headers.get('Location')!, {
        headers: { cookie: `${incoming.headers.get('cookie')}; ${header.split(';', 1)[0]}` },
      }),
      base(),
      scope,
    );
    expect(resumed.request.method).toBe('POST');
    expect(await resumed.request.text()).toBe(await incoming.text());
    expect(resumed.request.headers.get('cookie')).not.toMatch(
      /browser-proof|browser-binding|provider-security|session-token/,
    );
    // No source was admitted by transport restoration; the later GET pipeline
    // must independently reject these still-absent source and operation proofs.
  });
  it('refuses the production default false readiness despite asserted HTTP or environment readiness', async () => {
    const incoming = await request();
    incoming.headers.set('x-provider-ready', 'true');
    const result = await normalizeProviderSecurityAppleCallback(incoming, context, base(), {
      environment: { ...environment, PROVIDER_READY: 'true' },
    });
    expect(result?.status).toBe(503);
    expect(result?.headers.getSetCookie()).toEqual([]);
  });
  it.each([null, '', `${stateName}.${scope}=forged`])(
    'refuses missing or unauthenticated actual flow state %s',
    async (cookie) => {
      const result = await normalizeProviderSecurityAppleCallback(await request({ cookie }), context, base(), {
        environment,
        ready: () => true,
      });
      expect(result?.status).toBe(503);
      expect(result?.headers.getSetCookie()).toEqual([]);
    },
  );
  it.each(['foreign.example.test', 'www.apple-transport.example.test, foreign.example.test', ''])(
    'rejects noncanonical Host %s without using forwarded assertions',
    async (host) => {
      const result = await normalizeProviderSecurityAppleCallback(await request({ host }), context, base(), {
        environment,
        ready: () => true,
      });
      expect(result?.status).toBe(503);
      expect(result?.headers.getSetCookie()).toEqual([]);
    },
  );
  it.each([
    { claimProvider: 'google' },
    { maxAge: -120 },
    { body: `state=${state}&state=${state}` },
    { body: 'state=other&code=claimed' },
    { body: `state=${state}&code=${'x'.repeat(4096)}` },
  ])('refuses wrong provider, expired state or malformed bounded form %#', async (settings) => {
    const result = await normalizeProviderSecurityAppleCallback(await request(settings), context, base(), {
      environment,
      ready: () => true,
    });
    expect(result?.status).toBe(503);
    expect(result?.headers.getSetCookie()).toEqual([]);
  });
  it('captures actual request cookies and issuer settings before a route-parameter await', async () => {
    const incoming = await request();
    const issuer = base();
    let release!: (value: { nextauth: string[] }) => void;
    const params = new Promise<{ nextauth: string[] }>((resolve) => {
      release = resolve;
    });
    const pending = normalizeProviderSecurityAppleCallback(incoming, { params }, issuer, {
      environment,
      ready: () => true,
    });
    incoming.headers.set('cookie', 'claimed-state=forged');
    issuer.secret = 'different-issuer-secret';
    issuer.cookies!.state!.name = 'foreign-state-name';
    release({ nextauth: ['callback', 'apple'] });
    expect((await pending)?.status).toBe(303);
  });
  it('preserves legacy and non-Apple traffic without a continuation or cookie write', async () => {
    expect(
      await normalizeProviderSecurityAppleCallback(await request(), context, base(), {
        environment: { CURRENT_STORE_PROVIDER_SECURITY_MODE: 'legacy' },
      }),
    ).toBeNull();
    expect(
      await normalizeProviderSecurityAppleCallback(
        new NextRequest(`${origin}/api/auth/callback/google`),
        { params: Promise.resolve({ nextauth: ['callback', 'google'] }) },
        base(),
        { environment },
      ),
    ).toBeNull();
  });
});
