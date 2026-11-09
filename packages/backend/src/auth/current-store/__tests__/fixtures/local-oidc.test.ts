import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { startLocalOidcFixture, type LocalOidcControls } from './local-oidc';

const callbackUri = 'http://127.0.0.1:45678/api/auth/callback/google';
const identity = { subject: 'fixture-owned-subject', email: 'synthetic-climber@example.test', emailVerified: true };

describe('real loopback OIDC fixture protocol guarantees', () => {
  let provider: Awaited<ReturnType<typeof startLocalOidcFixture>>;
  beforeEach(async () => {
    provider = await startLocalOidcFixture();
    provider.registerRedirectUri(callbackUri);
  });
  afterEach(async () => provider?.close());

  function authorization(overrides: Record<string, string> = {}) {
    const verifier = randomBytes(32).toString('base64url');
    const state = randomUUID();
    const nonce = randomUUID();
    const url = new URL(`${provider.issuer}/authorize`);
    url.search = new URLSearchParams({
      client_id: provider.clientId,
      redirect_uri: callbackUri,
      response_type: 'code',
      scope: 'openid profile email',
      state,
      nonce,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      ...overrides,
    }).toString();
    return { url: url.toString(), verifier, state, nonce };
  }
  async function issue(controls: LocalOidcControls = {}) {
    const pending = authorization();
    const response = await provider.authorize(pending.url, identity, controls);
    expect(response.status).toBe(302);
    const callback = new URL(response.headers.get('location')!);
    expect(callback.origin + callback.pathname).toBe(callbackUri);
    expect(callback.searchParams.get('state')).toBe(pending.state);
    expect(response.headers.getSetCookie()).toEqual([]);
    const code = callback.searchParams.get('code');
    if (!code) throw new Error('Missing synthetic OIDC code');
    return { ...pending, code };
  }
  function token(code: string, verifier: string, options: { redirectUri?: string; clientSecret?: string } = {}) {
    const clientAuthorization = Buffer.from(
      `${encodeURIComponent(provider.clientId)}:${encodeURIComponent(options.clientSecret ?? provider.clientSecret)}`,
    ).toString('base64');
    return fetch(`${provider.issuer}/token`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(4000),
      headers: { authorization: `Basic ${clientAuthorization}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: options.redirectUri ?? callbackUri,
      }),
    });
  }
  async function idToken(response: Response) {
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || !('id_token' in body) || typeof body.id_token !== 'string')
      throw new Error('Missing synthetic signed IDtoken');
    return body.id_token;
  }

  it('serves real discovery/JWKS and verifies the exchanged IDtoken signature, issuer, audience and nonce', async () => {
    const discoveryResponse = await fetch(provider.discoveryUrl, { signal: AbortSignal.timeout(4000) });
    expect(discoveryResponse.status).toBe(200);
    expect(await discoveryResponse.json()).toMatchObject({
      issuer: provider.issuer,
      jwks_uri: `${provider.issuer}/jwks`,
      token_endpoint: `${provider.issuer}/token`,
      code_challenge_methods_supported: ['S256'],
    });
    const issued = await issue();
    const signed = await idToken(await token(issued.code, issued.verifier));
    const jwks = createRemoteJWKSet(new URL(`${provider.issuer}/jwks`), { timeoutDuration: 3000 });
    const verified = await jwtVerify(signed, jwks, {
      issuer: provider.issuer,
      audience: provider.clientId,
      algorithms: ['RS256'],
    });
    expect(verified.payload).toMatchObject({
      sub: identity.subject,
      email: identity.email,
      email_verified: true,
      nonce: issued.nonce,
    });
    expect(verified.payload.auth_time).toBeUndefined();
    expect(provider.requests().map((request) => request.path)).toContain('/jwks');
    await expect(jwtVerify(signed, jwks, { issuer: provider.issuer, audience: 'foreign-client' })).rejects.toThrow();
    const segments = signed.split('.');
    segments[2] = `${segments[2][0] === 'A' ? 'B' : 'A'}${segments[2].slice(1)}`;
    await expect(
      jwtVerify(segments.join('.'), jwks, { issuer: provider.issuer, audience: provider.clientId }),
    ).rejects.toThrow();
  });

  it('rejects an incorrect client secret before consuming the valid code', async () => {
    const issued = await issue();
    const denied = await token(issued.code, issued.verifier, { clientSecret: 'incorrect-client-secret' });
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: 'invalid_client' });
    expect(provider.stats().redeemedCodes).toBe(0);
    expect((await token(issued.code, issued.verifier)).status).toBe(200);
  });

  it('roundtrips explicit historical auth_time without deriving it from token issuance', async () => {
    const pending = authorization();
    const authTimeSeconds = Math.floor(Date.now() / 1000) - 600;
    const authorized = await provider.authorize(pending.url, { ...identity, authTimeSeconds });
    const code = new URL(authorized.headers.get('location')!).searchParams.get('code')!;
    const signed = await idToken(await token(code, pending.verifier));
    const jwks = createRemoteJWKSet(new URL(`${provider.issuer}/jwks`), { timeoutDuration: 3000 });
    const verified = await jwtVerify(signed, jwks, { issuer: provider.issuer, audience: provider.clientId });
    expect(verified.payload.auth_time).toBe(authTimeSeconds);
    expect(verified.payload.iat).toBeGreaterThan(authTimeSeconds);
  });

  it('requires the exact S256 verifier, preserving an unused code after incorrect PKCE', async () => {
    const issued = await issue();
    const denied = await token(issued.code, randomBytes(32).toString('base64url'));
    expect(denied.status).toBe(400);
    expect(await denied.json()).toEqual({ error: 'invalid_grant' });
    expect((await token(issued.code, issued.verifier)).status).toBe(200);
  });

  it('binds redemption to the exact registered callback used for authorization', async () => {
    const issued = await issue();
    const anotherRegistered = `${callbackUri}-another`;
    provider.registerRedirectUri(anotherRegistered);
    const denied = await token(issued.code, issued.verifier, { redirectUri: anotherRegistered });
    expect(denied.status).toBe(400);
    expect(await denied.json()).toEqual({ error: 'invalid_grant' });
    expect((await token(issued.code, issued.verifier)).status).toBe(200);
  });

  it.each([
    ['unregistered redirect', { redirect_uri: 'https://attacker.invalid/callback' }],
    ['missing state', { state: '' }],
    ['plain PKCE', { code_challenge_method: 'plain' }],
    ['missing nonce', { nonce: '' }],
    ['foreign client', { client_id: 'foreign-client' }],
  ] as const)(
    'rejects %s at the authorization endpoint without redirecting or issuing a code',
    async (_reason, overrides) => {
      const pending = authorization(overrides);
      const response = await provider.authorize(pending.url, identity);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_request' });
      expect(response.headers.get('location')).toBeNull();
      expect(provider.stats().issuedCodes).toBe(0);
    },
  );

  it('redemption is one-use even when the same valid code is submitted concurrently', async () => {
    const issued = await issue();
    const responses = await Promise.all([token(issued.code, issued.verifier), token(issued.code, issued.verifier)]);
    expect(
      responses.map((response) => response.status).sort((firstStatus, secondStatus) => firstStatus - secondStatus),
    ).toEqual([200, 400]);
    expect(provider.stats().redeemedCodes).toBe(1);
  });

  it('can issue distinct valid codes for one authorization URL/state for relying-party replay tests', async () => {
    const pending = authorization();
    const first = await provider.authorize(pending.url, identity);
    const second = await provider.authorize(pending.url, { ...identity, subject: 'another-owned-subject' });
    const firstCallback = new URL(first.headers.get('location')!);
    const secondCallback = new URL(second.headers.get('location')!);
    expect(firstCallback.searchParams.get('state')).toBe(pending.state);
    expect(secondCallback.searchParams.get('state')).toBe(pending.state);
    const firstCode = firstCallback.searchParams.get('code')!;
    const secondCode = secondCallback.searchParams.get('code')!;
    expect(firstCode).not.toBe(secondCode);
    const responses = await Promise.all([token(firstCode, pending.verifier), token(secondCode, pending.verifier)]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(provider.stats()).toMatchObject({ issuedCodes: 2, redeemedCodes: 2 });
  });

  it('expires a genuinely issued unused code using the provider clock', async () => {
    await provider.close();
    provider = await startLocalOidcFixture({ codeLifetimeMs: 100 });
    provider.registerRedirectUri(callbackUri);
    const issued = await issue();
    expect(provider.stats().issuedCodes).toBe(1);
    await new Promise<void>((resolve) => setTimeout(resolve, 125));
    const response = await token(issued.code, issued.verifier);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_grant' });
    expect(provider.stats().redeemedCodes).toBe(0);
  });

  it('cancellation returns the original state without code issuance or token exchange', async () => {
    const pending = authorization();
    const response = await provider.authorize(pending.url, identity, { cancel: true });
    expect(response.status).toBe(302);
    const callback = new URL(response.headers.get('location')!);
    expect(callback.searchParams.get('state')).toBe(pending.state);
    expect(callback.searchParams.get('error')).toBe('access_denied');
    expect(callback.searchParams.get('code')).toBeNull();
    expect(provider.stats().issuedCodes).toBe(0);
    expect(provider.requests().some((request) => request.path === '/token')).toBe(false);
  });

  it('wrong-nonce control still issues a genuinely signed token for relying-party validation', async () => {
    const issued = await issue({ wrongNonce: true });
    const signed = await idToken(await token(issued.code, issued.verifier));
    const jwks = createRemoteJWKSet(new URL(`${provider.issuer}/jwks`), { timeoutDuration: 3000 });
    const verified = await jwtVerify(signed, jwks, { issuer: provider.issuer, audience: provider.clientId });
    expect(verified.payload.nonce).not.toBe(issued.nonce);
    expect(verified.payload.nonce).toBe(`${issued.nonce}-wrong`);
  });

  it('configured token rejection consumes the code and returns no token', async () => {
    const issued = await issue({ rejectToken: true });
    const rejected = await token(issued.code, issued.verifier);
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ error: 'invalid_grant' });
    expect((await token(issued.code, issued.verifier)).status).toBe(400);
    expect(provider.stats()).toMatchObject({ redeemedCodes: 0, pendingCodes: 0 });
  });
});
