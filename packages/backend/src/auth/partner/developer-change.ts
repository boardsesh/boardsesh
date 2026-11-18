import { eq, sql } from 'drizzle-orm';
import { userCredentials, users } from '@boardsesh/db/schema/auth';
import type { WebSignInProof } from '@boardsesh/shared-schema';
import {
  isSignInGoodForPartnerAppChange,
  PARTNER_APP_CHANGE_SIGN_IN_MAX_AGE_SECONDS,
} from '@boardsesh/auth-protocol/auth-time';
import { PartnerRegistrationError } from './registration-rules';
import type { PartnerDatabase } from './tables';

/**
 * Advisory lock namespace for one developer's registrations (#6982, BA-08). The
 * second key is the developer id hashed; a collision only adds a wait. Taken
 * before any row lock, so it never joins the issuers' lock order.
 */
const REGISTRATION_LOCK_NAMESPACE = 6982;

export async function lockDeveloper(transaction: PartnerDatabase, developerId: string): Promise<void> {
  await transaction.execute(
    sql`select pg_advisory_xact_lock(${REGISTRATION_LOCK_NAMESPACE}, hashtext(${developerId}))`,
  );
}

/** The developer's address, read with their `users` row. */
type DeveloperAddress = { readonly email: string; readonly emailVerified: boolean };

function recentSignInRefusal(): PartnerRegistrationError {
  return new PartnerRegistrationError(
    'recent_sign_in_required',
    `Sign in again to make this change. Changing redirect URIs, making a new client secret or deleting an app needs a sign-in from the last ${PARTNER_APP_CHANGE_SIGN_IN_MAX_AGE_SECONDS / 60} minutes.`,
  );
}

/**
 * The gate in front of every change that decides where an app's codes and
 * tokens go: a redirect URI added, replaced or removed, a new client secret,
 * or the app deleted (#7598). Anyone holding an older session, on a shared
 * laptop or with a copied cookie, could otherwise point the app at their own
 * redirect and take its secret.
 *
 * The sign-in comes from the credential the request authenticated with: the
 * www session's `auth_time` and `link_guarded`, read the way partner consent
 * reads them (`legacyWebSignIn`). It must be under
 * `PARTNER_APP_CHANGE_SIGN_IN_MAX_AGE_SECONDS` old and clearly after the
 * developer's last password write. An unknown age, an app token or a WebSocket
 * call is refused.
 *
 * Runs after the developer's advisory lock and before any write. The
 * developer's `users` row is taken FOR SHARE first, the partner lock order, and
 * the password write time is read once it is held, so a change queued behind a
 * password reset reads the reset's time. An account deleted while this waited
 * took its apps with it, so that reads as the app being gone. Returns the
 * address for the notice.
 */
export async function requireRecentSignIn(
  transaction: PartnerDatabase,
  developerId: string,
  signIn: WebSignInProof | null | undefined,
): Promise<DeveloperAddress> {
  if (!signIn?.linkGuarded || signIn.authenticatedAtMs === null) throw recentSignInRefusal();
  const [developer] = await transaction
    .select({ email: users.email, emailVerified: users.emailVerified })
    .from(users)
    .where(eq(users.id, developerId))
    .for('share');
  if (!developer) throw new PartnerRegistrationError('not_found', 'No app with that client ID.');
  const [password] = await transaction
    .select({ updatedAt: userCredentials.updatedAt })
    .from(userCredentials)
    .where(eq(userCredentials.userId, developerId));
  const recent = isSignInGoodForPartnerAppChange(
    {
      authTimeSeconds: Math.floor(signIn.authenticatedAtMs / 1000),
      linkGuarded: signIn.linkGuarded,
      passwordChangedAt: password?.updatedAt ?? null,
    },
    Date.now(),
  );
  if (!recent) throw recentSignInRefusal();
  return { email: developer.email, emailVerified: developer.emailVerified !== null };
}
