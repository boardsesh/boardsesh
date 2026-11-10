import 'server-only';
import { cookies } from 'next/headers';
import { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { isLinkGuardedSignIn, isRecentSignIn, readAuthTimeClaim } from '@boardsesh/auth-protocol/auth-time';
import { isSecureCookieContext, sessionCookieNameCandidates } from '@/app/lib/auth/secure-cookies';
import type { PartnerPageSessionSummary } from './page-views';

/**
 * What the partner sign-in and consent pages know about the www session, read
 * from the cookie alone.
 *
 * It decides only what a page says. The backend decides who may approve an
 * app, on every authorize and consent request, with the password-change check
 * and the account lookup this skips: a wrong guess here costs the climber one
 * extra sign-in, never an approval. So the pages need no database and no
 * backend round trip to render.
 *
 * `recentGuardedSignIn` is the cookie half of decision 19: a known `auth_time`
 * under 30 days old, minted while the web marked sign-ins `link_guarded`.
 */
export async function readPartnerPageSession(nowMs: number = Date.now()): Promise<PartnerPageSessionSummary | null> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((cookie) => `${cookie.name}=${encodeURIComponent(cookie.value)}`)
    .join('; ');
  // The cookie only: getToken would also take an Authorization header.
  const cookieRequest = new NextRequest('http://partner-oauth-page.invalid/', { headers: { cookie: cookieHeader } });
  for (const cookieName of sessionCookieNameCandidates()) {
    try {
      const token = await getToken({
        req: cookieRequest,
        cookieName,
        secureCookie: isSecureCookieContext(),
        secret: process.env.NEXTAUTH_SECRET,
      });
      if (!token) continue;
      const authTimeSeconds = readAuthTimeClaim(token.auth_time, nowMs);
      const email = typeof token.email === 'string' && token.email ? token.email : null;
      const name = typeof token.name === 'string' && token.name ? token.name : null;
      return {
        account: email ?? name,
        recentGuardedSignIn:
          authTimeSeconds !== null && isLinkGuardedSignIn(token) && isRecentSignIn(authTimeSeconds, nowMs),
        signedInAtMs: authTimeSeconds === null ? null : authTimeSeconds * 1000,
      };
    } catch {
      // An undecodable cookie is no session, to NextAuth as well.
    }
  }
  return null;
}
