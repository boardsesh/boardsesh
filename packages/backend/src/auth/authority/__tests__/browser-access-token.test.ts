/**
 * #7596 B3a: the 15-minute browser access token's own cryptography. Whether
 * the session it names is live is the request path's job, tested over HTTP in
 * `browser-access-token-admission.test.ts`.
 */
import { SignJWT, UnsecuredJWT, decodeJwt, decodeProtectedHeader } from 'jose';
import { describe, expect, it } from 'vite-plus/test';
import {
  BROWSER_ACCESS_TOKEN_AUDIENCE,
  BROWSER_ACCESS_TOKEN_ISSUER,
  BROWSER_ACCESS_TOKEN_LIFETIME_SECONDS,
} from '@boardsesh/auth-protocol';
import {
  browserAccessTokenKey,
  claimsBrowserAudience,
  issueBrowserAccessToken,
  verifyBrowserAccessToken,
} from '../browser-access-token';
import type { FirstPartySession } from '../session-reader';

const key = browserAccessTokenKey('synthetic-browser-access-token-secret-for-tests');
const otherKey = browserAccessTokenKey('another-synthetic-browser-access-token-secret');
const now = new Date(Math.floor(Date.now() / 1000) * 1000);
const DAY_MS = 86_400_000;

function session(overrides: Partial<FirstPartySession> = {}): FirstPartySession {
  return {
    userId: 'climber-a',
    authSessionId: 'session-a',
    generation: 2,
    requiresAccountCutoff: false,
    authenticatedAt: new Date(now.getTime() - 60_000),
    linkGuarded: true,
    expiresAt: new Date(now.getTime() + 30 * DAY_MS),
    source: 'login',
    ...overrides,
  };
}

async function issued(overrides: Partial<FirstPartySession> = {}) {
  const token = await issueBrowserAccessToken(key, session(overrides), now);
  if (!token) throw new Error('No token issued');
  return token;
}

/** Signs claims with the real key and algorithm, so only the claim under test is wrong. */
function signed(claims: Record<string, unknown>, options: { audience?: string; lifetime?: number } = {}) {
  const issuedAt = Math.floor(now.getTime() / 1000);
  return new SignJWT({ sid: 'session-a', gen: 2, ...claims })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject('climber-a')
    .setIssuer(BROWSER_ACCESS_TOKEN_ISSUER)
    .setAudience(options.audience ?? BROWSER_ACCESS_TOKEN_AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + (options.lifetime ?? 600))
    .sign(key.key);
}

describe('issuing a browser access token', () => {
  it('signs HS256 for one session, with its generation and expiry, for 15 minutes', async () => {
    const { token, expiresAt } = await issued();
    expect(decodeProtectedHeader(token)).toEqual({ alg: 'HS256', typ: 'JWT' });
    const claims = decodeJwt(token);
    expect(claims).toMatchObject({
      sub: 'climber-a',
      sid: 'session-a',
      gen: 2,
      aud: BROWSER_ACCESS_TOKEN_AUDIENCE,
      iss: BROWSER_ACCESS_TOKEN_ISSUER,
      link_guarded: true,
      auth_time: Math.floor(now.getTime() / 1000) - 60,
      sexp: Math.floor(now.getTime() / 1000) + 30 * 86_400,
    });
    expect(claims.exp).toBe(Math.floor(now.getTime() / 1000) + BROWSER_ACCESS_TOKEN_LIFETIME_SECONDS);
    expect(expiresAt.getTime()).toBe((claims.exp ?? 0) * 1000);
    expect(await verifyBrowserAccessToken(key, token, now)).toEqual({
      userId: 'climber-a',
      sessionId: 'session-a',
      generation: 2,
      expiresAt,
    });
  });

  it('never outlives its session, and carries no sign-in time for a bridged or carried one', async () => {
    const ending = await issued({ expiresAt: new Date(now.getTime() + 120_000) });
    expect(ending.expiresAt.getTime()).toBe(now.getTime() + 120_000);
    expect(decodeJwt((await issued({ source: 'bridge' })).token).auth_time).toBeUndefined();
    expect(decodeJwt((await issued({ authenticatedAt: null })).token).auth_time).toBeUndefined();
    expect(await issueBrowserAccessToken(key, session({ expiresAt: new Date(now.getTime() + 500) }), now)).toBe(
      undefined,
    );
  });

  it('refuses a weak secret, and the key prints no bytes', () => {
    for (const weak of ['', 'short', ` ${'x'.repeat(40)}`]) expect(() => browserAccessTokenKey(weak)).toThrow();
    expect(JSON.stringify(key)).not.toMatch(/synthetic/);
  });
});

describe('verifying a browser access token', () => {
  it('refuses an expired, tampered, foreign-key, unsigned or wrong-audience token', async () => {
    const { token } = await issued();
    const [header, payload, signature] = token.split('.');
    const tamperedPayload = Buffer.from(JSON.stringify({ ...decodeJwt(token), sub: 'climber-b' }), 'utf8').toString(
      'base64url',
    );
    const refused = {
      expired: token,
      tampered: `${header}.${tamperedPayload}.${signature}`,
      'another key': (await issueBrowserAccessToken(otherKey, session(), now))?.token ?? '',
      'alg none': new UnsecuredJWT({ sid: 'session-a', gen: 2 })
        .setSubject('climber-a')
        .setIssuer(BROWSER_ACCESS_TOKEN_ISSUER)
        .setAudience(BROWSER_ACCESS_TOKEN_AUDIENCE)
        .setIssuedAt()
        .setExpirationTime('10m')
        .encode(),
      'the app audience': await signed({}, { audience: 'boardsesh-mobile' }),
      'a longer lifetime': await signed({}, { lifetime: 3600 }),
      'no session id': await signed({ sid: undefined }),
      'no generation': await signed({ gen: undefined }),
      'a negative generation': await signed({ gen: -1 }),
      empty: '',
    };
    for (const [label, candidate] of Object.entries(refused)) {
      const at =
        label === 'expired' ? new Date(now.getTime() + (BROWSER_ACCESS_TOKEN_LIFETIME_SECONDS + 31) * 1000) : now;
      expect(await verifyBrowserAccessToken(key, candidate, at), label).toBeNull();
    }
    expect(payload).toBeTruthy();
    // Inside the 30-second skew it still verifies.
    const late = new Date(now.getTime() + (BROWSER_ACCESS_TOKEN_LIFETIME_SECONDS + 20) * 1000);
    expect(await verifyBrowserAccessToken(key, token, late)).not.toBeNull();
  });

  it('reads the unverified audience only to pick a verifier', async () => {
    expect(claimsBrowserAudience((await issued()).token)).toBe(true);
    expect(claimsBrowserAudience(await signed({}, { audience: 'boardsesh-mobile' }))).toBe(false);
    for (const junk of ['', 'a.b.c', 'not-a-token']) expect(claimsBrowserAudience(junk)).toBe(false);
    // A browser token padded past 4096 characters is never decoded.
    const padded = await signed({ padding: 'x'.repeat(4096) });
    expect(padded.length).toBeGreaterThan(4096);
    expect(claimsBrowserAudience(padded)).toBe(false);
  });
});
