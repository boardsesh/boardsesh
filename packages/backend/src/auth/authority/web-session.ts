import { randomUUID } from 'node:crypto';
import { and, eq, gt, inArray, isNotNull, isNull, lt, ne, notExists, notLike, or, sql } from 'drizzle-orm';
import { WEB_SESSION_LIFETIME_SECONDS, WEB_SESSION_ROLL_BELOW_REMAINING_SECONDS } from '@boardsesh/auth-protocol';
import {
  authCredentialLineage,
  authSession,
  authSessionDenials,
  authSubjectCutoffs,
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
import { denyFirstPartySessionInTransaction } from './lineage';
import { revalidateIdentityAuthority, type IdentityAuthorityReceipt } from './router';
import { readFirstPartySession, type FirstPartySession } from './session-reader';
import { newSessionToken } from './session-token';

export { WEB_SESSION_LIFETIME_SECONDS, WEB_SESSION_ROLL_BELOW_REMAINING_SECONDS };

const WEB_SESSION_LIFETIME_MS = WEB_SESSION_LIFETIME_SECONDS * 1000;
const WEB_SESSION_ROLL_BELOW_REMAINING_MS = WEB_SESSION_ROLL_BELOW_REMAINING_SECONDS * 1000;

export interface WebSessionIssue {
  /** The account whose credential the caller verified, in this transaction, under its user lock. */
  readonly userId: string;
  /** When that credential was verified: the real sign-in time. Never later than `now`. */
  readonly authenticatedAt: Date;
  /**
   * The admitted first-party session that arrived on the login request, legacy
   * cookie or canonical, of any account. Revoked in this transaction.
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
  return {
    userId: input.userId,
    authenticatedAt,
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
 * Both accounts' `users` rows in `users.id` order, as the database sorts them:
 * FOR UPDATE for the presented session's account, whose rows are revoked, and
 * the weakest correct lock, FOR KEY SHARE, for the account signing in. Two
 * logins that present each other's sessions then queue instead of deadlocking.
 * Returns whether the presented account still exists.
 */
async function lockAccounts(
  transaction: AuthorityTransaction,
  userId: string,
  presentedUserId: string | undefined,
): Promise<boolean> {
  const accounts = await transaction
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.id, presentedUserId ? [userId, presentedUserId] : [userId]))
    .orderBy(users.id);
  let presentedAccountExists = false;
  for (const { id } of accounts) {
    const account = transaction.select({ id: users.id }).from(users).where(eq(users.id, id));
    if (id !== presentedUserId) await account.for('key share');
    else presentedAccountExists = (await account.for('update')).length === 1;
  }
  return presentedAccountExists;
}

/**
 * Issue a first-party web session for a verified sign-in, in the caller's
 * transaction, and revoke the session the login presented in the same one.
 * The caller verified the credential in this transaction and publishes the
 * token only after it commits.
 *
 * Lock order: the shared authority gate (and a manifest re-check), then
 * `users` rows in id order, then the presented session's rows, then the new
 * row. Refuses a deleted account with `AuthSubjectDeniedError`, as native
 * issuance does, and a moved authority with `STALE_AUTHORITY`.
 */
export async function issueWebSession(
  transaction: AuthorityTransaction,
  input: WebSessionIssue,
): Promise<IssuedWebSession> {
  const request = captureIssue(input);
  await requireReadCommitted(transaction);
  await revalidateIdentityAuthority(transaction, request.authority);
  const presentedAccountExists = await lockAccounts(transaction, request.userId, request.presented?.userId);
  // A deleted account's sessions are refused by every reader already.
  if (request.presented && presentedAccountExists)
    await denyFirstPartySessionInTransaction(transaction, request.presented, request.now, {
      expectedProjectionId: request.authority.projectionId,
      expectedNormalizerVersion: request.authority.normalizerVersion,
      expectedWriterEpoch: request.authority.epoch,
    });
  // After the revocation: ending this account's own no-SID legacy login moves
  // its generation, and the new session must carry the moved one.
  const subject = await requireHumanSubjectForIssuance(transaction, request.userId);
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
    // No lineage: this row's source is `login`.
    legacyLineageId: null,
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

export interface WebSessionSignOut {
  /** The opaque token from the session cookie, after its signature checked out. */
  readonly token: string;
  /** Who the tab believed it was signed in as. */
  readonly expectedUserId: string;
  readonly expectedAuthSessionId: string;
}

/**
 * Guarded sign-out of a canonical web session. `identity-changed` when the
 * token reads as another live session than the tab expected: nothing ends.
 * `signed-out` once the session is revoked, or when it was not live anyway.
 */
export async function signOutWebSession(
  database: AuthorityDatabase,
  input: WebSessionSignOut,
  authority: ExpectedCurrentStoreAuthority,
  now = new Date(),
): Promise<'signed-out' | 'identity-changed'> {
  const request = { ...input };
  const expectedAuthority = captureExpectedAuthority(authority);
  const outcome = await readFirstPartySession(database, { kind: 'canonical-token', token: request.token }, now);
  if (outcome.status === 'unavailable') throw new Error('Web session authority unavailable');
  if (outcome.status === 'denied') return 'signed-out';
  const { session } = outcome;
  if (session.userId !== request.expectedUserId || session.authSessionId !== request.expectedAuthSessionId)
    return 'identity-changed';
  await database.transaction(async (transaction) => {
    await transactionSettings(transaction);
    // A bridged no-SID row ends its whole account, which needs the expected authority.
    await denyFirstPartySessionInTransaction(transaction, session, now, expectedAuthority);
  });
  return 'signed-out';
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
