import 'server-only';
import type { NextAuthOptions } from 'next-auth';
import type { Adapter, AdapterAccount } from 'next-auth/adapters';
import { getToken, type JWT } from 'next-auth/jwt';
import { NextRequest } from 'next/server';
import { isRecentSignIn, readAuthTimeClaim } from '@boardsesh/auth-protocol/auth-time';
import { parsePartnerOAuthMode } from '@boardsesh/auth-protocol/partner-oauth-mode';

/** Named so NextAuth's logs say why the callback failed. It sends the browser to `error=Callback`. */
export class StaleSessionLinkError extends Error {
  constructor() {
    super('Refused to link a provider account into a session whose sign-in is unknown or over 30 days old.');
    this.name = 'StaleSessionLinkError';
  }
}

type SessionRead = { status: 'none' } | { status: 'read'; token: JWT } | { status: 'unreadable' };
type LinkAccount = NonNullable<Adapter['linkAccount']>;

/**
 * The session NextAuth itself will find on this callback: the configured cookie
 * name (with its chunks), decoded with the configured secret and decoder. Only
 * cookies, never an Authorization header, which NextAuth's callback ignores.
 */
async function readCallbackSession(base: NextAuthOptions, request: NextRequest): Promise<SessionRead> {
  const cookieName = base.cookies?.sessionToken?.name;
  if (!cookieName) return { status: 'unreadable' };
  if (!request.cookies.getAll().some(({ name }) => name.startsWith(cookieName))) return { status: 'none' };
  try {
    // The same cookies and nothing else: getToken would also take a Bearer header.
    const cookiesOnly = new NextRequest(request.url, { headers: { cookie: request.headers.get('cookie') ?? '' } });
    const token = await getToken({
      req: cookiesOnly,
      cookieName,
      secret: base.secret ?? process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET,
      decode: base.jwt?.decode,
    });
    // An expired or undecodable cookie is no session to NextAuth either.
    return token ? { status: 'read', token } : { status: 'none' };
  } catch {
    return { status: 'unreadable' };
  }
}

/**
 * Request-local options for an OAuth callback in legacy mode.
 *
 * When a callback arrives with a live session and the provider account is not
 * linked yet, NextAuth links it into the session's user and then runs the jwt
 * callback with `user` and `account`, which writes a fresh `auth_time`. Without
 * this guard, a 40-day-old cookie, or one from before a password reset, would
 * buy a new sign-in time, and pass partner consent's 30-day rule, just by
 * linking some Google account the holder controls. Dropping the claim on this
 * request would not be enough: the link itself would stay, and a later plain
 * Google sign-in would then mint a real one.
 *
 * So `linkAccount` refuses a link into a session unless that session's own
 * sign-in is known and under 30 days old. Nothing else changes: a sign-in with
 * no session cookie, a provider account already linked to this user, and a
 * new account all run as before. Staged mode needs none of this, because its
 * adapter refuses every link and the backend refuses to link into an actor.
 *
 * The guard only matters once partner consent can exist, so it follows the
 * same `PARTNER_OAUTH_MODE` the backend reads, and does nothing while that is
 * `off` (absent, empty or misspelled included). Every cookie from before the
 * claim lacks `auth_time`, so guarding earlier would refuse every signed-in
 * climber's link. The web service needs the variable set whenever the backend's
 * mode leaves `off`.
 */
export async function withSessionLinkGuard(base: NextAuthOptions, request: NextRequest): Promise<NextAuthOptions> {
  if (parsePartnerOAuthMode(process.env.PARTNER_OAUTH_MODE) === 'off') return base;
  // The adapter type is a union of NextAuth's and Auth.js's; both take one account.
  const linkAccount = base.adapter?.linkAccount as unknown as ((account: AdapterAccount) => unknown) | undefined;
  if (!base.adapter || !linkAccount) return base;
  const callbackSession = await readCallbackSession(base, request);
  const guardedLinkAccount = (account: AdapterAccount) => {
    if (callbackSession.status === 'unreadable') throw new StaleSessionLinkError();
    // NextAuth links into the cookie's user, so a matching user id is that link.
    // Any other link is to a user this callback created or matched by email.
    if (callbackSession.status === 'read' && callbackSession.token.sub === account.userId) {
      const now = Date.now();
      if (!isRecentSignIn(readAuthTimeClaim(callbackSession.token.auth_time, now), now)) {
        throw new StaleSessionLinkError();
      }
    }
    return linkAccount(account);
  };
  // Not async, so a refusal throws where NextAuth awaits the call, as a failed write would.
  const adapter: Adapter = { ...base.adapter, linkAccount: guardedLinkAccount as unknown as LinkAccount };
  return { ...base, adapter };
}
