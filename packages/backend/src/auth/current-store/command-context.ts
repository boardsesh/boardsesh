import { createHash } from 'node:crypto';
import type { DbInstance } from '@boardsesh/db/client';
import {
  AUTH_COMMAND_FUTURE_SKEW_MS,
  AUTH_COMMAND_MAX_AGE_MS,
  AUTH_COMMAND_TIMEOUT_MS,
  type AuthCommand,
} from '@boardsesh/auth-protocol';
import { verificationTokens } from '@boardsesh/db/schema/auth';
import { sql } from 'drizzle-orm';
import {
  captureExpectedAuthority,
  lockEnforcedProjection,
  type CurrentStoreTransaction,
  type ExpectedCurrentStoreAuthority,
} from './foundation-context';

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
/** Short preflight only. Never hold the global manifest lock during bcrypt. */
export async function preflight(database: DbInstance, authority: WebPasswordAuthority) {
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
  const commandHash = createHash('sha256').update(`${command.operation}\0${command.requestId}`).digest('hex');
  const claimed = await transaction
    .insert(verificationTokens)
    .values({
      identifier: `ba03-web-auth:${commandHash}`,
      token: commandHash,
      expires: new Date(
        command.issuedAt + AUTH_COMMAND_MAX_AGE_MS + AUTH_COMMAND_FUTURE_SKEW_MS + AUTH_COMMAND_TIMEOUT_MS,
      ),
    })
    .onConflictDoNothing()
    .returning({ token: verificationTokens.token });
  return claimed.length === 1;
}
