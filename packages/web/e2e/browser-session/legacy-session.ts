import { randomUUID } from 'node:crypto';
import type { BrowserContext } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { COOKIE_DOMAIN, WWW_ORIGIN, type SeededAccount } from './stack';

/**
 * Mints a NextAuth session cookie for a seeded account, in each shape the
 * fleet still holds, with the same `encode` NextAuth writes its own cookie with
 * and this run's NEXTAUTH_SECRET. Test code only: the app never imports this.
 *
 *   normal       `__Secure-next-auth.session-token`, `Domain=.boardsesh.test`: today's cookie
 *   chunked      the same cookie split into `.0`, `.1`, `.2` pieces, as NextAuth does past 4 KB
 *   host-only    the cookie before app.boardsesh.com shared the login: no Domain, www only
 *   plain-named  `next-auth.session-token`, no `__Secure-` prefix and no Secure flag: what a
 *                browser holds from when the cookie name followed the page's scheme
 */

export const LEGACY_SESSION_SHAPES = ['normal', 'chunked', 'host-only', 'plain-named'] as const;
export type LegacySessionShape = (typeof LEGACY_SESSION_SHAPES)[number];

type Cookie = Parameters<BrowserContext['addCookies']>[0][number];

const SECURE_NAME = '__Secure-next-auth.session-token';
const PLAIN_NAME = 'next-auth.session-token';
const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;
const CHUNK_COUNT = 3;

export interface MintedLegacySession {
  shape: LegacySessionShape;
  /** The `authSessionId` claim inside the cookie: the session id a bridge keeps. */
  authSessionId: string;
  /** The names of the cookies added, which is all a spec should ever print. */
  cookieNames: string[];
  cookies: Cookie[];
}

/** The claims a credentials sign-in leaves on the token (auth-options.ts `jwt`), minus the avatar cache. */
async function encodeSessionJwt(account: SeededAccount, secret: string, authSessionId: string): Promise<string> {
  return encode({
    secret,
    maxAge: THIRTY_DAYS_SECONDS,
    token: {
      sub: account.userId,
      id: account.userId,
      name: account.name,
      email: account.email,
      picture: null,
      gen: 0,
      authSessionId,
      auth_time: Math.floor(Date.now() / 1000),
      profileAvatarUrl: null,
      profileDisplayName: null,
      profileClaimsRefreshedAt: Date.now(),
    },
  });
}

export async function mintLegacySession(
  account: SeededAccount,
  shape: LegacySessionShape,
  secret: string,
): Promise<MintedLegacySession> {
  const authSessionId = randomUUID();
  const value = await encodeSessionJwt(account, secret, authSessionId);
  const expires = Math.floor(Date.now() / 1000) + THIRTY_DAYS_SECONDS;
  const base = { httpOnly: true, sameSite: 'Lax' as const, expires };
  const parentDomain = { ...base, path: '/', domain: COOKIE_DOMAIN };
  let cookies: Cookie[];
  if (shape === 'normal') {
    cookies = [{ ...parentDomain, name: SECURE_NAME, value, secure: true }];
  } else if (shape === 'chunked') {
    const chunkLength = Math.ceil(value.length / CHUNK_COUNT);
    cookies = Array.from({ length: CHUNK_COUNT }, (_, index) => ({
      ...parentDomain,
      name: `${SECURE_NAME}.${index}`,
      value: value.slice(index * chunkLength, (index + 1) * chunkLength),
      secure: true,
    }));
  } else if (shape === 'host-only') {
    // A `url` instead of a `domain` makes the cookie host-only on www; Playwright takes no `path` with it.
    cookies = [{ ...base, url: WWW_ORIGIN, name: SECURE_NAME, value, secure: true }];
  } else {
    cookies = [{ ...parentDomain, name: PLAIN_NAME, value, secure: false }];
  }
  return { shape, authSessionId, cookieNames: cookies.map((cookie) => cookie.name), cookies };
}

export async function addLegacySession(
  context: BrowserContext,
  account: SeededAccount,
  shape: LegacySessionShape,
  secret: string,
): Promise<MintedLegacySession> {
  const minted = await mintLegacySession(account, shape, secret);
  await context.addCookies(minted.cookies);
  return minted;
}
