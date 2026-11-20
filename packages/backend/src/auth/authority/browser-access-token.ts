import { createSecretKey, hkdfSync, type KeyObject } from 'node:crypto';
import { SignJWT, decodeJwt, jwtVerify } from 'jose';
import { eq, inArray } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  BROWSER_ACCESS_TOKEN_AUDIENCE,
  BROWSER_ACCESS_TOKEN_ISSUER,
  BROWSER_ACCESS_TOKEN_LIFETIME_SECONDS,
} from '@boardsesh/auth-protocol';
import {
  authCredentialLineage,
  authSession,
  authSessionDenials,
  authSubjectCutoffs,
  users,
} from '@boardsesh/db/schema/auth';
import { readOnAdmissionConnection } from '../admission-pool';
import { createAdmissionCoalescer } from '../admission-read-coalescer';
import {
  AUTH_ADMISSION_BATCH_SIZE,
  AuthAdmissionUnavailableError,
  runAuthAdmissionRead,
} from '../admission-read-runner';
import type { SubjectCutoffState } from '../credential-cutoffs';
import { admitsFirstPartySession, canonicalFirstPartySession, type FirstPartySession } from './session-reader';

/**
 * The 15-minute browser access token (#7596, B3a, owner decision 14). An HS256
 * JWS for one live web session. It proves which session a request comes from;
 * it never proves the session is still live. Every request re-reads the
 * session (`readBrowserSessions`) by exactly the rules the cookie read uses.
 */

/** Accepted clock difference between this backend's replicas and a token's `iat`/`exp`. */
export const BROWSER_ACCESS_TOKEN_CLOCK_TOLERANCE_SECONDS = 30;
const BROWSER_ACCESS_TOKEN_KEY_LABEL = 'boardsesh-browser-access-token-key-v1';

/** Holds a `KeyObject`, so logging it prints no key bytes. */
export interface BrowserAccessTokenKey {
  readonly kind: 'browser-access-token-key';
  readonly key: KeyObject;
}

/**
 * Derives the signing key from `AUTH_BROWSER_ACCESS_TOKEN_SECRET` with
 * HKDF-SHA256 and a fixed label, so the secret itself is never the HMAC key.
 * At least 32 bytes, no surrounding spaces.
 */
export function browserAccessTokenKey(secret: string): BrowserAccessTokenKey {
  if (!secret || secret !== secret.trim() || Buffer.byteLength(secret, 'utf8') < 32)
    throw new Error('Invalid browser access token secret');
  const material = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), BROWSER_ACCESS_TOKEN_KEY_LABEL, 32));
  return Object.freeze({ kind: 'browser-access-token-key', key: createSecretKey(material) });
}

export interface IssuedBrowserAccessToken {
  readonly token: string;
  readonly expiresAt: Date;
}

/**
 * Signs a token for a session the reader admitted just now. `exp` is the
 * earlier of 15 minutes and the row's own expiry. `auth_time` is set only for
 * a `login` session, so a bridged or carried one carries no sign-in time.
 * Undefined when the session ends within the second.
 */
