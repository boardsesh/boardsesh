// @vitest-environment node
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextAuthOptions } from 'next-auth';
import { decode, encode } from 'next-auth/jwt';
import { NextRequest } from 'next/server';
import { AUTH_BACKEND_UNAVAILABLE, AUTH_COMMAND_FUTURE_SKEW_MS } from '@boardsesh/auth-protocol';
vi.mock('server-only', () => ({}));
import {
  createWebOAuthCookieScope,
  scopedWebOAuthCookies,
  webOAuthFlowHash,
  findWebOAuthCallbackScope,
  readAppleOAuthCallbackState,
  holdAppleOAuthCallback,
  resumeAppleOAuthCallback,
} from '../web-oauth-continuation.server';

const origin = 'https://owned.example.test';
// What request.url reports on the standalone production server.
const bindOrigin = 'https://0.0.0.0:3000';
const callbackPath = '/api/auth/callback/apple';
const state = 'owned-state-value';
const secret = randomBytes(32).toString('base64url');
const cookieOptions = { httpOnly: true, secure: true, sameSite: 'none' as const, path: '/', domain: '.example.test' };
const base: NextAuthOptions = {
  providers: [],
  secret,
  cookies: {
    state: { name: '__Secure-next-auth.state', options: cookieOptions },
    pkceCodeVerifier: { name: '__Secure-next-auth.pkce.code_verifier', options: cookieOptions },
    nonce: { name: '__Secure-next-auth.nonce', options: cookieOptions },
    callbackUrl: { name: '__Secure-next-auth.callback-url', options: cookieOptions },
    sessionToken: { name: '__Secure-next-auth.session-token', options: { ...cookieOptions, sameSite: 'lax' } },
    csrfToken: { name: '__Host-next-auth.csrf-token', options: { ...cookieOptions, domain: undefined } },
  },
};
function request(method: 'GET' | 'POST', cookie: string, body?: string, requestOrigin = origin, scope?: string) {
  const url = new URL(callbackPath, requestOrigin);
  if (scope) url.searchParams.set('boardseshOAuthContinue', scope);
  return new NextRequest(url, {
    method,
    headers: { Cookie: cookie, ...(body !== undefined ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    ...(body !== undefined ? { body } : {}),
  });
}
async function stateCookie(scope: string, value = state, provider = 'apple', maxAge = 900, salt?: string) {
  const name = `${base.cookies!.state!.name}.${scope}`;
  const token = await encode({ token: { value, provider }, secret, maxAge, salt: salt ?? name });
  return `${name}=${token}`;
}
function pairs(response: Response) {
  return response.headers.getSetCookie().map((header) => header.split(';')[0]);
}
async function held(
  body = new URLSearchParams({ state, code: 'owned-code', id_token: 'owned-provider-token' }).toString(),
  stateValue = state,
) {
  const scope = createWebOAuthCookieScope();
  const signedState = await stateCookie(scope, stateValue);
  const response = await holdAppleOAuthCallback(request('POST', signedState, body), base, scope, stateValue);
  const continuation = pairs(response);
  return { scope, signedState, response, continuation, body };
}
function continuationBase(continuation: string[]) {
  const first = continuation[0].slice(0, continuation[0].indexOf('='));
  return first.endsWith('.0') ? first.slice(0, -2) : first;
}
async function reseal(
  fixture: Awaited<ReturnType<typeof held>>,
  patch: Record<string, unknown>,
  maxAge = 60,
  salt?: string,
) {
  const name = continuationBase(fixture.continuation);
  const raw = fixture.continuation.map((pair) => pair.slice(pair.indexOf('=') + 1)).join('');
  const claims = await decode({ token: raw, secret, salt: name });
  if (!claims) throw new Error('Missing owned continuation');
  const token = await encode({ token: { ...claims, ...patch }, secret, salt: salt ?? name, maxAge });
  return token.length <= 3500
    ? [`${name}=${token}`]
    : [`${name}.0=${token.slice(0, 3500)}`, `${name}.1=${token.slice(3500)}`];
}
function clearConfiguredSite() {
  for (const variable of ['NEXTAUTH_URL', 'BASE_URL', 'VERCEL', 'VERCEL_ENV', 'VERCEL_URL']) vi.stubEnv(variable, '');
}
beforeEach(() => {
  vi.stubEnv('NEXTAUTH_URL', origin);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('flow-scoped public NextAuth cookies', () => {
  it('creates random scopes and clones four flow cookies without changing session, CSRF or attributes', () => {
    const first = createWebOAuthCookieScope();
    const second = createWebOAuthCookieScope();
    expect(first).toMatch(/^[a-f0-9]{32}$/);
    expect(first === second).toBe(false);
    const scoped = scopedWebOAuthCookies(base, first)!;
    for (const key of ['state', 'pkceCodeVerifier', 'nonce', 'callbackUrl'] as const) {
      expect(scoped[key]?.name).toBe(`${base.cookies![key]!.name}.${first}`);
      expect(scoped[key]?.options).toEqual(cookieOptions);
      expect(scoped[key]?.options === base.cookies![key]!.options).toBe(false);
    }
    expect(scoped.sessionToken === base.cookies!.sessionToken).toBe(true);
    expect(scoped.csrfToken === base.cookies!.csrfToken).toBe(true);
    expect(base.cookies!.state!.name).toBe('__Secure-next-auth.state');
    expect(() => scopedWebOAuthCookies(base, '../other')).toThrow(AUTH_BACKEND_UNAVAILABLE);
  });

  it('domain-separates the provider/state hash and preserves exact state bytes', () => {
    expect(webOAuthFlowHash('apple', state)).toMatch(/^[a-f0-9]{64}$/);
    expect(webOAuthFlowHash('apple', state) === webOAuthFlowHash('google', state)).toBe(false);
    expect(webOAuthFlowHash('apple', state) === webOAuthFlowHash('apple', `${state} `)).toBe(false);
  });

  it('locates only the matching actual public state JWT among valid pending provider flows', async () => {
    const scope = createWebOAuthCookieScope();
    const sibling = createWebOAuthCookieScope();
    const cookies = `${await stateCookie(sibling, 'another-state', 'google')}; ${await stateCookie(scope)}`;
    expect(await findWebOAuthCallbackScope(request('POST', cookies), base, 'apple', state)).toBe(scope);
  });

  it.each([
    'missing',
    'bare',
    'duplicate',
    'invalid-scope',
    'wrong-salt',
    'wrong-provider',
    'wrong-state',
    'expired',
    'ambiguous',
  ])('rejects %s state-cookie evidence instead of treating it as anonymous', async (fault) => {
    const scope = createWebOAuthCookieScope();
    const valid = await stateCookie(scope);
    let cookies = valid;
    if (fault === 'missing') cookies = '';
    if (fault === 'bare') cookies = valid.slice(0, valid.indexOf('='));
    if (fault === 'duplicate') cookies = `${valid}; ${valid}`;
    if (fault === 'invalid-scope') cookies = valid.replace(scope, 'invalid');
    if (fault === 'wrong-salt') cookies = await stateCookie(scope, state, 'apple', 900, 'another-purpose');
    if (fault === 'wrong-provider') cookies = await stateCookie(scope, state, 'google');
    if (fault === 'wrong-state') cookies = await stateCookie(scope, 'another-state');
    if (fault === 'expired') cookies = await stateCookie(scope, state, 'apple', -60);
    if (fault === 'ambiguous') cookies = `${valid}; ${await stateCookie(createWebOAuthCookieScope())}`;
    await expect(findWebOAuthCallbackScope(request('POST', cookies), base, 'apple', state)).rejects.toThrow(
      AUTH_BACKEND_UNAVAILABLE,
    );
  });
});

describe('stateless encrypted Apple continuation', () => {
  it('emits only a fixed scope URL and host-only private short-lived cookies after genuine signed state', async () => {
    const fixture = await held();
    expect(fixture.response.status).toBe(303);
    expect(fixture.response.headers.get('Location')).toBe(
      `${origin}${callbackPath}?boardseshOAuthContinue=${fixture.scope}`,
    );
    const headers = fixture.response.headers.getSetCookie();
    expect(headers.length).toBe(1);
    expect(
      headers.every(
        (header) =>
          header.includes('HttpOnly') &&
          header.includes('SameSite=Lax') &&
          header.includes('Secure') &&
          header.includes(`Path=${callbackPath}`) &&
          header.includes('Max-Age=60') &&
          !/Domain=/i.test(header),
      ),
    ).toBe(true);
    expect(
      headers.every(
        (header) =>
          !header.includes('owned-code') && !header.includes('owned-provider-token') && !header.includes(state),
      ),
    ).toBe(true);
    expect(fixture.response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(fixture.response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(fixture.response.headers.get('X-Robots-Tag')).toBe('noindex, follow');
  });

  it('resumes after module reload using the current session cookie and clears only that valid continuation', async () => {
    const fixture = await held();
    const sibling = await held(
      new URLSearchParams({ state: 'sibling-state', code: 'sibling-owned-code' }).toString(),
      'sibling-state',
    );
    vi.resetModules();
    const reloaded = await import('../web-oauth-continuation.server');
    const currentCookie = '__Secure-next-auth.session-token=current-owned-login';
    const cookie = [
      fixture.signedState,
      ...fixture.continuation,
      sibling.signedState,
      ...sibling.continuation,
      currentCookie,
    ].join('; ');
    const resumed = await reloaded.resumeAppleOAuthCallback(
      request('GET', cookie, undefined, origin, fixture.scope),
      base,
      fixture.scope,
    );
    expect(resumed.state).toBe(state);
    expect(resumed.request.method).toBe('POST');
    expect(resumed.request.url).toBe(`${origin}${callbackPath}`);
    expect((await resumed.request.text()) === fixture.body).toBe(true);
    expect(resumed.request.headers.get('cookie') === cookie).toBe(true);
    expect(resumed.request.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    const cleared = resumed.clear(
      new Response('owned', { status: 200, headers: { 'Set-Cookie': 'unrelated=retained; Path=/' } }),
    );
    const names = cleared.headers.getSetCookie().map((header) => header.slice(0, header.indexOf('=')));
    expect(names).toEqual(['unrelated', continuationBase(fixture.continuation)]);
    expect(cleared.headers.getSetCookie().filter((header) => /Max-Age=0/i.test(header)).length).toBe(1);
    expect(
      names.some(
        (name) => name === continuationBase(sibling.continuation) || name === '__Secure-next-auth.session-token',
      ),
    ).toBe(false);
  });

  describe('behind the standalone server, whose request URL is its bind address', () => {
    const body = new URLSearchParams({ state, code: 'owned-code' }).toString();

    it('answers Apple with a 303 to www when NEXTAUTH_URL names www', async () => {
      vi.stubEnv('NEXTAUTH_URL', 'https://www.boardsesh.com');
      const scope = createWebOAuthCookieScope();
      const signedState = await stateCookie(scope);
      const response = await holdAppleOAuthCallback(request('POST', signedState, body, bindOrigin), base, scope, state);
      expect(response.status).toBe(303);
      expect(response.headers.get('Location')).toBe(
        `https://www.boardsesh.com${callbackPath}?boardseshOAuthContinue=${scope}`,
      );
    });

    it('sends Apple back to the configured site and resumes there', async () => {
      const scope = createWebOAuthCookieScope();
      const signedState = await stateCookie(scope);
      const response = await holdAppleOAuthCallback(request('POST', signedState, body, bindOrigin), base, scope, state);
      expect(response.headers.get('Location')).toBe(`${origin}${callbackPath}?boardseshOAuthContinue=${scope}`);
      const cookie = [signedState, ...pairs(response)].join('; ');
      const resumed = await resumeAppleOAuthCallback(request('GET', cookie, undefined, bindOrigin, scope), base, scope);
      expect(resumed.state).toBe(state);
      expect(resumed.request.url).toBe(`${origin}${callbackPath}`);
      expect((await resumed.request.text()) === body).toBe(true);
    });

    it('picks the cookie security from the configured site, not the request scheme', async () => {
      const scope = createWebOAuthCookieScope();
      const signedState = await stateCookie(scope);
      const response = await holdAppleOAuthCallback(
        request('POST', signedState, body, 'http://0.0.0.0:3000'),
        base,
        scope,
        state,
      );
      const [header] = response.headers.getSetCookie();
      expect(header.startsWith(`__Secure-boardsesh.web-oauth.apple.${scope}=`)).toBe(true);
      expect(header).toContain('Secure');
    });

    it('refuses a continuation sealed for a different configured site', async () => {
      const fixture = await held();
      vi.stubEnv('NEXTAUTH_URL', 'https://other.example.test');
      const cookie = [fixture.signedState, ...fixture.continuation].join('; ');
      await expect(
        resumeAppleOAuthCallback(request('GET', cookie, undefined, origin, fixture.scope), base, fixture.scope),
      ).rejects.toThrow(AUTH_BACKEND_UNAVAILABLE);
    });

    it('fails closed rather than trusting the request when no site is configured', async () => {
      const scope = createWebOAuthCookieScope();
      const signedState = await stateCookie(scope);
      clearConfiguredSite();
      await expect(
        holdAppleOAuthCallback(request('POST', signedState, body, bindOrigin), base, scope, state),
      ).rejects.toThrow(AUTH_BACKEND_UNAVAILABLE);
    });
  });

  it('reassembles exactly two bounded chunks and deletes only their observed names', async () => {
    const fixture = await held(new URLSearchParams({ state, code: 'C'.repeat(3000) }).toString());
    expect(fixture.continuation.length).toBe(2);
    expect(fixture.continuation.every((pair) => Buffer.byteLength(pair.slice(pair.indexOf('=') + 1)) <= 3500)).toBe(
      true,
    );
    const cookie = [fixture.signedState, ...fixture.continuation.reverse()].join('; ');
    const resumed = await resumeAppleOAuthCallback(
      request('GET', cookie, undefined, origin, fixture.scope),
      base,
      fixture.scope,
    );
    expect((await resumed.request.text()) === fixture.body).toBe(true);
    const deleted = resumed.clear(new Response(null)).headers.getSetCookie();
    expect(deleted.length).toBe(2);
    expect(deleted.every((header) => /Max-Age=0/i.test(header))).toBe(true);
    expect(deleted.map((header) => header.slice(0, header.indexOf('='))).sort()).toEqual(
      fixture.continuation.map((pair) => pair.slice(0, pair.indexOf('='))).sort(),
    );
  });

  it('cannot mint continuation cookies from a malicious POST with missing or invalid signed state', async () => {
    const scope = createWebOAuthCookieScope();
    for (const cookie of ['', `${base.cookies!.state!.name}.${scope}=invalid-owned-jwe`]) {
      await expect(
        holdAppleOAuthCallback(request('POST', cookie, `state=${state}&code=owned`), base, scope, state),
      ).rejects.toThrow(AUTH_BACKEND_UNAVAILABLE);
    }
  });

  it.each(['duplicate-state', 'missing-state', 'different-state', 'oversized', 'wrong-content-type'])(
    'rejects %s body without minting or reflecting it',
    async (fault) => {
      const scope = createWebOAuthCookieScope();
      const cookie = await stateCookie(scope);
      let body = `state=${state}&code=owned`;
      if (fault === 'duplicate-state') body += `&state=${state}`;
      if (fault === 'missing-state') body = 'code=owned';
      if (fault === 'different-state') body = 'state=another-state&code=owned';
      if (fault === 'oversized') body += 'C'.repeat(4096);
      const incoming = request('POST', cookie, body);
      if (fault === 'wrong-content-type') incoming.headers.set('Content-Type', 'application/json');
      await expect(holdAppleOAuthCallback(incoming, base, scope, state)).rejects.toThrow(AUTH_BACKEND_UNAVAILABLE);
    },
  );

  it('provides bounded state extraction without consuming the original request body', async () => {
    const incoming = request('POST', '', `state=${state}&code=owned`);
    expect(await readAppleOAuthCallbackState(incoming)).toBe(state);
    expect(incoming.bodyUsed).toBe(false);
    await expect(readAppleOAuthCallbackState(request('POST', '', 'state=one&state=two'))).rejects.toThrow(
      AUTH_BACKEND_UNAVAILABLE,
    );
  });

  it('caps actual UTF8 body bytes rather than JavaScript string length', async () => {
    const body = `state=${state}&code=${'é'.repeat(2050)}`;
    expect(body.length < 4096).toBe(true);
    expect(Buffer.byteLength(body) > 4096).toBe(true);
    await expect(readAppleOAuthCallbackState(request('POST', '', body))).rejects.toThrow(AUTH_BACKEND_UNAVAILABLE);
  });

  it('stops an unclosed body stream at the absolute read deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(created) {
        controller = created;
        created.enqueue(new TextEncoder().encode(`state=${state}`));
      },
    });
    const incoming = new NextRequest(`${origin}${callbackPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: stream,
    });
    try {
      const rejection = expect(readAppleOAuthCallbackState(incoming)).rejects.toThrow(AUTH_BACKEND_UNAVAILABLE);
      await vi.advanceTimersByTimeAsync(2001);
      await rejection;
    } finally {
      controller.close();
      await incoming.body?.cancel().catch(() => {});
    }
  });

  it.each([
    'purpose',
    'origin',
    'path',
    'provider',
    'scope',
    'state-body',
    'extra-field',
    'future-time',
    'wrong-salt',
    'expired',
  ])('rejects %s sealed evidence without returning a clearing response', async (fault) => {
    const fixture = await held();
    const patch: Record<string, unknown> = {};
    if (fault === 'purpose') patch.purpose = 'another-purpose';
    if (fault === 'origin') patch.origin = 'https://foreign.example.test';
    if (fault === 'path') patch.callbackPath = '/api/auth/callback/google';
    if (fault === 'provider') patch.provider = 'google';
    if (fault === 'scope') patch.scope = createWebOAuthCookieScope();
    if (fault === 'state-body') patch.body = 'state=another-state&code=owned';
    if (fault === 'extra-field') patch.actor = 'untrusted-actor';
    if (fault === 'future-time') patch.issuedAtMs = Date.now() + 60_000;
    const continuation = await reseal(
      fixture,
      patch,
      fault === 'expired' ? -60 : 60,
      fault === 'wrong-salt' ? 'other-purpose' : undefined,
    );
    const cookie = [fixture.signedState, ...continuation].join('; ');
    await expect(
      resumeAppleOAuthCallback(request('GET', cookie, undefined, origin, fixture.scope), base, fixture.scope),
    ).rejects.toThrow(AUTH_BACKEND_UNAVAILABLE);
  });

  it('enforces the original sixty-second deadline even within public decoder clock tolerance', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    const fixture = await held();
    vi.setSystemTime(start + 60_000);
    const cookie = [fixture.signedState, ...fixture.continuation].join('; ');
    await expect(
      resumeAppleOAuthCallback(request('GET', cookie, undefined, origin, fixture.scope), base, fixture.scope),
    ).rejects.toThrow(AUTH_BACKEND_UNAVAILABLE);
  });

  it.each([50, AUTH_COMMAND_FUTURE_SKEW_MS])(
    'accepts an actual sealed callback on a replica %s ms behind the issuer',
    async (difference) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const issuedAt = Date.now();
      const fixture = await held();
      vi.setSystemTime(issuedAt - difference);
      const cookie = [fixture.signedState, ...fixture.continuation].join('; ');
      const resumed = await resumeAppleOAuthCallback(
        request('GET', cookie, undefined, origin, fixture.scope),
        base,
        fixture.scope,
      );
      expect(resumed.state).toBe(state);
      expect((await resumed.request.text()) === fixture.body).toBe(true);
    },
  );

  it('rejects issuer-ahead clock skew beyond the supported bound', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const issuedAt = Date.now();
    const fixture = await held();
    vi.setSystemTime(issuedAt - AUTH_COMMAND_FUTURE_SKEW_MS - 1);
    const cookie = [fixture.signedState, ...fixture.continuation].join('; ');
    await expect(
      resumeAppleOAuthCallback(request('GET', cookie, undefined, origin, fixture.scope), base, fixture.scope),
    ).rejects.toThrow(AUTH_BACKEND_UNAVAILABLE);
  });

  it.each(['duplicate', 'gap', 'mixed', 'bare', 'foreign-scope', 'missing-state', 'ciphertext', 'wrong-secret'])(
    'rejects %s raw-cookie evidence without clearing a sibling flow',
    async (fault) => {
      const fixture = await held();
      const name = continuationBase(fixture.continuation);
      let cookie = [fixture.signedState, ...fixture.continuation].join('; ');
      let configured = base;
      if (fault === 'duplicate') cookie += `; ${fixture.continuation[0]}`;
      if (fault === 'gap') cookie = `${fixture.signedState}; ${name}.1=owned-only-chunk`;
      if (fault === 'mixed') cookie += `; ${name}.0=owned-extra-chunk`;
      if (fault === 'bare') cookie = `${fixture.signedState}; ${name}`;
      if (fault === 'foreign-scope')
        cookie = `${fixture.signedState}; ${fixture.continuation[0].replace(fixture.scope, createWebOAuthCookieScope())}`;
      if (fault === 'missing-state') cookie = fixture.continuation.join('; ');
      if (fault === 'ciphertext') cookie = `${fixture.signedState}; ${name}=invalid-owned-jwe`;
      if (fault === 'wrong-secret') configured = { ...base, secret: randomBytes(32).toString('base64url') };
      await expect(
        resumeAppleOAuthCallback(request('GET', cookie, undefined, origin, fixture.scope), configured, fixture.scope),
      ).rejects.toThrow(AUTH_BACKEND_UNAVAILABLE);
    },
  );
});
