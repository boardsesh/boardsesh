import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { webSessionMode } from '@boardsesh/auth-protocol';
import {
  isRecentSignIn,
  isSignInGoodForPartnerConsent,
  RECENT_SIGN_IN_MAX_AGE_SECONDS,
} from '@boardsesh/auth-protocol/auth-time';
import { readBrowserSessionCookies } from '@boardsesh/auth-protocol/browser-session-cookie';
import { isNewerLegacyLogin } from '@boardsesh/auth-protocol/legacy-login-precedence';
import {
  authSessionDenials,
  authSubjectCutoffs,
  oauthSession,
  userCredentials,
  users,
} from '@boardsesh/db/schema/auth';
import { verifyLegacyWebCookie, type VerifiedLegacyWebCredential } from '../legacy-web-credentials';
import { readFirstPartySession, type FirstPartySession } from '../authority/session-reader';
import { browserSessionCookieSecretFromEnvironment } from '../authority/browser-session-mode';
import { logger } from '../../utils/logger';
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
 * One row per login, so authorize, the consent screen and the consent post of
 * one login share it, and a different login (another account, or the same
 * account signed in again) never does. A bridged session gives the same id as
 * the legacy cookie it came from.
 */
function bridgedSessionId(userId: string, authSessionId: string, authTimeSeconds: number): string {
  return `nextauth_${createHash('sha256')
    .update(JSON.stringify(['partner-session-v1', userId, authSessionId, authTimeSeconds]))
    .digest('hex')}`;
}

/** The session store could not be read, or the cookie secret is unusable: the consent answers 503, never signed out. */
export class FirstPartySessionUnavailableError extends Error {
  constructor() {
    super('First-party session temporarily unavailable');
    this.name = 'FirstPartySessionUnavailableError';
  }
}

/** Whether the consent reads first-party cookies: only while the web session mode is on. An unknown value is off. */
export function readsFirstPartyCookies(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  try {
    return webSessionMode(environment) === 'backend-staging';
  } catch {
    return false;
  }
}

let unusableCookieSecretLogged = false;

/**
 * The cookie secret the consent verifies first-party cookies with, or
 * undefined while the mode is off. With the mode on and the secret missing,
 * short or reused, the consent is unavailable (503) and this is logged once per
 * process: answering as if the cookies were absent would fall back to a legacy
 * cookie, which may be an older login, even another account's.
 */
export function firstPartyCookieSecret(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  if (!readsFirstPartyCookies(environment)) return undefined;
  try {
    return browserSessionCookieSecretFromEnvironment(environment);
  } catch {
    if (!unusableCookieSecretLogged) {
      unusableCookieSecretLogged = true;
      logger.error('[partner-consent] AUTH_BROWSER_SESSION_COOKIE_SECRET is unusable; consent answers 503');
    }
    throw new FirstPartySessionUnavailableError();
  }
}

/**
 * The legacy cookie name this deployment writes: the `__Secure-` spelling (and
 * its chunks). Only it may outrank a first-party cookie; a plain-named copy
 * needs no `Secure` and is never honoured over one, as on www.
 */
const DEPLOYED_LEGACY_COOKIE_NAME = /^__Secure-next-auth\.session-token(?:\.\d+)?$/;

function writtenByThisDeployment(legacy: VerifiedLegacyWebCredential): boolean {
  return legacy.cookieNames.length > 0 && legacy.cookieNames.every((name) => DEPLOYED_LEGACY_COOKIE_NAME.test(name));
}

/** What a consent needs from a sign-in, whichever cookie proved it. */
interface ConsentSignIn {
  readonly userId: string;
  /** The login id; null for a cookie without one, which never consents. */
  readonly authSessionId: string | null;
  readonly generation: number;
  readonly signedInAt: Date | null;
  readonly linkGuarded: boolean;
}