export async function issueBrowserAccessToken(
  tokenKey: BrowserAccessTokenKey,
  session: FirstPartySession,
  now: Date,
): Promise<IssuedBrowserAccessToken | undefined> {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const sessionExpiresAt = Math.floor(session.expiresAt.getTime() / 1000);
  const expiresAt = Math.min(issuedAt + BROWSER_ACCESS_TOKEN_LIFETIME_SECONDS, sessionExpiresAt);
  if (expiresAt <= issuedAt) return undefined;
  const signedInAt = session.source === 'login' ? session.authenticatedAt : null;
  const token = await new SignJWT({
    sid: session.authSessionId,
    gen: session.generation,
    sexp: sessionExpiresAt,
    link_guarded: session.linkGuarded,
    ...(signedInAt ? { auth_time: Math.floor(signedInAt.getTime() / 1000) } : {}),
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(session.userId)
    .setIssuer(BROWSER_ACCESS_TOKEN_ISSUER)
    .setAudience(BROWSER_ACCESS_TOKEN_AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(tokenKey.key);
  return { token, expiresAt: new Date(expiresAt * 1000) };
}

/** What a verified token names. Admission is decided by the session read, never by these claims alone. */
export interface VerifiedBrowserAccessToken {
  readonly userId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly expiresAt: Date;
}

/**
 * Whether a token says it is a browser access token. Reads the unverified
 * audience only to choose a verifier; nothing is trusted from it.
 */
export function claimsBrowserAudience(token: string): boolean {
  // The verifier refuses longer tokens anyway; never decode one.
  if (token.length > 4096) return false;
  try {
    const { aud } = decodeJwt(token);
    return aud === BROWSER_ACCESS_TOKEN_AUDIENCE || (Array.isArray(aud) && aud.includes(BROWSER_ACCESS_TOKEN_AUDIENCE));
  } catch {
    return false;
  }
}

function isIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024;
}

/**
 * Strict: HS256 only (so never `none`), this audience and issuer, 30 seconds
 * of clock skew, a lifetime no longer than 15 minutes, and every claim this
 * backend writes, with its type. `sexp` and `link_guarded` are required but
 * never trusted: the session read decides expiry and sign-in proof. Null for anything else; the error never leaves.
 */
export async function verifyBrowserAccessToken(
  tokenKey: BrowserAccessTokenKey,
  token: string,
  now = new Date(),
): Promise<VerifiedBrowserAccessToken | null> {
  if (!token || token.length > 4096) return null;
  try {
    const { payload } = await jwtVerify(token, tokenKey.key, {
      algorithms: ['HS256'],
      audience: BROWSER_ACCESS_TOKEN_AUDIENCE,
      issuer: BROWSER_ACCESS_TOKEN_ISSUER,
      clockTolerance: BROWSER_ACCESS_TOKEN_CLOCK_TOLERANCE_SECONDS,
      currentDate: now,
      requiredClaims: ['sub', 'sid', 'gen', 'sexp', 'link_guarded', 'iat', 'exp'],
    });
    const { sub, sid, gen, sexp, link_guarded: linkGuarded, iat, exp } = payload;
    if (
      typeof sexp !== 'number' ||
      typeof linkGuarded !== 'boolean' ||
      !isIdentity(sub) ||
      !isIdentity(sid) ||
      typeof gen !== 'number' ||
      !Number.isSafeInteger(gen) ||
      gen < 0 ||
      typeof iat !== 'number' ||
      typeof exp !== 'number' ||
      exp <= iat ||
      exp - iat > BROWSER_ACCESS_TOKEN_LIFETIME_SECONDS ||
      iat * 1000 > now.getTime() + BROWSER_ACCESS_TOKEN_CLOCK_TOLERANCE_SECONDS * 1000
    )
      return null;
    return { userId: sub, sessionId: sid, generation: gen, expiresAt: new Date(exp * 1000) };
  } catch {
    return null;
  }
}

type AdmissionDatabase = Pick<PostgresJsDatabase, 'select'>;

/**
 * The sessions with these ids that are live right now, keyed by id: the row
 * rules (`canonicalFirstPartySession`) and the account rules
 * (`admitsFirstPartySession`) the cookie read applies, from ONE indexed
 * statement (`auth_session` by primary key, its lineage by primary key, the
 * account, its cutoff row and a denial of this id).
 */
export async function selectLiveSessions(
  database: AdmissionDatabase,
  sessionIds: readonly string[],
  now: Date,
): Promise<ReadonlyMap<string, FirstPartySession>> {
  const requested = [...new Set(sessionIds)];
  const live = new Map<string, FirstPartySession>();
  if (!requested.length) return live;
  const rows = await database
    .select({
      session: authSession,
      lineage: authCredentialLineage,
      accountId: users.id,
      generation: authSubjectCutoffs.generation,
      nativeGeneration: authSubjectCutoffs.nativeGeneration,
      deletedAt: authSubjectCutoffs.deletedAt,
      deniedSessionId: authSessionDenials.sessionId,
    })
    .from(authSession)
    .leftJoin(users, eq(users.id, authSession.userId))
    .leftJoin(authCredentialLineage, eq(authCredentialLineage.id, authSession.legacyLineageId))
    .leftJoin(authSubjectCutoffs, eq(authSubjectCutoffs.userId, authSession.userId))
    .leftJoin(authSessionDenials, eq(authSessionDenials.sessionId, authSession.id))
    .where(inArray(authSession.id, requested));
  for (const row of rows) {
    const session = canonicalFirstPartySession(row.session, row.lineage ?? undefined, now);
    if (!session) continue;
    // The same state `readHumanSubjectStates` builds; only this id's denial matters.
    const subject: SubjectCutoffState | undefined =
      row.accountId === null || row.deletedAt !== null
        ? undefined
        : {
            generation: row.generation ?? 0,
            nativeGeneration: row.nativeGeneration ?? 0,
            deniedSessionKeys: new Set(row.deniedSessionId ? [row.deniedSessionId] : []),
          };
    if (admitsFirstPartySession(session, subject, now)) live.set(session.authSessionId, session);
  }
  return live;
}

/** `selectLiveSessions` on the bounded auth admission pool, with its deadline. Throws unavailable on an outage. */
export async function readLiveSessions(
  sessionIds: readonly string[],
  now = new Date(),
): Promise<ReadonlyMap<string, FirstPartySession>> {
  if (sessionIds.length > AUTH_ADMISSION_BATCH_SIZE) throw new AuthAdmissionUnavailableError();
  if (!sessionIds.length) return new Map();
  return runAuthAdmissionRead((markExecuting) =>
    readOnAdmissionConnection(markExecuting, (admissionDatabase) =>
      selectLiveSessions(admissionDatabase, sessionIds, now),
    ),
  );
}

/**
 * The session a verified token names, if it is live and is the one the token
 * was signed for: same account and same generation (a password change on this
 * session moves both the row and the account, so a token signed before it is
 * refused).
 */
/**
 * The request path's session read, coalesced by session id (#7596, review of
 * B3a, H1): a burst of browser requests shares a few reads instead of taking
 * one runner slot each, and shares the `per-request` read slots with the
 * account read the app and web credentials use, so neither can starve the
 * other. A caller only joins a read that has not started: never a cache.
 */
const readCoalescedLiveSession = createAdmissionCoalescer(
  (sessionIds: readonly string[]) => readLiveSessions(sessionIds),
  'per-request',
);

export async function readBrowserAccessSession(
  verified: VerifiedBrowserAccessToken,
): Promise<FirstPartySession | undefined> {
  const session = await readCoalescedLiveSession(verified.sessionId);
  if (!session || session.userId !== verified.userId || session.generation !== verified.generation) return undefined;
  return session;
}
