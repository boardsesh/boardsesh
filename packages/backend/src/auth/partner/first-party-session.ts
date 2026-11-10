import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  isRecentSignIn,
  isSignInGoodForPartnerConsent,
  RECENT_SIGN_IN_MAX_AGE_SECONDS,
} from '@boardsesh/auth-protocol/auth-time';
import { oauthSession, userCredentials, users } from '@boardsesh/db/schema/auth';
import { verifyLegacyWebCookie } from '../legacy-web-credentials';
import { lockClimber } from './locks';
import type { PartnerDatabase } from './tables';

/** Long enough for a session-bound access token issued at the very end of the 30 days to run its hour. */
const SESSION_ROW_GRACE_MS = 60 * 60 * 1000;

export type PartnerSessionRow = typeof oauthSession.$inferSelect;
export type PartnerUserRow = typeof users.$inferSelect;

export type FirstPartySessionOutcome =
  /** No session cookie the web would accept, or the account is gone. */
  | { status: 'signed-out' }
  /** A real session whose sign-in is unknown, over 30 days old, or older than the last password change. */
  | { status: 'sign-in-required' }
  | { status: 'signed-in'; session: PartnerSessionRow; user: PartnerUserRow };

/**
 * One row per NextAuth login, so authorize, the consent screen and the consent
 * post of one login share it, and a different login (another account, or the
 * same account signed in again) never does.
 */
function bridgedSessionId(userId: string, authSessionId: string, authTimeSeconds: number): string {
  return `nextauth_${createHash('sha256')
    .update(JSON.stringify(['partner-session-v1', userId, authSessionId, authTimeSeconds]))
    .digest('hex')}`;
}

/**
 * The climber behind a request, read from the www NextAuth session cookie and
 * nothing else: no Better Auth cookie, header or body can name one. Decision 19
 * applies here, so only a sign-in under 30 days old, made while the web guarded
 * OAuth links (`link_guarded`), and later than the last password write, becomes
 * a partner session.
 *
 * The cookie is checked first, without the database: a request with no usable
 * cookie never asks for `transaction`, which is how a signed-out authorize runs
 * outside one. Everything after that runs in the request's transaction, in the
 * lock order every issuer uses: `users` FOR SHARE first. The password write time
 * is read only once that lock is held, so a request queued behind a reset reads
 * the reset's time. `user_credentials` itself is never locked: the legacy reset
 * locks that row before `users`, and taking both here could deadlock with it.
 */
export async function resolveFirstPartySession(
  cookieHeader: string | null,
  nextAuthSecret: string,
  transaction: () => PartnerDatabase,
  now: Date = new Date(),
): Promise<FirstPartySessionOutcome> {
  const credential = await verifyLegacyWebCookie(cookieHeader, nextAuthSecret, now);
  if (!credential) return { status: 'signed-out' };
  const signedInAt = credential.originalAuthenticatedAt;
  const authTimeSeconds = signedInAt ? Math.floor(signedInAt.getTime() / 1000) : null;
  // Every cookie a sign-in writes carries both; one without a login id predates them.
  // A sign-in the web made with its link guard off could have been bought by
  // linking a provider into an old session, so it never counts here.
  if (
    !credential.authSessionId ||
    !credential.linkGuarded ||
    authTimeSeconds === null ||
    !isRecentSignIn(authTimeSeconds, now.getTime())
  ) {
    return { status: 'sign-in-required' };
  }

  const database = transaction();
  // A deleted account's cookie stays decryptable for 30 days. No row, no climber.
  if (!(await lockClimber(database, credential.userId))) return { status: 'signed-out' };
  const [password] = await database
    .select({ updatedAt: userCredentials.updatedAt })
    .from(userCredentials)
    .where(eq(userCredentials.userId, credential.userId));
  const signIn = {
    authTimeSeconds,
    linkGuarded: credential.linkGuarded,
    passwordChangedAt: password?.updatedAt ?? null,
  };
  if (!isSignInGoodForPartnerConsent(signIn, now.getTime())) return { status: 'sign-in-required' };

  const sessionId = bridgedSessionId(credential.userId, credential.authSessionId, authTimeSeconds);
  await database
    .insert(oauthSession)
    .values({
      id: sessionId,
      // Never sent anywhere: the climber's only credential here is the NextAuth cookie.
      token: randomBytes(32).toString('base64url'),
      userId: credential.userId,
      // The provider takes a code's auth time and prompt freshness from this.
      createdAt: new Date(authTimeSeconds * 1000),
      updatedAt: now,
      expiresAt: new Date(authTimeSeconds * 1000 + RECENT_SIGN_IN_MAX_AGE_SECONDS * 1000 + SESSION_ROW_GRACE_MS),
    })
    .onConflictDoNothing({ target: oauthSession.id });
  const [session] = await database.select().from(oauthSession).where(eq(oauthSession.id, sessionId));
  const [user] = await database.select().from(users).where(eq(users.id, credential.userId));
  if (!session || !user) throw new Error('Bridged partner session could not be read back.');
  return { status: 'signed-in', session, user };
}