function legacySignIn(credential: VerifiedLegacyWebCredential): ConsentSignIn {
  return {
    userId: credential.userId,
    authSessionId: credential.authSessionId,
    generation: credential.generation,
    signedInAt: credential.originalAuthenticatedAt,
    linkGuarded: credential.linkGuarded,
  };
}

/**
 * A canonical session as the consent reads it. A bridged session keeps the
 * legacy cookie's session id and its guarded sign-in time, so it names the
 * same partner session as that cookie did before the bridge and nobody
 * consents again at cutover. The bridged row of a cookie without a session id
 * has its lineage id as its own id; like that cookie, it has no login id.
 */
function canonicalSignIn(session: FirstPartySession): ConsentSignIn {
  return {
    userId: session.userId,
    authSessionId: session.lineageId === session.authSessionId ? null : session.authSessionId,
    generation: session.generation,
    signedInAt: session.authenticatedAt,
    linkGuarded: session.linkGuarded,
  };
}

/**
 * The climber behind a request, read from www's session cookies and nothing
 * else: no Better Auth cookie, header or body can name one. Decision 19
 * applies here, so only a sign-in under 30 days old, made while the web guarded
 * OAuth links (`link_guarded`), and later than the last password write, becomes
 * a partner session.
 *
 * `browserSessionCookieSecret` is set only while `CURRENT_STORE_WEB_SESSION_MODE`
 * is on (#7596, B6). Then the first-party cookies come first: a verified login
 * cookie, else a verified bridged one, read with `readFirstPartySession`. A
 * conflicted login cookie, or a conflicted bridged one with no login cookie,
 * is signed out; so is a verified cookie whose session is no longer live,
 * whatever legacy cookie is also there. The one exception is the stale-cookie
 * rule www applies (`isNewerLegacyLogin`, by the first-party cookie's kind): a
 * legacy cookie under the deployed `__Secure-` name that is a newer login than
 * the live session is used instead. Without a first-party cookie
 * only the deployed legacy cookie name counts. Nothing here writes a cookie or
 * bridges.
 *
 * The cookies are checked first, without the database, where they can be: a
 * request with no usable cookie never asks for `transaction`, which is how a
 * signed-out authorize runs outside one. Everything after that runs in the
 * request's transaction, in the lock order every issuer uses: `users` FOR
 * SHARE first. The password write time is read only once that lock is held, so
 * a request queued behind a reset reads the reset's time. `user_credentials`
 * itself is never locked: the legacy reset locks that row before `users`, and
 * taking both here could deadlock with it.
 */
export async function resolveFirstPartySession(
  cookieHeader: string | null,
  nextAuthSecret: string,
  transaction: () => PartnerDatabase,
  now: Date = new Date(),
  browserSessionCookieSecret?: string,
): Promise<FirstPartySessionOutcome> {
  if (browserSessionCookieSecret !== undefined) {
    const cookies = readBrowserSessionCookies(cookieHeader, browserSessionCookieSecret, true);
    if (cookies.conflicted.includes('login') || (!cookies.login && cookies.conflicted.includes('bridged')))
      return { status: 'signed-out' };
    const token = cookies.login ?? cookies.bridged;
    if (token !== undefined) {
      const read = await readFirstPartySession(transaction(), { kind: 'canonical-token', token }, now);
      if (read.status === 'unavailable') throw new FirstPartySessionUnavailableError();
      if (read.status === 'denied') return { status: 'signed-out' };
      const legacy = await verifyLegacyWebCookie(cookieHeader, nextAuthSecret, now);
      const newerLegacy =
        legacy !== null &&
        writtenByThisDeployment(legacy) &&
        isNewerLegacyLogin(
          {
            authSessionId: legacy.authSessionId ?? undefined,
            authTime: legacy.originalAuthenticatedAt
              ? Math.floor(legacy.originalAuthenticatedAt.getTime() / 1000)
              : undefined,
            issuedAt: Math.floor(legacy.issuedAt.getTime() / 1000),
          },
          { authSessionId: read.session.authSessionId, authenticatedAt: read.session.authenticatedAt },
          // The kind comes from the cookie's name, never from the session's source.
          cookies.login !== undefined ? 'login' : 'bridged',
        );
      return consentFor(newerLegacy ? legacySignIn(legacy) : canonicalSignIn(read.session), transaction, now);
    }
  }
  const credential = await verifyLegacyWebCookie(cookieHeader, nextAuthSecret, now);
  if (!credential || (browserSessionCookieSecret !== undefined && !writtenByThisDeployment(credential)))
    return { status: 'signed-out' };
  return consentFor(legacySignIn(credential), transaction, now);
}

