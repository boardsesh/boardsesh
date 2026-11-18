import { randomUUID } from 'node:crypto';
import { and, eq, gt, isNotNull, isNull, lt, ne, notExists, notLike, or, sql, type SQL } from 'drizzle-orm';
import {
  WEB_SESSION_LIFETIME_SECONDS,
  WEB_SESSION_ROLL_BELOW_REMAINING_SECONDS,
  type PresentedWebSession,
} from '@boardsesh/auth-protocol';
import {
  authCredentialLineage,
  authSession,
  authSessionDenials,
  authSubjectCutoffs,
  userProfiles,
  users,
} from '@boardsesh/db/schema/auth';
import { requireHumanSubjectForIssuance } from '../human-admission';
import {
  captureExpectedAuthority,
  CurrentStoreFoundationError,
  requireReadCommitted,
  type ExpectedCurrentStoreAuthority,
} from '../current-store/foundation-context';
import { transactionSettings } from '../current-store/command-context';
import type { AuthorityDatabase, AuthorityTransaction } from './adapter';
import { bridgeLegacyCredential } from './bridge';
import { denyFirstPartySessionInTransaction } from './lineage';
import { revalidateIdentityAuthority, type IdentityAuthorityReceipt } from './router';
import { readFirstPartySession, type FirstPartyCredential, type FirstPartySession } from './session-reader';
import { newSessionToken, type BridgeTokenKey } from './session-token';

export { WEB_SESSION_LIFETIME_SECONDS, WEB_SESSION_ROLL_BELOW_REMAINING_SECONDS };

const WEB_SESSION_LIFETIME_MS = WEB_SESSION_LIFETIME_SECONDS * 1000;
const WEB_SESSION_ROLL_BELOW_REMAINING_MS = WEB_SESSION_ROLL_BELOW_REMAINING_SECONDS * 1000;

/**
 * The `legacy_lineage_id` of a `carried` session: no lineage row has this id,
 * so the reader finds none to check, but the column is not null, so the
 * session reads as `bridge` and never as a fresh login. No new column needed.
 */
export const CARRIED_WEB_SESSION_LINEAGE_PREFIX = 'carried:';

/**
 * `login`: the caller verified a credential just now, so the sign-in time may
 * pass a five-minute freshness check. `carried`: the sign-in happened
 * elsewhere (a native transfer, a provider sign-in without a verified
 * `auth_time`), so the row keeps that time for the 30-day rules but never
 * passes `requireFreshAuthentication` or `webSignInProof`, like a bridged row.
 */
export type WebSessionFreshness = 'login' | 'carried';

export interface WebSessionIssue {
  /**
   * The account whose credential the caller verified, in this transaction.
   * A caller that locks `users` rows before calling must lock this account and
   * the presented one in one pass with `lockWebSessionAccounts`; holding only
   * its own row and then calling deadlocks against a crossed login.
   */
  readonly userId: string;
  /** When that credential was verified: the real sign-in time. Never later than `now`. */
  readonly authenticatedAt: Date;
  /** Defaults to `login`. */
  readonly freshness?: WebSessionFreshness;
  /**
   * The admitted first-party session that arrived on the login request, legacy
   * cookie or canonical, of any account, exactly as `readFirstPartySession`
   * returned it in this transaction. Revoked here when it has its own session
   * id; one that `requiresAccountCutoff` is left alone.
   */
  readonly presented?: FirstPartySession;
  readonly now: Date;
  /** The authority the caller captured before its slow work. A switch since is `STALE_AUTHORITY`. */
  readonly authority: IdentityAuthorityReceipt;
}

