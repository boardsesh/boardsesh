import {
  and,
  asc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  notExists,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { DbInstance } from '@boardsesh/db/client';
import {
  oauthAccessToken,
  oauthConnections,
  oauthConsentInteractions,
  oauthGrants,
  oauthRefreshAncestors,
  oauthRefreshToken,
  oauthSession,
  oauthVerification,
} from '@boardsesh/db/schema/auth';
import { getPostgresErrorCode } from '../../utils/postgres-errors';

/**
 * The partner OAuth retention sweep (docs/integration-platform.md, "Retention
 * sweep"). Nothing in the provider deletes a row once it stops mattering, so
 * this does, in six steps:
 *
 * 1. An expired `oauth_session` goes together with the access tokens bound to
 *    it. Deleting the session alone would let `ON DELETE SET NULL` turn each of
 *    them into an unbound token that reads active until it expires.
 * 2. An access token past its expiry goes, from any family.
 * 3. A refresh token that was already rotated goes once its ancestor row records
 *    the rotation, so replaying it still trips reuse exactly as before.
 * 4. A family that can never issue again (no live code, refresh or access token,
 *    or a grant its connection has fenced off) goes whole: tokens, ancestry, the
 *    code and finally the grant. Ancestry of a live family is never touched,
 *    however old: expiry alone is never permission to forget it.
 * 5. An authorization code past its expiry goes, a deleted account's included.
 * 6. A consent screen past its expiry goes.
 *
 * Everything waits a grace period past its expiry first. The provider judges
 * expiry on each app server's clock and finishes a request inside one short
 * transaction, so an hour covers any skew between clocks and any request that
 * read a row as live just before it expired.
 *
 * How it stays out of a climber's way:
 * - It takes no lock on `users` or on `oauth_connections`. Every row it deletes
 *   it locks first with `FOR UPDATE SKIP LOCKED`, in the same statement, and a
 *   row a live flow holds (a refresh, Disconnect, the password trigger, account
 *   deletion) is skipped until the next run. The foreign-key actions find
 *   nothing to wait for: a refresh token goes only when no access token points at
 *   it, and a session only when no token is bound to it. So it never waits for a
 *   row and can never be part of a deadlock.
 * - A batch is one transaction of at most six statements, each capped at 250 ms,
 *   so a live flow that wants a row the batch holds waits at most 1.5 s, under
 *   the 2 s an issuer allows and the 5 s the password trigger allows. Measured
 *   batches take a few milliseconds.
 * - Two sweeps at once split the rows between them; running it twice deletes
 *   nothing the first run left.
 */

/** How long past its expiry a row is kept. */
export const PARTNER_SWEEP_GRACE_MS = 60 * 60 * 1000;

export interface PartnerSweepLimits {
  /** Rows a batch takes per table; for the family step, also grants. */
  batchSize: number;
  /** Batches a step may run in one sweep before the next step starts. */
  maxBatchesPerStep: number;
  /** No new batch starts after this long. */
  budgetMs: number;
}

/** At most 50,000 rows per step and 30 s a run. */
export const PARTNER_SWEEP_LIMITS: PartnerSweepLimits = {
  batchSize: 200,
  maxBatchesPerStep: 250,
  budgetMs: 30_000,
};

export interface PartnerSweepCounts {
  sessions: number;
  sessionAccessTokens: number;
  expiredAccessTokens: number;
  rotatedRefreshTokens: number;
  families: number;
  familyAccessTokens: number;
  familyRefreshTokens: number;
  familyAncestors: number;
  familyCodes: number;
  expiredCodes: number;
  expiredInteractions: number;
}

export type PartnerSweepStep =
  | 'sessions'
  | 'access-tokens'
  | 'rotated-refresh-tokens'
  | 'families'
  | 'codes'
  | 'interactions';

export interface PartnerSweepResult {
  counts: PartnerSweepCounts;
  /** Steps that stopped early because the database was busy. The next run carries on. */
  busySteps: PartnerSweepStep[];
  /** False when the time budget or the batch cap stopped a step with rows left. */
  complete: boolean;
}

/** All the sweep needs of a database: transactions on the primary. */
export type PartnerSweepDatabase = Pick<DbInstance, 'transaction'>;

type SweepTransaction = Parameters<Parameters<DbInstance['transaction']>[0]>[0];

interface BatchOutcome {
  /** A read in the batch came back full, so rows may be left for another batch. */
  more: boolean;
  /** What the batch deleted. Added to the sweep's counts only once it commits. */
  deleted: Partial<PartnerSweepCounts>;
}

const LOCK_TIMEOUT = '100ms';
const STATEMENT_TIMEOUT = '250ms';
const IDLE_IN_TRANSACTION_TIMEOUT = '5s';

/** lock_not_available (a table lock, such as a migration's), query_canceled (statement_timeout), deadlock_detected. */
const DATABASE_BUSY_CODES = new Set(['55P03', '57014', '40P01']);

function emptyCounts(): PartnerSweepCounts {
  return {
    sessions: 0,
    sessionAccessTokens: 0,
    expiredAccessTokens: 0,
    rotatedRefreshTokens: 0,
    families: 0,
    familyAccessTokens: 0,
    familyRefreshTokens: 0,
    familyAncestors: 0,
    familyCodes: 0,
    expiredCodes: 0,
    expiredInteractions: 0,
  };
}

/**
 * Joins a grant's connection to the grant's ancestry. Ancestry is indexed by
 * (user, client, code), not by code alone, so this is the indexed way in.
 */
function ancestryOfGrant() {
  return and(
    eq(oauthRefreshAncestors.userId, oauthConnections.userId),
    eq(oauthRefreshAncestors.clientId, oauthConnections.clientId),
    eq(oauthRefreshAncestors.authorizationCodeId, oauthGrants.authorizationCodeId),
  );
}

/** A refresh token can go only once no access token points at it, or the cascade would reach that row. */
function noAccessTokenPointsAtRefreshToken(transaction: SweepTransaction) {
  return notExists(
    transaction
      .select({ id: oauthAccessToken.id })
      .from(oauthAccessToken)
      .where(eq(oauthAccessToken.refreshId, oauthRefreshToken.id)),
  );
}

/*
 * Each delete below names its rows through a `FOR UPDATE SKIP LOCKED` read in the
 * same statement: it locks what it can take without waiting, skips what a live
 * flow holds, and deletes only the rows it locked.
 */

function deleteAccessTokens(transaction: SweepTransaction, where: SQL | undefined, batchSize: number) {
  return transaction
    .delete(oauthAccessToken)
    .where(
      inArray(
        oauthAccessToken.id,
        transaction
          .select({ id: oauthAccessToken.id })
          .from(oauthAccessToken)
          .where(where)
          .limit(batchSize)
          .for('update', { skipLocked: true }),
      ),
    )
    .returning({ id: oauthAccessToken.id });
}

function deleteRefreshTokens(transaction: SweepTransaction, where: SQL | undefined, batchSize: number) {
  return transaction
    .delete(oauthRefreshToken)
    .where(
      inArray(
        oauthRefreshToken.id,
        transaction
          .select({ id: oauthRefreshToken.id })
          .from(oauthRefreshToken)
          .where(and(where, noAccessTokenPointsAtRefreshToken(transaction)))
          .limit(batchSize)
          .for('update', { skipLocked: true }),
      ),
    )
    .returning({ id: oauthRefreshToken.id });
}

function deleteCodes(transaction: SweepTransaction, where: SQL | undefined, batchSize: number) {
  return transaction
    .delete(oauthVerification)
    .where(
      inArray(
        oauthVerification.id,
        transaction
          .select({ id: oauthVerification.id })
          .from(oauthVerification)
          .where(where)
          .limit(batchSize)
          .for('update', { skipLocked: true }),
      ),
    )
    .returning({ id: oauthVerification.id });
}

/** Step 1: expired sessions and the access tokens bound to them. */
async function sweepExpiredSessions(
  transaction: SweepTransaction,
  cutoff: Date,
  batchSize: number,
): Promise<BatchOutcome> {
  // Held FOR UPDATE until commit, so no token can bind to one of these meanwhile.
  const claimed = await transaction
    .select({ id: oauthSession.id })
    .from(oauthSession)
    .where(
      and(
        lt(oauthSession.expiresAt, cutoff),
        // Refresh tokens are offline and detach from their session when issued.
        // One still bound would be detached, not ended, by deleting the session,
        // so such a session is left alone rather than claimed again every batch.
        notExists(
          transaction
            .select({ id: oauthRefreshToken.id })
            .from(oauthRefreshToken)
            .where(eq(oauthRefreshToken.sessionId, oauthSession.id)),
        ),
      ),
    )
    .orderBy(asc(oauthSession.expiresAt))
    .limit(batchSize)
    .for('update', { skipLocked: true });
  if (claimed.length === 0) return { more: false, deleted: {} };
  const sessionIds = claimed.map(({ id }) => id);

  const boundTokens = await deleteAccessTokens(transaction, inArray(oauthAccessToken.sessionId, sessionIds), batchSize);

  // This statement sees every token committed before the claim took its locks.
  // A session with a token still bound (one another transaction holds, or one
  // committed between the claim's snapshot and its lock) waits for the next
  // batch, so the SET NULL action never reaches a real row.
  const sessions = await transaction
    .delete(oauthSession)
    .where(
      and(
        inArray(oauthSession.id, sessionIds),
        notExists(
          transaction
            .select({ id: oauthAccessToken.id })
            .from(oauthAccessToken)
            .where(eq(oauthAccessToken.sessionId, oauthSession.id)),
        ),
        notExists(
          transaction
            .select({ id: oauthRefreshToken.id })
            .from(oauthRefreshToken)
            .where(eq(oauthRefreshToken.sessionId, oauthSession.id)),
        ),
      ),
    )
    .returning({ id: oauthSession.id });

  return {
    more: claimed.length === batchSize || boundTokens.length === batchSize,
    deleted: { sessionAccessTokens: boundTokens.length, sessions: sessions.length },
  };
}

/** Step 2: access tokens past their expiry. Nothing can use one, and nothing points at one. */
async function sweepExpiredAccessTokens(
  transaction: SweepTransaction,
  cutoff: Date,
  batchSize: number,
): Promise<BatchOutcome> {
  const deleted = await deleteAccessTokens(transaction, lt(oauthAccessToken.expiresAt, cutoff), batchSize);
  return { more: deleted.length === batchSize, deleted: { expiredAccessTokens: deleted.length } };
}

/**
 * Step 3: refresh tokens already rotated. The family guard reads the ancestor
 * row when the refresh row is gone, so a replay still closes the family. A row
 * whose ancestor does not record the rotation stays until its family ends, and
 * so does one that an access token issued with it still points at.
 */
async function sweepRotatedRefreshTokens(
  transaction: SweepTransaction,
  cutoff: Date,
  batchSize: number,
): Promise<BatchOutcome> {
  const deleted = await deleteRefreshTokens(
    transaction,
    and(
      lt(oauthRefreshToken.revoked, cutoff),
      exists(
        transaction
          .select({ tokenHash: oauthRefreshAncestors.tokenHash })
          .from(oauthRefreshAncestors)
          .where(
            and(
              eq(oauthRefreshAncestors.tokenHash, oauthRefreshToken.token),
              eq(oauthRefreshAncestors.clientId, oauthRefreshToken.clientId),
              eq(oauthRefreshAncestors.userId, oauthRefreshToken.userId),
              eq(oauthRefreshAncestors.authorizationCodeId, oauthRefreshToken.authorizationCodeId),
              isNotNull(oauthRefreshAncestors.consumedAt),
            ),
          ),
      ),
    ),
    batchSize,
  );
  return { more: deleted.length === batchSize, deleted: { rotatedRefreshTokens: deleted.length } };
}

/**
 * Step 4: families that can never issue again. A family is one authorization
 * code: its grant row, and every token and ancestor carrying that code's id. It
 * is over when its connection has fenced the grant off (revoked, or a newer
 * generation), or when its code, its refresh tokens and its access tokens are
 * all spent or expired. Nothing can bring such a family back: only a live code or
 * a live refresh token issues anything.
 *
 * Rows go in the order the provider's own cleanup uses, the grant last, so a
 * family too big for one batch is found again by the next one.
 */
async function sweepEndedFamilies(
  transaction: SweepTransaction,
  cutoff: Date,
  batchSize: number,
): Promise<BatchOutcome> {
  const claimed = await transaction
    .select({ authorizationCodeId: oauthGrants.authorizationCodeId })
    .from(oauthGrants)
    .innerJoin(oauthConnections, eq(oauthConnections.id, oauthGrants.connectionId))
    .where(
      and(
        lt(oauthGrants.createdAt, cutoff),
        or(
          isNotNull(oauthConnections.revokedAt),
          ne(oauthGrants.generation, oauthConnections.generation),
          and(
            notExists(
              transaction
                .select({ id: oauthVerification.id })
                .from(oauthVerification)
                .where(
                  and(
                    eq(oauthVerification.identifier, oauthGrants.authorizationCodeId),
                    gt(oauthVerification.expiresAt, cutoff),
                  ),
                ),
            ),
            notExists(
              transaction
                .select({ id: oauthRefreshToken.id })
                .from(oauthRefreshToken)
                .where(
                  and(
                    eq(oauthRefreshToken.authorizationCodeId, oauthGrants.authorizationCodeId),
                    isNull(oauthRefreshToken.revoked),
                    gt(oauthRefreshToken.expiresAt, cutoff),
                  ),
                ),
            ),
            notExists(
              transaction
                .select({ id: oauthAccessToken.id })
                .from(oauthAccessToken)
                .where(
                  and(
                    eq(oauthAccessToken.authorizationCodeId, oauthGrants.authorizationCodeId),
                    gt(oauthAccessToken.expiresAt, cutoff),
                  ),
                ),
            ),
          ),
        ),
      ),
    )
    .orderBy(asc(oauthGrants.authorizationCodeId))
    .limit(batchSize)
    // Only the grant rows. The connection is read, never locked.
    .for('update', { of: oauthGrants, skipLocked: true });
  if (claimed.length === 0) return { more: false, deleted: {} };
  const codeIds = claimed.map(({ authorizationCodeId }) => authorizationCodeId);

  const accessTokens = await deleteAccessTokens(
    transaction,
    inArray(oauthAccessToken.authorizationCodeId, codeIds),
    batchSize,
  );
  const refreshTokens = await deleteRefreshTokens(
    transaction,
    inArray(oauthRefreshToken.authorizationCodeId, codeIds),
    batchSize,
  );

  // Ancestry goes only once no unrotated refresh token of the family is left. One
  // still there was skipped because another transaction holds it, perhaps a
  // refresh mid-rotation, so its ancestry waits for the next batch. Reached
  // through the grant and its connection to use the ancestry index.
  const ancestors = await transaction
    .delete(oauthRefreshAncestors)
    .where(
      inArray(
        oauthRefreshAncestors.tokenHash,
        transaction
          .select({ tokenHash: oauthRefreshAncestors.tokenHash })
          .from(oauthGrants)
          .innerJoin(oauthConnections, eq(oauthConnections.id, oauthGrants.connectionId))
          .innerJoin(oauthRefreshAncestors, ancestryOfGrant())
          .where(
            and(
              inArray(oauthGrants.authorizationCodeId, codeIds),
              notExists(
                transaction
                  .select({ id: oauthRefreshToken.id })
                  .from(oauthRefreshToken)
                  // Keyed on the grant, so it is checked once per family, not once per ancestor.
                  .where(
                    and(
                      eq(oauthRefreshToken.authorizationCodeId, oauthGrants.authorizationCodeId),
                      isNull(oauthRefreshToken.revoked),
                    ),
                  ),
              ),
            ),
          )
          .limit(batchSize)
          // Only the ancestry rows: the grants are held already, the connection never is.
          .for('update', { of: oauthRefreshAncestors, skipLocked: true }),
      ),
    )
    .returning({ tokenHash: oauthRefreshAncestors.tokenHash });

  const codes = await deleteCodes(transaction, inArray(oauthVerification.identifier, codeIds), batchSize);

  // The grant goes last, and only when nothing of its family is left. Until then
  // the fence still finds it, and the next batch finds the family again.
  const grants = await transaction
    .delete(oauthGrants)
    .where(
      and(
        inArray(oauthGrants.authorizationCodeId, codeIds),
        notExists(
          transaction
            .select({ id: oauthAccessToken.id })
            .from(oauthAccessToken)
            .where(eq(oauthAccessToken.authorizationCodeId, oauthGrants.authorizationCodeId)),
        ),
        notExists(
          transaction
            .select({ id: oauthRefreshToken.id })
            .from(oauthRefreshToken)
            .where(eq(oauthRefreshToken.authorizationCodeId, oauthGrants.authorizationCodeId)),
        ),
        notExists(
          transaction
            .select({ tokenHash: oauthRefreshAncestors.tokenHash })
            .from(oauthConnections)
            .innerJoin(oauthRefreshAncestors, ancestryOfGrant())
            .where(eq(oauthConnections.id, oauthGrants.connectionId)),
        ),
        notExists(
          transaction
            .select({ id: oauthVerification.id })
            .from(oauthVerification)
            .where(eq(oauthVerification.identifier, oauthGrants.authorizationCodeId)),
        ),
      ),
    )
    .returning({ authorizationCodeId: oauthGrants.authorizationCodeId });

  return {
    more: [claimed, accessTokens, refreshTokens, ancestors, codes].some((rows) => rows.length === batchSize),
    deleted: {
      families: grants.length,
      familyAccessTokens: accessTokens.length,
      familyRefreshTokens: refreshTokens.length,
      familyAncestors: ancestors.length,
      familyCodes: codes.length,
    },
  };
}

/**
 * Step 5: authorization codes past their expiry. The provider deletes a code only
 * when someone presents it, and the row holds the climber's id, their session id
 * and the authorization query. A deleted account's codes have no grant left to
 * reach them, so this is what removes those.
 */
async function sweepExpiredCodes(
  transaction: SweepTransaction,
  cutoff: Date,
  batchSize: number,
): Promise<BatchOutcome> {
  const deleted = await deleteCodes(transaction, lt(oauthVerification.expiresAt, cutoff), batchSize);
  return { more: deleted.length === batchSize, deleted: { expiredCodes: deleted.length } };
}

/** Step 6: consent screens past their expiry. A missing screen is refused like a spent one. */
async function sweepExpiredInteractions(
  transaction: SweepTransaction,
  cutoff: Date,
  batchSize: number,
): Promise<BatchOutcome> {
  const deleted = await transaction
    .delete(oauthConsentInteractions)
    .where(
      inArray(
        oauthConsentInteractions.digest,
        transaction
          .select({ digest: oauthConsentInteractions.digest })
          .from(oauthConsentInteractions)
          .where(lt(oauthConsentInteractions.expiresAt, cutoff))
          .limit(batchSize)
          .for('update', { skipLocked: true }),
      ),
    )
    .returning({ digest: oauthConsentInteractions.digest });
  return { more: deleted.length === batchSize, deleted: { expiredInteractions: deleted.length } };
}

const STEPS: ReadonlyArray<{
  name: PartnerSweepStep;
  run: (transaction: SweepTransaction, cutoff: Date, batchSize: number) => Promise<BatchOutcome>;
}> = [
  // Sessions first: their bound tokens are what keeps a session-only family alive.
  { name: 'sessions', run: sweepExpiredSessions },
  { name: 'access-tokens', run: sweepExpiredAccessTokens },
  { name: 'rotated-refresh-tokens', run: sweepRotatedRefreshTokens },
  { name: 'families', run: sweepEndedFamilies },
  { name: 'codes', run: sweepExpiredCodes },
  { name: 'interactions', run: sweepExpiredInteractions },
];

export function isPartnerSweepBusy(error: unknown): boolean {
  const code = getPostgresErrorCode(error);
  return code !== undefined && DATABASE_BUSY_CODES.has(code);
}

/**
 * One sweep. Bounded by `limits`, safe to run beside another sweep, a live
 * request or a password write, and a no-op on empty tables. Throws only on an
 * unexpected database error; a busy database ends that step early instead.
 */
export async function sweepPartnerOAuth(
  database: PartnerSweepDatabase,
  { now = new Date(), limits = PARTNER_SWEEP_LIMITS }: { now?: Date; limits?: PartnerSweepLimits } = {},
): Promise<PartnerSweepResult> {
  const cutoff = new Date(now.getTime() - PARTNER_SWEEP_GRACE_MS);
  // performance.now, not Date: a test that freezes Date must not freeze the budget.
  const deadline = performance.now() + limits.budgetMs;
  const counts = emptyCounts();
  const busySteps: PartnerSweepStep[] = [];
  let complete = true;

  for (const step of STEPS) {
    let drained = false;
    for (let batch = 0; batch < limits.maxBatchesPerStep && performance.now() < deadline; batch += 1) {
      let outcome: BatchOutcome;
      try {
        outcome = await database.transaction(async (transaction) => {
          await transaction.execute(
            sql`select set_config('lock_timeout', ${LOCK_TIMEOUT}, true),
                       set_config('statement_timeout', ${STATEMENT_TIMEOUT}, true),
                       set_config('idle_in_transaction_session_timeout', ${IDLE_IN_TRANSACTION_TIMEOUT}, true)`,
          );
          return step.run(transaction, cutoff, limits.batchSize);
        });
      } catch (error) {
        if (!isPartnerSweepBusy(error)) throw error;
        busySteps.push(step.name);
        drained = true;
        break;
      }
      let deletedRows = 0;
      for (const [name, deleted] of Object.entries(outcome.deleted) as [keyof PartnerSweepCounts, number][]) {
        counts[name] += deleted;
        deletedRows += deleted;
      }
      // A batch whose reads all came back short leaves nothing behind. A batch
      // that deleted nothing met only rows other transactions hold; the next
      // sweep tries them again.
      if (!outcome.more || deletedRows === 0) {
        drained = true;
        break;
      }
    }
    if (!drained) complete = false;
  }

  return { counts, busySteps, complete };
}
