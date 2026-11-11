import { createHash } from 'node:crypto';
import type { DbInstance } from '@boardsesh/db/client';
import {
  AUTH_COMMAND_FUTURE_SKEW_MS,
  AUTH_COMMAND_MAX_AGE_MS,
  AUTH_COMMAND_TIMEOUT_MS,
  type AuthCommand,
} from '@boardsesh/auth-protocol';
import { verificationTokens } from '@boardsesh/db/schema/auth';
import { and, inArray, like, lt, sql } from 'drizzle-orm';
import {
  captureExpectedAuthority,
  lockEnforcedProjection,
  type CurrentStoreTransaction,
  type ExpectedCurrentStoreAuthority,
} from './foundation-context';

const WEB_AUTH_COMMAND_IDENTIFIER_PREFIX = 'ba03-web-auth:';
// One run a minute covers 5,000 commands; each backend process accepts at most 960.
const EXPIRED_COMMAND_CLAIMS_PER_RUN = 5_000;

export interface WebPasswordAuthority extends ExpectedCurrentStoreAuthority {
  readonly emailVerificationEnabled: boolean;
}
export class WebPasswordCommandError extends Error {
  constructor(readonly code: 'expired_request') {
    super('Current-store command expired');
    this.name = 'WebPasswordCommandError';
  }
}
export function captureAuthority(authority: WebPasswordAuthority): WebPasswordAuthority {
  return { ...captureExpectedAuthority(authority), emailVerificationEnabled: authority.emailVerificationEnabled };
}
export function isWebPasswordCommandFresh(issuedAt: number): boolean {
  const now = Date.now();
  return (
    Number.isSafeInteger(issuedAt) &&
    issuedAt >= 0 &&
    issuedAt <= now + AUTH_COMMAND_FUTURE_SKEW_MS &&
    now - issuedAt <= AUTH_COMMAND_MAX_AGE_MS
  );
}
export function assertFresh(issuedAt: number) {
  if (!isWebPasswordCommandFresh(issuedAt)) throw new WebPasswordCommandError('expired_request');
}
export async function transactionSettings(transaction: CurrentStoreTransaction) {
  await transaction.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
  await transaction.execute(sql`SET LOCAL lock_timeout = '4000ms'`);
}

/**
 * How long a sign-in, forgot-password or resend-verification waits for a held
 * climber's row (and, after it, their reservation) before giving up. Giving up
 * throws 55P03, which every caller answers as unavailable, a reply clients
 * retry; it is never answered as a wrong password. Writers that must win (reset,
 * set-password, deletion) keep the 4 s limit above. Each waiting request holds
 * one of a backend process's five pool connections (`DEFAULT_POOL_MAX`), so at
 * 4 s a burst naming one held account, such as one being deleted, kept the pool
 * busy and an unrelated sign-in in the same process waited 16 s.
 */
export const SIGN_IN_LOCK_TIMEOUT = '250ms';

/** Call right before the first climber-row lock: the gate wait before it keeps 4 s. */
export async function boundSignInLockWaits(transaction: CurrentStoreTransaction) {
  await transaction.execute(sql.raw(`SET LOCAL lock_timeout = '${SIGN_IN_LOCK_TIMEOUT}'`));
}

/**
 * `transactionSettings` for native password sign-in, which takes no gate: the
 * user row is the first lock it waits for, so the short limit applies from the
 * start, in the same two statements.
 */
export async function signInTransactionSettings(transaction: CurrentStoreTransaction) {
  await transaction.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
  await boundSignInLockWaits(transaction);
}
/**
 * Short preflight only: fail on a stale authority before bcrypt or other long
 * work, which then runs with no transaction open. The command re-validates under
 * the gate in its own transaction.
 */
export async function preflight(database: DbInstance, authority: ExpectedCurrentStoreAuthority) {
  await database.transaction(async (transaction) => {
    await transactionSettings(transaction);
    await lockEnforcedProjection(transaction, authority);
  });
}
export async function claimCommand(
  transaction: CurrentStoreTransaction,
  command: Pick<AuthCommand, 'operation' | 'requestId' | 'issuedAt'>,
) {
  assertFresh(command.issuedAt);
  // The schema accepts either case, and the same UUID must claim the same row.
  const commandHash = createHash('sha256')
    .update(`${command.operation}\0${command.requestId.toLowerCase()}`)
    .digest('hex');
  const claimed = await transaction
    .insert(verificationTokens)
    .values({
      identifier: `${WEB_AUTH_COMMAND_IDENTIFIER_PREFIX}${commandHash}`,
      token: commandHash,
      expires: new Date(
        command.issuedAt + AUTH_COMMAND_MAX_AGE_MS + AUTH_COMMAND_FUTURE_SKEW_MS + AUTH_COMMAND_TIMEOUT_MS,
      ),
    })
    .onConflictDoNothing()
    .returning({ token: verificationTokens.token });
  return claimed.length === 1;
}

/**
 * Spends a pre-switch email link once. The old row stays where it is, because
 * command roles may only append to this table; this replay record marks it used.
 * It expires at the link's own deadline, so the cleanup below removes it only
 * once the link is dead anyway. The hash domain cannot meet a command's.
 */
export async function claimLegacyLink(
  transaction: CurrentStoreTransaction,
  link: {
    readonly purpose: 'password-reset' | 'email-verification';
    readonly identifier: string;
    readonly storedToken: string;
    readonly expires: Date;
  },
): Promise<boolean> {
  const linkHash = createHash('sha256')
    .update(`legacy-link-v1\0${link.purpose}\0${link.identifier}\0${link.storedToken}`)
    .digest('hex');
  const claimed = await transaction
    .insert(verificationTokens)
    .values({ identifier: `${WEB_AUTH_COMMAND_IDENTIFIER_PREFIX}${linkHash}`, token: linkHash, expires: link.expires })
    .onConflictDoNothing()
    .returning({ token: verificationTokens.token });
  return claimed.length === 1;
}

/**
 * Deletes at most one batch of expired replay records; a backlog drains over
 * later runs. Safe because freshness rejects a command before its row expires.
 * Runs apart from the commands themselves: their database role may only append
 * to this table, and a failed cleanup must never fail a sign-in.
 */
export async function deleteExpiredCommandClaims(
  database: DbInstance,
  batchSize: number = EXPIRED_COMMAND_CLAIMS_PER_RUN,
): Promise<number> {
  return database.transaction(async (transaction) => {
    await transactionSettings(transaction);
    const expired = await transaction
      .select({ identifier: verificationTokens.identifier })
      .from(verificationTokens)
      .where(
        and(
          like(verificationTokens.identifier, `${WEB_AUTH_COMMAND_IDENTIFIER_PREFIX}%`),
          lt(verificationTokens.expires, new Date()),
        ),
      )
      .limit(batchSize)
      .for('update', { skipLocked: true });
    if (expired.length === 0) return 0;
    await transaction.delete(verificationTokens).where(
      inArray(
        verificationTokens.identifier,
        expired.map(({ identifier }) => identifier),
      ),
    );
    return expired.length;
  });
}