export interface IssuedWebSession {
  readonly sessionId: string;
  /** The raw opaque token, returned this once. The row stores only its digest, so nothing can hand it out again. */
  readonly token: string;
  readonly expiresAt: Date;
  readonly generation: number;
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/** Copy every caller object before the first await, as `denyFirstPartySession` does. */
function captureIssue(input: WebSessionIssue) {
  const now = new Date(input.now.getTime());
  const authenticatedAt = new Date(input.authenticatedAt.getTime());
  if (
    typeof input.userId !== 'string' ||
    !input.userId ||
    !validDate(now) ||
    !validDate(authenticatedAt) ||
    authenticatedAt.getTime() <= 0 ||
    authenticatedAt.getTime() > now.getTime()
  )
    throw new CurrentStoreFoundationError('INVALID_COMMAND');
  const freshness = input.freshness ?? 'login';
  if (freshness !== 'login' && freshness !== 'carried') throw new CurrentStoreFoundationError('INVALID_COMMAND');
  return {
    userId: input.userId,
    authenticatedAt,
    freshness,
    now,
    presented: input.presented && {
      ...input.presented,
      authenticatedAt: input.presented.authenticatedAt && new Date(input.presented.authenticatedAt.getTime()),
      expiresAt: new Date(input.presented.expiresAt.getTime()),
    },
    authority: { ...input.authority },
  };
}

/**
 * The `users` row locks a web-session issuance needs, in one pass in
 * `users.id` order, each at its final strength: FOR UPDATE for the presented
 * session's account, whose rows are revoked, and FOR KEY SHARE for every row
 * `signingIn` selects. Two logins that present each other's sessions then
 * queue instead of deadlocking, and no row is upgraded later. Every caller
 * that locks `users` before `issueWebSession` uses this instead of its own
 * statement. `limit` bounds the rows `signingIn` may name, plus one for the
 * presented account. Returns whether the presented account still exists.
 */
export async function lockWebSessionAccounts(
  transaction: AuthorityTransaction,
  signingIn: SQL,
  presentedUserId: string | undefined,
  limit = 1,
): Promise<{ readonly presentedAccountExists: boolean }> {
  const accounts = await transaction
    .select({ id: users.id })
    .from(users)
    .where(presentedUserId === undefined ? signingIn : or(signingIn, eq(users.id, presentedUserId)))
    .orderBy(users.id)
    .limit(limit + 1);
  let presentedAccountExists = false;
  for (const { id } of accounts) {
    const account = transaction.select({ id: users.id }).from(users).where(eq(users.id, id));
    if (id !== presentedUserId) await account.for('key share');
    else presentedAccountExists = (await account.for('update')).length === 1;
  }
  return { presentedAccountExists };
}

/**
 * Issue a first-party web session for a verified sign-in, in the caller's
 * transaction, and revoke the session the login presented in the same one.
 * The caller verified the credential in this transaction and publishes the
 * token only after it commits.
 *
 * Lock order: the shared authority gate (and a manifest re-check), then
 * `users` rows in id order (`lockWebSessionAccounts`), then the presented
 * session's rows, then the new row. A caller that already holds a `users` row
 * must have taken it with `lockWebSessionAccounts` for this account and the
 * presented one.
 *
 * It refuses before writing anything: a deleted or missing account with
 * `AuthSubjectDeniedError`, as native issuance does, and a moved authority
 * with `STALE_AUTHORITY`. A presented session is revoked only through its own
 * session id. One that `requiresAccountCutoff` (a no-SID legacy cookie, or the
 * bridged row of one) ends only the row the bridge made from it, matched by
 * exact id and lineage, if there is one; nothing else of it is written, so a
 * login never cuts off an account and never moves its generation.
 */
export async function issueWebSession(
  transaction: AuthorityTransaction,
  input: WebSessionIssue,
): Promise<IssuedWebSession> {
  const request = captureIssue(input);
  await requireReadCommitted(transaction);
  await revalidateIdentityAuthority(transaction, request.authority);
  const presented = request.presented;
  const { presentedAccountExists } = await lockWebSessionAccounts(
    transaction,
    eq(users.id, request.userId),
    presented?.userId,
  );
  // Refuse before any write, so a caller that catches the refusal commits nothing.
  const subject = await requireHumanSubjectForIssuance(transaction, request.userId);
  // A deleted account's sessions are refused by every reader already.
  if (presented && presentedAccountExists) {
    const expectedAuthority = {
      expectedProjectionId: request.authority.projectionId,
      expectedNormalizerVersion: request.authority.normalizerVersion,
      expectedWriterEpoch: request.authority.epoch,
    };
    if (presented.requiresAccountCutoff)
      await endBridgedRowAlone(transaction, presented, request.now, expectedAuthority);
    else await denyFirstPartySessionInTransaction(transaction, presented, request.now, expectedAuthority);
  }
  const sessionId = randomUUID();
  const issued = newSessionToken();
  const expiresAt = new Date(request.now.getTime() + WEB_SESSION_LIFETIME_MS);
  await transaction.insert(authSession).values({
    id: sessionId,
    token: issued.stored,
    userId: request.userId,
    expiresAt,
    // Not a freshness input: readers use originalAuthenticatedAt.
    createdAt: request.authenticatedAt,
    updatedAt: request.now,
    originalAuthenticatedAt: request.authenticatedAt,
    // No lineage: this row's source is `login`. A carried one names no lineage
    // row but reads as `bridge`, so it is never fresh.
    legacyLineageId: request.freshness === 'carried' ? `${CARRIED_WEB_SESSION_LINEAGE_PREFIX}${sessionId}` : null,
    // An SID denial never moves the generation, so this is the one the
    // caller's credential was verified at.
    revocationGeneration: subject.generation,
  });
  return { sessionId, token: issued.token, expiresAt, generation: subject.generation };
}

export type WebSessionRoll = { readonly rolled: true; readonly expiresAt: Date } | { readonly rolled: false };

/**
 * Extend a live web session to `now` + 30 days, once fewer than 29 days
 * remain. One conditional UPDATE, no lock taken first and no cookie written.
 *
 * Live means what the session reader admits: unexpired, no SID denial, a
 * generation equal to the account's, an account not deleted, and a legacy
 * lineage, if any, unrevoked and still naming this row. Bridged web rows roll
 * too. Rows bound to a native refresh token keep that token's expiry and are
 * never rolled. Rolling never makes a row readable: every reader re-checks the
 * same conditions itself.
 *
 * `rolled: true` is not proof the session is live. Under READ COMMITTED a roll
 * queued behind an account cutoff re-checks only the row it waited on; its
 * sub-selects keep their earlier snapshot, so it can push out the expiry of a
 * row the cutoff just ended. The reader still refuses that row by its
 * generation. Callers rely on the reader, never on this result.
 */
export async function rollWebSession(
  database: Pick<AuthorityDatabase, 'select' | 'update'>,
  sessionId: string,
  now: Date,
): Promise<WebSessionRoll> {
  const rollAt = new Date(now.getTime());
  if (!sessionId || !validDate(rollAt)) return { rolled: false };
  const accountGeneration = database
    .select({ generation: authSubjectCutoffs.generation })
    .from(authSubjectCutoffs)
    .where(eq(authSubjectCutoffs.userId, authSession.userId));
  const [rolled] = await database
    .update(authSession)
    .set({ expiresAt: new Date(rollAt.getTime() + WEB_SESSION_LIFETIME_MS), updatedAt: rollAt })
    .where(
      and(
        eq(authSession.id, sessionId),
        gt(authSession.expiresAt, rollAt),
        lt(authSession.expiresAt, new Date(rollAt.getTime() + WEB_SESSION_ROLL_BELOW_REMAINING_MS)),
        or(
          isNull(authSession.legacyLineageId),
          and(
            notLike(authSession.legacyLineageId, 'native-refresh:%'),
            notLike(authSession.legacyLineageId, 'credential:native-refresh:%'),
          ),
        ),
        notExists(
          database
            .select({ sessionId: authSessionDenials.sessionId })
            .from(authSessionDenials)
            .where(eq(authSessionDenials.sessionId, authSession.id)),
        ),
        // No cutoff row stands for generation 0.
        sql`coalesce(${authSession.revocationGeneration}, 0) = coalesce((${accountGeneration}), 0)`,
        notExists(
          database
            .select({ userId: authSubjectCutoffs.userId })
            .from(authSubjectCutoffs)
            .where(and(eq(authSubjectCutoffs.userId, authSession.userId), isNotNull(authSubjectCutoffs.deletedAt))),
        ),
        notExists(
          database
            .select({ id: authCredentialLineage.id })
            .from(authCredentialLineage)
            .where(
              and(
                eq(authCredentialLineage.id, authSession.legacyLineageId),
                or(
                  isNotNull(authCredentialLineage.revokedAt),
                  ne(authCredentialLineage.userId, authSession.userId),
                  ne(authCredentialLineage.sessionId, authSession.id),
                ),
              ),
            ),
        ),
      ),
    )
    .returning({ expiresAt: authSession.expiresAt });
  return rolled ? { rolled: true, expiresAt: rolled.expiresAt } : { rolled: false };
}

/**
 * The reader credential for a session www presented. A legacy cookie needs
 * `NEXTAUTH_SECRET`; without it the session store is unavailable, never a
 * signed-out answer.
 */
export function presentedWebCredential(
  presented: PresentedWebSession,
  nextAuthSecret: string | undefined = process.env.NEXTAUTH_SECRET,
): FirstPartyCredential {
  if (presented.kind === 'canonical-token') return { kind: 'canonical-token', token: presented.token };
  if (!nextAuthSecret) throw new Error('Web session authority unavailable');
  return { kind: 'legacy-jwe', credential: presented.credential, secret: nextAuthSecret };
}

export interface WebSessionSignOut {
  /**
   * The cookie's credential: the canonical token after its signature checked
   * out, or the joined legacy NextAuth cookie.
   */
  readonly credential: FirstPartyCredential;
  /** Who the tab believed it was signed in as. */
  readonly expectedUserId: string;
  readonly expectedAuthSessionId: string;
}

/**
 * Guarded sign-out of a web session. `identity-changed` when the credential
 * reads as another live session than the tab expected: nothing ends.
 * `signed-out` once the session is revoked, or when it was not live anyway.
 *
 * A legacy cookie with its own session id gets a denial of that id, which
 * ends that login and no other. A legacy cookie without one could only be
 * ended by cutting off its whole account, phones included, so it is answered
 * `signed-out` and only its own id ends: the row the bridge made from it, if
 * any, and a denial of that id, so the cookie is never bridged afterwards. www
 * clears the cookie, as NextAuth's own sign-out does today. A bridged row of
 * such a cookie, presented by its token, is ended as that row alone. It never
 * performs an account cutoff.
 */
export async function signOutWebSession(
  database: AuthorityDatabase,
  input: WebSessionSignOut,
  authority: ExpectedCurrentStoreAuthority,
  now = new Date(),
): Promise<'signed-out' | 'identity-changed'> {
  const request = { ...input, credential: { ...input.credential } };
  const expectedAuthority = captureExpectedAuthority(authority);
  const outcome = await readFirstPartySession(database, request.credential, now);
  if (outcome.status === 'unavailable') throw new Error('Web session authority unavailable');
  if (outcome.status === 'denied') return 'signed-out';
  const { session } = outcome;
  if (session.userId !== request.expectedUserId || session.authSessionId !== request.expectedAuthSessionId)
    return 'identity-changed';
  if (request.credential.kind === 'legacy-jwe' && session.requiresAccountCutoff) {
    await endBridgedRowOfLegacyCookie(database, session, now, expectedAuthority);
    return 'signed-out';
  }
  await database.transaction(async (transaction) => {
    await transactionSettings(transaction);
    // A bridged row of a legacy cookie without a session id is ended as that
    // row alone (row, lineage, denial of its id), never by cutting off the
    // account: that would end every session and phone (#7596 review of #7722).
    await denyFirstPartySessionInTransaction(
      transaction,
      { ...session, requiresAccountCutoff: false },
      now,
      expectedAuthority,
    );
  });
  return 'signed-out';
}

/**
 * The row the bridge made from a legacy cookie without a session id: its id is
 * the session id the reader gave the cookie and its lineage is the cookie's
 * own. That id ends alone (row if any, lineage, denial of the id), as a
 * sign-out presenting its token ends it; never by an account cutoff. The
 * denial is written even when no row exists yet (review of #7789, Low 4), so a
 * bridge of this cookie that follows or races the sign-out is refused: the
 * bridge reads denials of the id first. The caller holds the gate and the
 * account FOR UPDATE.
 */
async function endBridgedRowAlone(
  transaction: AuthorityTransaction,
  session: FirstPartySession,
  now: Date,
  expectedAuthority: ExpectedCurrentStoreAuthority,
): Promise<void> {
  const lineageId = session.lineageId;
  if (!lineageId?.startsWith('credential:') || lineageId.startsWith('credential:native-refresh:')) return;
  // A row under this id that the bridge did not make from this cookie is never touched.
  const [existing] = await transaction
    .select({ userId: authSession.userId, legacyLineageId: authSession.legacyLineageId })
    .from(authSession)
    .where(eq(authSession.id, session.authSessionId));
  if (existing && (existing.userId !== session.userId || existing.legacyLineageId !== lineageId)) return;
  await denyFirstPartySessionInTransaction(
    transaction,
    { ...session, requiresAccountCutoff: false },
    now,
    expectedAuthority,
  );
}

/**
 * A legacy cookie that could only be ended by an account cutoff is never ended
 * that way: only the row the bridge made from it, if any, ends.
 */
async function endBridgedRowOfLegacyCookie(
  database: AuthorityDatabase,
  session: FirstPartySession,
  now: Date,
  expectedAuthority: ExpectedCurrentStoreAuthority,
): Promise<void> {
  await database.transaction(async (transaction) => {
    await transactionSettings(transaction);
    // The denial's own order: the gate, then the account FOR UPDATE, which a
    // bridge (KEY SHARE) of this cookie must wait for, so a row it committed
    // first is found here.
    await transaction.execute(sql`SELECT pg_advisory_xact_lock_shared(6975, 2)`);
    await transaction.select({ id: users.id }).from(users).where(eq(users.id, session.userId)).for('update');
    await endBridgedRowAlone(transaction, session, now, expectedAuthority);
  });
}

/** The user fields of today's NextAuth session JSON. */
export interface WebSessionUser {
  readonly id: string;
  readonly email: string | null;
  readonly name: string | null;
  readonly image: string | null;
}

export type WebSessionRead =
  | { readonly status: 'active'; readonly session: FirstPartySession; readonly user: WebSessionUser }
  | { readonly status: 'unauthenticated' };

/**
 * Read the session a cookie carries, by exactly the rules every request uses
 * (`readFirstPartySession`), and the user fields the NextAuth session JSON
 * shows. Only SELECTs: no roll, no last-seen time, no bridge. A legacy cookie
 * is answered by its own admission rules.
 */
export async function readWebSession(
  database: Pick<AuthorityDatabase, 'select'>,
  credential: FirstPartyCredential,
  now = new Date(),
): Promise<WebSessionRead> {
  const outcome = await readFirstPartySession(database, credential, now);
  if (outcome.status === 'unavailable') throw new Error('Web session authority unavailable');
  if (outcome.status === 'denied') return { status: 'unauthenticated' };
  const { session } = outcome;
  const [account] = await database
    .select({
      email: users.email,
      name: users.name,
      image: users.image,
      displayName: userProfiles.displayName,
      avatarUrl: userProfiles.avatarUrl,
    })
    .from(users)
    .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
    .where(eq(users.id, session.userId));
  // The reader admitted it a moment ago; an account gone since is signed out.
  if (!account) return { status: 'unauthenticated' };
  return {
    status: 'active',
    session,
    user: {
      id: session.userId,
      email: account.email,
      // As the NextAuth session callback: the profile's name and avatar win.
      name: account.displayName || account.name,
      image: account.avatarUrl || account.image,
    },
  };
}

export type WebSessionRefresh =
  | {
      readonly status: 'active';
      readonly session: FirstPartySession;
      readonly rolled: boolean;
      readonly expiresAt: Date;
    }
  | { readonly status: 'unauthenticated' };

/** Read the session a cookie carries, as every request does, then roll it when it is due. */
export async function refreshWebSession(
  database: AuthorityDatabase,
  token: string,
  now = new Date(),
): Promise<WebSessionRefresh> {
  const outcome = await readFirstPartySession(database, { kind: 'canonical-token', token }, now);
  if (outcome.status === 'unavailable') throw new Error('Web session authority unavailable');
  if (outcome.status === 'denied') return { status: 'unauthenticated' };
  const roll = await rollWebSession(database, outcome.session.authSessionId, now);
  return {
    status: 'active',
    session: outcome.session,
    rolled: roll.rolled,
    expiresAt: roll.rolled ? roll.expiresAt : outcome.session.expiresAt,
  };
}

export type WebSessionBridge =
  | {
      readonly status: 'bridged';
      readonly userId: string;
      readonly sessionId: string;
      readonly token: string;
      readonly expiresAt: Date;
      readonly generation: number;
    }
  | { readonly status: 'denied' };

/**
 * Bridge a legacy NextAuth cookie into a backend web session (#7596, B2). The
 * session keeps the cookie's own session id (a no-SID cookie: its lineage id,
 * as the bridge has always keyed it), its signed expiry until the first roll,
 * and its sign-in time for the 30-day rules; its source is `bridge`, so it never
 * passes a five-minute check. The token is derived from the session id, so the
 * same cookie always gets the same token and one row. `mode` is 'on' here: the
 * caller's `CURRENT_STORE_WEB_SESSION_MODE` is the switch, never
 * `AUTH_LEGACY_BRIDGE_MODE`, which the native refresh path keeps reading.
 *
 * A no-SID cookie is bridged as its own row, never by an account cutoff; login
 * and sign-out also treat that row alone. A cookie stamped with another
 * generation than the account's (a missing stamp counts as 0) is denied, as is
 * one whose session id was signed out. It writes only under an enforced
 * manifest with the configured projection and epoch (`unavailable` otherwise).
 */
export async function bridgeWebSession(
  database: AuthorityDatabase,
  credential: string,
  keys: { readonly nextAuthSecret: string; readonly tokenKey: BridgeTokenKey },
  authority: ExpectedCurrentStoreAuthority,
  now = new Date(),
): Promise<WebSessionBridge> {
  const bridged = await bridgeLegacyCredential(
    database,
    credential,
    keys.nextAuthSecret,
    keys.tokenKey,
    'on',
    now,
    authority,
  );
  if (bridged.status === 'unavailable') throw new Error('Web session authority unavailable');
  if (bridged.status !== 'bridged') return { status: 'denied' };
  return {
    status: 'bridged',
    userId: bridged.session.userId,
    sessionId: bridged.session.id,
    token: bridged.token,
    expiresAt: bridged.session.expiresAt,
    generation: bridged.session.revocationGeneration ?? 0,
  };
}
