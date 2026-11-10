import 'server-only';
import type { NextAuthOptions } from 'next-auth';
import type { Adapter, AdapterAccount } from 'next-auth/adapters';
import { getToken, type JWT } from 'next-auth/jwt';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import {
  isLinkGuardedSignIn,
  isSignInGoodForPartnerConsent,
  readAuthTimeClaim,
} from '@boardsesh/auth-protocol/auth-time';
import { partnerLinkGuardActive } from './partner-link-guard-mode';

/** Named so NextAuth's logs say why the callback failed. It sends the browser to `error=Callback`. */
export class StaleSessionLinkError extends Error {
  constructor() {
    super('Refused to link a provider account into a session that could not approve a partner app.');
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
 * The climber's last password write, read on the primary like every web
 * credential read. Loaded on first use: the route module imports this file, and
 * the database client opens its pool on import.
 */
async function passwordChangedAt(userId: string): Promise<Date | null> {
  const [{ getDb }, schema] = await Promise.all([import('@/app/lib/db/db'), import('@/app/lib/db/schema')]);
  const [password] = await getDb()
    .select({ updatedAt: schema.userCredentials.updatedAt })
    .from(schema.userCredentials)
    .where(eq(schema.userCredentials.userId, userId))
    .limit(1);
  return password?.updatedAt ?? null;
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
 * sign-in could approve a partner app itself: the rule consent applies
 * (`isSignInGoodForPartnerConsent`), known, under 30 days old, made while links
 * were guarded (`link_guarded`), and clearly after the last password write, so
 * neither an old cookie nor one from before a reset can buy a new sign-in time,
 * and a sign-in bought while the guard was off cannot be laundered through a
 * second link once it is on. Nothing else changes: a sign-in with
 * no session cookie, a provider account already linked to this user, and a
 * new account all run as before. Staged mode needs none of this, because its
 * adapter refuses every link and the backend refuses to link into an actor.
 *
 * The guard only matters once partner consent can exist, so it follows the
 * same `PARTNER_OAUTH_MODE` the backend reads, and does nothing while that is
 * `off` (absent, empty or misspelled included). That defers its cost rather than
 * avoiding it: NextAuth re-issues cookies on every use but writes `auth_time`
 * and `link_guarded` only at sign-in, so when the mode turns on every climber
 * must sign in once before linking a provider. The web service needs the
 * variable set whenever the backend's mode leaves `off`.
 */
export async function withSessionLinkGuard(base: NextAuthOptions, request: NextRequest): Promise<NextAuthOptions> {
  if (!partnerLinkGuardActive()) return base;
  // The adapter type is a union of NextAuth's and Auth.js's; both take one account.
  const linkAccount = base.adapter?.linkAccount as unknown as ((account: AdapterAccount) => unknown) | undefined;
  if (!base.adapter || !linkAccount) return base;
  const callbackSession = await readCallbackSession(base, request);
  const guardedLinkAccount = async (account: AdapterAccount) => {
    if (callbackSession.status === 'unreadable') throw new StaleSessionLinkError();
    // NextAuth links into the cookie's user, so a matching user id is that link.
    // Any other link is to a user this callback created or matched by email.
    if (callbackSession.status === 'read' && callbackSession.token.sub === account.userId) {
      const { token } = callbackSession;
      const now = Date.now();
      const signIn = {
        authTimeSeconds: readAuthTimeClaim(token.auth_time, now),
        linkGuarded: isLinkGuardedSignIn(token),
        // Read only for a link into a session, and failing shut: no answer, no link.
        passwordChangedAt: await passwordChangedAt(account.userId).catch(() => {
          throw new StaleSessionLinkError();
        }),
      };
      if (!isSignInGoodForPartnerConsent(signIn, now)) throw new StaleSessionLinkError();
    }
    return linkAccount(account);
  };
  // NextAuth awaits linkAccount, so a refusal fails the callback as a failed write would.
  const adapter: Adapter = { ...base.adapter, linkAccount: guardedLinkAccount as unknown as LinkAccount };
  return { ...base, adapter };
}