async function consentFor(
  signIn: ConsentSignIn,
  transaction: () => PartnerDatabase,
  now: Date,
): Promise<FirstPartySessionOutcome> {
  const signedInAt = signIn.signedInAt;
  const authTimeSeconds = signedInAt ? Math.floor(signedInAt.getTime() / 1000) : null;
  // Every cookie a sign-in writes carries both; one without a login id predates them.
  // A sign-in the web made with its link guard off could have been bought by
  // linking a provider into an old session, so it never counts here.
  if (
    !signIn.authSessionId ||
    !signIn.linkGuarded ||
    authTimeSeconds === null ||
    !isRecentSignIn(authTimeSeconds, now.getTime())
  ) {
    return { status: 'sign-in-required' };
  }

  const database = transaction();
  // A deleted account's cookie stays decryptable for 30 days. No row, no climber.
  if (!(await lockClimber(database, signIn.userId))) return { status: 'signed-out' };
  // A revoke and a generation change both lock this user for update. Recheck
  // the selected login after our share lock, including legacy cookies during rollback.
  const [account] = await database
    .select({ passwordChangedAt: userCredentials.updatedAt, generation: authSubjectCutoffs.generation })
    .from(users)
    .leftJoin(userCredentials, eq(userCredentials.userId, users.id))
    .leftJoin(authSubjectCutoffs, eq(authSubjectCutoffs.userId, users.id))
    .leftJoin(
      authSessionDenials,
      and(eq(authSessionDenials.userId, users.id), eq(authSessionDenials.sessionId, signIn.authSessionId)),
    )
    .where(and(eq(users.id, signIn.userId), isNull(authSubjectCutoffs.deletedAt), isNull(authSessionDenials.sessionId)))
    .catch(() => {
      throw new FirstPartySessionUnavailableError();
    });
  if (!account || (account.generation ?? 0) !== signIn.generation) return { status: 'signed-out' };
  const consentSignIn = {
    authTimeSeconds,
    linkGuarded: signIn.linkGuarded,
    passwordChangedAt: account.passwordChangedAt,
  };
  if (!isSignInGoodForPartnerConsent(consentSignIn, now.getTime())) return { status: 'sign-in-required' };

  const sessionId = bridgedSessionId(signIn.userId, signIn.authSessionId, authTimeSeconds);
  await database
    .insert(oauthSession)
    .values({
      id: sessionId,
      // Never sent anywhere: the climber's only credential here is the www session cookie.
      token: randomBytes(32).toString('base64url'),
      userId: signIn.userId,
      // The provider takes a code's auth time and prompt freshness from this.
      createdAt: new Date(authTimeSeconds * 1000),
      updatedAt: now,
      expiresAt: new Date(authTimeSeconds * 1000 + RECENT_SIGN_IN_MAX_AGE_SECONDS * 1000 + SESSION_ROW_GRACE_MS),
    })
    .onConflictDoNothing({ target: oauthSession.id });
  const [session] = await database.select().from(oauthSession).where(eq(oauthSession.id, sessionId));
  const [user] = await database.select().from(users).where(eq(users.id, signIn.userId));
  if (!session || !user) throw new Error('Bridged partner session could not be read back.');
  return { status: 'signed-in', session, user };
}
